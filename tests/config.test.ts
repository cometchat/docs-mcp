import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { loadConfig } from "../src/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const KEYS = ["RATE_LIMIT_ENABLED", "RATE_LIMIT_MAX", "RATE_LIMIT_WINDOW_MS", "SEARCH_TIMEOUT_MS"] as const;
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

// RATE_LIMIT_* used to be parsed with a bare parseInt in server.ts, outside
// the zod schema: a non-numeric max silently disabled the limiter, and a
// non-numeric window made every bucket's reset time NaN, so the first client
// to hit the limit was locked out for good. Bad values must now stop startup.
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

// SEARCH_TIMEOUT_MS was parsed from the initial commit on and never read, so
// setting it changed nothing, yet a malformed value still stopped startup.
// Every setting loadConfig parses must be read somewhere in src. Both sides are
// matched on the TypeScript syntax tree, so a comment or a string that mentions
// config.<key> can neither satisfy this check nor break it.

type Setting = { key: string; name: string };

const parseTs = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);

/** The `key: env("NAME")` entries of the object literal passed to ConfigSchema.parse. */
function parsedSettings(): Setting[] {
  const settings: Setting[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ConfigSchema" &&
      node.expression.name.text === "parse" &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const prop of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const init = prop.initializer;
        if (
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "env" &&
          init.arguments.length === 1 &&
          ts.isStringLiteral(init.arguments[0])
        ) {
          settings.push({ key: prop.name.text, name: init.arguments[0].text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parseTs(path.join(ROOT, "src", "config.ts")));
  return settings;
}

/** The keys of the object literal passed to z.object in `const ConfigSchema = z.object({...})`. */
function schemaKeys(): string[] {
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "ConfigSchema" &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0])
    ) {
      for (const prop of node.initializer.arguments[0].properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) keys.push(prop.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parseTs(path.join(ROOT, "src", "config.ts")));
  return keys;
}

/** Which of `keys` are read as `config.<key>` or `<expr>.config.<key>` in `files`. */
function keysReadFromConfig(files: string[], keys: ReadonlySet<string>): Set<string> {
  const read = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && keys.has(node.name.text)) {
      const target = node.expression;
      if (
        (ts.isIdentifier(target) && target.text === "config") ||
        (ts.isPropertyAccessExpression(target) && target.name.text === "config")
      ) {
        read.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) visit(parseTs(file));
  return read;
}

describe("loadConfig — settings inventory", () => {
  it("reads every setting it parses somewhere in src", () => {
    const settings = parsedSettings();
    // Guards against a vacuous pass: the match must still find every key
    // loadConfig returns (zod keeps optional keys passed as undefined).
    expect(settings.length).toBeGreaterThanOrEqual(20);
    expect(settings.map((s) => s.key).sort()).toEqual(Object.keys(loadConfig()).sort());
    // An optional key whose env() entry is deleted drops out of both sides above.
    expect(schemaKeys().sort()).toEqual(settings.map((s) => s.key).sort());
    // The encoding selects readdirSync's string[] overload, which lint needs.
    const files = readdirSync(path.join(ROOT, "src"), { recursive: true, encoding: "utf8" }).filter(
      (f) => f.endsWith(".ts") && f !== "config.ts",
    );
    expect(files).toContain(path.join("search", "sqlite.ts")); // the walk recursed
    const read = keysReadFromConfig(
      files.map((f) => path.join(ROOT, "src", f)),
      new Set(settings.map((s) => s.key)),
    );
    const unused = settings.filter((s) => !read.has(s.key)).map((s) => `${s.key} (${s.name})`);
    expect(
      unused,
      "parsed in src/config.ts but never read as config.<key> in src: use it or remove it (update this test if config access changes style)",
    ).toEqual([]);
  });

  // Delete this test deliberately if a real per-search time budget is ever added.
  it("ignores SEARCH_TIMEOUT_MS, which no code ever read", () => {
    process.env.SEARCH_TIMEOUT_MS = "abc";
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig()).not.toHaveProperty("searchTimeoutMs");
  });
});
