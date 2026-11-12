// A tiny stand-in for the CometChat dashboard API (apimgmt), shared by the
// dashboard tests. Loopback only.
import http from "node:http";
import type { AddressInfo } from "node:net";

export const DASH_TOKEN = "dash-token-123";
/** Session id the mock gives a browser-bound sign-in (one that sends metadata.returnUrl). */
export const BB_SESSION = "b".repeat(64);
/** The one-time verifier the mock dashboard hands the browser that allowed the sign-in. */
export const BB_VERIFIER = "c".repeat(64);

/**
 * The dashboard sent the browser back after the user allowed the sign-in:
 * GET the callback the way that browser would (with its sign-in cookie).
 */
export async function callbackFromDashboard(base: string, cookie: string | undefined, extra: { sessionId?: string; verifier?: string; headers?: Record<string, string>; path?: string } = {}) {
  // Like the dashboard: back to the return URL the server gave this sign-in.
  const returnUrl = lastState?.sessionMetadata?.returnUrl as string | undefined;
  const u = new URL(`${base}${extra.path ?? (returnUrl ? new URL(returnUrl).pathname : "/oauth/cometchat/callback/missing")}`);
  u.searchParams.set("sessionId", extra.sessionId ?? BB_SESSION);
  u.searchParams.set("verifier", extra.verifier ?? BB_VERIFIER);
  const res = await fetch(u, { redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...(extra.headers ?? {}) } });
  return { res, location: res.headers.get("location") ?? undefined, setCookie: res.headers.get("set-cookie") ?? undefined };
}

/** `name=value` of the first Set-Cookie, as a browser would send it back. */
export const cookiePairOf = (setCookie: string | null | undefined) => (setCookie ?? "").split(";")[0]!;

export interface MockState {
  authorized: boolean;
  openAIKey: string;
  calls: Array<{ method: string; path: string; body: unknown }>;
  extensionsOn: Set<string>;
  /** Extensions that have a row on the app (on or off). */
  extensionsKnown: Set<string>;
  users: Set<string>;
  settings: Record<string, unknown>;
  /** The dashboard has ended this token (password change, logout): every call → 401. */
  tokenRevoked: boolean;
  /** metadata the last /cli-auth/session request sent. */
  sessionMetadata?: Record<string, unknown>;
  /** The user declined the sign-in on the dashboard. */
  denied?: boolean;
  /** The browser-bound session's token has been collected (single use). */
  bbUsed?: boolean;
  /** The sign-in response omits the email (it then has to come from /me). */
  omitSignInEmail: boolean;
  /** The email the sign-in response carries (default dev@example.com). */
  signInEmail?: string;
  /** Push providers deleted so far (they drop out of the provider lists). */
  deletedProviders: Set<string>;
  /** Like a delete that answers OK but changes nothing. */
  ignorePushDeletes: boolean;
  /** FCM providers added through the API (id → stored provider). */
  fcmAdded: Map<string, Record<string, unknown>>;
  /** Trigger ids attached to each webhook. */
  webhookTriggers: Map<string, string[]>;
  /** Moderation lists and rules deleted so far (`keywords/<id>`, `rules/<id>`). */
  deletedModeration: Set<string>;
}

let lastState: MockState | undefined;

export async function startDashboardMock(): Promise<{ url: string; state: MockState; close: () => Promise<void> }> {
  const state: MockState = {
    authorized: false,
    openAIKey: "",
    calls: [],
    extensionsOn: new Set(["reactions"]),
    extensionsKnown: new Set(["reactions", "polls"]), // polls has a row but is off
    users: new Set(["cometchat-uid-1"]),
    settings: { "core.notifications.push.enabled": false },
    tokenRevoked: false,
    omitSignInEmail: false,
    deletedProviders: new Set(),
    ignorePushDeletes: false,
    fcmAdded: new Map(),
    webhookTriggers: new Map(),
    deletedModeration: new Set(),
  };
  lastState = state;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = raw ? JSON.parse(raw) : undefined;
      state.calls.push({ method: req.method ?? "", path: url.pathname, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const p = url.pathname;
      if (req.method === "POST" && p === "/cli-auth/session") {
        state.sessionMetadata = body?.metadata;
        state.bbUsed = false;
        return send(200, { data: { sessionId: body?.metadata?.returnUrl ? BB_SESSION : "sess-1" } });
      }
      if (req.method === "GET" && p === "/cli-auth/session/authenticate") {
        const sid = req.headers.sessionid;
        if (sid !== "sess-1" && sid !== BB_SESSION) return send(404, { error: { code: "ERR_SESSION_NOT_FOUND" } });
        if (state.denied) return send(403, { error: { code: "ERR_SESSION_DENIED" } });
        // Like mgmt-api: a browser-bound session is only collected with its verifier, and only once.
        if (state.authorized && sid === BB_SESSION && req.headers.verifier !== BB_VERIFIER) return send(403, { error: { code: "ERR_SESSION_VERIFIER_INVALID" } });
        if (state.authorized && sid === BB_SESSION && state.bbUsed) return send(400, { error: { code: "ERR_SESSION_ALREADY_AUTHENTICATED" } });
        if (state.authorized && sid === BB_SESSION) state.bbUsed = true;
        return state.authorized
          ? send(200, { data: { token: DASH_TOKEN, ...(state.omitSignInEmail ? {} : { email: state.signInEmail ?? "dev@example.com" }) } })
          : send(400, { error: "authorization_pending" });
      }
      if (state.tokenRevoked || req.headers.authorization !== `Bearer ${DASH_TOKEN}`) return send(401, { error: { code: "AUTH_TOKEN_INVALID", message: "bad token" } });
      if (req.method === "GET" && p === "/me") return send(200, { data: { name: "Dev User", email: "dev@example.com" } });
      if (req.method === "GET" && p === "/apps")
        return send(200, { data: [{ appId: "app123", name: "Demo", region: "us", plan: "build", createdAt: 1700000000000, metadata: { features: "chat" } }] });
      if (req.method === "POST" && p === "/apps") return send(200, { data: { appId: "new456", region: body.region, accessKey: "FULLACCESS-new" } });
      // Like the real dashboard: the app record's accessKey is a FULL-ACCESS key
      // (what the dashboard calls the REST API with), not the app's Auth Key.
      if (req.method === "GET" && p === "/apps/app123") return send(200, { data: { appId: "app123", region: "us", accessKey: "FULLACCESS-not-an-auth-key", version: "3", plan: "build", state: "active", trialEndsAt: 99 } });
      if (req.method === "GET" && p === "/apps/new456") return send(200, { data: { appId: "new456", region: "eu", accessKey: "FULLACCESS-new", version: "3" } });
      if (req.method === "GET" && p === "/apps/new456/chat-api/v3.0/apikeys")
        return send(200, { data: [{ apiKey: "ak-new", name: "Auth Key", scope: "authOnly", createdAt: 1700000001 }, { apiKey: "rest-new", name: "Rest API Key", scope: "fullAccess", createdAt: 1700000001 }] });
      if (req.method === "GET" && p === "/apps/missing") return send(404, { error: { code: "ERR_APP_NOT_FOUND", message: "App not found" } });
      if (req.method === "GET" && p === "/regions/us/extensions")
        return send(200, { data: [{ id: "polls", name: "Polls", description: "Create polls" }, { id: "reactions", name: "Reactions" }, { id: "broken", name: "Broken" }, { id: "ghost", name: "Ghost" }] });
      if (req.method === "GET" && p === "/apps/app123/extensions")
        // Like the real API: disabled rows stay (enabled: 0) and every row
        // carries the extension's global isActive flag.
        return send(200, { data: [...state.extensionsKnown].map((id) => ({ id, enabled: state.extensionsOn.has(id) ? 1 : 0, isActive: true })) });
      if (req.method === "POST" && p === "/apps/app123/extensions") {
        if ((body.enabled ?? []).includes("broken")) return send(200, { data: { enabled: { broken: { success: false, message: "Not available on your plan." } } } });
        if ((body.enabled ?? []).includes("ghost")) return send(200, { data: { enabled: { ghost: { success: true, message: "The extension ghost has been enabled successfully." } } } });
        for (const id of body.enabled ?? []) {
          state.extensionsOn.add(id);
          state.extensionsKnown.add(id);
        }
        for (const id of body.disabled ?? []) state.extensionsOn.delete(id);
        const key = body.enabled ? "enabled" : "disabled";
        const ids: string[] = body.enabled ?? body.disabled ?? [];
        return send(200, { data: { [key]: Object.fromEntries(ids.map((i) => [i, { success: true, message: `The extension ${i} has been ${key} successfully.` }])) } });
      }
      if (req.method === "GET" && p === "/apps/app123/ai/settings") return send(200, { data: { openAIKey: state.openAIKey, model: "gpt" } });
      if (req.method === "PUT" && p === "/apps/app123/ai/settings") {
        state.openAIKey = body.openAIKey;
        return send(200, { data: {} });
      }
      const REST = "/apps/app123/chat-api/v3.0";
      if (req.method === "GET" && p === `${REST}/apikeys`)
        return send(200, {
          data: [
            { apiKey: "abcdef0123456789wxyz", name: "Default", scope: "fullAccess", createdAt: 1700000000 },
            { apiKey: "authkey-extra", name: "Extra Auth Key", scope: "authOnly", createdAt: 1700000500 },
            { apiKey: "authkey123", name: "Auth Key", scope: "authOnly", createdAt: 1700000000 },
          ],
        });
      if (req.method === "POST" && p === `${REST}/apikeys`) return send(200, { data: { apiKey: "newkey9999", name: body.name, scope: body.scope } });
      if (req.method === "GET" && p === `${REST}/triggers`)
        return send(200, { data: [{ trigger: "after_message", name: "After message", description: "A message was sent" }] });
      if (req.method === "GET" && p === `${REST}/webhooks`) return send(200, { data: [{ id: "hook1", name: "Hook", webhookURL: "https://example.com/h", enabled: true }] });
      if (req.method === "POST" && p === `${REST}/webhooks`) return send(200, { data: body });
      // Like the real API: one result per trigger id, and unknown ids aren't attached.
      const TRIGGERS = ["after_message", "message_sent"];
      const hookTriggers = p.match(/^\/apps\/app123\/chat-api\/v3\.0\/webhooks\/([^/]+)\/triggers$/);
      if (req.method === "POST" && hookTriggers && hookTriggers[1] !== "no-triggers") {
        const ids = (body.triggerIds as string[]) ?? [];
        const ok = ids.filter((t) => TRIGGERS.includes(t));
        state.webhookTriggers.set(hookTriggers[1]!, [...(state.webhookTriggers.get(hookTriggers[1]!) ?? []), ...ok]);
        return send(200, { data: Object.fromEntries(ids.map((t) => [t, TRIGGERS.includes(t) ? { success: true, message: "Triggers has been added successfully." } : { success: false, message: "The Trigger does not exist." }])) });
      }
      if (req.method === "GET" && hookTriggers) return send(200, { data: (state.webhookTriggers.get(hookTriggers[1]!) ?? (hookTriggers[1] === "hook1" ? ["after_message"] : [])).map((id) => ({ id, category: "Message" })) });
      if (req.method === "POST" && p === `${REST}/users`) {
        if (state.users.has(body.uid)) return send(400, { error: { code: "ERR_UID_ALREADY_EXISTS", message: "exists" } });
        state.users.add(body.uid);
        return send(200, { data: { uid: body.uid, name: body.name } });
      }
      if (req.method === "POST" && p === `${REST}/users/cometchat-uid-1/auth_tokens`) return send(200, { data: { uid: "cometchat-uid-1", authToken: "tok_abc" } });
      if (req.method === "POST" && p === `${REST}/groups`) return send(200, { data: body });
      // users, groups, members, conversations, messages
      const page = (data: unknown[], total = data.length) => ({ data, meta: { pagination: { total, count: data.length, per_page: 25, current_page: 1, total_pages: 1 } } });
      if (req.method === "GET" && p === `${REST}/users`)
        return send(200, page([{ uid: "cometchat-uid-1", name: "Andrew", status: "offline", role: "default", lastActiveAt: 1, createdAt: 1 }]));
      if (req.method === "GET" && p === `${REST}/users/cometchat-uid-1`) return send(200, { data: { uid: "cometchat-uid-1", name: "Andrew", role: "default" } });
      if (req.method === "PUT" && p === `${REST}/users/cometchat-uid-1`) return send(200, { data: { uid: "cometchat-uid-1", name: body.name ?? "Andrew", role: body.role ?? "default" } });
      if (req.method === "PUT" && p === `${REST}/users`) return send(200, { data: {} });
      if (req.method === "DELETE" && p === `${REST}/users/missing-user`) return send(404, { error: { code: "ERR_UID_NOT_FOUND", message: "The UID missing-user does not exist." } });
      // deletes (shapes and error codes as checked against the live REST API)
      if (req.method === "DELETE" && p === `${REST}/users/no-tokens/auth_tokens`) return send(404, { error: { code: "ERR_AUTH_TOKENS_NOT_FOUND", message: "No auth tokens exist for UID no-tokens." } });
      if (req.method === "DELETE" && /^\/apps\/app123\/chat-api\/v3\.0\/users\/[^/]+\/auth_tokens(\/[^/]+)?$/.test(p)) return send(200, { data: { success: true } });
      if (req.method === "DELETE" && p.startsWith(`${REST}/users/`)) return send(200, { data: { success: true } });
      if (req.method === "DELETE" && p === `${REST}/groups/missing-group`) return send(404, { error: { code: "ERR_GUID_NOT_FOUND", message: "The GUID missing-group does not exist." } });
      if (req.method === "DELETE" && p.startsWith(`${REST}/groups/`) && !p.includes("/members/")) return send(200, { data: { success: true } });
      // Message 77 stays readable after a delete, like one that was only marked deleted.
      if (req.method === "GET" && p === `${REST}/messages/77`) return send(200, { data: { id: "77", sender: "a", receiver: "b", receiverType: "user", category: "message", type: "text", deletedAt: 9 } });
      if (req.method === "DELETE" && p === `${REST}/messages/404`) return send(404, { error: { code: "ERR_MESSAGE_ID_NOT_FOUND", message: "The message 404 does not exist." } });
      if (req.method === "DELETE" && /^\/apps\/app123\/chat-api\/v3\.0\/messages\/\d+$/.test(p)) return send(200, { data: { success: true } });
      if (req.method === "DELETE" && p === `${REST}/apikeys/authkey123`) return send(200, { data: { success: true } });
      if (req.method === "DELETE" && p === `${REST}/webhooks/hook1`) return send(200, { data: { success: true } });
      if (req.method === "DELETE" && p.startsWith(`${REST}/roles/`)) return send(200, { data: { success: true } });
      // Like a free-plan app: the proxy's moderation routes are plan-gated.
      if (req.method === "DELETE" && p.startsWith(`${REST}/moderation/`)) return send(403, { error: { code: "ERR_FEATURE_NOT_ACCESSIBLE", message: "rules feature is not available. To enable this feature, please upgrade your plan." } });
      // Like the real API: deleting a push provider reports success even for an id that doesn't exist.
      if (req.method === "DELETE" && p.startsWith(`${REST}/notifications/push/v1/providers/`)) {
        if (!state.ignorePushDeletes) state.deletedProviders.add(decodeURIComponent(p.split("/").pop()!));
        return send(200, { data: { success: true } });
      }
      if (req.method === "POST" && p === `${REST}/webhooks/no-triggers/triggers`) return send(400, { error: { code: "ERR_BAD_TRIGGER", message: "Unknown trigger." } });
      if (req.method === "GET" && p === `${REST}/groups`) return send(200, page([{ guid: "team", name: "Team", type: "public", membersCount: 3, owner: "cometchat-uid-1", createdAt: 1 }]));
      if (req.method === "GET" && p === `${REST}/groups/team/members`) return send(200, page([{ uid: "cometchat-uid-1", name: "Andrew", scope: "admin", joinedAt: 2 }]));
      if (req.method === "POST" && p === `${REST}/groups/team/members`) return send(200, { data: {} });
      if (req.method === "DELETE" && p === `${REST}/groups/team/members/alice`) return send(200, { data: { success: true } });
      const msg = { id: "9", conversationId: "a_user_b", sender: "a", receiver: "b", receiverType: "user", category: "message", type: "text", data: { text: "hi ".repeat(300) }, sentAt: 5 };
      if (req.method === "GET" && p === `${REST}/conversations`) return send(200, page([{ conversationId: "a_user_b", conversationType: "user", updatedAt: 5, lastMessage: msg }]));
      if (req.method === "GET" && (p === `${REST}/messages` || p === `${REST}/conversations/a_user_b/messages`)) return send(200, { data: [msg], meta: { current: { limit: 25, count: 1 } } });
      if (req.method === "GET" && p === `${REST}/moderation/flagged-messages`) return send(200, { data: [{ message: msg, reason: "spam" }], meta: {} });
      if (req.method === "GET" && p === `${REST}/notifications/push/v1/providers/dashboard/fcm`)
        return send(200, { data: { pushProviders: [{ providerId: "android", isDefault: true, serviceAccountCreds: { project_id: "proj-1", private_key: "SECRET-KEY" } }, ...state.fcmAdded.values()].filter((x) => !state.deletedProviders.has(String(x.providerId))) } });
      if (req.method === "GET" && p === `${REST}/notifications/push/v1/providers/dashboard/apns`) return send(200, { data: { pushProviders: [] } });
      if (req.method === "POST" && p === `${REST}/notifications/push/v1/providers/dashboard/fcm`) {
        // Like notifications-core: notificationInPayload { ios, android, web } × { chat, call } is required.
        const n = body.notificationInPayload;
        const valid = n && ["ios", "android", "web"].every((k) => n[k] && typeof n[k].chat === "boolean" && typeof n[k].call === "boolean");
        if (!valid) return send(400, { error: { code: "ERR_BAD_REQUEST", message: ".notificationInPayload should not be empty" } });
        state.fcmAdded.set(body.providerId, { providerId: body.providerId, isDefault: false, serviceAccountCreds: { project_id: body.serviceAccountCreds.project_id }, notificationInPayload: n });
        return send(201, { data: { success: true } });
      }
      if (req.method === "GET" && p === `${REST}/roles`) return send(200, page([{ role: "default", name: "Default", description: "Default role" }]));
      if (req.method === "POST" && p === `${REST}/roles`) return send(200, { data: body });
      // management API
      if (req.method === "GET" && /^\/apps\/app123\/metrics\/(mau|pcc|voice)\/\d+\/\d+$/.test(p)) {
        const kind = p.split("/")[4];
        if (kind === "mau") return send(200, { data: [{ MAU: 12, date: "2026-10" }] });
        if (kind === "pcc") return send(200, { data: [{ PCC: "3", date: "2026-10-01" }, { PCC: "7", date: "2026-10-02" }] });
        return send(200, { data: [{ voice_minutes: "1.5", date: "2026-10-01" }, { voice_minutes: "2", date: "2026-10-02" }] });
      }
      if (req.method === "GET" && p === "/plans") return send(200, { data: { free: { id: "build", name: "Build" } } });
      if (req.method === "GET" && p === "/apps/app123/invoices") return send(404, { error: { code: "ERR_NOT_FOUND", message: "No invoices" } });
      if (req.method === "GET" && p === "/apps/app123/moderation/rules")
        return send(200, { data: [{ id: "profanity", name: "Profanity", description: "Blocks swearing", enabled: true, action: ["block"], default: true }, { id: "my-rule", name: "My rule", enabled: true, action: ["flag"], default: false }].filter((r) => !state.deletedModeration.has(`rules/${r.id}`)) });
      if (req.method === "PUT" && p === "/apps/app123/moderation/rules/profanity") return send(200, { data: { id: "profanity", enabled: body.enabled } });
      if (req.method === "GET" && p === "/apps/app123/moderation/keywords")
        return send(200, { data: [{ id: "bad-words", name: "Bad words", category: "keywords", searchTerms: ["x", "y"], disallowedSentences: [], default: false }, { id: "profanity-list", name: "Profane Words", category: "word", searchTerms: ["z"], default: true }].filter((l) => !state.deletedModeration.has(`keywords/${l.id}`)) });
      // Moderation deletes go to the management API (the chat-api proxy route is plan-gated).
      const modDelete = p.match(/^\/apps\/app123\/moderation\/(keywords|rules)\/([^/]+)$/);
      if (req.method === "DELETE" && modDelete) {
        state.deletedModeration.add(`${modDelete[1]}/${decodeURIComponent(modDelete[2]!)}`);
        return send(200, { data: { success: true } });
      }
      if (req.method === "POST" && p === "/apps/app123/moderation/keywords") return send(200, { data: body });
      if (req.method === "GET" && p === "/apps/app123/collaborators")
        return send(200, page([{ name: "Dev User", email: "dev@example.com", role: "owner", isCollaborating: true }]));
      if (req.method === "POST" && p === "/apps/app123/collaborators") return send(200, { data: {} });
      if (req.method === "GET" && p === "/apps/app123/call-api/v3.0/calls")
        return send(200, page([{ sessionId: "s1", type: "video", mode: "call", status: "ended", receiverType: "user", startedAt: 1, endedAt: 2, totalDurationInMinutes: 1.5, totalAudioMinutes: 0, totalVideoMinutes: 1.5, totalParticipants: 2, hasRecording: false }]));
      if (req.method === "GET" && p === "/apps/app123/settings") return send(200, { data: { settings: state.settings } });
      if (req.method === "POST" && p === "/apps/app123/settings") {
        Object.assign(state.settings, body.settings);
        return send(200, { data: {} });
      }
      if (p.startsWith("/apps/app123/features/") && (req.method === "POST" || req.method === "DELETE")) return send(200, { data: {} });
      return send(404, { error: { code: "NOT_FOUND", message: `${req.method} ${p}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(() => r())) };
}
