import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { logger } from "./lib/logger.js";
import { asStructured } from "./lib/errors.js";
import { SqliteSearchClient } from "./search/sqlite.js";
import { BundleStore } from "./bundles/loader.js";
import { ResourceRegistry } from "./resources/registry.js";
import { rateLimit } from "./lib/rateLimit.js";
import {
  SEARCH_TOOL_DEFINITION,
  SEARCH_TOOL_NAME,
  runSearch,
} from "./tools/search.js";
import {
  FETCH_TOOL_DEFINITION,
  FETCH_TOOL_NAME,
  runFetch,
} from "./tools/fetch.js";
import {
  BUNDLE_TOOL_DEFINITION,
  BUNDLE_TOOL_NAME,
  runBundle,
} from "./tools/bundle.js";

const SERVER_NAME = "CometChat Docs";
const SERVER_VERSION = readPackageVersion();
const SESSION_HEADER = "mcp-session-id";

const SERVER_INSTRUCTIONS =
  "Use this server to integrate CometChat — real-time chat, voice/video, and moderation — into web and mobile apps. Read the cometchat://skills/overview resource first for orientation. Use search_cometchat_docs for conceptual queries, fetch_cometchat_doc_page to read a specific page, and get_cometchat_implementation_bundle for ready-to-use recipes (React, React Native, Flutter, iOS, Android, JavaScript SDK, widget, moderation, multi-tenant, presence).";

async function main() {
  const config = loadConfig();
  const searchClient = new SqliteSearchClient(config.indexPath);
  const bundleStore = await BundleStore.load(config.bundlesDir, {
    strict: config.nodeEnv === "production",
  });
  const resources = await ResourceRegistry.load(config.skillsDir, bundleStore);

  const transports = new Map<string, StreamableHTTPServerTransport>();

  function buildServer(): Server {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
        },
        instructions: SERVER_INSTRUCTIONS,
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [SEARCH_TOOL_DEFINITION, FETCH_TOOL_DEFINITION, BUNDLE_TOOL_DEFINITION],
    }));

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: resources.list(),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const uri = req.params.uri;
      const found = resources.read(uri);
      if (!found) {
        throw new Error(`Resource not found: ${uri}`);
      }
      return { contents: [found] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const start = Date.now();
      const { name, arguments: args } = req.params;
      try {
        let result: unknown;
        switch (name) {
          case SEARCH_TOOL_NAME:
            result = await runSearch(args, searchClient);
            break;
          case FETCH_TOOL_NAME:
            result = await runFetch(args, {
              docsBaseUrl: config.docsBaseUrl,
              timeoutMs: config.fetchTimeoutMs,
            });
            break;
          case BUNDLE_TOOL_NAME:
            result = runBundle(args, bundleStore);
            break;
          default:
            return errorResult(`Unknown tool '${name}'.`);
        }
        logger.info(
          { tool: name, duration_ms: Date.now() - start, status: "success" },
          "tool_invocation",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const structured = asStructured(err);
        if (structured.code === "internal_error") {
          logger.error({ tool: name, err }, "tool_invocation_failed");
        } else {
          logger.warn(
            {
              tool: name,
              duration_ms: Date.now() - start,
              status: structured.code,
            },
            "tool_invocation_handled_error",
          );
        }
        return errorResult(structured.message, structured.code);
      }
    });

    return server;
  }

  const allowedHosts = parseList(process.env.ALLOWED_HOSTS) ?? [
    `${config.host}:${config.port}`,
    `localhost:${config.port}`,
    `127.0.0.1:${config.port}`,
  ];
  const allowedOrigins = parseList(process.env.ALLOWED_ORIGINS);
  const dnsRebindingProtection = process.env.DNS_REBINDING_PROTECTION !== "false";

  async function createSessionTransport(): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
        logger.info({ sessionId: sid, sessions: transports.size }, "session_opened");
      },
      enableDnsRebindingProtection: dnsRebindingProtection,
      allowedHosts,
      ...(allowedOrigins ? { allowedOrigins } : {}),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports.delete(sid)) {
        logger.info({ sessionId: sid, sessions: transports.size }, "session_closed");
      }
    };

    const server = buildServer();
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

  const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX ?? "120", 10);
  const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10);
  const rateLimitEnabled =
    process.env.RATE_LIMIT_ENABLED !== "false" &&
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
        transport = await createSessionTransport();
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
    searchClient.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
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

function errorResult(message: string, code = "error") {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
  };
}

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main().catch((err) => {
  logger.fatal({ err }, "server_startup_failed");
  process.exit(1);
});
