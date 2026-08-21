import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initAnalytics,
  capture,
  fingerprint,
  ipHash,
  isAnthropicEgress,
  shutdownAnalytics,
} from "../src/lib/analytics.js";
import { clientIp } from "../src/lib/rateLimit.js";
import type { Request } from "express";

const ENV_KEYS = ["POSTHOG_KEY", "POSTHOG_HOST", "ANALYTICS_SALT"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("initAnalytics", () => {
  it("is disabled without POSTHOG_KEY", () => {
    expect(initAnalytics()).toBe(false);
  });

  it("refuses to run with a key but no salt (fail-safe, not fail-open)", () => {
    process.env.POSTHOG_KEY = "phc_test";
    expect(initAnalytics()).toBe(false);
  });

  it("treats empty-string env as unset (orchestrator-injected empties)", () => {
    process.env.POSTHOG_KEY = "  ";
    expect(initAnalytics()).toBe(false);
  });
});

describe("capture / shutdown without init", () => {
  it("are clean no-ops", async () => {
    expect(() => capture("mcp:x", "mcp_session_started", {})).not.toThrow();
    await expect(shutdownAnalytics()).resolves.toBeUndefined();
  });
});

describe("fingerprint", () => {
  it("is namespaced and fixed-length", () => {
    const fp = fingerprint("claude-ai", "1.0", "1.2.3.4");
    expect(fp).toMatch(/^mcp:[0-9a-f]{32}$/);
  });

  it("is deterministic for identical inputs", () => {
    expect(fingerprint("a", "b", "c")).toBe(fingerprint("a", "b", "c"));
  });

  it("differs when any component changes", () => {
    const base = fingerprint("claude-ai", "1.0", "1.2.3.4");
    expect(fingerprint("cursor", "1.0", "1.2.3.4")).not.toBe(base);
    expect(fingerprint("claude-ai", "2.0", "1.2.3.4")).not.toBe(base);
    expect(fingerprint("claude-ai", "1.0", "5.6.7.8")).not.toBe(base);
  });

  it("changes when the salt rotates", () => {
    process.env.ANALYTICS_SALT = "salt-one";
    const one = fingerprint("a", "b", "c");
    process.env.ANALYTICS_SALT = "salt-two";
    expect(fingerprint("a", "b", "c")).not.toBe(one);
  });

  it("does not embed inputs verbatim (hashed, not concatenated)", () => {
    expect(fingerprint("claude-ai", "1.0", "1.2.3.4")).not.toContain("1.2.3.4");
  });
});

describe("ipHash", () => {
  it("returns undefined for missing ip", () => {
    expect(ipHash(undefined)).toBeUndefined();
    expect(ipHash("")).toBeUndefined();
  });

  it("hashes deterministically and differs from fingerprint", () => {
    expect(ipHash("1.2.3.4")).toBe(ipHash("1.2.3.4"));
    expect(ipHash("1.2.3.4")).not.toBe(fingerprint(undefined, undefined, "1.2.3.4"));
  });
});

describe("clientIp (rightmost XFF hop — spoofing resistance)", () => {
  const reqWith = (xff?: string): Request =>
    ({
      header: (name: string) =>
        name.toLowerCase() === "x-forwarded-for" ? xff : undefined,
      ip: "203.0.113.9",
      socket: { remoteAddress: "203.0.113.9" },
    }) as unknown as Request;

  it("takes the last hop, not the client-forgeable first", () => {
    // Attacker sends their own XFF; the proxy appends the real address last.
    expect(clientIp(reqWith("160.79.104.9, 198.51.100.7"))).toBe("198.51.100.7");
  });

  it("single hop (proxy replaced or appended to empty) still works", () => {
    expect(clientIp(reqWith("198.51.100.7"))).toBe("198.51.100.7");
  });

  it("falls back to the socket address without XFF", () => {
    expect(clientIp(reqWith(undefined))).toBe("203.0.113.9");
  });

  it("a spoofed Anthropic-egress first hop does not classify as Anthropic", () => {
    expect(isAnthropicEgress(clientIp(reqWith("160.79.104.9, 198.51.100.7")))).toBe(false);
  });
});

describe("isAnthropicEgress (160.79.104.0/21)", () => {
  it("matches the range boundaries", () => {
    expect(isAnthropicEgress("160.79.104.0")).toBe(true);
    expect(isAnthropicEgress("160.79.111.255")).toBe(true);
  });

  it("rejects adjacent addresses just outside the /21", () => {
    expect(isAnthropicEgress("160.79.103.255")).toBe(false);
    expect(isAnthropicEgress("160.79.112.0")).toBe(false);
  });

  it("handles IPv6-mapped IPv4 (Node sockets report ::ffff: prefixes)", () => {
    expect(isAnthropicEgress("::ffff:160.79.105.5")).toBe(true);
    expect(isAnthropicEgress("::ffff:8.8.8.8")).toBe(false);
  });

  it("rejects non-IPv4 and malformed input", () => {
    expect(isAnthropicEgress(undefined)).toBe(false);
    expect(isAnthropicEgress("")).toBe(false);
    expect(isAnthropicEgress("2607:f8b0::1")).toBe(false);
    expect(isAnthropicEgress("160.79.104")).toBe(false);
    expect(isAnthropicEgress("160.79.104.999")).toBe(false);
    expect(isAnthropicEgress("not-an-ip")).toBe(false);
    expect(isAnthropicEgress("160.79.104.0x1")).toBe(false);
  });
});
