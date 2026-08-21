import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";
import { envVar } from "./env.js";
import { logger } from "./logger.js";
import { SERVER_VERSION } from "../mcp.js";

// PostHog usage-analytics sink (ENG-37102). Everything here is fail-safe:
// absent POSTHOG_KEY = no-op (local dev, stdio, tests), and capture() never
// throws — telemetry must not be able to take the server down.

// Anthropic's documented egress range (IPv4 only). claude.ai web, Claude
// Desktop connectors, and API MCP-connector calls all originate here, so the
// per-IP fingerprint collapses for these surfaces — report them as sessions,
// not deduped clients.
const ANTHROPIC_EGRESS_BASE = ipv4ToInt("160.79.104.0");
const ANTHROPIC_EGRESS_PREFIX_BITS = 21;

let client: PostHog | undefined;

/** Reads env and enables the sink. Returns whether analytics is on. */
export function initAnalytics(): boolean {
  const key = envVar("POSTHOG_KEY");
  if (!key) return false;
  const salt = envVar("ANALYTICS_SALT");
  if (!salt) {
    // Unsalted fingerprints would be trivially reversible IP hashes; refuse
    // to run half-configured rather than emit them.
    logger.warn("analytics_disabled_missing_salt");
    return false;
  }
  const host = envVar("POSTHOG_HOST") ?? "https://us.i.posthog.com";
  client = new PostHog(key, { host });
  // Without this, delivery failures (bad key, blocked egress) are swallowed
  // by the SDK and the metric silently reads zero.
  client.on("error", (err) => logger.warn({ err }, "analytics_delivery_failed"));
  logger.info({ host }, "analytics_enabled");
  return true;
}

/** Stable per-client id: salted hash of clientInfo + ip, namespaced so it can
 *  never collide with real CometChat distinct_ids. */
export function fingerprint(name?: string, version?: string, ip?: string): string {
  return "mcp:" + saltedHash(`${name ?? ""}|${version ?? ""}|${ip ?? ""}`);
}

/** Salted hash of the ip alone (NAT/VPN analysis). Never store raw IPs. */
export function ipHash(ip?: string): string | undefined {
  return ip ? saltedHash(ip) : undefined;
}

export function isAnthropicEgress(ip?: string): boolean {
  if (!ip) return false;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const n = ipv4ToInt(v4);
  if (n === undefined) return false;
  const shift = 32 - ANTHROPIC_EGRESS_PREFIX_BITS;
  return n >>> shift === (ANTHROPIC_EGRESS_BASE as number) >>> shift;
}

export function capture(
  distinctId: string,
  event: string,
  properties: Record<string, unknown>,
): void {
  if (!client) return;
  try {
    client.capture({
      distinctId,
      event,
      properties: {
        ...properties,
        source: "docs-mcp",
        server_version: SERVER_VERSION,
        $process_person_profile: false,
      },
    });
  } catch (err) {
    logger.warn({ err }, "analytics_capture_failed");
  }
}

/** Flush the final batch. Must run in the SIGTERM path or the last
 *  flushInterval's worth of events is lost on every deploy. The 5s budget
 *  stays well under ECS's 30s stopTimeout — with the SDK's default 30s an
 *  unreachable PostHog would eat the whole grace period and turn every
 *  deploy-time stop into a SIGKILL. */
export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown(5000);
  } catch (err) {
    logger.warn({ err }, "analytics_shutdown_failed");
  }
}

function saltedHash(input: string): string {
  const salt = envVar("ANALYTICS_SALT") ?? "";
  return createHash("sha256").update(`${salt}|${input}`).digest("hex").slice(0, 32);
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    n = n * 256 + octet;
  }
  return n;
}
