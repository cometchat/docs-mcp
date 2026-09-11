// The HTTP app: CORS, health, rate limiting and the stateless MCP transport.
// No listening, index loading, analytics init or signal handling (src/server.ts
// owns those), so tests drive it in-process over a real socket.
import { randomUUID } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { sanitizeRef, sanitizeSessionId } from "./lib/attribution.js";
import { logger } from "./lib/logger.js";
import type { SqliteSearchClient } from "./search/sqlite.js";
import type { BundleStore } from "./bundles/loader.js";
import type { ResourceRegistry } from "./resources/registry.js";
import { rateLimit, clientIp } from "./lib/rateLimit.js";
import { capture, fingerprint, ipHash, isAnthropicEgress } from "./lib/analytics.js";
import type { IndexRefresher } from "./index/refresher.js";
import { refreshView, wantsDetail } from "./lib/health.js";
import { buildMcpServer, SERVER_VERSION } from "./mcp.js";

const SESSION_HEADER = "mcp-session-id";

/** clientInfo + protocol version captured from the initialize request
 *  (ENG-37102): a connector install that never calls a tool is exactly
 *  `initialize` + `tools/list`, so session open must record who connected. */
interface ClientMeta {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

export interface AppDeps {
  config: Config;
  searchClient: SqliteSearchClient;
  bundleStore: BundleStore;
  resources: ResourceRegistry;
  /** Null when INDEX_AUTO_REFRESH is off; /health then omits indexRefresh. */
  refresher: IndexRefresher | null;
  /** `Host` allowlist enforced by the SDK's DNS-rebinding guard. */
  allowedHosts: string[];
  /**
   * Browser `Origin` allowlist for /mcp. Empty allows no browser origin at all;
   * requests without an Origin (every non-browser client) are unaffected.
   */
  allowedOrigins: string[];
  dnsRebindingProtection: boolean;
}

/**
 * The HTTP app on its own: no listening, index loading, analytics init or
 * signal handlers (main() owns those), so tests can drive it over a socket.
 */
export function createApp(deps: AppDeps): Express {
  const {
    config,
    searchClient,
    bundleStore,
    resources,
    refresher,
    allowedHosts,
    allowedOrigins,
    dnsRebindingProtection,
  } = deps;

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Browsers attach `Origin` to cross-origin requests; native MCP clients (the
  // SDK, IDEs, CLIs, hosted connectors calling from their own backends) send
  // none. Only an allowlisted origin gets CORS headers.
  app.use((req, res, next) => {
    res.vary("Origin");
    const origin = req.header("origin");
    if (origin !== undefined && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        `Content-Type, Authorization, ${SESSION_HEADER}, mcp-protocol-version, last-event-id`,
      );
      res.setHeader("Access-Control-Expose-Headers", SESSION_HEADER);
    }
    next();
  });

  // Withholding CORS headers stops a page reading a reply, not a request the
  // browser sends without a preflight. The MCP transport spec requires servers
  // to validate Origin, so a /mcp request carrying one that is not allowlisted
  // is refused before any handler runs, its preflight included.
  app.use("/mcp", (req, res, next) => {
    const origin = req.header("origin");
    if (origin === undefined || allowedOrigins.includes(origin)) {
      next();
      return;
    }
    sendJsonRpcError(res, 403, "Origin not allowed.");
  });

  app.use((req, res, next) => {
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Glama connector-ownership proof (https://glama.ai/mcp/schemas/connector.json):
  // Glama polls this path on the server's domain and matches the email against
  // a Glama account to grant listing ownership.
  app.get("/.well-known/glama.json", (_req, res) => {
    res.json({
      $schema: "https://glama.ai/mcp/schemas/connector.json",
      maintainers: [{ email: "ketan.yekale@cometchat.com" }],
    });
  });

  app.get("/health", (req, res) => {
    const indexReady = searchClient.isReady();
    const indexAgeSeconds = searchClient.indexAgeSeconds();
    const bundleCount = bundleStore.list().length;
    const ok = indexReady && bundleCount > 0;
    res.status(ok ? 200 : 503).json({
      status: ok ? "ok" : "degraded",
      service: "cometchat-mcp",
      version: SERVER_VERSION,
      indexReady,
      indexAgeSeconds,
      bundles: bundleCount,
      ...(refresher
        ? {
            indexRefresh: refreshView(
              refresher.snapshot(),
              wantsDetail(req, config.healthDetailToken),
            ),
          }
        : {}),
    });
  });

  if (config.rateLimitEnabled) {
    const limiter = rateLimit({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs });
    app.use("/mcp", limiter);
    logger.info(
      { max: config.rateLimitMax, windowMs: config.rateLimitWindowMs },
      "rate_limit_enabled",
    );
  }

  /**
   * STATELESS transport: a fresh transport + server per request, no session
   * map, so ANY replica can serve ANY request.
   *
   * The `Mcp-Session-Id` header is still issued on initialize and echoed by
   * the client, but it is a CORRELATION LABEL only — no state hangs off it,
   * which is what removes the load-balancer affinity requirement. A request
   * arriving without one is served normally, just unattributed.
   */
  app.post("/mcp", async (req, res) => {
    const body = req.body as {
      method?: string;
      params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown } };
    };
    const isInit = isInitializeRequest(req.body);
    // The SERVER owns session identity. On initialize we always mint a fresh
    // id — honouring a client-supplied one there would let a client pin a
    // single id forever, collapsing unrelated working sessions into one row in
    // the analytics. On later requests we accept the echoed id, but only if it
    // is well-formed: it is reflected in a response header and recorded in log
    // lines and PostHog, so an unvalidated value is an injection sink.
    const sessionId = isInit ? randomUUID() : sanitizeSessionId(req.header(SESSION_HEADER));

    const ip = clientIp(req);
    // ENG-37100: links we control carry ?ref=<source>. Clients send their
    // configured URL on every request, so this is present throughout.
    const ref = sanitizeRef(req.query.ref);
    const distinctId = fingerprint(ip);

    if (isInit) {
      const client: ClientMeta = {
        name: asString(body.params?.clientInfo?.name),
        version: asString(body.params?.clientInfo?.version),
        protocolVersion: asString(body.params?.protocolVersion),
      };
      // Record the install only once the transport has ACCEPTED the handshake.
      // Emitting here unconditionally would count requests the SDK rejects
      // (406 on a bad Accept, 415 on wrong Content-Type, 403 from the
      // DNS-rebinding guard) as installs, inflating the headline metric.
      res.on("finish", () => {
        if (res.statusCode >= 400) return;
        logger.info(
          { sessionId, ref, client_name: client.name, client_version: client.version },
          "session_opened",
        );
        capture(distinctId, "mcp_session_started", {
          ref,
          client_name: client.name,
          client_version: client.version,
          protocol_version: client.protocolVersion,
          is_anthropic_egress: isAnthropicEgress(ip),
          ip_hash: ipHash(ip),
          session_id: sessionId,
        });
      });
    }

    if (sessionId) res.setHeader(SESSION_HEADER, sessionId);
    // NB: the SDK still sees the incoming header (it re-reads the raw request
    // via @hono/node-server), but in stateless mode validateSession() returns
    // early without checking it, so an id the SDK never issued is ignored
    // rather than rejected. Nothing to strip.

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: dnsRebindingProtection,
      allowedHosts,
      ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
    });
    const mcpServer = buildMcpServer({
      config,
      searchClient,
      bundleStore,
      resources,
      attribution: { ref, sessionId: () => sessionId },
      telemetry: {
        toolCall: (info) => {
          capture(
            distinctId,
            info.status === "success" ? "mcp_tool_called" : "mcp_tool_failed",
            { ref, session_id: sessionId, ...info },
          );
        },
      },
    });

    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      frameBodylessResponses(res);
      // express.json() under Express 5 (body-parser 2) leaves req.body
      // undefined when the Content-Type is not one it parses; Express 4 set {}.
      // The SDK reads an undefined parsedBody from the raw stream itself, with
      // no size limit, after only a substring check for "application/json" —
      // so `application/jsonx` would carry any size of body past the 4mb cap.
      // {} keeps the Express 4 contract: the SDK rejects it as invalid JSON-RPC.
      await transport.handleRequest(req, res, req.body ?? {});
    } catch (err) {
      logger.error({ err }, "mcp_request_failed");
      if (!res.headersSent) sendJsonRpcError(res, 500, "Internal error handling MCP request.");
    }
  });

  // No server->client stream exists (both capabilities declare
  // listChanged:false), so there is nothing to stream. 405 is the
  // spec-sanctioned response for a server that does not offer GET.
  app.get("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST, DELETE").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "This server does not offer an SSE stream." },
      id: null,
    });
  });

  // Nothing is held server-side, so termination is a no-op the client may
  // still politely announce.
  app.delete("/mcp", (req, res) => {
    const sessionId = req.header(SESSION_HEADER);
    if (sessionId) logger.info({ sessionId }, "session_closed");
    res.status(204).end();
  });

  return app;
}

// Cap client-supplied strings before they flow into every log line and
// analytics event — clientInfo is attacker-controlled and unbounded.
function asString(v: unknown, maxLen = 200): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, maxLen) : undefined;
}

export function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function sendJsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

/**
 * Frame a bodyless MCP response with `Content-Length: 0`, never as an empty
 * chunked body.
 *
 * The SDK answers notifications and client JSON-RPC responses with
 * `new Response(null, { status: 202 })`, and @hono/node-server's own
 * fallbacks are bodyless too (400 for a Host header `new URL()` rewrites,
 * 500/504 if the handler rejects). hono writes each as
 * `writeHead(status, headers)` then `end()`. The explicit writeHead makes
 * Node fix the framing before it knows no body follows, so it picks
 * `Transfer-Encoding: chunked` and sends a zero-length chunked body — which
 * the production gateway turns into a bare 500, breaking client connect.
 *
 * Applying hono's headers with setHeader instead (what Node's writeHead does
 * internally once any header is set) defers that choice to the first write
 * or end: an empty end() gets `Content-Length: 0`, a JSON reply keeps its
 * exact length, and a streamed SSE reply stays chunked. hono's placeholder
 * `Content-Type: text/plain` is dropped when no body is sent.
 */
function frameBodylessResponses(res: Response): void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, statusCode: number, ...rest: unknown[]) {
    const headers = typeof rest[0] === "string" ? rest[1] : rest[0];
    // Node's implicit-header path re-enters as writeHead(statusCode) with no
    // headers to commit the status line; that call must pass straight through.
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
      return Reflect.apply(writeHead, this, [statusCode, ...rest]);
    }
    res.writeHead = writeHead;
    res.statusCode = statusCode;
    if (typeof rest[0] === "string") res.statusMessage = rest[0];
    for (const [name, value] of Object.entries(headers as OutgoingHttpHeaders)) {
      if (value !== undefined) res.setHeader(name, value);
    }
    return this;
  } as Response["writeHead"];

  const end = res.end;
  res.end = function (this: Response, ...args: unknown[]) {
    // No header block stored yet and no chunk: nothing was ever written.
    if (!res.headersSent && (args[0] == null || typeof args[0] === "function")) {
      res.removeHeader("content-type");
    }
    return Reflect.apply(end, this, args);
  } as Response["end"];
}
