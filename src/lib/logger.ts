import pino from "pino";
import { loadConfig } from "../config.js";

const config = loadConfig();

export const logger = pino({
  level: config.logLevel,
  base: { service: "cometchat-mcp" },
  redact: ["req.headers.authorization", "req.headers.cookie"],
});
