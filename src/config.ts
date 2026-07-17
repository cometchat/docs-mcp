import { z } from "zod";

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

// Treat empty-string env vars as unset: orchestrators (sandboxes, PaaS UIs)
// commonly inject declared-but-empty variables, and "" would otherwise
// override defaults and break paths/enums.
function env(name: string): string | undefined {
  const v = process.env[name];
  return v === "" ? undefined : v;
}

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
