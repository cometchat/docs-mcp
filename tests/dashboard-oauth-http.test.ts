// End to end over a real socket: dynamic client registration → /authorize →
// dashboard sign-in (mocked apimgmt) → code + PKCE → access token →
// /mcp/dashboard tools. Also checks /mcp stays public and unchanged.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { stubBundleStore } from "./helpers/bundles.js";
import { ResourceRegistry } from "../src/resources/registry.js";
import { startDashboardMock } from "./dashboard-mock.js";
import { testSecret } from "./secrets.js";

import { ALL_DASHBOARD_TOOLS } from "../src/tools/dashboard/index.js";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REDIRECT = "http://localhost:7777/callback";
const ACCEPT = { accept: "application/json, text/event-stream", "content-type": "application/json" };

let mock: Awaited<ReturnType<typeof startDashboardMock>>;
let server: http.Server;
let base: string;

beforeAll(async () => {
  mock = await startDashboardMock();
  const bundleStore = stubBundleStore();
  const app = createApp({
    config: {
      ...loadConfig(),
      indexAutoRefresh: false,
      rateLimitEnabled: false,
      dashboardEnabled: true,
      dashboardTokenSecret: testSecret("s"),
      publicUrl: "http://localhost",
      dashboardApiHost: mock.url,
      dashboardHost: "https://app.cometchat.com",
    },
    searchClient: new SqliteSearchClient(path.join(ROOT, "does-not-exist", "index.sqlite")),
    bundleStore,
    resources: await ResourceRegistry.load(path.join(ROOT, "skills"), bundleStore),
    refresher: null,
    allowedHosts: [],
    allowedOrigins: [],
    dnsRebindingProtection: false,
  });
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await mock.close();
});

function rpcMessages(body: string): any[] {
  const sse = body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  return sse.length ? sse : [JSON.parse(body)];
}
async function rpc(endpoint: string, message: unknown, token?: string) {
  const res = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: { ...ACCEPT, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { res, text, msg: res.ok ? rpcMessages(text)[0] : undefined };
}
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } };
const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const call = (name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });

async function signIn(opts: { readOnly?: boolean; scope?: string; redirectUri?: string } = {}): Promise<{ access_token: string; refresh_token: string; client_id: string; scope: string; pageHtml: string }> {
  const redirectUri = opts.redirectUri ?? REDIRECT;
  mock.state.authorized = false;
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Vitest Agent", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: "http://localhost/mcp/dashboard", ...(opts.scope ? { scope: opts.scope } : {}) })) authUrl.searchParams.set(k, v);
  const page = await fetch(authUrl, { redirect: "manual" });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Vitest Agent");
  expect(html).toContain("https://app.cometchat.com/login?sessionId=sess-1");
  const handle = /var h="([^"]+)"/.exec(html)![1]!;

  const pending = await (await fetch(`${base}/oauth/cometchat/poll?handle=${encodeURIComponent(handle)}`)).json();
  expect(pending).toEqual({ status: "pending" });
  mock.state.authorized = true; // the user finishes signing in on the dashboard
  const done = (await (await fetch(`${base}/oauth/cometchat/poll?handle=${encodeURIComponent(handle)}${opts.readOnly ? "&read_only=1" : ""}`)).json()) as { status: string; location: string };
  expect(done.status).toBe("redirect");
  const back = new URL(done.location);
  expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
  expect(back.searchParams.get("state")).toBe("st-1");

  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri }),
  });
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; token_type: string; scope: string };
  expect(tokens.token_type.toLowerCase()).toBe("bearer");
  expect(tokens.access_token).not.toContain("dash-token");
  return { ...tokens, client_id: client.client_id, pageHtml: html };
}

describe("public /mcp is unchanged", () => {
  it("lists only the four docs tools and refuses account tools", async () => {
    await rpc("/mcp", init);
    const { msg } = await rpc("/mcp", list);
    expect(msg.result.tools.map((t: any) => t.name)).toEqual([
      "search_cometchat_docs", "fetch_cometchat_doc_page", "get_cometchat_implementation_bundle", "list_cometchat_bundles",
    ]);
    const { msg: refused } = await rpc("/mcp", call("cometchat_list_apps"));
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("unauthorized");
  });
});

describe("OAuth metadata", () => {
  it("advertises the protected resource and the authorization server", async () => {
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp/dashboard`)).json()) as any;
    expect(prm.resource).toBe("http://localhost/mcp/dashboard");
    expect(prm.authorization_servers).toEqual(["http://localhost/"]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(as.code_challenge_methods_supported).toContain("S256");
    expect(as.scopes_supported).toEqual(["dashboard:read", "dashboard:write"]);
    expect(as.registration_endpoint).toBe("http://localhost/register");
  });

  it("answers an unauthenticated /mcp/dashboard call with 401 and a resource_metadata pointer", async () => {
    const { res } = await rpc("/mcp/dashboard", init);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp/dashboard"');
    const forged = await rpc("/mcp/dashboard", init, "v1.forged.token.value");
    expect(forged.res.status).toBe(401);
  });
});

describe("sign-in pages", () => {
  it("serves the disconnect help page and links to it from the sign-in page", async () => {
    const help = await fetch(`${base}/oauth/cometchat/disconnect`);
    expect(help.status).toBe(200);
    const text = await help.text();
    expect(text).toContain("Disconnect an AI tool");
    expect(text).toContain("Clear authentication");
    expect(text).toContain("codex mcp logout");
    expect(text).not.toContain('href="/oauth/cometchat/disconnect"');
  });

  it("shows where sign-in returns to and links the disconnect help", async () => {
    const reg = (await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Vitest Agent", token_endpoint_auth_method: "none" }) })).json()) as { client_id: string };
    const u = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" })) u.searchParams.set(k, v);
    const html = await (await fetch(u)).text();
    expect(html).toContain(`Returns to ${new URL(REDIRECT).origin} after sign-in`);
    expect(html).toContain('href="/oauth/cometchat/disconnect"');
    expect(html).toContain('aria-label="CometChat"');
  });
});

describe("signed-in /mcp/dashboard", () => {
  it("grants read + write by default and read-only only when the client asks for it", async () => {
    const full = await signIn();
    expect(full.scope).toBe("dashboard:read dashboard:write");
    // The sign-in page offers no Read-only choice, and a read_only poll flag is ignored.
    expect(full.pageHtml).not.toContain('name="access"');
    expect(full.pageHtml).not.toContain("Read-only");
    expect(full.pageHtml).not.toContain("read_only");
    expect((await signIn({ readOnly: true })).scope).toBe("dashboard:read dashboard:write");
    const ro = await signIn({ scope: "dashboard:read" });
    expect(ro.scope).toBe("dashboard:read");
    expect(ro.pageHtml).toContain("Read-only: it can't change your account.");
    const { msg: tools } = await rpc("/mcp/dashboard", list, ro.access_token);
    const names = tools.result.tools.map((t: any) => t.name);
    expect(names).toContain("cometchat_list_apps");
    expect(names).not.toContain("cometchat_create_app");
    const { msg: refused } = await rpc("/mcp/dashboard", call("cometchat_create_users", { app_id: "app123", users: [{ uid: "z", name: "Z" }] }), ro.access_token);
    expect(refused.result.content[0].text).toContain("forbidden");
  });

  it("accepts a session-end DELETE from a signed-in client, and refuses it without a token", async () => {
    const { access_token } = await signIn();
    expect((await fetch(`${base}/mcp/dashboard`, { method: "DELETE", headers: { authorization: `Bearer ${access_token}`, "mcp-session-id": "s-1" } })).status).toBe(204);
    expect((await fetch(`${base}/mcp/dashboard`, { method: "DELETE" })).status).toBe(401);
  });

  it("signs in through the dashboard and runs account tools", async () => {
    const { access_token } = await signIn();
    const { msg: initMsg } = await rpc("/mcp/dashboard", init, access_token);
    expect(initMsg.result.instructions).toContain("cometchat_list_apps");
    const { msg: tools } = await rpc("/mcp/dashboard", list, access_token);
    const names = tools.result.tools.map((t: any) => t.name);
    expect(names).toContain("search_cometchat_docs");
    expect(names).toEqual(expect.arrayContaining(["cometchat_whoami", "cometchat_list_apps", "cometchat_get_usage", "cometchat_create_app"]));
    expect(names).not.toContain("cometchat_add_fcm_provider"); // local-only
    const { msg: apps } = await rpc("/mcp/dashboard", call("cometchat_list_apps"), access_token);
    expect(apps.result.structuredContent).toMatchObject({ total: 1, apps: [{ app_id: "app123" }] });
    const { msg: me } = await rpc("/mcp/dashboard", call("cometchat_whoami"), access_token);
    expect(me.result.structuredContent).toEqual({ signed_in: true, name: "Dev User", email: "dev@example.com" });
  });

  it("refreshes tokens, and refuses a refresh token from another client", async () => {
    const first = await signIn();
    const refreshed = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.client_id }),
    });
    expect(refreshed.status).toBe(200);
    const { access_token } = (await refreshed.json()) as { access_token: string };
    expect((await rpc("/mcp/dashboard", init, access_token)).res.status).toBe(200);

    const other = await signIn();
    const stolen = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: other.client_id }),
    });
    expect(stolen.status).toBe(400);
  });

  it("rejects a code exchanged without the right PKCE verifier", async () => {
    mock.state.authorized = true;
    const reg = (await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json()) as { client_id: string };
    const challenge = createHash("sha256").update("right-verifier-right-verifier-right-verifier").digest("base64url");
    const u = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
    const handle = /var h="([^"]+)"/.exec(await (await fetch(u)).text())![1]!;
    const done = (await (await fetch(`${base}/oauth/cometchat/poll?handle=${encodeURIComponent(handle)}`)).json()) as { location: string };
    const code = new URL(done.location).searchParams.get("code")!;
    const bad = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier", client_id: reg.client_id, redirect_uri: REDIRECT }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("default scope: read + write unless the client asks for read-only", () => {
  const httpTools = ALL_DASHBOARD_TOOLS.filter((t) => !t.localOnly);
  const readTools = httpTools.filter((t) => t.access === "read").map((t) => t.name);
  const writeTools = httpTools.filter((t) => t.access === "write").map((t) => t.name);
  const dashboardNames = (msg: any) => msg.result.tools.map((t: any) => t.name).filter((n: string) => n.startsWith("cometchat_"));

  /** The scope a spec-compliant MCP client asks for (SDK client/auth.js, SEP-835): the 401's scope, else the PRM's scopes_supported. */
  async function sdkSelectedScope(): Promise<string> {
    const { res } = await rpc("/mcp/dashboard", init);
    const challenge = /scope="([^"]*)"/.exec(res.headers.get("www-authenticate") ?? "")?.[1];
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp/dashboard`)).json()) as { scopes_supported?: string[] };
    return challenge || prm.scopes_supported!.join(" ");
  }

  it("the 401 challenge advertises both scopes, and both metadata documents list them", async () => {
    const { res } = await rpc("/mcp/dashboard", init);
    expect(res.status).toBe(401);
    const header = res.headers.get("www-authenticate")!;
    expect(header).toContain('scope="dashboard:read dashboard:write"');
    expect(header).toContain('error="invalid_token"');
    expect(header).toContain('resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp/dashboard"');
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp/dashboard`)).json()) as any;
    expect(prm.scopes_supported).toEqual(["dashboard:read", "dashboard:write"]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(as.scopes_supported).toEqual(["dashboard:read", "dashboard:write"]);
  });

  it("a client following the SDK's scope rule gets read + write and every account tool", async () => {
    const scope = await sdkSelectedScope();
    expect(scope).toBe("dashboard:read dashboard:write");
    const s = await signIn({ scope });
    expect(s.scope).toBe("dashboard:read dashboard:write");
    expect(s.pageHtml).toContain("Create apps, API keys, webhooks and users, and change settings");
    const { msg } = await rpc("/mcp/dashboard", list, s.access_token);
    expect(dashboardNames(msg).sort()).toEqual([...readTools, ...writeTools].sort());
    expect(dashboardNames(msg)).toHaveLength(50); // 51 account tools; the local-file FCM tool is stdio-only
  });

  it("an explicit dashboard:read request stays read-only, and that token still works for read tools", async () => {
    const ro = await signIn({ scope: "dashboard:read" });
    expect(ro.scope).toBe("dashboard:read");
    const { res, msg } = await rpc("/mcp/dashboard", list, ro.access_token);
    expect(res.status).toBe(200);
    expect(dashboardNames(msg).sort()).toEqual([...readTools].sort());
    expect(dashboardNames(msg)).toHaveLength(23);
    const { res: callRes, msg: apps } = await rpc("/mcp/dashboard", call("cometchat_list_apps"), ro.access_token);
    expect(callRes.status).toBe(200);
    expect(apps.result.isError).toBeFalsy();
  });

  it("claude.ai's connector (the Claude desktop app): a trusted callback asking for the challenge's scope gets read + write", async () => {
    const scope = await sdkSelectedScope();
    const s = await signIn({ scope, redirectUri: "https://claude.ai/api/mcp/auth_callback" });
    expect(s.scope).toBe("dashboard:read dashboard:write");
    expect(s.pageHtml).not.toContain("(unverified)");
    expect(s.pageHtml).toContain("Create apps, API keys, webhooks and users, and change settings");
    expect(s.pageHtml).not.toContain("Read-only: it can't change your account.");
    const { msg } = await rpc("/mcp/dashboard", list, s.access_token);
    expect(dashboardNames(msg)).toHaveLength(50);
  });
});

describe("authorization codes work once", () => {
  /** A fresh code and its PKCE verifier, as the client gets them back from the sign-in. */
  async function freshCode(): Promise<{ code: string; verifier: string; client_id: string }> {
    mock.state.authorized = true;
    const reg = (await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json()) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const u = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
    const handle = /var h="([^"]+)"/.exec(await (await fetch(u)).text())![1]!;
    const done = (await (await fetch(`${base}/oauth/cometchat/poll?handle=${encodeURIComponent(handle)}`)).json()) as { location: string };
    return { code: new URL(done.location).searchParams.get("code")!, verifier, client_id: reg.client_id };
  }
  const exchange = (code: string, verifier: string, clientId: string) =>
    fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }),
    });

  it("refuses a second exchange of the same code", async () => {
    const { code, verifier, client_id } = await freshCode();
    expect((await exchange(code, verifier, client_id)).status).toBe(200);
    const again = await exchange(code, verifier, client_id);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses the same code spelled differently", async () => {
    // The tag's last base64url character carries 4 unused bits, so another
    // character with the same top 2 bits decodes to the same bytes.
    const { code, verifier, client_id } = await freshCode();
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const i = A.indexOf(code.at(-1)!);
    const respelled = code.slice(0, -1) + A[(i & 0x30) | ((i + 1) & 0x0f)];
    expect(respelled).not.toBe(code);
    expect((await exchange(respelled, verifier, client_id)).status).toBe(200); // still a valid spelling
    expect((await exchange(code, verifier, client_id)).status).toBe(400);
  });

  it("a wrong verifier doesn't use the code up", async () => {
    const { code, verifier, client_id } = await freshCode();
    expect((await exchange(code, "wrong-verifier-wrong-verifier-wrong-verifier", client_id)).status).toBe(400);
    expect((await exchange(code, verifier, client_id)).status).toBe(200);
  });
});
