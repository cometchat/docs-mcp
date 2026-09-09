import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { envVar } from "./lib/env.js";
import { sanitizeRef, sanitizeSessionId } from "./lib/attribution.js";
import { logger } from "./lib/logger.js";
import { SqliteSearchClient } from "./search/sqlite.js";
import { BundleStore } from "./bundles/loader.js";
import { ResourceRegistry } from "./resources/registry.js";
import { rateLimit, clientIp } from "./lib/rateLimit.js";
import {
  initAnalytics,
  capture,
  fingerprint,
  ipHash,
  isAnthropicEgress,
  shutdownAnalytics,
} from "./lib/analytics.js";
import { IndexRefresher } from "./index/refresher.js";
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

async function main() {
  const config = loadConfig();
  const searchClient = new SqliteSearchClient(config.indexPath);

  // In-container index refresh (opt-in). The baked image index is the boot
  // floor: serving never waits on, or depends on, GitHub being reachable.
  const refresher = config.indexAutoRefresh
    ? new IndexRefresher({
        searchClient,
        repoUrl: config.docsRepoUrl,
        ref: config.docsRef,
        pinnedCommit: config.docsCommitPin,
        workDir: config.indexWorkDir,
        pollIntervalMs: config.indexPollIntervalMs,
        keepGenerations: config.indexKeepGenerations,
        policy: {
          minPages: config.indexMinPages,
          maxDropRatio: config.indexMaxDropRatio,
        },
      })
    : null;
  const bundleStore = await BundleStore.load(config.bundlesDir, {
    strict: config.nodeEnv === "production",
  });
  const resources = await ResourceRegistry.load(config.skillsDir, bundleStore);


  const allowedHosts = parseList(envVar("ALLOWED_HOSTS")) ?? [
    `${config.host}:${config.port}`,
    `localhost:${config.port}`,
    `127.0.0.1:${config.port}`,
  ];
  const allowedOrigins = parseList(envVar("ALLOWED_ORIGINS"));
  const dnsRebindingProtection = envVar("DNS_REBINDING_PROTECTION") !== "false";

  initAnalytics();

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && (!allowedOrigins || allowedOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      `Content-Type, Authorization, ${SESSION_HEADER}, mcp-protocol-version, last-event-id`,
    );
    res.setHeader("Access-Control-Expose-Headers", SESSION_HEADER);
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

  const rateLimitMax = parseInt(envVar("RATE_LIMIT_MAX") ?? "120", 10);
  const rateLimitWindowMs = parseInt(envVar("RATE_LIMIT_WINDOW_MS") ?? "60000", 10);
  const rateLimitEnabled =
    envVar("RATE_LIMIT_ENABLED") !== "false" &&
    Number.isFinite(rateLimitMax) &&
    rateLimitMax > 0;

  if (rateLimitEnabled) {
    const limiter = rateLimit({ max: rateLimitMax, windowMs: rateLimitWindowMs });
    app.use("/mcp", limiter);
    logger.info(
      { max: rateLimitMax, windowMs: rateLimitWindowMs },
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
      ...(allowedOrigins ? { allowedOrigins } : {}),
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
      await transport.handleRequest(req, res, req.body);
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

  const server = app.listen(config.port, config.host, () => {
    logger.info(
      {
        host: config.host,
        port: config.port,
        version: SERVER_VERSION,
        bundles: bundleStore.list().length,
        resources: resources.list().length,
        indexReady: searchClient.isReady(),
        dnsRebindingProtection,
      },
      "server_listening",
    );
  });

  refresher?.start();

  const shutdown = async (signal: string) => {
    await refresher?.stop();
    logger.info({ signal }, "server_shutdown");
    server.close();
    // Flush the last analytics batch — skipping this loses the final
    // flushInterval's worth of events on every deploy.
    await shutdownAnalytics();
    searchClient.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Cap client-supplied strings before they flow into every log line and
// analytics event — clientInfo is attacker-controlled and unbounded.
function asString(v: unknown, maxLen = 200): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, maxLen) : undefined;
}

function parseList(raw: string | undefined): string[] | undefined {
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

main().catch((err) => {
  logger.fatal({ err }, "server_startup_failed");
  process.exit(1);
});
