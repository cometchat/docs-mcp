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
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  nodeEnv: z.enum(["development", "production", "test"]).default("development"),
  // In-container index refresh (opt-in: local dev and stdio are unaffected).
  indexAutoRefresh: z
    .string()
    .optional()
    .transform((v) => v === "true")
    .pipe(z.boolean())
    .default("false"),
  indexPollIntervalMs: z.coerce.number().int().positive().default(600_000),
  indexWorkDir: z.string().default("./data/generations"),
  indexKeepGenerations: z.coerce.number().int().min(1).max(10).default(2),
  indexMinPages: z.coerce.number().int().positive().default(2000),
  indexMaxDropRatio: z.coerce.number().min(0).max(1).default(0.2),
  docsRepoUrl: z.string().url().default("https://github.com/cometchat/docs.git"),
  docsRef: z.string().default("main"),
  /** Freeze on one commit; the poller stops following HEAD. */
  docsCommitPin: z.string().optional(),
  /** Unlocks the diagnostic fields on /health. Unset = never released. */
  healthDetailToken: z.string().optional(),
  // Per-IP rate limit on /mcp. Validated here so a bad value stops startup:
  // parsed ad hoc, a non-numeric max silently disabled the limiter and a
  // non-numeric window made every bucket's reset time NaN (a permanent 429).
  rateLimitEnabled: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  rateLimitMax: z.coerce.number().int().positive().default(120),
  rateLimitWindowMs: z.coerce.number().int().positive().default(60_000),
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
    logLevel: env("LOG_LEVEL"),
    nodeEnv: env("NODE_ENV"),
    indexAutoRefresh: env("INDEX_AUTO_REFRESH"),
    indexPollIntervalMs: env("INDEX_POLL_INTERVAL_MS"),
    indexWorkDir: env("INDEX_WORK_DIR"),
    indexKeepGenerations: env("INDEX_KEEP_GENERATIONS"),
    indexMinPages: env("INDEX_MIN_PAGES"),
    indexMaxDropRatio: env("INDEX_MAX_DROP_RATIO"),
    docsRepoUrl: env("DOCS_REPO_URL"),
    docsRef: env("DOCS_REF"),
    docsCommitPin: env("DOCS_COMMIT_PIN"),
    healthDetailToken: env("HEALTH_DETAIL_TOKEN"),
    rateLimitEnabled: env("RATE_LIMIT_ENABLED"),
    rateLimitMax: env("RATE_LIMIT_MAX"),
    rateLimitWindowMs: env("RATE_LIMIT_WINDOW_MS"),
  });
}
