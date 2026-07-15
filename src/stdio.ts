import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { logger } from "./lib/logger.js";
import { SqliteSearchClient } from "./search/sqlite.js";
import { BundleStore } from "./bundles/loader.js";
import { ResourceRegistry } from "./resources/registry.js";
import { buildMcpServer, SERVER_VERSION } from "./mcp.js";

// Stdio entrypoint: `node dist/stdio.js`. Speaks MCP over stdin/stdout for
// local clients and sandboxes (e.g. Glama's mcp-proxy inspection). Logs go to
// stderr — stdout is reserved for JSON-RPC (see lib/logger.ts).
async function main() {
  const config = loadConfig();
  const searchClient = new SqliteSearchClient(config.indexPath);
  const bundleStore = await BundleStore.load(config.bundlesDir, {
    strict: config.nodeEnv === "production",
  });
  const resources = await ResourceRegistry.load(config.skillsDir, bundleStore);

  const server = buildMcpServer({ config, searchClient, bundleStore, resources });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(
    {
      version: SERVER_VERSION,
      transport: "stdio",
      bundles: bundleStore.list().length,
      resources: resources.list().length,
      indexReady: searchClient.isReady(),
    },
    "server_ready",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "server_shutdown");
    try {
      await server.close();
    } catch {
      // stdout may already be gone; nothing useful to do
    }
    searchClient.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "server_startup_failed");
  process.exit(1);
});
