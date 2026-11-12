// DASHBOARD_ON_MCP, end to end over a real socket: /mcp keeps its docs tools
// open, lists the account tools, and answers an account tool call without a
// token with a 401 that sends the client to sign in for /mcp. With the flag
// off, /mcp is exactly as before.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REDIRECT = "http://localhost:7777/callback";
const ACCEPT = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const DOCS_TOOLS = ["search_cometchat_docs", "fetch_cometchat_doc_page", "get_cometchat_implementation_bundle", "list_cometchat_bundles"];

let mock: Awaited<ReturnType<typeof startDashboardMock>>;
const servers: http.Server[] = [];

async function start(dashboardOnMcp: boolean, overrides: Record<string, unknown> = {}): Promise<string> {
  const bundleStore = stubBundleStore();
  const app = createApp({
    config: {
      ...loadConfig(),
      indexAutoRefresh: false,
      rateLimitEnabled: false,
      dashboardEnabled: true,
      dashboardOnMcp,
      dashboardTokenSecret: testSecret("s"),
      publicUrl: "http://localhost",
      dashboardApiHost: mock.url,
      dashboardHost: "https://app.cometchat.com",
      ...overrides,
    },
    searchClient: new SqliteSearchClient(path.join(ROOT, "does-not-exist", "index.sqlite")),
    bundleStore,
    resources: await ResourceRegistry.load(path.join(ROOT, "skills"), bundleStore),
    refresher: null,
    allowedHosts: [],
    allowedOrigins: [],
    dnsRebindingProtection: false,
  });
  const server = await new Promise<http.Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let on: string;
let off: string;
beforeAll(async () => {
  mock = await startDashboardMock();
  on = await start(true);
  off = await start(false);
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  await mock.close();
});

function rpcMessages(body: string): any[] {
  const sse = body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  return sse.length ? sse : [JSON.parse(body)];
}
async function rpc(base: string, endpoint: string, message: unknown, token?: string) {
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

/** Register → /authorize (for `resource`) → dashboard sign-in (mocked) → code + PKCE → tokens. */
async function signIn(base: string, resource: string): Promise<string> {
  mock.state.authorized = false;
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Vitest Agent", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  const client = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const authUrl = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "st", resource, scope: "dashboard:read dashboard:write" })) authUrl.searchParams.set(k, v);
  const page = await fetch(authUrl, { redirect: "manual" });
  if (page.status !== 200) return `refused:${page.headers.get("location")}`;
  const handle = /var h="([^"]+)"/.exec(await page.text())![1]!;
  mock.state.authorized = true;
  const done = (await (await fetch(`${base}/oauth/cometchat/poll?handle=${encodeURIComponent(handle)}`)).json()) as { location: string };
  const code = new URL(done.location).searchParams.get("code")!;
  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT }),
  });
  expect(tokenRes.status).toBe(200);
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

describe("DASHBOARD_ON_MCP on: /mcp without a token", () => {
  it("initializes and lists the docs tools plus the account tools", async () => {
    const { res, msg: initMsg } = await rpc(on, "/mcp", init);
    expect(res.status).toBe(200);
    expect(initMsg.result.instructions).toContain("asks the user to sign in to CometChat");
    const { msg } = await rpc(on, "/mcp", list);
    const names: string[] = msg.result.tools.map((t: any) => t.name);
    expect(names.slice(0, 4)).toEqual(DOCS_TOOLS);
    expect(names).toContain("cometchat_list_apps");
    expect(names).toContain("cometchat_create_app"); // write tools too: the default grant is read + write
  });

  it("runs the docs tools without sign-in", async () => {
    const { res, msg } = await rpc(on, "/mcp", call("list_cometchat_bundles"));
    expect(res.status).toBe(200);
    expect(msg.result.isError).not.toBe(true);
  });

  it("answers an account tool call with a 401 pointing at /mcp's sign-in", async () => {
    const { res } = await rpc(on, "/mcp", call("cometchat_list_apps"));
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain('resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"');
    expect(challenge).toContain('scope="dashboard:read dashboard:write"');
  });

  it("challenges a batch that contains an account tool call", async () => {
    const { res } = await rpc(on, "/mcp", [call("list_cometchat_bundles"), { ...call("cometchat_whoami"), id: 4 }]);
    expect(res.status).toBe(401);
  });

  it("publishes /mcp as a protected resource", async () => {
    const prm = (await (await fetch(`${on}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
    expect(prm.resource).toBe("http://localhost/mcp");
    expect(prm.authorization_servers).toEqual(["http://localhost/"]);
    expect(prm.scopes_supported).toEqual(["dashboard:read", "dashboard:write"]);
  });

  it("rejects a non-Bearer Authorization header with a 401", async () => {
    const res = await fetch(`${on}/mcp`, { method: "POST", headers: { ...ACCEPT, authorization: "Basic dXNlcjpwYXNz" }, body: JSON.stringify(list) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
  });

  // The MCP authorization spec: invalid or expired tokens MUST get a 401, so
  // the client refreshes or signs in again rather than silently losing access.
  it("rejects a bad token with a 401, even for a docs tool", async () => {
    const { res } = await rpc(on, "/mcp", call("list_cometchat_bundles"), "not-a-token");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
  });
});

describe("DASHBOARD_ON_MCP on: signed in on /mcp", () => {
  it("issues a token for /mcp that runs account and docs tools there", async () => {
    const token = await signIn(on, "http://localhost/mcp");
    const { res, msg } = await rpc(on, "/mcp", call("cometchat_list_apps"), token);
    expect(res.status).toBe(200);
    expect(msg.result.isError).not.toBe(true);
    expect(msg.result.structuredContent.apps.length).toBeGreaterThan(0);
    const docs = await rpc(on, "/mcp", call("list_cometchat_bundles"), token);
    expect(docs.res.status).toBe(200);
    const { msg: listed } = await rpc(on, "/mcp", list, token);
    expect(listed.result.tools.map((t: any) => t.name)).toContain("cometchat_list_apps");
  });

  it("keeps /mcp/dashboard working with its own tokens", async () => {
    const token = await signIn(on, "http://localhost/mcp/dashboard");
    const { res } = await rpc(on, "/mcp/dashboard", call("cometchat_whoami"), token);
    expect(res.status).toBe(200);
  });

  it("still refuses tokens for other resources", async () => {
    expect(await signIn(on, "https://evil.example/mcp")).toMatch(/^refused:.*invalid_target/);
  });
});

describe("DASHBOARD_ON_MCP rate limits on /mcp", () => {
  const limited = { rateLimitEnabled: true, rateLimitMax: 2, rateLimitWindowMs: 60_000 };
  async function statuses(base: string, n: number, token?: string): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await rpc(base, "/mcp", list, token)).res.status);
    return out;
  }

  it("keeps the normal per-IP limit for requests without a token", async () => {
    expect(await statuses(await start(true, limited), 3)).toEqual([200, 200, 429]);
  });

  it("gives a token no looser limit when the dashboard isn't configured", async () => {
    const base = await start(true, { ...limited, dashboardEnabled: false });
    expect(await statuses(base, 3, "junk")).toEqual([200, 200, 429]);
  });

  it("checks a token before serving, so a junk one only earns 401s", async () => {
    expect(await statuses(await start(true, limited), 3, "junk")).toEqual([401, 401, 401]);
  });
});

describe("DASHBOARD_ON_MCP off: /mcp is unchanged", () => {
  it("lists only the docs tools and refuses account tools in a tool result, not a 401", async () => {
    await rpc(off, "/mcp", init);
    const { msg } = await rpc(off, "/mcp", list);
    expect(msg.result.tools.map((t: any) => t.name)).toEqual(DOCS_TOOLS);
    const { res, msg: refused } = await rpc(off, "/mcp", call("cometchat_list_apps"));
    expect(res.status).toBe(200);
    expect(refused.result.isError).toBe(true);
  });

  it("doesn't publish /mcp as a protected resource or accept /mcp tokens", async () => {
    expect((await fetch(`${off}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
    expect(await signIn(off, "http://localhost/mcp")).toMatch(/^refused:.*invalid_target/);
  });
});

describe("DASHBOARD_ON_MCP default", () => {
  const keys = ["DASHBOARD_ENABLED", "DASHBOARD_ON_MCP", "DASHBOARD_TOKEN_SECRET"] as const;
  function withEnv(env: Partial<Record<(typeof keys)[number], string>>): boolean | undefined {
    const saved = keys.map((k) => [k, process.env[k]] as const);
    try {
      for (const k of keys) delete process.env[k];
      Object.assign(process.env, env);
      return loadConfig().dashboardOnMcp;
    } finally {
      for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  }
  const secret = testSecret("d");

  it("is off when the dashboard is off", () => {
    expect(withEnv({})).toBe(false);
  });
  it("follows DASHBOARD_ENABLED when unset", () => {
    expect(withEnv({ DASHBOARD_ENABLED: "true", DASHBOARD_TOKEN_SECRET: secret })).toBe(true);
  });
  it("can be turned off while the dashboard is on", () => {
    expect(withEnv({ DASHBOARD_ENABLED: "true", DASHBOARD_TOKEN_SECRET: secret, DASHBOARD_ON_MCP: "false" })).toBe(false);
  });
});
