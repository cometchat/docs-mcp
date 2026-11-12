// Paging for the chat-api list tools, against a fake that follows chat-api's
// own rules (app/Lib/V3/Core/V3_0/ConversationCore.php, GroupUserCore.php):
// - GET /conversations without unique=1 is one row per participant, sized by
//   per_page (default 100), and its simple paginator reports total: 0.
// - GET /conversations?unique=1 is one row per conversation, sized by limit
//   (default 100), paged by an opaque cursor in meta.next.
// - GET /groups/{guid}/members is sized by per_page and reports total: 0 with
//   total_pages = this page, or this page + 1 when there are more.
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { DashboardClient } from "../src/dashboard/client.js";
import { ALL_DASHBOARD_TOOLS, READ_SCOPE, runDashboardTool, type DashboardSession } from "../src/tools/dashboard/index.js";
import { pageInfo } from "../src/tools/dashboard/registry.js";

const APP = "app123";
const REST = `/apps/${APP}/chat-api/v3.0`;

// 40 one-to-one conversations (2 participants each) and 20 groups (3 members each), newest first.
const CONVERSATIONS = Array.from({ length: 60 }, (_, i) =>
  i < 40
    ? { conversationId: `u${i}_user_v${i}`, conversationType: "user", updatedAt: 10_000 - i, participants: 2 }
    : { conversationId: `group_g${i}`, conversationType: "group", updatedAt: 10_000 - i, participants: 3 },
);
const MEMBERS = Array.from({ length: 7 }, (_, i) => ({ uid: `m${i}`, name: `Member ${i}`, scope: "participant", joinedAt: i }));

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ offset })).toString("base64");
const decodeCursor = (c: string) => (JSON.parse(Buffer.from(c, "base64").toString("utf8")) as { offset: number }).offset;

function size(v: string | null): number {
  const n = Number(v);
  return n > 0 ? Math.min(n, 1000) : 100;
}

function simplePage(rows: unknown[], page: number, perPage: number, totalPagesOverride?: number) {
  const slice = rows.slice((page - 1) * perPage, page * perPage);
  const more = rows.length > page * perPage;
  return { data: slice, meta: { pagination: { total: 0, count: slice.length, per_page: perPage, current_page: page, total_pages: totalPagesOverride ?? (more ? page + 1 : page) } } };
}

function fakeChatApi(seen: string[], opts: { membersTotalPages?: number } = {}) {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname}${url.search}`);
    const q = url.searchParams;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === `/apps/${APP}`) return json({ data: { appId: APP, version: "3" } });
    if (url.pathname === `${REST}/conversations`) {
      const rows = CONVERSATIONS.filter((c) => !q.get("conversationType") || c.conversationType === q.get("conversationType"));
      const shaped = (c: (typeof CONVERSATIONS)[number]) => ({ conversationId: c.conversationId, conversationType: c.conversationType, updatedAt: c.updatedAt });
      if (q.get("unique") === "1") {
        const limit = size(q.get("limit"));
        const offset = q.get("cursor") ? decodeCursor(q.get("cursor")!) : 0;
        const slice = rows.slice(offset, offset + limit).map(shaped);
        const meta: Record<string, unknown> = { current: { limit, count: slice.length } };
        if (limit <= slice.length) meta.next = { cursor: encodeCursor(offset + slice.length) };
        return json({ data: slice, meta });
      }
      // Per-participant projection: each conversation once per participant.
      const perUser = rows.flatMap((c) => Array.from({ length: c.participants }, () => shaped(c)));
      return json(simplePage(perUser, Number(q.get("page") ?? 1), size(q.get("per_page"))));
    }
    if (url.pathname === `${REST}/groups/team/members`) {
      return json(simplePage(MEMBERS, Number(q.get("page") ?? 1), size(q.get("per_page")), opts.membersTotalPages));
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: url.pathname } }), { status: 404 });
  }) as unknown as typeof fetch;
}

function session(seen: string[], opts: { membersTotalPages?: number } = {}): DashboardSession {
  return {
    client: new DashboardClient({ apiHost: "http://dashboard.test", token: "t", fetchImpl: fakeChatApi(seen, opts) }),
    scopes: new Set([READ_SCOPE]),
    readOnly: true,
    local: true,
    actor: "test-actor",
    writesPerMinute: 0,
  };
}

const ajv = new Ajv({ strict: false });
async function run(name: string, args: Record<string, unknown>, s: DashboardSession) {
  const out = await runDashboardTool(name, args, s);
  const validate = ajv.compile(ALL_DASHBOARD_TOOLS.find((t) => t.name === name)!.outputSchema);
  if (!validate(out)) throw new Error(`${name} output breaks its outputSchema: ${JSON.stringify(validate.errors)}`);
  return out as any;
}
const ids = (out: { conversations: Array<{ conversation_id: string }> }) => out.conversations.map((c) => c.conversation_id);

describe("cometchat_list_conversations paging", () => {
  it("asks chat-api for unique conversations with the page size", async () => {
    const seen: string[] = [];
    await run("cometchat_list_conversations", { app_id: APP, per_page: 25 }, session(seen));
    const call = new URL(`http://x${seen.find((s) => s.startsWith(`${REST}/conversations`))}`);
    expect(call.searchParams.get("unique")).toBe("1");
    expect(call.searchParams.get("limit")).toBe("25");
    expect(call.searchParams.get("per_page")).toBe("25");
    expect(call.searchParams.has("cursor")).toBe(false);
  });

  it("returns one row per conversation, no more than the page size", async () => {
    const out = await run("cometchat_list_conversations", { app_id: APP, per_page: 25 }, session([]));
    expect(out.conversations).toHaveLength(25);
    expect(new Set(ids(out)).size).toBe(25);
    expect(ids(out)).toEqual(CONVERSATIONS.slice(0, 25).map((c) => c.conversationId));
    expect(out).toMatchObject({ per_page: 25, has_more: true });
    expect(typeof out.next_cursor).toBe("string");
    expect(out.total).toBeUndefined();
  });

  it("page 2 (next_cursor) carries straight on from page 1, and the last page says so", async () => {
    const s = session([]);
    const all: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out = await run("cometchat_list_conversations", { app_id: APP, per_page: 25, ...(cursor ? { cursor } : {}) }, s);
      all.push(...ids(out));
      cursor = out.next_cursor;
      pages++;
      expect(out.has_more).toBe(cursor !== undefined);
    } while (cursor && pages < 10);
    expect(pages).toBe(3); // 25 + 25 + 10
    expect(all).toEqual(CONVERSATIONS.map((c) => c.conversationId));
  });

  it("forwards the type filter and refuses a malformed cursor before calling CometChat", async () => {
    const seen: string[] = [];
    const s = session(seen);
    const out = await run("cometchat_list_conversations", { app_id: APP, type: "group" }, s);
    expect(out.conversations.every((c: { type: string }) => c.type === "group")).toBe(true);
    expect(out.conversations).toHaveLength(20);
    expect(out.has_more).toBe(false);
    const before = seen.length;
    await expect(runDashboardTool("cometchat_list_conversations", { app_id: APP, cursor: "a&b=c" }, s)).rejects.toThrow(/cursor/);
    expect(seen.length).toBe(before);
  });
});

describe("cometchat_list_group_members paging", () => {
  it("sends per_page and page, and doesn't report chat-api's total: 0 as a count", async () => {
    const seen: string[] = [];
    const s = session(seen);
    const p1 = await run("cometchat_list_group_members", { app_id: APP, guid: "team", per_page: 3 }, s);
    const call = new URL(`http://x${seen.find((x) => x.startsWith(`${REST}/groups/team/members`))}`);
    expect(call.searchParams.get("per_page")).toBe("3");
    expect(call.searchParams.get("page")).toBe("1");
    expect(p1.members.map((m: { uid: string }) => m.uid)).toEqual(["m0", "m1", "m2"]);
    expect(p1.total).toBeUndefined();
    expect(p1.has_more).toBe(true);
    const p2 = await run("cometchat_list_group_members", { app_id: APP, guid: "team", per_page: 3, page: 2 }, s);
    expect(p2.members.map((m: { uid: string }) => m.uid)).toEqual(["m3", "m4", "m5"]);
    expect(p2.has_more).toBe(true);
    const p3 = await run("cometchat_list_group_members", { app_id: APP, guid: "team", per_page: 3, page: 3 }, s);
    expect(p3.members.map((m: { uid: string }) => m.uid)).toEqual(["m6"]);
    expect(p3.has_more).toBe(false);
  });

  it("falls back to the row count when chat-api reports total_pages: 0 alongside rows", async () => {
    const s = session([], { membersTotalPages: 0 });
    const full = await run("cometchat_list_group_members", { app_id: APP, guid: "team", per_page: 3 }, s);
    expect(full.total).toBeUndefined();
    expect(full.has_more).toBe(true);
    const last = await run("cometchat_list_group_members", { app_id: APP, guid: "team", per_page: 3, page: 3 }, s);
    expect(last.members).toHaveLength(1);
    expect(last.has_more).toBe(false);
  });
});

describe("pageInfo", () => {
  it("keeps a real (length-aware) total and total_pages", () => {
    const meta = { pagination: { total: 33, total_pages: 2, per_page: 25, current_page: 1 } };
    expect(pageInfo(meta, 1, 25, 25)).toEqual({ page: 1, per_page: 25, total: 33, has_more: true });
    expect(pageInfo({ pagination: { ...meta.pagination, current_page: 2 } }, 2, 25, 8)).toEqual({ page: 2, per_page: 25, total: 33, has_more: false });
    // An empty page past the end still reports the real total.
    expect(pageInfo({ pagination: { ...meta.pagination, current_page: 3 } }, 3, 25, 0)).toEqual({ page: 3, per_page: 25, total: 33, has_more: false });
  });

  it("drops a total or total_pages that contradicts the rows returned", () => {
    expect(pageInfo({ pagination: { total: 0, total_pages: 2 } }, 1, 25, 25)).toEqual({ page: 1, per_page: 25, has_more: true });
    expect(pageInfo({ pagination: { total: 0, total_pages: 0 } }, 1, 25, 25)).toEqual({ page: 1, per_page: 25, has_more: true });
    expect(pageInfo({ pagination: { total: 0, total_pages: 0 } }, 2, 25, 3)).toEqual({ page: 2, per_page: 25, has_more: false });
    expect(pageInfo({ pagination: { total: 10, total_pages: 1 } }, 2, 25, 5)).toEqual({ page: 2, per_page: 25, has_more: false });
  });
});
