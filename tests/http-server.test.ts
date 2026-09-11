import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, type AppDeps } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { BundleStore } from "../src/bundles/loader.js";
import { ResourceRegistry } from "../src/resources/registry.js";

// Drives the real Express app over a real socket. Hermetic: loopback only,
// no index (a path that does not exist), analytics never initialised.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "mcp.test";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MCP_HEADERS = {
  host: HOST,
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let base: Omit<AppDeps, "config">;
let baseConfig: Config;
const servers: http.Server[] = [];

async function start(
  overrides: Partial<Config> = {},
  deps: Partial<Omit<AppDeps, "config">> = {},
): Promise<number> {
  const app = createApp({ ...base, ...deps, config: { ...baseConfig, ...overrides } });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

function request(
  port: number,
  opts: { method: string; path?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Reply> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: opts.path ?? "/mcp",
        method: opts.method,
        headers: {
          host: HOST,
          ...opts.headers,
          ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const mcp = (port: number, message: unknown, headers: Record<string, string> = {}) =>
  request(port, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: message });

/** JSON-RPC messages carried in an SSE reply's `data:` lines. */
function sseMessages(body: string): Array<Record<string, any>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
};
const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

beforeAll(async () => {
  const bundleStore = await BundleStore.load(path.join(ROOT, "bundles"));
  base = {
    searchClient: new SqliteSearchClient(path.join(ROOT, "does-not-exist", "index.sqlite")),
    bundleStore,
    resources: await ResourceRegistry.load(path.join(ROOT, "skills"), bundleStore),
    refresher: null,
    allowedHosts: [HOST],
    allowedOrigins: [],
    dnsRebindingProtection: true,
  };
  baseConfig = {
    ...loadConfig(),
    indexAutoRefresh: false,
    rateLimitEnabled: true,
    rateLimitMax: 120,
    rateLimitWindowMs: 60_000,
  };
});

afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  base.searchClient.close();
});

describe("POST /mcp — session identity", () => {
  let port: number;
  beforeAll(async () => {
    port = await start();
  });

  it("initialize mints a fresh UUID session id and ignores a client-supplied one", async () => {
    const clientId = "11111111-2222-4333-8444-555555555555";
    const first = await mcp(port, initialize, { "mcp-session-id": clientId });
    const second = await mcp(port, initialize, { "mcp-session-id": clientId });

    expect(first.status).toBe(200);
    expect(sseMessages(first.body)[0].result.serverInfo.name).toBe("CometChat Docs");
    for (const r of [first, second]) {
      expect(r.headers["mcp-session-id"]).toMatch(UUID_RE);
      expect(r.headers["mcp-session-id"]).not.toBe(clientId);
    }
    expect(second.headers["mcp-session-id"]).not.toBe(first.headers["mcp-session-id"]);
  });

  it("echoes a well-formed session id on later requests", async () => {
    const init = await mcp(port, initialize);
    const sessionId = init.headers["mcp-session-id"] as string;
    const r = await mcp(port, toolsList, { "mcp-session-id": sessionId });
    expect(r.status).toBe(200);
    expect(r.headers["mcp-session-id"]).toBe(sessionId);
  });

  it("does not reflect a malformed session id, and still serves the request", async () => {
    const r = await mcp(port, toolsList, { "mcp-session-id": "not-a-uuid<script>" });
    expect(r.status).toBe(200);
    expect(r.headers["mcp-session-id"]).toBeUndefined();
    expect(sseMessages(r.body)[0].result.tools.length).toBe(4);
  });
});

describe("POST /mcp — response framing", () => {
  const ORIGIN = "https://inspector.example";
  let port: number;
  beforeAll(async () => {
    // Allowlisted, so the bodyless replies below must carry CORS headers too.
    port = await start({}, { allowedOrigins: [ORIGIN] });
  });

  // The SDK answers these with a null-body 202. Sent as an empty chunked body
  // they became a bare 500 at the production gateway and broke client connect.
  const bodyless = {
    "notifications/initialized": initialized,
    "a client JSON-RPC response": { jsonrpc: "2.0", id: 7, result: {} },
  };
  for (const [label, message] of Object.entries(bodyless)) {
    it(`${label}: 202 with Content-Length 0 and no chunked framing`, async () => {
      const sessionId = "0f0e0d0c-0b0a-4908-8706-050403020100";
      const r = await mcp(port, message, { "mcp-session-id": sessionId, origin: ORIGIN });
      expect(r.status).toBe(202);
      expect(r.headers["content-length"]).toBe("0");
      expect(r.headers["transfer-encoding"]).toBeUndefined();
      expect(r.headers["content-type"]).toBeUndefined();
      expect(r.body).toBe("");
      // Headers set before the SDK writes (session id, CORS) still go out.
      expect(r.headers["mcp-session-id"]).toBe(sessionId);
      expect(r.headers["access-control-allow-origin"]).toBe(ORIGIN);
      expect(r.headers["access-control-expose-headers"]).toBe("mcp-session-id");
    });
  }

  it("puts nothing on the wire after the 202 header block", async () => {
    const payload = JSON.stringify(initialized);
    const raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(
          [
            "POST /mcp HTTP/1.1",
            `Host: ${HOST}`,
            `Accept: ${MCP_HEADERS.accept}`,
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(payload)}`,
            "Connection: close", // server closes after the response: a deterministic end of capture
            "",
            payload,
          ].join("\r\n"),
        );
      });
      sock.on("data", (c: Buffer) => chunks.push(c));
      sock.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
      sock.on("error", reject);
    });
    const headerEnd = raw.indexOf("\r\n\r\n");
    expect(raw.startsWith("HTTP/1.1 202 Accepted\r\n")).toBe(true);
    expect(raw.slice(0, headerEnd)).toMatch(/\r\nContent-Length: 0(\r\n|$)/i);
    expect(raw.slice(0, headerEnd)).not.toMatch(/transfer-encoding/i);
    expect(raw.slice(headerEnd + 4)).toBe(""); // no "0\r\n\r\n" terminator
  });

  it("hono's own bodyless 400 (a Host header new URL() rewrites) is framed the same way", async () => {
    const r = await mcp(port, toolsList, { host: `x@${HOST}` });
    expect(r.status).toBe(400);
    expect(r.headers["content-length"]).toBe("0");
    expect(r.headers["transfer-encoding"]).toBeUndefined();
    expect(r.body).toBe("");
  });

  it("tools/list works without a session header and keeps its SSE body", async () => {
    const r = await mcp(port, toolsList);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/event-stream");
    expect(r.headers["mcp-session-id"]).toBeUndefined();
    if (r.headers["content-length"] !== undefined) {
      expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(r.body));
    }
    const [reply] = sseMessages(r.body);
    expect(reply.id).toBe(2);
    expect(reply.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "search_cometchat_docs",
      "fetch_cometchat_doc_page",
      "get_cometchat_implementation_bundle",
      "list_cometchat_bundles",
    ]);
  });

  it("JSON error replies keep their exact Content-Length", async () => {
    const r = await mcp(port, toolsList, { accept: "application/json" });
    expect(r.status).toBe(406);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["transfer-encoding"]).toBeUndefined();
    expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(r.body));
    expect(JSON.parse(r.body).error.code).toBe(-32000);
  });

  it("a disallowed Host header gets 403", async () => {
    const r = await mcp(port, toolsList, { host: "evil.example.com" });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error.message).toContain("Invalid Host header");
  });
});

describe("/mcp — other methods", () => {
  let port: number;
  beforeAll(async () => {
    port = await start();
  });

  it("GET is 405: this server offers no SSE stream", async () => {
    const r = await request(port, { method: "GET", headers: { accept: "text/event-stream" } });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("POST, DELETE");
    expect(JSON.parse(r.body).error.code).toBe(-32000);
  });

  it("DELETE is 204: nothing is held server-side", async () => {
    const r = await request(port, {
      method: "DELETE",
      headers: { "mcp-session-id": "0f0e0d0c-0b0a-4908-8706-050403020100" },
    });
    expect(r.status).toBe(204);
    expect(r.body).toBe("");
  });
});

describe("/mcp — browser origins", () => {
  const INSPECTOR = "https://inspector.example";
  const CORS_HEADERS = [
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
  ];
  let closedPort: number; // ALLOWED_ORIGINS unset
  let listedPort: number; // ALLOWED_ORIGINS=https://inspector.example
  beforeAll(async () => {
    closedPort = await start();
    listedPort = await start({}, { allowedOrigins: [INSPECTOR] });
  });

  it("serves a request without an Origin, as every non-browser client sends", async () => {
    const r = await mcp(closedPort, initialize);
    expect(r.status).toBe(200);
    for (const h of CORS_HEADERS) expect(r.headers).not.toHaveProperty(h);
  });

  it("refuses an unlisted Origin with 403 on every /mcp method, preflight included", async () => {
    const origin = "https://evil.example";
    const replies = {
      POST: await mcp(closedPort, initialize, { origin }),
      GET: await request(closedPort, { method: "GET", headers: { origin } }),
      DELETE: await request(closedPort, { method: "DELETE", headers: { origin } }),
      OPTIONS: await request(closedPort, { method: "OPTIONS", headers: { origin } }),
    };
    for (const [method, r] of Object.entries(replies)) {
      expect(r.status, method).toBe(403);
      expect(JSON.parse(r.body), method).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Origin not allowed." },
        id: null,
      });
      expect(r.headers["mcp-session-id"], method).toBeUndefined();
      expect(r.headers.vary, method).toBe("Origin");
      for (const h of CORS_HEADERS) expect(r.headers, method).not.toHaveProperty(h);
    }
  });

  it("matches the allowlist exactly on scheme, host and port", async () => {
    for (const origin of [
      "http://inspector.example",
      "https://inspector.example:8443",
      "https://inspector.example.evil.com",
      "null",
    ]) {
      expect((await mcp(listedPort, initialize, { origin })).status, origin).toBe(403);
    }
  });

  it("grants CORS to a listed origin, on the preflight and the request", async () => {
    const preflight = await request(listedPort, { method: "OPTIONS", headers: { origin: INSPECTOR } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(INSPECTOR);
    expect(preflight.headers.vary).toBe("Origin");
    expect(preflight.headers["access-control-allow-methods"]).toBe("GET, POST, DELETE, OPTIONS");
    expect(preflight.headers["access-control-allow-headers"]).toBe(
      "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id",
    );
    expect(preflight.headers["access-control-expose-headers"]).toBe("mcp-session-id");

    const r = await mcp(listedPort, initialize, { origin: INSPECTOR });
    expect(r.status).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBe(INSPECTOR);
    expect(r.headers["mcp-session-id"]).toMatch(UUID_RE);
  });

  it("does not gate /health on Origin, and grants it no CORS either", async () => {
    const r = await request(closedPort, {
      method: "GET",
      path: "/health",
      headers: { origin: "https://evil.example" },
    });
    expect(JSON.parse(r.body).service).toBe("cometchat-mcp");
    expect(r.headers).not.toHaveProperty("access-control-allow-origin");
  });
});

describe("/mcp — rate limiting", () => {
  it("returns 429 with Retry-After once max requests are used", async () => {
    const port = await start({ rateLimitMax: 2, rateLimitWindowMs: 60_000 });
    const statuses: number[] = [];
    for (let i = 0; i < 2; i++) statuses.push((await request(port, { method: "GET" })).status);
    expect(statuses).toEqual([405, 405]);

    const limited = await request(port, { method: "GET" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(JSON.parse(limited.body).error.code).toBe(-32000);
  });

  it("is not mounted when rateLimitEnabled is false", async () => {
    const port = await start({ rateLimitEnabled: false, rateLimitMax: 1 });
    for (let i = 0; i < 3; i++) {
      const r = await request(port, { method: "GET" });
      expect(r.status).toBe(405);
      expect(r.headers["ratelimit-limit"]).toBeUndefined();
    }
  });
});
