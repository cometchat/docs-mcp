// Fixes from the PR #35 E2E triage, each against a fake dashboard API that
// answers only the calls a test sets up and records every request.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { DashboardClient } from "../src/dashboard/client.js";
import { ALL_DASHBOARD_TOOLS, READ_SCOPE, WRITE_SCOPE, runDashboardTool, type DashboardSession } from "../src/tools/dashboard/index.js";
import { asStructured } from "../src/lib/errors.js";

const APP = "app123";
const REST = `/apps/${APP}/chat-api/v3.0`;

type Handler = (url: URL, method: string, body: unknown) => { status?: number; body: unknown } | undefined;
interface Seen {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(handlers: Record<string, Handler | { status?: number; body: unknown }>, seen: Seen[]) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, path: `${url.pathname}${url.search}`, body });
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === `/apps/${APP}` && !handlers[`GET /apps/${APP}`]) return reply(200, { data: { appId: APP, version: "3", region: "us", accessKey: "ak" } });
    const h = handlers[`${method} ${url.pathname}`];
    const out = typeof h === "function" ? h(url, method, body) : h;
    if (!out) return reply(404, { error: { code: "ERR_NOT_FOUND", message: `no fake for ${method} ${url.pathname}` } });
    return reply(out.status ?? 200, out.body);
  }) as unknown as typeof fetch;
}

function session(handlers: Parameters<typeof fakeApi>[0], seen: Seen[] = [], over: Partial<DashboardSession> = {}): DashboardSession {
  return {
    client: new DashboardClient({ apiHost: "http://dashboard.test", token: "t", fetchImpl: fakeApi(handlers, seen) }),
    scopes: new Set([READ_SCOPE, WRITE_SCOPE]),
    readOnly: false,
    local: true,
    actor: "test-actor",
    writesPerMinute: 0,
    ...over,
  };
}

const ajv = new Ajv({ strict: false });
const spec = (name: string) => ALL_DASHBOARD_TOOLS.find((t) => t.name === name)!;
async function run(name: string, args: Record<string, unknown>, s: DashboardSession) {
  const out = await runDashboardTool(name, args, s);
  const validate = ajv.compile(spec(name).outputSchema);
  if (!validate(out)) throw new Error(`${name} output breaks its outputSchema: ${JSON.stringify(validate.errors)}`);
  return out as any;
}
async function failure(name: string, args: Record<string, unknown>, s: DashboardSession) {
  try {
    await runDashboardTool(name, args, s);
  } catch (err) {
    return asStructured(err);
  }
  throw new Error("expected the tool to fail");
}
const writes = (seen: Seen[]) => seen.filter((x) => x.method !== "GET");

// chat-api's affix=prepend returns the latest N messages oldest first.
const ascending = [1, 2, 3].map((n) => ({ id: String(n), sender: "a", receiver: "b", receiverType: "user", category: "message", type: "text", data: { text: `m${n}` }, sentAt: 1000 + n }));

describe("K6: cometchat_list_messages is newest first, as described", () => {
  it("returns the latest messages newest first, for the app and for one conversation", async () => {
    const s = session({
      [`GET ${REST}/messages`]: { body: { data: ascending, meta: {} } },
      [`GET ${REST}/conversations/a_user_b/messages`]: { body: { data: ascending, meta: {} } },
    });
    for (const args of [{ app_id: APP }, { app_id: APP, conversation_id: "a_user_b" }]) {
      const out = await run("cometchat_list_messages", args, s);
      expect(out.messages.map((m: { id: string }) => m.id)).toEqual(["3", "2", "1"]);
    }
    expect(spec("cometchat_list_messages").description).toContain("newest first");
  });
});

describe("K9: input that can't work is refused before asking for confirmation or approval", () => {
  const approvals = { requestUrl: () => "https://mcp.test/oauth/cometchat/approve?r=x", check: () => true, release: () => undefined } as unknown as DashboardSession["approvals"];
  const hooks = { body: { data: [{ id: "existing-hook", webhookURL: "https://example.com/a", enabled: 1 }] } };
  const hookArgs = { app_id: APP, id: "new-hook", name: "N", url: "https://example.com/h", triggers: ["message_sent"] };

  it("create_webhook: an http:// URL is refused before an approval link is issued", async () => {
    const seen: Seen[] = [];
    const f = await failure("cometchat_create_webhook", { ...hookArgs, url: "http://example.com/insecure" }, session({ [`GET ${REST}/webhooks`]: hooks, [`GET ${REST}/triggers`]: { body: { data: [{ id: "message_sent" }] } } }, seen, { local: false, approvals }));
    expect(f.code).toBe("invalid_input");
    expect(f.message).toContain("https://");
    expect(writes(seen)).toEqual([]);
  });

  it("create_webhook: an id that's already taken is refused before an approval link is issued", async () => {
    const seen: Seen[] = [];
    const f = await failure("cometchat_create_webhook", { ...hookArgs, id: "existing-hook" }, session({ [`GET ${REST}/webhooks`]: hooks, [`GET ${REST}/triggers`]: { body: { data: [{ id: "message_sent" }] } } }, seen, { local: false, approvals }));
    expect(f.code).toBe("invalid_input");
    expect(f.message).toContain("already");
    expect(writes(seen)).toEqual([]);
  });

  it("create_webhook: valid input still needs the browser approval", async () => {
    const f = await failure("cometchat_create_webhook", hookArgs, session({ [`GET ${REST}/webhooks`]: hooks, [`GET ${REST}/triggers`]: { body: { data: [{ id: "message_sent" }] } } }, [], { local: false, approvals }));
    expect(f.code).toBe("approval_required");
  });

  it("set_feature: an unknown feature id is refused before asking for confirmation", async () => {
    const s = session({
      "GET /regions/us/extensions": { body: { data: [{ id: "polls", name: "Polls" }] } },
      [`GET /apps/${APP}/extensions`]: { body: { data: [] } },
    });
    const f = await failure("cometchat_set_feature", { app_id: APP, feature_id: "no-such-thing", enabled: true }, s);
    expect(f.code).toBe("invalid_input");
    const ok = await failure("cometchat_set_feature", { app_id: APP, feature_id: "polls", enabled: true }, s);
    expect(ok.code).toBe("confirmation_required");
  });
});

describe("K2: the sign-in page can tell the AI tool the sign-in was cancelled", () => {
  async function signInPageHtml(signInFlow: "poll" | "confirm") {
    const { DashboardOAuthProvider } = await import("../src/dashboard/oauth.js");
    const provider = new DashboardOAuthProvider({
      secret: "k2-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
      apiHost: "http://dashboard.test",
      dashboardHost: "https://app.cometchat.com",
      issuer: "https://mcp.example.com/",
      signInFlow,
      fetchImpl: fakeApi({ "POST /cli-auth/session": { body: { data: { sessionId: "sess-1" } } } }, []),
    });
    let html = "";
    const res = { append: () => res, status: () => res, type: () => res, set: () => res, send: (b: string) => ((html = b), res), redirect: () => res };
    await provider.authorize(
      { client_id: "c1", client_name: "Test tool", redirect_uris: ["http://localhost:7777/callback"] } as never,
      { redirectUri: "http://localhost:7777/callback", codeChallenge: "x", state: "st&ate", scopes: [] },
      res as never,
    );
    return html;
  }
  const decode = (s: string) => s.replace(/&amp;/g, "&");

  for (const flow of ["poll", "confirm"] as const) {
    it(`(${flow}) has a Cancel link that returns access_denied with the client's state and our issuer`, async () => {
      const html = await signInPageHtml(flow);
      const href = /<a id="cancel" href="([^"]+)"/.exec(html)?.[1];
      expect(href).toBeTruthy();
      const u = new URL(decode(href!));
      expect(`${u.origin}${u.pathname}`).toBe("http://localhost:7777/callback");
      expect(u.searchParams.get("error")).toBe("access_denied");
      expect(u.searchParams.get("state")).toBe("st&ate");
      expect(u.searchParams.get("iss")).toBe("https://mcp.example.com/");
      expect(u.searchParams.has("code")).toBe(false);
    });
  }

  it("(poll) sends the tool access_denied when the dashboard reports the sign-in was denied", async () => {
    const html = await signInPageHtml("poll");
    expect(html).toMatch(/r\.status==="denied"\)\{done=true;show\([^)]*\);location\.replace\(c\);return\}/);
    // c is the same access_denied URL as the Cancel link, never empty and never a code.
    const c = JSON.parse(/,c=("(?:[^"\\]|\\.)*"),/.exec(html)![1]!) as string;
    const u = new URL(c);
    expect(`${u.origin}${u.pathname}`).toBe("http://localhost:7777/callback");
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("st&ate");
    expect(u.searchParams.has("code")).toBe(false);
  });
});

describe("K7: get_plan for an admin who isn't the app owner", () => {
  it("returns the plan, says invoices are owner-only, and doesn't echo the dashboard's error (which holds the email)", async () => {
    const s = session({
      [`GET /apps/${APP}`]: { body: { data: { appId: APP, version: "3", plan: "build", state: "active", trialEndsAt: 1 } } },
      "GET /plans": { body: { data: { build: { id: "build", name: "Build" } } } },
      [`GET /apps/${APP}/invoices`]: { status: 400, body: { error: { code: "ERR_NOT_AN_OWNER", message: `A customer or developer with email admin@example.com is not an owner of the app with appId ${APP}.` } } },
    });
    const out = await run("cometchat_get_plan", { app_id: APP }, s);
    expect(out).toMatchObject({ plan: "build", plan_name: "Build", state: "active", invoices: [], invoices_available: false });
    expect(JSON.stringify(out)).not.toContain("admin@example.com");
    expect(spec("cometchat_get_plan").description).toMatch(/owner/i);
  });

  it("still fails on other errors", async () => {
    const s = session({
      [`GET /apps/${APP}`]: { body: { data: { appId: APP, version: "3", plan: "build" } } },
      [`GET /apps/${APP}/invoices`]: { status: 400, body: { error: { code: "ERR_BAD_REQUEST", message: "Something else." } } },
    });
    expect((await failure("cometchat_get_plan", { app_id: APP }, s)).code).toBe("dashboard_error");
  });
});

describe("K10: a refused approval code says why", () => {
  async function setup() {
    const { Sealer } = await import("../src/dashboard/seal.js");
    const { ApprovalService } = await import("../src/dashboard/approval.js");
    const secret = "k10-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
    const approvals = new ApprovalService({ sealer: new Sealer(secret), secret, publicUrl: "https://mcp.example.com" });
    const s = session(
      {
        [`GET ${REST}/webhooks`]: { body: { data: [] } },
        [`POST ${REST}/webhooks`]: { body: { data: {} } },
        [`POST ${REST}/webhooks/h1/triggers`]: { body: { data: { message_sent: { success: true } } } },
        [`GET ${REST}/webhooks/h1/triggers`]: { body: { data: [{ id: "message_sent" }] } },
        [`GET ${REST}/triggers`]: { body: { data: [{ id: "message_sent" }] } },
      },
      [],
      { local: false, approvals },
    );
    const args = { app_id: APP, id: "h1", name: "N", url: "https://example.com/h", triggers: ["message_sent"] };
    const code = async (a: Record<string, unknown>) => {
      const f = await failure("cometchat_create_webhook", a, s);
      const r = new URL((f.details as { approval_url: string }).approval_url).searchParams.get("r");
      const res = approvals.approveWithCookie(r, approvals.approverCookie("test-actor").split(";")[0]);
      return (res as { code: string }).code;
    };
    return { s, args, code };
  }

  it("tells a code for different arguments, an expired code and a used code apart", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
      const { s, args, code } = await setup();
      const c = await code(args);

      const mismatch = await failure("cometchat_create_webhook", { ...args, url: "https://example.com/other", approval_code: c }, s);
      expect(mismatch.details).toMatchObject({ invalid_code: true, reason: "mismatch" });
      expect(mismatch.message).toContain("doesn't match this exact change");
      expect(mismatch.message).not.toContain("expired");

      expect(await run("cometchat_create_webhook", { ...args, approval_code: c }, s)).toMatchObject({ id: "h1" });
      const used = await failure("cometchat_create_webhook", { ...args, approval_code: c }, s);
      expect(used.details).toMatchObject({ invalid_code: true, reason: "used" });
      expect(used.message).toContain("already used");

      const c2 = await code(args);
      vi.setSystemTime(new Date("2026-11-11T10:16:00Z"));
      const expired = await failure("cometchat_create_webhook", { ...args, approval_code: c2 }, s);
      expect(expired.details).toMatchObject({ invalid_code: true, reason: "expired" });
      expect(expired.message).toContain("expired");
      expect(expired.code).toBe("approval_required");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("L2: set_feature's confirmation reads naturally", () => {
  it("says 'Turn polls on for app …'", async () => {
    const s = session({ "GET /regions/us/extensions": { body: { data: [{ id: "polls", name: "Polls" }] } }, [`GET /apps/${APP}/extensions`]: { body: { data: [] } } });
    const f = await failure("cometchat_set_feature", { app_id: APP, feature_id: "polls", enabled: true }, s);
    expect(f.message).toContain(`Turn polls on for app ${APP}.`);
    expect(f.message).not.toContain("on on");
  });
});

describe("L4: list_webhook_triggers names a trigger that exists", () => {
  it("uses message_sent as its example, not the non-existent after_message", () => {
    const d = spec("cometchat_list_webhook_triggers").description;
    expect(d).toContain("message_sent");
    expect(d).not.toContain("after_message");
  });
});

describe("L7: create_users says what a valid uid is", () => {
  it("names the allowed characters and length", async () => {
    const out = await run("cometchat_create_users", { app_id: APP, users: [{ uid: "bad uid!@#", name: "X" }, { uid: "ok", name: " " }] }, session({}));
    expect(out.results[0]).toMatchObject({ uid: "bad uid!@#", status: "failed" });
    expect(out.results[0].message).toMatch(/letters, numbers, - and _/);
    expect(out.results[0].message).toMatch(/1-100/);
    expect(out.results[1].message).toMatch(/name/);
  });
});

describe("L8: a user's deactivated state is explicit", () => {
  it("reports deactivated: false for an active (or reactivated) user, true for a deactivated one", async () => {
    const s = session({
      [`GET ${REST}/users/active`]: { body: { data: { uid: "active", name: "A" } } },
      [`GET ${REST}/users/gone`]: { body: { data: { uid: "gone", name: "G", deactivatedAt: 1700000000 } } },
    });
    expect((await run("cometchat_get_user", { app_id: APP, uid: "active" }, s)).user.deactivated).toBe(false);
    expect((await run("cometchat_get_user", { app_id: APP, uid: "gone" }, s)).user.deactivated).toBe(true);
  });
});

describe("L9: remove_group_member says it removed the user", () => {
  it("returns removed: true", async () => {
    const s = session({
      [`GET ${REST}/groups/team/members/alice`]: { body: { data: { uid: "alice" } } },
      [`DELETE ${REST}/groups/team/members/alice`]: { body: { data: { success: true } } },
    });
    expect(await run("cometchat_remove_group_member", { app_id: APP, guid: "team", uid: "alice", confirm: true }, s)).toMatchObject({ guid: "team", uid: "alice", removed: true });
  });
});

describe("L10: create_app returns the app's name", () => {
  it("includes name with the credentials", async () => {
    const s = session({
      "POST /apps": { body: { data: { appId: "new1", region: "eu", accessKey: "full-access" } } },
      "GET /apps/new1": { body: { data: { appId: "new1", region: "eu", version: "3", accessKey: "full-access" } } },
      "GET /apps/new1/chat-api/v3.0/apikeys": { body: { data: [{ apiKey: "auth-new1", scope: "authOnly", createdAt: 1 }] } },
    });
    const out = await run("cometchat_create_app", { name: "My app", region: "eu" }, s);
    expect(out).toMatchObject({ app_id: "new1", name: "My app", region: "eu", auth_key: "auth-new1" });
    expect(JSON.stringify(out)).not.toContain("full-access");
  });
});

describe("the Auth Key is the app's authOnly key, never the app record's accessKey", () => {
  const keys = (data: unknown[]) => ({ [`GET ${REST}/apikeys`]: { body: { data } } });

  it("get_app_credentials returns the oldest authOnly key, not accessKey or a fullAccess key", async () => {
    const s = session(
      keys([
        { apiKey: "rest-key", scope: "fullAccess", createdAt: 1 },
        { apiKey: "auth-newer", scope: "authOnly", createdAt: 30 },
        { apiKey: "auth-oldest", scope: "authOnly", createdAt: 20 },
      ]),
    );
    const out = await run("cometchat_get_app_credentials", { app_id: APP }, s);
    expect(out.auth_key).toBe("auth-oldest");
    expect(JSON.stringify(out)).not.toMatch(/"ak"|rest-key/);
  });

  it("fails clearly when the app has no Auth Key instead of falling back to accessKey", async () => {
    const f = await failure("cometchat_get_app_credentials", { app_id: APP }, session(keys([{ apiKey: "rest-key", scope: "fullAccess", createdAt: 1 }])));
    expect(f.message).toContain("no Auth Key");
    expect(JSON.stringify(f)).not.toMatch(/"ak"|rest-key/);
  });

  it("create_app says the app exists (don't recreate) when its keys can't be read", async () => {
    const s = session({
      "POST /apps": { body: { data: { appId: "new1", region: "eu", accessKey: "full-access" } } },
      "GET /apps/new1": { body: { data: { appId: "new1", region: "eu", version: "3", accessKey: "full-access" } } },
      "GET /apps/new1/chat-api/v3.0/apikeys": { status: 403, body: { error: { code: "ERR_FORBIDDEN", message: "forbidden" } } },
    });
    const f = await failure("cometchat_create_app", { name: "My app", region: "eu" }, s);
    expect(f.message).toContain("Don't create it again");
    expect(f.message).toContain("new1");
    expect(JSON.stringify(f)).not.toContain("full-access");
  });
});

describe("L20: the webhook approval summary names the webhook id", () => {
  it("includes the id the user is approving", async () => {
    const f = await failure("cometchat_create_webhook", { app_id: APP, id: "backend-sync", name: "N", url: "https://example.com/h", triggers: ["message_sent"] }, session({ [`GET ${REST}/webhooks`]: { body: { data: [] } }, [`GET ${REST}/triggers`]: { body: { data: [{ id: "message_sent" }] } } }));
    expect(f.code).toBe("confirmation_required");
    expect((f.details as { summary: string }).summary).toContain("backend-sync");
  });
});

describe("L16: list_features trims names and descriptions", () => {
  it("drops stray newlines and spaces from the catalog", async () => {
    const s = session({
      "GET /regions/us/extensions": { body: { data: [{ id: "e2ee", name: "End-to-end Encryption\n", description: "Keeps messages private. " }] } },
      [`GET /apps/${APP}/extensions`]: { body: { data: [] } },
      [`GET /apps/${APP}/ai/settings`]: { status: 404, body: { error: { code: "NOT_FOUND", message: "none" } } },
    });
    const out = await run("cometchat_list_features", { app_id: APP }, s);
    expect(out.extensions[0]).toMatchObject({ id: "e2ee", name: "End-to-end Encryption", description: "Keeps messages private." });
  });
});

describe("L28: on approval tools, confirm says it isn't enough on its own", () => {
  it("tells the model the hosted server needs approval_code for these changes", () => {
    for (const t of ALL_DASHBOARD_TOOLS.filter((x) => x.approval)) {
      const confirm = (t.inputSchema.properties as Record<string, { description: string }>).confirm;
      expect(confirm.description, t.name).toContain("approval_code");
    }
    const plain = (spec("cometchat_update_user").inputSchema.properties as Record<string, { description: string }>).confirm;
    expect(plain.description).not.toContain("approval_code");
  });
});

describe("PR35 fixes: webhook paging and moderation read-back", () => {
  it("list_webhooks asks for perPage (the endpoint ignores per_page and returns 10)", async () => {
    const seen: Seen[] = [];
    await run("cometchat_list_webhooks", { app_id: APP }, session({ [`GET ${REST}/webhooks`]: { body: { data: [] } } }, seen));
    expect(seen.find((c) => c.path.startsWith(`${REST}/webhooks`))!.path).toContain("perPage=100");
  });

  it("a moderation list delete that didn't apply is reported, not called deleted", async () => {
    const list = { body: { data: [{ id: "my-list", name: "Mine", default: false }] } };
    const f = await failure(
      "cometchat_delete_moderation_list",
      { app_id: APP, list_id: "my-list", confirm: true },
      session({ [`GET /apps/${APP}/moderation/keywords`]: list, [`DELETE /apps/${APP}/moderation/keywords/my-list`]: { body: { data: { success: true } } } }),
    );
    expect(f.message).toMatch(/reported moderation list my-list deleted, but it.s still listed/);
    expect((f.details as { api_code?: string }).api_code).toBe("delete_not_applied");
  });
});

describe("PR35 fixes: read-back failures", () => {
  it("create_webhook falls back to the per-trigger results when the read-back fails", async () => {
    const out = await run(
      "cometchat_create_webhook",
      { app_id: APP, id: "rb-hook", name: "N", url: "https://example.com/h", triggers: ["message_sent"], confirm: true },
      session({
        [`GET ${REST}/webhooks`]: { body: { data: [] } },
        [`GET ${REST}/triggers`]: { body: { data: [{ id: "message_sent" }] } },
        [`POST ${REST}/webhooks`]: { body: { data: {} } },
        [`POST ${REST}/webhooks/rb-hook/triggers`]: { body: { data: { message_sent: { success: true } } } },
        [`GET ${REST}/webhooks/rb-hook/triggers`]: { status: 500, body: { error: { code: "ERR", message: "boom" } } },
      }),
    );
    expect(out.triggers).toEqual(["message_sent"]);
  });
});

describe("PR35 fixes: an ended sign-in is never hidden", () => {
  const hookRoutes = {
    [`GET ${REST}/webhooks`]: { body: { data: [] } },
    [`GET ${REST}/triggers`]: { body: { data: [{ id: "message_sent" }, { id: "user_mentioned" }] } },
    [`POST ${REST}/webhooks`]: { body: { data: {} } },
  };
  const args = { app_id: APP, id: "rb2", name: "N", url: "https://example.com/h", triggers: ["message_sent", "user_mentioned"], confirm: true };

  it("create_webhook: a 401 on the trigger read-back fails the call", async () => {
    const f = await failure("cometchat_create_webhook", args, session({
      ...hookRoutes,
      [`POST ${REST}/webhooks/rb2/triggers`]: { body: { data: { message_sent: { success: true }, user_mentioned: { success: true } } } },
      [`GET ${REST}/webhooks/rb2/triggers`]: { status: 401, body: { error: { code: "ERR_UNAUTHORIZED", message: "expired" } } },
    }));
    expect(f.code).not.toBe("dashboard_error");
    expect(f.code).toMatch(/auth|unauthorized|sign/i);
  });

  it("create_webhook: when the read-back fails, only triggers CometChat confirmed are reported", async () => {
    const out = await run("cometchat_create_webhook", args, session({
      ...hookRoutes,
      [`POST ${REST}/webhooks/rb2/triggers`]: { body: { data: { message_sent: { success: true } } } }, // user_mentioned not mentioned
      [`GET ${REST}/webhooks/rb2/triggers`]: { status: 500, body: { error: { code: "ERR", message: "boom" } } },
    }));
    expect(out.triggers).toEqual(["message_sent"]);
    expect(out.failed_triggers).toEqual([{ id: "user_mentioned", error: "not attached" }]);
  });
});

describe("PR35 fixes: FCM reads don't hide an ended sign-in", () => {
  it("a 401 on the provider listing fails add_fcm_provider before anything is sent", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fcm-auth-"));
    const file = path.join(dir, "sa.json");
    writeFileSync(file, JSON.stringify({ type: "service_account", project_id: "p", client_email: "x@y.iam.gserviceaccount.com", private_key: "k", private_key_id: "i" }));
    const seen: Seen[] = [];
    const f = await failure("cometchat_add_fcm_provider", { app_id: APP, provider_id: "auth-test", service_account_file: file, confirm: true }, session({
      [`GET ${REST}/notifications/push/v1/providers/dashboard/fcm`]: { status: 401, body: { error: { code: "ERR_UNAUTHORIZED", message: "expired" } } },
      [`POST ${REST}/notifications/push/v1/providers/dashboard/fcm`]: { status: 201, body: { data: { success: true } } },
    }, seen));
    expect(f.code).toMatch(/auth|unauthorized|sign/i);
    expect(writes(seen)).toEqual([]);
  });
});

describe("PR35 fixes: get_push_setup doesn't hide an ended sign-in", () => {
  it("a 401 on the provider listing is an auth error, not an empty list", async () => {
    const f = await failure("cometchat_get_push_setup", { app_id: APP }, session({
      [`GET /apps/${APP}/settings`]: { body: { data: { settings: {} } } },
      [`GET ${REST}/notifications/push/v1/providers/dashboard/fcm`]: { status: 401, body: { error: { code: "ERR_UNAUTHORIZED", message: "expired" } } },
      [`GET ${REST}/notifications/push/v1/providers/dashboard/apns`]: { body: { data: { pushProviders: [] } } },
    }));
    expect(f.code).toMatch(/auth|unauthorized|sign/i);
  });
});
