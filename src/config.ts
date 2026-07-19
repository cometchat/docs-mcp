import { z } from "zod";
import { envVar as env } from "./lib/env.js";

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default("0.0.0.0"),
  docsBaseUrl: z.string().url().default("https://www.cometchat.com/docs"),
  indexPath: z.string().default("./data/index.sqlite"),
  bundlesDir: z.string().default("./bundles"),
  skillsDir: z.string().default("./skills"),
  fetchTimeoutMs: z.coerce.number().int().positive().default(5000),
  searchTimeoutMs: z.coerce.number().int().positive().default(5000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  nodeEnv: z.enum(["development", "production", "test"]).default("development"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse({
    port: env("PORT"),
    host: env("HOST"),
    docsBaseUrl: env("DOCS_BASE_URL"),
    indexPath: env("INDEX_PATH"),
    bundlesDir: env("BUNDLES_DIR"),
    skillsDir: env("SKILLS_DIR"),
    fetchTimeoutMs: env("FETCH_TIMEOUT_MS"),
    searchTimeoutMs: env("SEARCH_TIMEOUT_MS"),
    logLevel: env("LOG_LEVEL"),
    nodeEnv: env("NODE_ENV"),
  });
}
