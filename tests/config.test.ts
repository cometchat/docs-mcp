import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

// RATE_LIMIT_* used to be parsed with a bare parseInt in server.ts, outside
// the zod schema: a non-numeric max silently disabled the limiter, and a
// non-numeric window made every bucket's reset time NaN, so the first client
// to hit the limit was locked out for good. Bad values must now stop startup.
const KEYS = ["RATE_LIMIT_ENABLED", "RATE_LIMIT_MAX", "RATE_LIMIT_WINDOW_MS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadConfig — rate limit", () => {
  it("defaults to enabled, 120 requests per 60s", () => {
    const c = loadConfig();
    expect(c.rateLimitEnabled).toBe(true);
    expect(c.rateLimitMax).toBe(120);
    expect(c.rateLimitWindowMs).toBe(60_000);
  });

  it("treats an orchestrator-injected empty value as unset", () => {
    process.env.RATE_LIMIT_ENABLED = "";
    process.env.RATE_LIMIT_MAX = "  ";
    process.env.RATE_LIMIT_WINDOW_MS = "";
    const c = loadConfig();
    expect(c.rateLimitEnabled).toBe(true);
    expect(c.rateLimitMax).toBe(120);
    expect(c.rateLimitWindowMs).toBe(60_000);
  });

  it("reads valid overrides", () => {
    process.env.RATE_LIMIT_ENABLED = "false";
    process.env.RATE_LIMIT_MAX = "30";
    process.env.RATE_LIMIT_WINDOW_MS = "1000";
    const c = loadConfig();
    expect(c.rateLimitEnabled).toBe(false);
    expect(c.rateLimitMax).toBe(30);
    expect(c.rateLimitWindowMs).toBe(1000);
    process.env.RATE_LIMIT_ENABLED = "true";
    expect(loadConfig().rateLimitEnabled).toBe(true);
  });

  for (const bad of ["abc", "0", "-5", "1.5", "Infinity"]) {
    it(`rejects RATE_LIMIT_MAX=${bad}`, () => {
      process.env.RATE_LIMIT_MAX = bad;
      expect(() => loadConfig()).toThrow(/rateLimitMax/);
    });
  }

  for (const bad of ["1m", "0", "-1000", "2.5", "NaN"]) {
    it(`rejects RATE_LIMIT_WINDOW_MS=${bad}`, () => {
      process.env.RATE_LIMIT_WINDOW_MS = bad;
      expect(() => loadConfig()).toThrow(/rateLimitWindowMs/);
    });
  }

  for (const bad of ["yes", "0", "off", "FALSE"]) {
    it(`rejects RATE_LIMIT_ENABLED=${bad} instead of guessing`, () => {
      process.env.RATE_LIMIT_ENABLED = bad;
      expect(() => loadConfig()).toThrow(/rateLimitEnabled/);
    });
  }

  it("validates the limits even while the limiter is disabled", () => {
    process.env.RATE_LIMIT_ENABLED = "false";
    process.env.RATE_LIMIT_WINDOW_MS = "abc";
    expect(() => loadConfig()).toThrow(/rateLimitWindowMs/);
  });
});
