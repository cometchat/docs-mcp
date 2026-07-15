import pino from "pino";
import { loadConfig } from "../config.js";

const config = loadConfig();

// In stdio mode stdout carries MCP JSON-RPC frames, so logs must go to stderr.
// Detected via the entry script (dist/stdio.js, or src/stdio.ts under tsx)
// because this module is evaluated before any entrypoint code runs; the env
// var is an explicit override for embedding scenarios.
const stdioMode =
  process.env.MCP_TRANSPORT === "stdio" ||
  /stdio\.(js|ts)$/.test(process.argv[1] ?? "");

export const logger = pino(
  {
    level: config.logLevel,
    base: { service: "cometchat-mcp" },
    redact: ["req.headers.authorization", "req.headers.cookie"],
  },
  pino.destination(stdioMode ? 2 : 1),
);
