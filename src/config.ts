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

export function loadConfig(): Config {
  return ConfigSchema.parse({
    port: process.env.PORT,
    host: process.env.HOST,
    docsBaseUrl: process.env.DOCS_BASE_URL,
    indexPath: process.env.INDEX_PATH,
    bundlesDir: process.env.BUNDLES_DIR,
    skillsDir: process.env.SKILLS_DIR,
    fetchTimeoutMs: process.env.FETCH_TIMEOUT_MS,
    searchTimeoutMs: process.env.SEARCH_TIMEOUT_MS,
    logLevel: process.env.LOG_LEVEL,
    nodeEnv: process.env.NODE_ENV,
  });
}
