// Process entrypoint for the Streamable HTTP server: loads config, the search
// index and bundles, starts the app from app.ts, and owns listening and shutdown.
import { loadConfig } from "./config.js";
import { envVar } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { SqliteSearchClient } from "./search/sqlite.js";
import { BundleStore } from "./bundles/loader.js";
import { ResourceRegistry } from "./resources/registry.js";
import { initAnalytics, shutdownAnalytics } from "./lib/analytics.js";
import { IndexRefresher } from "./index/refresher.js";
import { SERVER_VERSION } from "./mcp.js";
import { createApp, parseList } from "./app.js";

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
  const allowedOrigins = parseList(envVar("ALLOWED_ORIGINS")) ?? [];
  const dnsRebindingProtection = envVar("DNS_REBINDING_PROTECTION") !== "false";

  initAnalytics();

  const app = createApp({
    config,
    searchClient,
    bundleStore,
    resources,
    refresher,
    allowedHosts,
    allowedOrigins,
    dnsRebindingProtection,
  });

  const server = app.listen(config.port, config.host, (err?: Error) => {
    // Express 5 passes bind errors (EADDRINUSE, EACCES) to this callback
    // instead of crashing on an unhandled 'error' event. Unchecked, a port
    // clash would log server_listening and exit 0 with nothing bound.
    if (err) {
      logger.fatal({ err }, "server_startup_failed");
      process.exit(1);
    }
    logger.info(
      {
        host: config.host,
        port: config.port,
        version: SERVER_VERSION,
        bundles: bundleStore.list().length,
        resources: resources.list().length,
        indexReady: searchClient.isReady(),
        dnsRebindingProtection,
        allowedOrigins,
      },
      "server_listening",
    );
  });
  // Express only watches 'error' through a once() wrapper around the callback
  // above, which is spent after a successful bind, so a later server error (an
  // accept failure such as EMFILE) would vanish without a trace; Express 4 let
  // it crash the process. Node keeps accepting after one, so log it and keep
  // serving. Bind errors stay with the callback, hence the listening guard.
  server.on("error", (err) => {
    if (server.listening) logger.error({ err }, "server_error");
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

main().catch((err) => {
  logger.fatal({ err }, "server_startup_failed");
  process.exit(1);
});
