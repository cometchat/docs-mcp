import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { envVar } from "./lib/env.js";
import { sanitizeRef } from "./lib/attribution.js";
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
  const bundleStore = await BundleStore.load(config.bundlesDir, {
    strict: config.nodeEnv === "production",
  });
  const resources = await ResourceRegistry.load(config.skillsDir, bundleStore);

  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Set before the shutdown handler force-closes transports so session-ended
  // events can be told apart from genuine client disconnects: sessions that
  // were silently abandoned (network drop, no DELETE) only surface at the
  // next deploy, with duration_ms inflated to the whole abandonment window.
  let shuttingDown = false;

  const allowedHosts = parseList(envVar("ALLOWED_HOSTS")) ?? [
    `${config.host}:${config.port}`,
    `localhost:${config.port}`,
    `127.0.0.1:${config.port}`,
  ];
  const allowedOrigins = parseList(envVar("ALLOWED_ORIGINS"));
  const dnsRebindingProtection = envVar("DNS_REBINDING_PROTECTION") !== "false";

  initAnalytics();

  async function createSessionTransport(
    ref?: string,
    client?: ClientMeta,
    ip?: string,
  ): Promise<StreamableHTTPServerTransport> {
    const distinctId = fingerprint(client?.name, client?.version, ip);
    const sessionProps = {
      ref,
      client_name: client?.name,
      client_version: client?.version,
    };
    let startedAt = 0;
    let toolCalls = 0;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
        startedAt = Date.now();
        logger.info(
          { sessionId: sid, ...sessionProps, sessions: transports.size },
          "session_opened",
        );
        capture(distinctId, "mcp_session_started", {
          ...sessionProps,
          protocol_version: client?.protocolVersion,
          is_anthropic_egress: isAnthropicEgress(ip),
          ip_hash: ipHash(ip),
        });
      },
      enableDnsRebindingProtection: dnsRebindingProtection,
      allowedHosts,
      ...(allowedOrigins ? { allowedOrigins } : {}),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports.delete(sid)) {
        logger.info({ sessionId: sid, sessions: transports.size }, "session_closed");
        if (startedAt > 0) {
          capture(distinctId, "mcp_session_ended", {
            ...sessionProps,
            duration_ms: Date.now() - startedAt,
            tool_calls_in_session: toolCalls,
            ended_by: shuttingDown ? "server_shutdown" : "client",
          });
        }
      }
    };

    const server = buildMcpServer({
      config,
      searchClient,
      bundleStore,
      resources,
      attribution: { ref, sessionId: () => transport.sessionId },
      telemetry: {
        toolCall: (info) => {
          toolCalls += 1;
          capture(
            distinctId,
            info.status === "success" ? "mcp_tool_called" : "mcp_tool_failed",
            { ...sessionProps, ...info },
          );
        },
      },
    });
    await server.connect(transport);
    return transport;
  }

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

  app.get("/health", (_req, res) => {
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
      sessions: transports.size,
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

  app.post("/mcp", async (req, res) => {
    const sessionId = req.header(SESSION_HEADER);
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId) {
        sendJsonRpcError(res, 400, "Unknown or expired session ID.");
        return;
      }
      if (!isInitializeRequest(req.body)) {
        sendJsonRpcError(res, 400, "First request on a new session must be 'initialize'.");
        return;
      }
      try {
        // ENG-37100: links we control carry ?ref=<source> on the connect URL;
        // captured once at initialize, tagged on every call in the session.
        const params = (req.body as { params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown } } }).params;
        transport = await createSessionTransport(
          sanitizeRef(req.query.ref),
          {
            name: asString(params?.clientInfo?.name),
            version: asString(params?.clientInfo?.version),
            protocolVersion: asString(params?.protocolVersion),
          },
          clientIp(req),
        );
      } catch (err) {
        logger.error({ err }, "session_create_failed");
        sendJsonRpcError(res, 500, "Failed to initialize MCP session.");
        return;
      }
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.header(SESSION_HEADER);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

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

  const shutdown = async (signal: string) => {
    shuttingDown = true;
    logger.info({ signal, sessions: transports.size }, "server_shutdown");
    server.close();
    for (const t of transports.values()) {
      try {
        await t.close();
      } catch (err) {
        logger.warn({ err }, "transport_close_failed");
      }
    }
    transports.clear();
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
