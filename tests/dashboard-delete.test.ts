// The delete tools: the exact request each one sends, the checks that refuse
// before any change (built-in entries, unknown push providers, bad ids), the
// confirm / browser-approval gate, read-only refusal and the audit record.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Ajv from "ajv";
import { DashboardClient } from "../src/dashboard/client.js";
import { ApprovalService } from "../src/dashboard/approval.js";
import { Sealer } from "../src/dashboard/seal.js";
import {
  ALL_DASHBOARD_TOOLS, READ_SCOPE, WRITE_SCOPE, resetWriteLimits, runDashboardTool, visibleDashboardTools, type DashboardSession,
} from "../src/tools/dashboard/index.js";
import { asStructured } from "../src/lib/errors.js";
import { logger } from "../src/lib/logger.js";
import { startDashboardMock, DASH_TOKEN, type MockState } from "./dashboard-mock.js";
import { testSecret } from "./secrets.js";

const DELETE_TOOLS = [
  "cometchat_delete_users",
  "cometchat_delete_group",
  "cometchat_delete_message",
  "cometchat_revoke_auth_tokens",
  "cometchat_delete_api_key",
  "cometchat_delete_webhook",
  "cometchat_delete_role",
  "cometchat_delete_moderation_list",
  "cometchat_delete_moderation_rule",
  "cometchat_delete_push_provider",
];
const REST = "/apps/app123/chat-api/v3.0";
const ajv = new Ajv({ strict: false });
let mock: Awaited<ReturnType<typeof startDashboardMock>>;
let state: MockState;
let session: DashboardSession;

function makeSession(over: Partial<DashboardSession> = {}): DashboardSession {
  return {
    client: new DashboardClient({ apiHost: mock.url, token: DASH_TOKEN }),
    scopes: new Set([READ_SCOPE, WRITE_SCOPE]),
    readOnly: false,
    local: true,
    actor: "test-actor",
    writesPerMinute: 0,
    ...over,
  };
}
const spec = (name: string) => ALL_DASHBOARD_TOOLS.find((t) => t.name === name)!;
async function run(name: string, args: Record<string, unknown>, s = session) {
  const out = await runDashboardTool(name, args, s);
  const validate = ajv.compile(spec(name).outputSchema);
  if (!validate(out)) throw new Error(`${name} output breaks its outputSchema: ${JSON.stringify(validate.errors)}`);
  return out as any;
}
async function failure(name: string, args: Record<string, unknown>, s = session) {
  try {
    await runDashboardTool(name, args, s);
  } catch (err) {
    return asStructured(err);
  }
  throw new Error(`expected ${name} to fail`);
}
/** Changing calls (anything but GET) the mock received since `from`. */
const writesSince = (from: number) => state.calls.slice(from).filter((c) => c.method !== "GET");

beforeAll(async () => {
  mock = await startDashboardMock();
  state = mock.state;
  session = makeSession();
});
afterAll(() => mock.close());
beforeEach(() => resetWriteLimits());

describe("delete tool definitions", () => {
  it("are write tools marked destructive, and every delete but token revocation needs browser approval", () => {
    for (const name of DELETE_TOOLS) {
      const t = spec(name);
      expect(t, name).toBeDefined();
      expect(t.access).toBe("write");
      expect(t.confirm).toBe(true);
      expect(t.approval ?? false).toBe(name !== "cometchat_revoke_auth_tokens");
      const def = visibleDashboardTools(session).find((d) => d.name === name)!;
      expect(def.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it("adding group members asks for confirmation but isn't marked destructive", () => {
    const def = visibleDashboardTools(session).find((d) => d.name === "cometchat_add_group_members")!;
    expect(spec("cometchat_add_group_members").confirm).toBe(true);
    expect(def.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // Other confirmed writes stay destructive.
    expect(visibleDashboardTools(session).find((d) => d.name === "cometchat_remove_group_member")!.annotations).toMatchObject({ destructiveHint: true });
  });

  it("never offers deleting an app", () => {
    expect(ALL_DASHBOARD_TOOLS.some((t) => /delete_app/.test(t.name))).toBe(false);
  });

  it("are hidden from read-only connections", () => {
    const names = visibleDashboardTools(makeSession({ scopes: new Set([READ_SCOPE]) })).map((d) => d.name);
    for (const name of DELETE_TOOLS) expect(names).not.toContain(name);
  });
});

describe("delete tools send the right request (local connection, confirm: true)", () => {
  it("deletes users permanently, one call each, and reports a failure part-way", async () => {
    const from = state.calls.length;
    const out = await run("cometchat_delete_users", { app_id: "app123", uids: ["u-1", "missing-user", "u-2"], confirm: true });
    expect(out.deleted).toEqual(["u-1", "u-2"]);
    expect(out.failed).toEqual([{ id: "missing-user", error: expect.stringContaining("does not exist") }]);
    expect(writesSince(from)).toEqual([
      { method: "DELETE", path: `${REST}/users/u-1`, body: { permanent: true } },
      { method: "DELETE", path: `${REST}/users/missing-user`, body: { permanent: true } },
      { method: "DELETE", path: `${REST}/users/u-2`, body: { permanent: true } },
    ]);
  });

  it("fails when no user could be deleted", async () => {
    expect((await failure("cometchat_delete_users", { app_id: "app123", uids: ["missing-user"], confirm: true })).message).toMatch(/No users were deleted/);
  });

  it("deletes a group, and passes a not-found through", async () => {
    const from = state.calls.length;
    expect(await run("cometchat_delete_group", { app_id: "app123", guid: "team", confirm: true })).toEqual({ app_id: "app123", guid: "team", deleted: true });
    expect(writesSince(from)).toEqual([{ method: "DELETE", path: `${REST}/groups/team`, body: undefined }]);
    expect((await failure("cometchat_delete_group", { app_id: "app123", guid: "missing-group", confirm: true })).message).toMatch(/does not exist/);
  });

  it("soft-deletes a message by default and removes it with permanent: true", async () => {
    const from = state.calls.length;
    expect(await run("cometchat_delete_message", { app_id: "app123", message_id: "12003", confirm: true })).toMatchObject({ message_id: "12003", permanent: false, deleted: true });
    expect(await run("cometchat_delete_message", { app_id: "app123", message_id: "12004", permanent: true, confirm: true })).toMatchObject({ permanent: true });
    expect(writesSince(from)).toEqual([
      { method: "DELETE", path: `${REST}/messages/12003`, body: { permanent: false } },
      { method: "DELETE", path: `${REST}/messages/12004`, body: { permanent: true } },
    ]);
  });

  it("refuses a message id that isn't one, before any change", async () => {
    const from = state.calls.length;
    expect((await failure("cometchat_delete_message", { app_id: "app123", message_id: "../users/x", confirm: true })).code).toBe("invalid_input");
    expect((await failure("cometchat_delete_message", { app_id: "app123", message_id: "5", permanent: "yes", confirm: true })).code).toBe("invalid_input");
    expect(writesSince(from)).toEqual([]);
  });

  it("revokes all of a user's tokens, one token, or reports none", async () => {
    const from = state.calls.length;
    expect(await run("cometchat_revoke_auth_tokens", { app_id: "app123", uid: "cometchat-uid-1", confirm: true })).toMatchObject({ revoked: "all" });
    expect(await run("cometchat_revoke_auth_tokens", { app_id: "app123", uid: "cometchat-uid-1", auth_token: "cometchat-uid-1_17944100abc", confirm: true })).toMatchObject({ revoked: "one" });
    expect(await run("cometchat_revoke_auth_tokens", { app_id: "app123", uid: "no-tokens", confirm: true })).toMatchObject({ revoked: "none" });
    expect(writesSince(from).map((c) => c.path)).toEqual([
      `${REST}/users/cometchat-uid-1/auth_tokens`,
      `${REST}/users/cometchat-uid-1/auth_tokens/cometchat-uid-1_17944100abc`,
      `${REST}/users/no-tokens/auth_tokens`,
    ]);
  });

  it("deletes an API key that exists, and refuses one that doesn't before any change", async () => {
    const from = state.calls.length;
    expect((await failure("cometchat_delete_api_key", { app_id: "app123", api_key: "notakey99", confirm: true })).message).toMatch(/isn't a key on app app123/);
    expect((await failure("cometchat_delete_api_key", { app_id: "app123", api_key: "../apps", confirm: true })).code).toBe("invalid_input");
    expect(writesSince(from)).toEqual([]);
    expect(await run("cometchat_delete_api_key", { app_id: "app123", api_key: "authkey123", confirm: true })).toEqual({ app_id: "app123", name: "Auth Key", scope: "authOnly", deleted: true });
    expect(writesSince(from)).toEqual([{ method: "DELETE", path: `${REST}/apikeys/authkey123`, body: undefined }]);
  });

  it("deletes a webhook, a role and a moderation list or rule you created", async () => {
    const from = state.calls.length;
    await run("cometchat_delete_webhook", { app_id: "app123", webhook_id: "hook1", confirm: true });
    await run("cometchat_delete_role", { app_id: "app123", role: "moderators", confirm: true });
    await run("cometchat_delete_moderation_list", { app_id: "app123", list_id: "bad-words", confirm: true });
    await run("cometchat_delete_moderation_rule", { app_id: "app123", rule_id: "my-rule", confirm: true });
    expect(writesSince(from).map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE ${REST}/webhooks/hook1`,
      `DELETE ${REST}/roles/moderators`,
      `DELETE /apps/app123/moderation/keywords/bad-words`,
      `DELETE /apps/app123/moderation/rules/my-rule`,
    ]);
  });

  it("refuses built-in or unknown roles, lists and rules before any change", async () => {
    const from = state.calls.length;
    expect((await failure("cometchat_delete_role", { app_id: "app123", role: "default", confirm: true })).message).toMatch(/built-in default role/);
    expect((await failure("cometchat_delete_moderation_list", { app_id: "app123", list_id: "profanity-list", confirm: true })).message).toMatch(/built-in moderation list/);
    expect((await failure("cometchat_delete_moderation_rule", { app_id: "app123", rule_id: "profanity", confirm: true })).message).toMatch(/built-in moderation rule/);
    expect((await failure("cometchat_delete_moderation_rule", { app_id: "app123", rule_id: "nope", confirm: true })).message).toMatch(/no moderation rule nope/);
    expect(writesSince(from)).toEqual([]);
  });

  it("deletes a push provider only after finding it, since the API reports success for any id", async () => {
    state.deletedProviders.clear();
    const from = state.calls.length;
    expect(await run("cometchat_delete_push_provider", { app_id: "app123", kind: "fcm", provider_id: "android", confirm: true })).toEqual({ app_id: "app123", kind: "fcm", provider_id: "android", deleted: true });
    expect((await failure("cometchat_delete_push_provider", { app_id: "app123", kind: "apns", provider_id: "android", confirm: true })).message).toMatch(/no APNS provider android/);
    expect(writesSince(from)).toEqual([{ method: "DELETE", path: `${REST}/notifications/push/v1/providers/fcm/android`, body: undefined }]);
    state.deletedProviders.clear();
  });

  it("says so when CometChat answers OK but the push provider is still there", async () => {
    state.ignorePushDeletes = true;
    try {
      const err = await failure("cometchat_delete_push_provider", { app_id: "app123", kind: "fcm", provider_id: "android", confirm: true });
      expect(err.message).toMatch(/still set up/);
    } finally {
      state.ignorePushDeletes = false;
    }
  });

  it("reports a 'permanent' delete that left the user or message readable", async () => {
    // The mock still serves cometchat-uid-1 after the DELETE, like a delete that only deactivated.
    const out = await run("cometchat_delete_users", { app_id: "app123", uids: ["u-3", "cometchat-uid-1"], confirm: true });
    expect(out.deleted).toEqual(["u-3"]);
    expect(out.failed).toEqual([{ id: "cometchat-uid-1", error: expect.stringContaining("still exists") }]);
  });

  it("keeps the users already deleted when the sign-in ends part-way", async () => {
    const s = makeSession({ client: new DashboardClient({ apiHost: mock.url, token: DASH_TOKEN }) });
    const orig = s.client.chatApi.bind(s.client);
    let n = 0;
    s.client.chatApi = (async (...args: Parameters<typeof orig>) => {
      if (args[1] === "DELETE" && n++ === 1) state.tokenRevoked = true;
      try {
        return await orig(...args);
      } finally {
        if (args[1] === "DELETE" && n === 2) state.tokenRevoked = false;
      }
    }) as typeof s.client.chatApi;
    const from = state.calls.length;
    const err = await failure("cometchat_delete_users", { app_id: "app123", uids: ["u-4", "u-5", "u-6"], confirm: true }, s);
    expect(err.message).toMatch(/Deleted u-4, then the CometChat sign-in ended before u-5/);
    expect(writesSince(from).map((c) => c.path)).toEqual([`${REST}/users/u-4`, `${REST}/users/u-5`]);
  });

  it("reports a permanent message delete that left the message stored", async () => {
    const err = await failure("cometchat_delete_message", { app_id: "app123", message_id: "77", permanent: true, confirm: true });
    expect(err.message).toMatch(/still stored/);
    // A soft delete expects the message to stay readable, so it succeeds.
    expect(await run("cometchat_delete_message", { app_id: "app123", message_id: "77", confirm: true })).toMatchObject({ permanent: false, deleted: true });
  });

  it("treats a push provider delete as done when the read-back fails", async () => {
    state.deletedProviders.clear();
    const s = makeSession({ client: new DashboardClient({ apiHost: mock.url, token: DASH_TOKEN }) });
    const orig = s.client.chatApi.bind(s.client);
    let deleted = false;
    s.client.chatApi = (async (...args: Parameters<typeof orig>) => {
      if (deleted && args[1] === "GET") throw new Error("read failed");
      if (args[1] === "DELETE") deleted = true;
      return orig(...args);
    }) as typeof s.client.chatApi;
    expect(await run("cometchat_delete_push_provider", { app_id: "app123", kind: "fcm", provider_id: "android", confirm: true }, s)).toMatchObject({ deleted: true });
    state.deletedProviders.clear();
  });

  it("never lets an auth token leave its path (. and .. are path segments)", async () => {
    const from = state.calls.length;
    for (const t of [".", "..", "...", "a/../b", "%2e%2e"]) {
      expect((await failure("cometchat_revoke_auth_tokens", { app_id: "app123", uid: "cometchat-uid-1", auth_token: t, confirm: true })).code, t).toBe("invalid_input");
    }
    expect(writesSince(from)).toEqual([]);
  });
});

describe("delete tool safety", () => {
  it("does nothing without confirm on a local connection", async () => {
    const from = state.calls.length;
    const err = await failure("cometchat_delete_group", { app_id: "app123", guid: "team" });
    expect(err.code).toBe("confirmation_required");
    expect(err.message).toMatch(/Delete group team .* can't be undone/);
    expect(writesSince(from)).toEqual([]);
  });

  it("needs the user's browser approval on the hosted server; confirm alone is not enough", async () => {
    const secret = testSecret("delete-approvals");
    const hosted = makeSession({ local: false, approvals: new ApprovalService({ sealer: new Sealer(secret), secret, publicUrl: "http://localhost" }) });
    const from = state.calls.length;
    for (const [name, args] of [
      ["cometchat_delete_users", { app_id: "app123", uids: ["u-1"] }],
      ["cometchat_delete_message", { app_id: "app123", message_id: "7", permanent: true }],
      ["cometchat_delete_push_provider", { app_id: "app123", kind: "fcm", provider_id: "android" }],
    ] as const) {
      const err = await failure(name, { ...args, confirm: true }, hosted);
      expect(err.code, name).toBe("approval_required");
      expect(JSON.stringify(err)).toContain("http://localhost/oauth/cometchat/approve?r=");
      expect((await failure(name, { ...args, approval_code: "ABCD-EFGH" }, hosted)).code, name).toBe("approval_required");
    }
    expect(writesSince(from)).toEqual([]);
    // Revoking tokens only logs a user out: confirm is enough there.
    expect(await run("cometchat_revoke_auth_tokens", { app_id: "app123", uid: "cometchat-uid-1", confirm: true }, hosted)).toMatchObject({ revoked: "all" });
  });

  it("refuses every delete on a read-only connection", async () => {
    const ro = makeSession({ readOnly: true });
    for (const name of DELETE_TOOLS) expect((await failure(name, { app_id: "app123", confirm: true }, ro)).code, name).toBe("forbidden");
  });

  it("audits ids and the permanent flag, never the API key or token", async () => {
    const lines: Record<string, unknown>[] = [];
    const spy = vi.spyOn(logger, "info").mockImplementation(((o: unknown) => void lines.push(o as Record<string, unknown>)) as never);
    try {
      await run("cometchat_delete_message", { app_id: "app123", message_id: "12005", permanent: true, confirm: true });
      await run("cometchat_revoke_auth_tokens", { app_id: "app123", uid: "cometchat-uid-1", auth_token: "cometchat-uid-1_secret99", confirm: true });
      await failure("cometchat_delete_api_key", { app_id: "app123", api_key: "abcdef0123456789wxyz", confirm: false });
    } finally {
      spy.mockRestore();
    }
    const audit = lines.filter((l) => l.audit === "dashboard_tool");
    expect(audit[0]).toMatchObject({ tool: "cometchat_delete_message", target: { message_id: "12005", permanent: true }, outcome: "success" });
    expect(audit[1]).toMatchObject({ tool: "cometchat_revoke_auth_tokens", target: { uid: "cometchat-uid-1" } });
    expect(JSON.stringify(audit)).not.toContain("secret99");
    expect(JSON.stringify(audit)).not.toContain("abcdef0123456789wxyz");
  });
});
