import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { Attribution } from "./lib/attribution.js";
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
import {
  LIST_BUNDLES_TOOL_DEFINITION,
  LIST_BUNDLES_TOOL_NAME,
  runListBundles,
} from "./tools/list-bundles.js";
import { DASHBOARD_TOOL_NAMES, runDashboardTool, signInDashboardTools, visibleDashboardTools, type DashboardSession } from "./tools/dashboard/index.js";
import { DashboardAuthError } from "./lib/errors.js";

export const SERVER_NAME = "CometChat Docs";
export const SERVER_VERSION = readPackageVersion();

export const SERVER_INSTRUCTIONS =
  "Use this server to integrate CometChat — real-time chat, voice/video, and moderation — into web and mobile apps. Read the cometchat://skills/overview resource first for orientation. Use search_cometchat_docs for conceptual queries, fetch_cometchat_doc_page to read a specific page, and get_cometchat_implementation_bundle for ready-to-use recipes (React, Angular, React Native, Flutter, iOS, Android, JavaScript SDK, widget, moderation, multi-tenant, presence). Call list_cometchat_bundles to discover which bundles exist.";

export const DASHBOARD_INSTRUCTIONS =
  " This connection is also signed in to the user's CometChat account. Use the cometchat_ tools to read and manage it: apps and credentials, features, API keys, webhooks, users, groups, messages, moderation, push setup, roles, team, usage and call logs. Start with cometchat_whoami and cometchat_list_apps. Write credentials and keys to env files; never echo them. Ask the user before any change to their account; tools that change existing data or access return a summary instead of acting until you pass confirm: true, which you may only do after the user agrees. Deletes (cometchat_delete_*) can't be undone: before one, tell the user exactly what will be deleted and get their explicit OK.";

// For /mcp before sign-in (DASHBOARD_ON_MCP): the account tools are listed, and
// the first one called makes the client sign in.
export const DASHBOARD_SIGNIN_INSTRUCTIONS =
  " The cometchat_ tools read and manage the user's CometChat account: apps and credentials, features, API keys, webhooks, users, groups, messages, moderation, push setup, roles, team, usage and call logs. The first one you call asks the user to sign in to CometChat in their browser; the docs tools never need sign-in. Start with cometchat_whoami and cometchat_list_apps. Write credentials and keys to env files; never echo them. Ask the user before any change to their account; tools that change existing data or access return a summary instead of acting until you pass confirm: true, which you may only do after the user agrees. Deletes (cometchat_delete_*) can't be undone: before one, tell the user exactly what will be deleted and get their explicit OK.";

export interface McpServerDeps {
  config: Config;
  searchClient: SqliteSearchClient;
  bundleStore: BundleStore;
  resources: ResourceRegistry;
  /** Per-session attribution (ENG-37100/37101); absent on stdio. */
  attribution?: Attribution;
  /** Per-call analytics hook (ENG-37102); absent on stdio. */
  telemetry?: ToolCallTelemetry;
  /** Signed-in dashboard access. When absent, the account tools aren't offered (unless offerDashboardSignIn). */
  dashboard?: DashboardSession;
  /** Not signed in, but list the account tools anyway; calling one gets a sign-in challenge before it reaches here. */
  offerDashboardSignIn?: boolean;
}

export interface ToolCallInfo {
  tool: string;
  status: string;
  duration_ms: number;
  bundle_id?: string;
  error_code?: string;
}

export interface ToolCallTelemetry {
  toolCall: (info: ToolCallInfo) => void;
}

// Transport-agnostic MCP server wiring, shared by the Streamable HTTP entry
// (server.ts) and the stdio entry (stdio.ts).
export function buildMcpServer(deps: McpServerDeps): Server {
  const { config, searchClient, bundleStore, resources, attribution, telemetry, dashboard, offerDashboardSignIn } = deps;

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        // False is accurate: the resource list is fixed (the skill overview and
        // one entry per manifest bundle), and this stateless server has no
        // session to notify anyway.
        resources: { listChanged: false },
      },
      instructions: dashboard
        ? SERVER_INSTRUCTIONS + DASHBOARD_INSTRUCTIONS
        : offerDashboardSignIn
          ? SERVER_INSTRUCTIONS + DASHBOARD_SIGNIN_INSTRUCTIONS
          : SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      SEARCH_TOOL_DEFINITION,
      FETCH_TOOL_DEFINITION,
      BUNDLE_TOOL_DEFINITION,
      LIST_BUNDLES_TOOL_DEFINITION,
      ...(dashboard ? visibleDashboardTools(dashboard) : offerDashboardSignIn ? signInDashboardTools(config.dashboardReadOnly) : []),
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.list(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    let found;
    try {
      found = await resources.read(uri);
    } catch (err) {
      logger.warn({ uri, err: (err as Error).message }, "resource_read_failed");
      throw err;
    }
    if (!found) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return { contents: [found] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const start = Date.now();
    const { name, arguments: args } = req.params;
    // Per-call attribution fields (ENG-37101): one queryable record per call.
    // Populated by the SDK only on a Server that handled `initialize` — true
    // for stdio (one long-lived Server) but NOT for stateless HTTP, where a
    // fresh Server serves each request. On HTTP the per-call client is
    // unknowable by construction; correlate via session_id with the
    // `session_opened` line / `mcp_session_started` event instead.
    const client = server.getClientVersion();
    const callCtx = {
      tool: name,
      session_id: attribution?.sessionId?.(),
      ref: attribution?.ref,
      client_name: client?.name,
      client_version: client?.version,
    };
    const bundleId =
      name === BUNDLE_TOOL_NAME && typeof (args as { bundle?: unknown })?.bundle === "string"
        ? (args as { bundle: string }).bundle.slice(0, 100)
        : undefined;
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
          result = await runBundle(args, bundleStore);
          break;
        case LIST_BUNDLES_TOOL_NAME:
          result = runListBundles(bundleStore);
          break;
        default:
          if (DASHBOARD_TOOL_NAMES.has(name)) {
            if (!dashboard) {
              throw new DashboardAuthError(
                config.dashboardEnabled
                  ? "This tool needs a signed-in CometChat account, and this server doesn't offer the account tools on /mcp (DASHBOARD_ON_MCP=false)."
                  : "This tool needs a signed-in CometChat account, and account tools are not enabled on this server.",
              );
            }
            result = await runDashboardTool(name, args, dashboard);
            break;
          }
          // Unknown tool is a protocol error (-32602), not a tool-result error
          // (matches the SDK's own McpServer behavior).
          throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
      }
      logger.info(
        { ...callCtx, duration_ms: Date.now() - start, status: "success" },
        "tool_invocation",
      );
      telemetry?.toolCall({
        tool: name,
        status: "success",
        duration_ms: Date.now() - start,
        bundle_id: bundleId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (err) {
      if (err instanceof McpError) throw err;
      const structured = asStructured(err);
      if (structured.code === "internal_error") {
        logger.error({ ...callCtx, err }, "tool_invocation_failed");
      } else {
        logger.warn(
          {
            ...callCtx,
            duration_ms: Date.now() - start,
            status: structured.code,
          },
          "tool_invocation_handled_error",
        );
      }
      telemetry?.toolCall({
        tool: name,
        status: structured.code,
        duration_ms: Date.now() - start,
        bundle_id: bundleId,
        error_code: structured.code,
      });
      return errorResult(structured.message, structured.code, structured.details);
    }
  });

  return server;
}

function errorResult(message: string, code = "error", details?: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } }) }],
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
