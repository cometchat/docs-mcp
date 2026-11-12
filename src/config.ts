import { z } from "zod";
import { envVar as env } from "./lib/env.js";

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default("0.0.0.0"),
  docsBaseUrl: z.string().url().default("https://www.cometchat.com/docs"),
  indexPath: z.string().default("./data/index.sqlite"),
  skillsDir: z.string().default("./skills"),
  fetchTimeoutMs: z.coerce.number().int().positive().default(5000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
  // Dashboard account tools on /mcp/dashboard (OAuth sign-in). Off unless
  // DASHBOARD_ENABLED=true; then DASHBOARD_TOKEN_SECRET is required.
  dashboardEnabled: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Also offer the account tools on /mcp itself: the docs tools stay open, and
   * the first account tool call without a token gets a 401 so the client signs
   * in. /mcp/dashboard keeps working either way. Needs DASHBOARD_ENABLED, and
   * follows it when unset: DASHBOARD_ON_MCP=false keeps /mcp docs-only.
   */
  dashboardOnMcp: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  /** Seals OAuth clients, codes and tokens. 32+ random characters; rotating it signs everyone out. */
  dashboardTokenSecret: z.string().min(32).optional(),
  /** The secret before a rotation, still accepted for opening existing sign-ins. Remove after 30 days. */
  dashboardTokenSecretPrevious: z.string().min(32).optional(),
  /** Public base URL clients reach this server at; the OAuth issuer. */
  publicUrl: z.string().url().default("https://mcp.cometchat.com"),
  dashboardApiHost: z.string().url().default("https://apimgmt.cc-cluster-2.io"),
  dashboardHost: z.string().url().default("https://app.cometchat.com"),
  /**
   * How a dashboard sign-in finishes. "poll" (default, works with today's
   * dashboard): the sign-in page polls until the dashboard hands back a token;
   * a forwarded sign-in link hands the token to whoever started the sign-in,
   * the same as `cometchat auth login` today. "confirm": the user allows the
   * tool on the dashboard, which returns the same browser with a one-time
   * verifier. Needs mgmt-api#935 and customer-dashboard#2602 released first.
   */
  dashboardSignInFlow: z.enum(["confirm", "poll"]).default("poll"),
  /**
   * Show a connecting app's own logo (its registered logo_uri) on the sign-in
   * page when it isn't a known app and isn't unverified. The server fetches it
   * (https, public addresses, small images only). false shows the initial.
   */
  dashboardClientLogos: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Offer only read tools on every connection, whatever the token allows. */
  dashboardReadOnly: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Max account changes per signed-in user per minute, per replica (0 = unlimited). */
  dashboardWritesPerMinute: z.coerce.number().int().min(0).default(30),
  /**
   * Sign-in requests (/register, /authorize, /token) per client IP per minute,
   * per endpoint and replica. Sized for a whole office behind one NAT address.
   */
  dashboardAuthRequestsPerMinute: z.coerce.number().int().positive().default(30),
  /**
   * Cut off sign-ins without a database: comma-separated `actor:unixSeconds`
   * entries. Tokens for that actor from sign-ins before that time stop working
   * (access and refresh). `*` as the actor means everyone.
   * `npm run revoke-sign-in -- <email>` prints an entry.
   */
  dashboardRevokedSignIns: z.string().default(""),
  /**
   * Exact https callback addresses (origin + path, comma-separated) whose
   * sign-ins count as a known AI tool. Loopback and known app-scheme redirects
   * are always known: a phishing page can't receive them on the victim's
   * machine. Any other https redirect is shown as an unverified app and gets
   * read-only access.
   */
  dashboardTrustedRedirectUris: z.string().default("https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback"),
  /** Let unverified apps ask for write access too (not recommended). */
  dashboardAllowUnverifiedWrite: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * High-risk changes (webhooks, API keys, auth tokens, team invites, app
   * settings) need the user's OK in the browser they signed in with, not just
   * `confirm: true` from the model. Turn off only for testing.
   */
  dashboardBrowserApproval: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Keys the pseudonymous actor ids in audit lines and revocations, so they
   * can't be reversed by hashing guessed emails. 32+ random characters. When
   * unset it's derived from DASHBOARD_TOKEN_SECRET, so set it explicitly to
   * keep actor ids stable across a secret rotation.
   */
  dashboardActorSalt: z.string().trim().min(32).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const config = ConfigSchema.parse({
    port: env("PORT"),
    host: env("HOST"),
    docsBaseUrl: env("DOCS_BASE_URL"),
    indexPath: env("INDEX_PATH"),
    skillsDir: env("SKILLS_DIR"),
    fetchTimeoutMs: env("FETCH_TIMEOUT_MS"),
    logLevel: env("LOG_LEVEL"),
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
    dashboardEnabled: env("DASHBOARD_ENABLED"),
    dashboardOnMcp: env("DASHBOARD_ON_MCP"),
    dashboardTokenSecret: env("DASHBOARD_TOKEN_SECRET"),
    dashboardTokenSecretPrevious: env("DASHBOARD_TOKEN_SECRET_PREVIOUS"),
    publicUrl: env("PUBLIC_URL"),
    dashboardApiHost: env("DASHBOARD_API_HOST"),
    dashboardHost: env("DASHBOARD_HOST"),
    dashboardReadOnly: env("DASHBOARD_READ_ONLY"),
    dashboardWritesPerMinute: env("DASHBOARD_WRITES_PER_MINUTE"),
    dashboardAuthRequestsPerMinute: env("DASHBOARD_AUTH_REQUESTS_PER_MINUTE"),
    dashboardRevokedSignIns: env("DASHBOARD_REVOKED_SIGN_INS"),
    dashboardTrustedRedirectUris: env("DASHBOARD_TRUSTED_REDIRECT_URIS"),
    dashboardAllowUnverifiedWrite: env("DASHBOARD_ALLOW_UNVERIFIED_WRITE"),
    dashboardBrowserApproval: env("DASHBOARD_BROWSER_APPROVAL"),
    dashboardSignInFlow: env("DASHBOARD_SIGNIN_FLOW"),
    dashboardClientLogos: env("DASHBOARD_CLIENT_LOGOS"),
    dashboardActorSalt: env("DASHBOARD_ACTOR_SALT"),
  });
  if (config.dashboardEnabled && !config.dashboardTokenSecret) {
    throw new Error("DASHBOARD_TOKEN_SECRET (32+ characters) is required when DASHBOARD_ENABLED=true");
  }
  return { ...config, dashboardOnMcp: config.dashboardOnMcp ?? config.dashboardEnabled };
}
