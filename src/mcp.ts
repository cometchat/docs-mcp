import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { logger } from "./lib/logger.js";
import { asStructured } from "./lib/errors.js";
import type { SqliteSearchClient } from "./search/sqlite.js";
import type { BundleStore } from "./bundles/loader.js";
import type { ResourceRegistry } from "./resources/registry.js";
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

export const SERVER_NAME = "CometChat Docs";
export const SERVER_VERSION = readPackageVersion();

export const SERVER_INSTRUCTIONS =
  "Use this server to integrate CometChat — real-time chat, voice/video, and moderation — into web and mobile apps. Read the cometchat://skills/overview resource first for orientation. Use search_cometchat_docs for conceptual queries, fetch_cometchat_doc_page to read a specific page, and get_cometchat_implementation_bundle for ready-to-use recipes (React, React Native, Flutter, iOS, Android, JavaScript SDK, widget, moderation, multi-tenant, presence).";

export interface McpServerDeps {
  config: Config;
  searchClient: SqliteSearchClient;
  bundleStore: BundleStore;
  resources: ResourceRegistry;
}

// Transport-agnostic MCP server wiring, shared by the Streamable HTTP entry
// (server.ts) and the stdio entry (stdio.ts).
export function buildMcpServer(deps: McpServerDeps): Server {
  const { config, searchClient, bundleStore, resources } = deps;

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
