import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv from "ajv";
import { DashboardClient } from "../src/dashboard/client.js";
import {
  ALL_DASHBOARD_TOOLS, READ_SCOPE, WRITE_SCOPE, resetWriteLimits, runDashboardTool, visibleDashboardTools, type DashboardSession,
} from "../src/tools/dashboard/index.js";
import { asStructured } from "../src/lib/errors.js";
import { logger } from "../src/lib/logger.js";
import { startDashboardMock, DASH_TOKEN, type MockState } from "./dashboard-mock.js";

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
async function run(name: string, args: Record<string, unknown> = {}, s = session) {
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
  throw new Error("expected the tool to fail");
}

beforeAll(async () => {
  mock = await startDashboardMock();
  state = mock.state;
  session = makeSession();
});
afterAll(() => mock.close());
beforeEach(() => resetWriteLimits());

describe("tool definitions", () => {
  it("unique cometchat_ names, valid schemas, annotations and a confirm arg on confirm tools", () => {
    const names = ALL_DASHBOARD_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(38);
    for (const t of ALL_DASHBOARD_TOOLS) {
      expect(t.name).toMatch(/^cometchat_[a-z_]+$/);
      ajv.compile(t.inputSchema);
      ajv.compile(t.outputSchema);
      expect(t.description.length).toBeGreaterThan(40);
      if (t.confirm) {
        expect(t.access).toBe("write");
        expect((t.inputSchema.properties as Record<string, unknown>).confirm).toBeDefined();
        expect(typeof t.describe).toBe("function");
      }
    }
    for (const d of visibleDashboardTools(session)) expect(d.annotations.readOnlyHint).toBe(ALL_DASHBOARD_TOOLS.find((t) => t.name === d.name)!.access === "read");
  });
});

describe("policy", () => {
  it("read-only scope: only read tools are listed; writes are forbidden", async () => {
    const ro = makeSession({ scopes: new Set([READ_SCOPE]) });
    const visible = visibleDashboardTools(ro).map((t) => t.name);
    expect(visible).toContain("cometchat_list_apps");
    expect(visible).not.toContain("cometchat_create_app");
    expect((await failure("cometchat_create_app", { name: "x", region: "us" }, ro)).code).toBe("forbidden");
  });

  it("read-only server switch overrides a write scope", async () => {
    const ro = makeSession({ readOnly: true });
    expect(visibleDashboardTools(ro).some((t) => t.annotations.readOnlyHint === false)).toBe(false);
    expect((await failure("cometchat_create_users", { app_id: "app123", users: [{ uid: "z", name: "Z" }] }, ro)).message).toMatch(/read-only/);
  });

  it("local-only tools are hidden and refused on the hosted server", async () => {
    const hosted = makeSession({ local: false });
    expect(visibleDashboardTools(hosted).map((t) => t.name)).not.toContain("cometchat_add_fcm_provider");
    expect((await failure("cometchat_add_fcm_provider", { app_id: "app123", provider_id: "p", service_account_file: "/x.json", confirm: true }, hosted)).message).toMatch(/local connection/);
  });

  it("confirm tools do nothing without confirm: true and return a summary", async () => {
    const before = state.calls.length;
    const r = await failure("cometchat_update_app_settings", { app_id: "app123", settings: { "core.notifications.push.enabled": true } });
    expect(r.code).toBe("confirmation_required");
    expect(r.message).toContain("core.notifications.push.enabled → true");
    expect(state.calls.length).toBe(before); // nothing reached the API
  });

  it("rate-limits account changes per actor", async () => {
    const limited = makeSession({ writesPerMinute: 2, actor: "busy" });
    await run("cometchat_create_role", { app_id: "app123", role: "r1", name: "R1" }, limited);
    await run("cometchat_create_role", { app_id: "app123", role: "r2", name: "R2" }, limited);
    const r = await failure("cometchat_create_role", { app_id: "app123", role: "r3", name: "R3" }, limited);
    expect(r.code).toBe("rate_limited");
    await run("cometchat_list_roles", { app_id: "app123" }, limited); // reads aren't limited
  });

  it("writes one audit record per call with no argument values except the app id", async () => {
    const spy = vi.spyOn(logger, "info");
    await failure("cometchat_create_api_key", { app_id: "app123", name: "secret-name", scope: "fullAccess" });
    const audit = spy.mock.calls.map((c) => c[0] as Record<string, unknown>).find((x) => x?.audit === "dashboard_tool");
    spy.mockRestore();
    expect(audit).toMatchObject({ tool: "cometchat_create_api_key", access: "write", app_id: "app123", outcome: "confirmation_required", actor: "test-actor" });
    expect(JSON.stringify(audit)).not.toContain("secret-name");
  });
});

describe("account tools", () => {
  it("whoami, apps, credentials", async () => {
    expect(await run("cometchat_whoami")).toEqual({ signed_in: true, name: "Dev User", email: "dev@example.com" });
    expect(await run("cometchat_list_apps")).toMatchObject({ total: 1, apps: [{ app_id: "app123", product: "chat-messaging" }] });
    const c = await run("cometchat_get_app_credentials", { app_id: "app123" });
    expect(c).toMatchObject({ app_id: "app123", auth_key: "authkey123" });
    expect(c.env.nextjs).toContain("NEXT_PUBLIC_COMETCHAT_APP_ID=app123");
  });

  it("create app validates and posts the onboarding shape", async () => {
    expect((await failure("cometchat_create_app", { name: "X", region: "mars" })).code).toBe("invalid_input");
    expect(await run("cometchat_create_app", { name: "My App", region: "eu" })).toMatchObject({ app_id: "new456", region: "eu" });
    expect(state.calls.find((c) => c.method === "POST" && c.path === "/apps")!.body).toMatchObject({ metadata: { technology: "mcp" } });
  });

  it("features: list, toggle with confirmation readback, refusal and unconfirmed success", async () => {
    const f = await run("cometchat_list_features", { app_id: "app123" });
    expect(f.extensions.map((e: any) => e.id)).toEqual(["broken", "ghost", "polls", "reactions"]);
    // Changing a live app's features needs the user's OK first: no request without confirm.
    expect(await failure("cometchat_set_feature", { app_id: "app123", feature_id: "polls", enabled: false })).toMatchObject({ code: "confirmation_required" });
    expect(await run("cometchat_set_feature", { app_id: "app123", feature_id: "polls", enabled: true, confirm: true })).toMatchObject({ kind: "extension", confirmed: true });
    expect(await failure("cometchat_set_feature", { app_id: "app123", feature_id: "broken", enabled: true, confirm: true })).toMatchObject({ code: "dashboard_error", message: "Not available on your plan." });
    expect(await run("cometchat_set_feature", { app_id: "app123", feature_id: "ghost", enabled: true, confirm: true })).toMatchObject({ confirmed: false });
    // A disabled extension keeps its row (enabled: 0, isActive: true). It must read as off,
    // and turning one off must read back as confirmed.
    expect(await run("cometchat_set_feature", { app_id: "app123", feature_id: "reactions", enabled: false, confirm: true })).toMatchObject({ enabled: false, confirmed: true });
    const after = await run("cometchat_list_features", { app_id: "app123" });
    expect(after.extensions.find((e: any) => e.id === "reactions")).toMatchObject({ enabled: false });
  });

  it("AI features need an OpenAI key; the key is never echoed", async () => {
    expect((await failure("cometchat_set_feature", { app_id: "app123", feature_id: "smart-replies", enabled: true, confirm: true })).message).toMatch(/OpenAI key/);
    const key = "sk-" + "a".repeat(40);
    const out = await run("cometchat_set_openai_key", { app_id: "app123", openai_key: key, confirm: true });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(await run("cometchat_set_feature", { app_id: "app123", feature_id: "smart-replies", enabled: true, confirm: true })).toMatchObject({ kind: "ai_feature" });
  });

  it("maps dashboard errors to structured codes", async () => {
    expect((await failure("cometchat_get_app_credentials", { app_id: "missing" })).code).toBe("dashboard_error");
    expect((await failure("cometchat_list_apps", {}, makeSession({ client: new DashboardClient({ apiHost: mock.url, token: "expired" }) }))).code).toBe("unauthorized");
    expect((await failure("cometchat_list_apps", {}, makeSession({ client: new DashboardClient({ apiHost: "http://127.0.0.1:1", token: DASH_TOKEN }) }))).code).toBe("backend_unavailable");
    expect((await failure("cometchat_get_app_credentials", { app_id: "../etc" })).code).toBe("invalid_input");
  });
});

describe("project tools", () => {
  it("API keys are listed with their values and created only with confirmation", async () => {
    const listed = await run("cometchat_list_api_keys", { app_id: "app123" });
    expect(listed.masked).toBe(false);
    expect(listed.keys).toEqual([
      { name: "Default", scope: "fullAccess", api_key: "abcdef0123456789wxyz", created_at: 1700000000 },
      { name: "Extra Auth Key", scope: "authOnly", api_key: "authkey-extra", created_at: 1700000500 },
      { name: "Auth Key", scope: "authOnly", api_key: "authkey123", created_at: 1700000000 },
    ]);
    expect(await run("cometchat_create_api_key", { app_id: "app123", name: "data-import", scope: "fullAccess", confirm: true })).toMatchObject({ api_key: "newkey9999" });
  });

  it("a read-only connection gets API keys masked (read scope only, or the read-only switch)", async () => {
    for (const ro of [makeSession({ scopes: new Set([READ_SCOPE]) }), makeSession({ readOnly: true })]) {
      const listed = await run("cometchat_list_api_keys", { app_id: "app123" }, ro);
      expect(listed.masked).toBe(true);
      expect(listed.keys).toEqual([
        { name: "Default", scope: "fullAccess", api_key: "••••••••wxyz", created_at: 1700000000 },
        { name: "Extra Auth Key", scope: "authOnly", api_key: "••••••••xtra", created_at: 1700000500 },
        { name: "Auth Key", scope: "authOnly", api_key: "••••••••y123", created_at: 1700000000 },
      ]);
      expect(JSON.stringify(listed)).not.toContain("abcdef0123456789");
    }
  });

  it("webhooks: triggers, list, create (HTTPS only)", async () => {
    expect((await run("cometchat_list_webhook_triggers", { app_id: "app123" })).triggers[0].id).toBe("after_message");
    expect((await run("cometchat_list_webhooks", { app_id: "app123" })).webhooks).toHaveLength(1);
    expect(await run("cometchat_create_webhook", { app_id: "app123", id: "backend-sync", name: "B", url: "https://api.example.com/cc", triggers: ["after_message"], username: "u", password: "p", confirm: true })).toMatchObject({ basic_auth: true });
    expect(state.calls.find((c) => c.path.endsWith("/webhooks/backend-sync/triggers"))!.body).toEqual({ triggerIds: ["after_message"] });
    expect((await failure("cometchat_create_webhook", { app_id: "app123", id: "h", name: "n", url: "http://plain", triggers: ["x"], confirm: true })).code).toBe("invalid_input");
  });

  it("settings: read and update only the given keys", async () => {
    expect((await run("cometchat_get_app_settings", { app_id: "app123" })).settings).toHaveProperty("core.notifications.push.enabled");
    await run("cometchat_update_app_settings", { app_id: "app123", settings: { "core.notifications.push.enabled": true }, confirm: true });
    expect(state.settings["core.notifications.push.enabled"]).toBe(true);
    expect((await failure("cometchat_update_app_settings", { app_id: "app123", settings: { k: { nested: 1 } }, confirm: true })).code).toBe("invalid_input");
  });
});

describe("users, groups and messages", () => {
  it("lists users with pagination, gets and updates a user", async () => {
    expect(await run("cometchat_list_users", { app_id: "app123", search: "andrew" })).toMatchObject({ users: [{ uid: "cometchat-uid-1" }], page: 1, total: 1, has_more: false });
    expect(state.calls.at(-1)!.path).toBe("/apps/app123/chat-api/v3.0/users");
    expect((await run("cometchat_get_user", { app_id: "app123", uid: "cometchat-uid-1" })).user.name).toBe("Andrew");
    expect((await run("cometchat_update_user", { app_id: "app123", uid: "cometchat-uid-1", role: "admin", confirm: true })).user.role).toBe("admin");
    expect((await failure("cometchat_update_user", { app_id: "app123", uid: "cometchat-uid-1", confirm: true })).code).toBe("invalid_input");
  });

  it("creates users (reporting existing ones) and deactivates/reactivates", async () => {
    const out = await run("cometchat_create_users", { app_id: "app123", users: [{ uid: "alice", name: "Alice" }, { uid: "cometchat-uid-1", name: "A" }, { uid: "bad uid!", name: "X" }] });
    expect(out.results.map((r: any) => r.status)).toEqual(["created", "exists", "failed"]);
    await run("cometchat_set_users_active", { app_id: "app123", uids: ["alice"], active: false, confirm: true });
    expect(state.calls.at(-1)).toMatchObject({ method: "DELETE", body: { permanent: false } });
    await run("cometchat_set_users_active", { app_id: "app123", uids: ["alice"], active: true, confirm: true });
    expect(state.calls.at(-1)).toMatchObject({ method: "PUT", body: { uidsToActivate: ["alice"] } });
  });

  it("groups: list, create, members, add, remove; auth token", async () => {
    expect((await run("cometchat_list_groups", { app_id: "app123", type: "public" })).groups[0]).toMatchObject({ guid: "team", members_count: 3 });
    expect(await run("cometchat_create_group", { app_id: "app123", guid: "team2", name: "T2", type: "public", members: ["alice"] })).toMatchObject({ members_added: 1 });
    expect((await run("cometchat_list_group_members", { app_id: "app123", guid: "team" })).members[0]).toMatchObject({ uid: "cometchat-uid-1", scope: "admin" });
    expect(await run("cometchat_add_group_members", { app_id: "app123", guid: "team", moderators: ["alice"], confirm: true })).toMatchObject({ added: 1 });
    expect(await run("cometchat_remove_group_member", { app_id: "app123", guid: "team", uid: "alice", confirm: true })).toEqual({ app_id: "app123", guid: "team", uid: "alice", removed: true });
    expect(await failure("cometchat_create_auth_token", { app_id: "app123", uid: "cometchat-uid-1" })).toMatchObject({ code: "confirmation_required" });
    expect((await run("cometchat_create_auth_token", { app_id: "app123", uid: "cometchat-uid-1", confirm: true })).auth_token).toBe("tok_abc");
  });

  it("conversations and messages truncate message text", async () => {
    const conv = await run("cometchat_list_conversations", { app_id: "app123" });
    expect(conv.conversations[0].last_message.text.length).toBeLessThanOrEqual(501);
    const msgs = await run("cometchat_list_messages", { app_id: "app123", conversation_id: "a_user_b", limit: 5 });
    expect(msgs).toMatchObject({ count: 1, messages: [{ id: "9", sender: "a" }] });
    expect((await failure("cometchat_list_messages", { app_id: "app123", conversation_id: "bad id with spaces" })).code).toBe("invalid_input");
  });
});

describe("operations", () => {
  it("usage summarises each metric and reports per-metric errors", async () => {
    const u = await run("cometchat_get_usage", { app_id: "app123", days: 7, metrics: ["mau", "pcc", "voice", "dcu"] });
    const by = Object.fromEntries(u.metrics.map((m: any) => [m.metric, m]));
    expect(by.mau).toMatchObject({ summary: 12, summary_kind: "latest" });
    expect(by.pcc).toMatchObject({ summary: 7, summary_kind: "max" });
    expect(by.voice).toMatchObject({ summary: 3.5, summary_kind: "sum" });
    expect(by.dcu.error).toBeDefined(); // the mock has no dcu endpoint
    expect((await failure("cometchat_get_usage", { app_id: "app123", days: 400 })).code).toBe("invalid_input");
  });

  it("usage makes at most one dashboard request per known metric", async () => {
    const before = state.calls.length;
    const u = await run("cometchat_get_usage", { app_id: "app123", days: 7, metrics: ["mau", "mau", "mau", "pcc"] });
    expect(u.metrics.map((m: any) => m.metric)).toEqual(["mau", "pcc"]);
    expect(state.calls.slice(before).filter((c) => c.path.includes("/metrics/")).length).toBe(2);
    for (const bad of [["toString"], ["constructor"], ["__proto__"], Array(1000).fill("mau")]) {
      const n = state.calls.length;
      expect((await failure("cometchat_get_usage", { app_id: "app123", metrics: bad })).code).toBe("invalid_input");
      expect(state.calls.length).toBe(n); // refused before any request
    }
  });

  it("plan: name resolved from the catalog; missing invoices are an empty list", async () => {
    expect(await run("cometchat_get_plan", { app_id: "app123" })).toEqual({ app_id: "app123", plan: "build", plan_name: "Build", state: "active", trial_ends_at: 99, invoices: [] });
  });

  it("moderation: rules, toggle, lists, create list, flagged messages", async () => {
    expect((await run("cometchat_list_moderation_rules", { app_id: "app123" })).rules[0]).toMatchObject({ id: "profanity", enabled: true, actions: ["block"] });
    expect(await run("cometchat_set_moderation_rule", { app_id: "app123", rule_id: "profanity", enabled: false, confirm: true })).toMatchObject({ enabled: false });
    expect((await run("cometchat_list_moderation_lists", { app_id: "app123" })).lists[0]).toMatchObject({ id: "bad-words", terms: 2 });
    expect(await run("cometchat_create_moderation_list", { app_id: "app123", id: "spam", name: "Spam", keywords: ["buy now", "buy now", " free "] })).toMatchObject({ keywords: 2 });
    expect(state.calls.at(-1)!.body).toMatchObject({ category: "word", searchTerms: ["buy now", "free"] });
    expect((await run("cometchat_list_flagged_messages", { app_id: "app123" })).messages[0]).toMatchObject({ id: "9", reason: "spam" });
  });

  it("push setup never returns provider secrets; FCM upload reads a local file", async () => {
    const p = await run("cometchat_get_push_setup", { app_id: "app123" });
    expect(p.fcm).toEqual([{ provider_id: "android", project_id: "proj-1", default: true }]);
    expect(JSON.stringify(p)).not.toContain("SECRET-KEY");
    const dir = mkdtempSync(path.join(tmpdir(), "fcm-"));
    const file = path.join(dir, "sa.json");
    writeFileSync(file, JSON.stringify({ type: "service_account", project_id: "proj-2", client_email: "x@y.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n", private_key_id: "kid" }));
    const DEFAULTS = { ios: { chat: true, call: true }, android: { chat: false, call: false }, web: { chat: false, call: false } };
    const out = await run("cometchat_add_fcm_provider", { app_id: "app123", provider_id: "android-prod", service_account_file: file, confirm: true });
    expect(out).toEqual({ app_id: "app123", provider_id: "android-prod", project_id: "proj-2", notification_in_payload: DEFAULTS });
    expect(JSON.stringify(out)).not.toContain("PRIVATE KEY");
    const post = state.calls.filter((c) => c.method === "POST" && c.path.endsWith("/providers/dashboard/fcm")).at(-1)!;
    // notificationInPayload is required by CometChat; without it every add failed with a 400.
    expect(post.body).toMatchObject({ providerId: "android-prod", serviceAccountFilename: "sa.json", serviceAccountCreds: { project_id: "proj-2" }, notificationInPayload: DEFAULTS });
    // Read back: get_push_setup now lists it.
    expect((await run("cometchat_get_push_setup", { app_id: "app123" })).fcm.map((f: { provider_id: string }) => f.provider_id)).toContain("android-prod");
    // Overrides merge with the defaults.
    const custom = await run("cometchat_add_fcm_provider", { app_id: "app123", provider_id: "android-2", service_account_file: file, notification_in_payload: { android: { chat: true } }, confirm: true });
    expect(custom.notification_in_payload).toEqual({ ...DEFAULTS, android: { chat: true, call: false } });
    // A taken id or a bad flag is refused before anything is sent.
    const before = state.calls.filter((c) => c.method === "POST").length;
    expect((await failure("cometchat_add_fcm_provider", { app_id: "app123", provider_id: "android-prod", service_account_file: file, confirm: true })).message).toMatch(/already an FCM provider/);
    expect((await failure("cometchat_add_fcm_provider", { app_id: "app123", provider_id: "x1", service_account_file: file, notification_in_payload: { ios: { chat: "yes" } }, confirm: true })).message).toMatch(/ios.chat must be true or false/);
    expect((await failure("cometchat_add_fcm_provider", { app_id: "app123", provider_id: "x2", service_account_file: file, notification_in_payload: { windows: {} }, confirm: true })).message).toMatch(/unknown platform/);
    expect(state.calls.filter((c) => c.method === "POST").length).toBe(before);
    writeFileSync(file, JSON.stringify({ type: "authorized_user" }));
    expect((await failure("cometchat_add_fcm_provider", { app_id: "app123", provider_id: "p", service_account_file: file, confirm: true })).code).toBe("invalid_input");
  });

  it("roles, team, invite and call logs", async () => {
    expect((await run("cometchat_list_roles", { app_id: "app123" })).roles[0].role).toBe("default");
    expect(await run("cometchat_create_role", { app_id: "app123", role: "vip", name: "VIP" })).toEqual({ app_id: "app123", role: "vip", name: "VIP" });
    expect((await run("cometchat_list_team", { app_id: "app123" })).members[0]).toMatchObject({ email: "dev@example.com", role: "owner" });
    expect(await run("cometchat_invite_team_member", { app_id: "app123", email: "New@Example.com", role: "developer", confirm: true })).toEqual({ app_id: "app123", email: "new@example.com", role: "developer" });
    expect(state.calls.at(-1)!.body).toEqual({ developers: ["new@example.com"] });
    expect((await failure("cometchat_invite_team_member", { app_id: "app123", email: "nope", role: "admin", confirm: true })).code).toBe("invalid_input");
    expect((await run("cometchat_list_call_logs", { app_id: "app123" })).calls[0]).toMatchObject({ session_id: "s1", video_minutes: 1.5, participants: 2 });
  });
});

describe("partial failures are reported, not hidden", () => {
  it("deactivation reports which users changed and which didn't", async () => {
    const r = await run("cometchat_set_users_active", { app_id: "app123", uids: ["alice", "missing-user", "bob"], active: false, confirm: true });
    expect(r).toMatchObject({ uids: ["alice", "bob"], active: false });
    expect(r.failed).toEqual([{ uid: "missing-user", error: expect.stringContaining("does not exist") }]);
    expect((await failure("cometchat_set_users_active", { app_id: "app123", uids: ["missing-user"], active: false, confirm: true })).message).toMatch(/No users were deactivated/);
  });

  it("create_webhook refuses unknown triggers before creating anything, and reports what was attached", async () => {
    const before = state.calls.filter((c) => c.method === "POST").length;
    const f = await failure("cometchat_create_webhook", { app_id: "app123", id: "typo-hook", name: "N", url: "https://api.example.com/cc", triggers: ["after_message", "nope"], confirm: true });
    expect(f.code).toBe("invalid_input");
    expect(f.message).toMatch(/unknown trigger id nope/);
    expect(state.calls.filter((c) => c.method === "POST").length).toBe(before);
    const ok = await run("cometchat_create_webhook", { app_id: "app123", id: "good-hook", name: "N", url: "https://api.example.com/cc", triggers: ["after_message"], confirm: true });
    expect(ok.triggers).toEqual(["after_message"]);
    expect(state.calls.some((c) => c.method === "GET" && c.path.endsWith("/webhooks/good-hook/triggers"))).toBe(true);
  });

  it("list_webhooks shows each webhook's triggers", async () => {
    const r = await run("cometchat_list_webhooks", { app_id: "app123" });
    expect(r.webhooks[0]).toMatchObject({ id: "hook1", triggers: ["after_message"] });
  });

  it("a webhook whose triggers fail says it exists but listens to nothing", async () => {
    const f = await failure("cometchat_create_webhook", { app_id: "app123", id: "no-triggers", name: "N", url: "https://api.example.com/cc", triggers: ["after_message"], confirm: true });
    expect(f.message).toMatch(/Webhook no-triggers was created but its triggers couldn't be added/);
  });

  it("conversation ids can't contain dot segments", async () => {
    for (const bad of ["..", "a..b", "."]) {
      expect((await failure("cometchat_list_messages", { app_id: "app123", conversation_id: bad })).code).toBe("invalid_input");
    }
  });
});
