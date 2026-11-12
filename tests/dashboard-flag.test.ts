// The DASHBOARD_ENABLED flag, end to end over a real socket:
// - off: every account route is a 404 and /mcp serves the docs tools only
// - on, with DASHBOARD_ON_MCP off: an account tool on /mcp says why it is unavailable
// - on: the SDK's OAuth endpoints answer browser preflights with CORS headers
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { stubBundleStore } from "./helpers/bundles.js";
import { ResourceRegistry } from "../src/resources/registry.js";
import { testSecret } from "./secrets.js";
import { configureActorKey } from "../src/dashboard/actor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCEPT = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const STAGING = "https://mcp.cometchat-staging.com";

async function start(overrides: Partial<Config>): Promise<{ server: http.Server; base: string }> {
  const bundleStore = stubBundleStore();
  const app = createApp({
    config: { ...loadConfig(), indexAutoRefresh: false, rateLimitEnabled: false, ...overrides },
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
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const stop = (server: http.Server) => new Promise<void>((r) => server.close(() => r()));

function rpcMessages(body: string): any[] {
  const sse = body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  return sse.length ? sse : [JSON.parse(body)];
}
async function rpc(base: string, method: string, params: unknown = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: ACCEPT,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return rpcMessages(await res.text())[0];
}

describe("DASHBOARD_ENABLED off", () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => ({ server, base } = await start({ dashboardEnabled: false })));
  afterAll(() => stop(server));

  it.each([
    ["GET", "/mcp/dashboard"],
    ["POST", "/mcp/dashboard"],
    ["GET", "/.well-known/oauth-authorization-server"],
    ["GET", "/.well-known/oauth-protected-resource/mcp/dashboard"],
    ["GET", "/authorize"],
    ["POST", "/token"],
    ["POST", "/register"],
    ["POST", "/revoke"],
    ["GET", "/oauth/cometchat/poll"],
    ["GET", "/oauth/cometchat/approve"],
    ["GET", "/oauth/cometchat/disconnect"],
  ])("%s %s is 404", async (method, route) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: ACCEPT,
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    expect(res.status).toBe(404);
  });

  it("lists only the docs tools on /mcp", async () => {
    const msg = await rpc(base, "tools/list");
    const names: string[] = msg.result.tools.map((t: { name: string }) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => n.startsWith("cometchat_"))).toEqual([]);
  });

  it("says account tools are not enabled instead of pointing at a 404", async () => {
    const msg = await rpc(base, "tools/call", { name: "cometchat_whoami", arguments: {} });
    const text = JSON.stringify(msg);
    expect(text).toContain("not enabled on this server");
    expect(text).not.toContain("/mcp/dashboard");
  });
});

describe("DASHBOARD_ENABLED on", () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => ({ server, base } = await start({
    dashboardEnabled: true,
    dashboardTokenSecret: testSecret("flag"),
    dashboardActorSalt: testSecret("flag-salt"),
    publicUrl: STAGING,
  })));
  afterAll(async () => {
    await stop(server);
    configureActorKey(undefined);
  });

  it("with DASHBOARD_ON_MCP off, says /mcp doesn't offer account tools (no longer points at /mcp/dashboard)", async () => {
    const msg = await rpc(base, "tools/call", { name: "cometchat_whoami", arguments: {} });
    const text = JSON.stringify(msg);
    expect(text).toContain("DASHBOARD_ON_MCP=false");
    expect(text).not.toContain("/mcp/dashboard");
  });

  it.each(["/token", "/register", "/.well-known/oauth-authorization-server"])(
    "answers the browser preflight for %s with CORS headers",
    async (route) => {
      const res = await fetch(`${base}${route}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://client.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    },
  );
});
