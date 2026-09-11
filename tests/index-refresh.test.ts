import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ExecFileException } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  validateCandidate,
  generationsToPrune,
  PoisonedCommits,
  DEFAULT_POLICY,
  type IndexStats,
} from "../src/index/validate.js";
import {
  buildExit,
  describeBuildFailure,
  inspectIndex,
  summarizeBuildOutput,
  type BuildExit,
} from "../src/index/refresher.js";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { loadConfig } from "../src/config.js";

let workDir: string;

/**
 * Builds a miniature index with the production schema. `product` adds the
 * column the builder fills from docs.json navigation.
 */
function makeIndex(
  file: string,
  rows: Array<{ title: string; body: string; product?: string | null }>,
  opts: { product?: boolean } = {},
): void {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
      title TEXT NOT NULL, section TEXT NOT NULL, ${opts.product ? "product TEXT, " : ""}version TEXT,
      body TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      title, body, section, version,
      content='pages', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, body, section, version)
      VALUES (new.id, new.title, new.body, new.section, COALESCE(new.version, ''));
    END;
  `);
  if (opts.product) {
    const ins = db.prepare(
      "INSERT INTO pages (path,url,title,section,product,version,body) VALUES (?,?,?,?,?,?,?)",
    );
    rows.forEach((r, i) => ins.run(`/p${i}`, `https://x/p${i}`, r.title, "Sec", r.product ?? null, null, r.body));
  } else {
    const ins = db.prepare(
      "INSERT INTO pages (path,url,title,section,version,body) VALUES (?,?,?,?,?,?)",
    );
    rows.forEach((r, i) => ins.run(`/p${i}`, `https://x/p${i}`, r.title, "Sec", null, r.body));
  }
  // Same finalization the real builder does: single-file, read-only safe.
  db.pragma("journal_mode = DELETE");
  db.close();
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "idx-refresh-test-"));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("validateCandidate", () => {
  const good: IndexStats = { pages: 3000, journalMode: "delete", bytes: 20_000_000 };

  it("accepts a healthy candidate with no current index", () => {
    expect(validateCandidate(good, null)).toEqual({ ok: true });
  });

  it("rejects a WAL-mode index (unsafe on a read-only mount)", () => {
    const r = validateCandidate({ ...good, journalMode: "wal" }, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("wal_journal");
  });

  it("rejects WAL regardless of case", () => {
    const r = validateCandidate({ ...good, journalMode: "WAL" }, null);
    expect(r.ok).toBe(false);
  });

  it("rejects an index below the absolute page floor", () => {
    const r = validateCandidate({ ...good, pages: 12 }, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("below_min_pages");
  });

  it("rejects an empty file", () => {
    const r = validateCandidate({ ...good, bytes: 0 }, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("empty_file");
  });

  // The case an absolute floor alone misses: a big regression that is still
  // comfortably above minPages.
  it("rejects a >20% page-count regression against the served index", () => {
    const current: IndexStats = { pages: 3000, journalMode: "delete", bytes: 1 };
    const r = validateCandidate({ ...good, pages: 2300 }, current);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("page_count_regression");
  });

  it("accepts a drop inside the tolerance", () => {
    const current: IndexStats = { pages: 3000, journalMode: "delete", bytes: 1 };
    expect(validateCandidate({ ...good, pages: 2500 }, current)).toEqual({ ok: true });
  });

  it("accepts growth", () => {
    const current: IndexStats = { pages: 3000, journalMode: "delete", bytes: 1 };
    expect(validateCandidate({ ...good, pages: 4000 }, current)).toEqual({ ok: true });
  });

  it("honours a custom policy", () => {
    const current: IndexStats = { pages: 1000, journalMode: "delete", bytes: 1 };
    const strict = { minPages: 10, maxDropRatio: 0.01 };
    const r = validateCandidate({ pages: 900, journalMode: "delete", bytes: 5 }, current, strict);
    expect(r.ok).toBe(false);
  });

  it("ignores the relative rule when there is no current index", () => {
    expect(validateCandidate({ ...good, pages: DEFAULT_POLICY.minPages }, null)).toEqual({
      ok: true,
    });
  });

  // A docs.json the builder cannot use still builds every page, so only the
  // navigation count notices. Figures measured on the real docs: 2,947 of
  // 3,130 pages take their version from docs.json.
  it("rejects a candidate that lost docs.json navigation", () => {
    const current: IndexStats = { pages: 3130, journalMode: "delete", bytes: 1, navPages: 2947 };
    const r = validateCandidate(
      { pages: 3130, journalMode: "delete", bytes: 20_000_000, navPages: 0 },
      current,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("navigation_regression");
      expect(r.reason).toContain("0 pages vs 2947");
    }
  });

  it("rejects a navigation drop just past the tolerance", () => {
    // Floor: 2947 * 0.8 = 2357.6.
    const current: IndexStats = { pages: 3000, journalMode: "delete", bytes: 1, navPages: 2947 };
    const r = validateCandidate({ ...good, navPages: 2300 }, current);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("navigation_regression");
  });

  it("accepts a navigation drop landing exactly on the floor", () => {
    // 3000 * (1 - 0.2) === 2400 exactly, so this pins < against <=.
    const current: IndexStats = { pages: 3000, journalMode: "delete", bytes: 1, navPages: 3000 };
    expect(validateCandidate({ ...good, navPages: 2400 }, current)).toEqual({ ok: true });
  });

  it("fails closed when the candidate's navigation count is unknown", () => {
    const current: IndexStats = { pages: 3000, journalMode: "delete", bytes: 1, navPages: 2947 };
    const r = validateCandidate(good, current);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("navigation_regression");
  });

  // Fixtures without docs.json and indexes from before version metadata.
  it.each<[string, IndexStats | null]>([
    ["0", { pages: 3000, journalMode: "delete", bytes: 1, navPages: 0 }],
    ["null", { pages: 3000, journalMode: "delete", bytes: 1, navPages: null }],
    ["absent", { pages: 3000, journalMode: "delete", bytes: 1 }],
    ["unknown (no served index)", null],
  ])("skips the navigation rule when served navigation pages are %s", (_, current) => {
    expect(validateCandidate({ ...good, navPages: 0 }, current)).toEqual({ ok: true });
  });

  it("disables the navigation rule with maxDropRatio 1", () => {
    const current: IndexStats = { pages: 3000, journalMode: "delete", bytes: 1, navPages: 2947 };
    const lenient = { minPages: 2000, maxDropRatio: 1 };
    expect(validateCandidate({ ...good, navPages: 0 }, current, lenient)).toEqual({ ok: true });
  });

  it("reports page loss before navigation loss", () => {
    const current: IndexStats = { pages: 3000, journalMode: "delete", bytes: 1, navPages: 2947 };
    const r = validateCandidate({ ...good, pages: 2300, navPages: 0 }, current);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("page_count_regression");
  });
});

describe("generationsToPrune", () => {
  const gens = [
    { path: "/a", docsCommit: "a", createdAt: 100 },
    { path: "/b", docsCommit: "b", createdAt: 200 },
    { path: "/c", docsCommit: "c", createdAt: 300 },
    { path: "/d", docsCommit: "d", createdAt: 400 },
  ];

  it("keeps the newest N and prunes the rest", () => {
    const doomed = generationsToPrune(gens, 2).map((g) => g.path);
    expect(doomed.sort()).toEqual(["/a", "/b"]);
  });

  it("never prunes the currently-served generation, even when old", () => {
    const doomed = generationsToPrune(gens, 2, "/a").map((g) => g.path);
    expect(doomed).toEqual(["/b"]);
  });

  it("prunes nothing when under the limit", () => {
    expect(generationsToPrune(gens.slice(0, 2), 5)).toEqual([]);
  });
});

describe("PoisonedCommits", () => {
  it("remembers a failed commit so the poller stops retrying it", () => {
    const p = new PoisonedCommits();
    expect(p.has("abc")).toBe(false);
    p.mark("abc");
    expect(p.has("abc")).toBe(true);
  });

  it("is idempotent", () => {
    const p = new PoisonedCommits();
    p.mark("abc");
    p.mark("abc");
    expect(p.size).toBe(1);
  });

  it("evicts oldest entries beyond the cap (bounded memory)", () => {
    const p = new PoisonedCommits(3);
    ["a", "b", "c", "d"].forEach((s) => p.mark(s));
    expect(p.size).toBe(3);
    expect(p.has("a")).toBe(false);
    expect(p.has("d")).toBe(true);
  });
});

describe("inspectIndex", () => {
  it("reports pages, journal mode and size from a real file", async () => {
    const file = path.join(workDir, "inspect.sqlite");
    makeIndex(file, [
      { title: "Chat quickstart", body: "chat message send" },
      { title: "Calling", body: "voice video call" },
    ]);
    const stats = await inspectIndex(file);
    expect(stats.pages).toBe(2);
    expect(stats.journalMode).toBe("delete");
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it("reports navigation pages as null for an index without the product column", async () => {
    const file = path.join(workDir, "inspect-no-product.sqlite");
    makeIndex(file, [{ title: "Chat quickstart", body: "chat message send" }]);
    expect((await inspectIndex(file)).navPages).toBeNull();
  });

  it("counts the pages whose product came from docs.json navigation", async () => {
    const file = path.join(workDir, "inspect-product.sqlite");
    makeIndex(
      file,
      [
        { title: "Chat quickstart", body: "chat message send", product: "Chat & Messaging / SDKs" },
        { title: "Calling", body: "voice video call", product: "Voice & Video / SDKs" },
        { title: "Legacy", body: "older content", product: null },
      ],
      { product: true },
    );
    expect((await inspectIndex(file)).navPages).toBe(2);
  });
});

describe("SqliteSearchClient.navigationPageCount", () => {
  it("counts navigation pages on the served index and follows swapTo", () => {
    const a = path.join(workDir, "nav-count-a.sqlite");
    const b = path.join(workDir, "nav-count-b.sqlite");
    makeIndex(a, [{ title: "Alpha topic", body: "alpha only content" }]);
    makeIndex(
      b,
      [
        { title: "Beta topic", body: "beta only content", product: "Docs / Beta" },
        { title: "Beta extra", body: "beta more content", product: "Docs / Beta" },
        { title: "Beta path", body: "beta path content", product: null },
      ],
      { product: true },
    );

    const client = new SqliteSearchClient(a);
    expect(client.navigationPageCount()).toBeNull();
    client.swapTo(b);
    expect(client.navigationPageCount()).toBe(2);
    client.close();
  });
});

describe("SqliteSearchClient hot swap", () => {
  it("serves the new index after swapTo and reports the new path", async () => {
    const a = path.join(workDir, "gen-a.sqlite");
    const b = path.join(workDir, "gen-b.sqlite");
    makeIndex(a, [{ title: "Alpha topic", body: "alpha only content" }]);
    makeIndex(b, [
      { title: "Beta topic", body: "beta only content" },
      { title: "Beta extra", body: "beta more content" },
    ]);

    const client = new SqliteSearchClient(a);
    const before = await client.search("alpha", { limit: 5 });
    expect(before.results.length).toBe(1);
    expect(client.pageCount()).toBe(1);
    expect(client.currentPath()).toBe(a);

    client.swapTo(b);

    expect(client.currentPath()).toBe(b);
    expect(client.pageCount()).toBe(2);
    const afterBeta = await client.search("beta", { limit: 5 });
    expect(afterBeta.results.length).toBeGreaterThan(0);
    // Content from the previous generation must be gone.
    const afterAlpha = await client.search("alpha", { limit: 5 });
    expect(afterAlpha.results.length).toBe(0);
    client.close();
  });

  it("can swap back (the self-heal revert path)", async () => {
    const a = path.join(workDir, "revert-a.sqlite");
    const b = path.join(workDir, "revert-b.sqlite");
    makeIndex(a, [{ title: "Good", body: "known good content" }]);
    makeIndex(b, [{ title: "Bad", body: "regressed content" }]);

    const client = new SqliteSearchClient(a);
    await client.search("known", { limit: 1 });
    client.swapTo(b);
    expect(client.pageCount()).toBe(1);
    client.swapTo(a); // revert
    const back = await client.search("known", { limit: 5 });
    expect(back.results.length).toBe(1);
    expect(client.currentPath()).toBe(a);
    client.close();
  });

  it("swapping to a missing file surfaces an error without crashing the client", async () => {
    const a = path.join(workDir, "exists.sqlite");
    makeIndex(a, [{ title: "Here", body: "present content" }]);
    const client = new SqliteSearchClient(a);
    await client.search("present", { limit: 1 });
    client.swapTo(path.join(workDir, "does-not-exist.sqlite"));
    await expect(client.search("present", { limit: 1 })).rejects.toBeTruthy();
    // and can be recovered by swapping back
    client.swapTo(a);
    const back = await client.search("present", { limit: 1 });
    expect(back.results.length).toBe(1);
    client.close();
  });
});

// Builder stderr carries docs text (version labels, page paths, JSON.parse
// excerpts) into production logs.
describe("summarizeBuildOutput", () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("neutralizes control and bidi characters and cuts lines without splitting a surrogate pair", () => {
    const stderr =
      `WARNING: label ${String.fromCharCode(27)}[31mred\r\u202eevil\u2028next\n` +
      `${"x".repeat(298)}\u{1F600}${"y".repeat(100)}\n`;
    const out = summarizeBuildOutput(stderr);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toBe("WARNING: label  [31mred  evil next");
    expect(out.warnings).toBe(1);
    for (const line of out.lines) {
      expect(Array.from(line).length).toBeLessThanOrEqual(300);
      expect(line).not.toMatch(LONE_SURROGATE);
    }
    expect(out.lines[1]).toBe(`${"x".repeat(298)}\u{1F600}…`);
  });

  // Listed here rather than copied from the source's character class, so a
  // narrower class fails. Line feed is left out: it splits lines instead.
  it("replaces every control, format and line or paragraph separator character", () => {
    const points = [
      // C0 and C1 controls
      0x00, 0x09, 0x0d, 0x1b, 0x1f, 0x7f, 0x85, 0x9f,
      // format: bidi marks, embeddings, overrides and isolates
      0x061c, 0x200e, 0x200f, 0x202a, 0x202c, 0x202e, 0x2066, 0x2068, 0x2069,
      // format: soft hyphen, zero-width characters and tags
      0x00ad, 0x200b, 0x200d, 0x2060, 0xfeff, 0xe0001, 0xe0041, 0xe007f,
      // line and paragraph separators
      0x2028, 0x2029,
    ];
    for (const point of points) {
      const label = `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(summarizeBuildOutput(`a${String.fromCodePoint(point)}b`).lines, label).toEqual(["a b"]);
    }
    const nbsp = String.fromCodePoint(0xa0);
    expect(summarizeBuildOutput(`a${nbsp}b`).lines).toEqual([`a${nbsp}b`]);
  });

  it("keeps the first and last 10 lines and counts every WARNING line", () => {
    const stderr = Array.from({ length: 50 }, (_, i) =>
      [2, 25, 49].includes(i + 1) ? `WARNING: line ${i + 1}` : `line ${i + 1}`,
    ).join("\n");
    const out = summarizeBuildOutput(stderr);
    expect(out.lines).toHaveLength(20);
    expect(out.lines[0]).toBe("line 1");
    expect(out.lines[19]).toBe("line 50");
    expect(out.linesOmitted).toBe(30);
    expect(out.warnings).toBe(3);
  });

  it("drops stack frames", () => {
    const out = summarizeBuildOutput(
      "SqliteError: database or disk is full\n" +
        "    at Database.exec (/app/node_modules/better-sqlite3/lib/methods/wrappers.js:9:14)",
    );
    expect(out).toEqual({ lines: ["SqliteError: database or disk is full"], warnings: 0, linesOmitted: 1 });
  });

  it("counts only lines that start with WARNING: once trimmed", () => {
    const out = summarizeBuildOutput("Warning: dep\n(node:1) Warning: x\nnote WARNING: inline\n   WARNING: indented");
    expect(out.warnings).toBe(1);
  });

  it("adds the lines cut by the cap to the stack frames, and never counts blank lines", () => {
    const parts: string[] = [];
    for (let i = 1; i <= 25; i++) {
      parts.push(`line ${i}`);
      if (i % 8 === 0) parts.push("    at x (y:1:1)");
    }
    const out = summarizeBuildOutput(parts.join("\n\n"));
    expect(out.lines).toHaveLength(20);
    // 3 stack frames plus the 5 lines cut from the middle.
    expect(out.linesOmitted).toBe(8);
  });
});

describe("describeBuildFailure", () => {
  const limits = { timeoutMs: 600_000, maxBuffer: 8 * 1024 * 1024 };
  type Shape = { code?: string | number | null; killed?: boolean; signal?: NodeJS.Signals | null; message?: string };
  // The fields execFile sets on its rejection, as measured per failure kind.
  const failure = (shape: Shape) =>
    Object.assign(new Error("Command failed: tsx scripts/build-index.ts"), shape) as ExecFileException;

  it("names the crash, not an earlier WARNING line", () => {
    const output = summarizeBuildOutput(
      "WARNING: docs.json is not valid JSON (x); deriving page versions from paths\n" +
        "Indexing 5 mdx files from /w/clone-a\n" +
        "Error [SqliteError]: database or disk is full\n" +
        "    at [eval]:1:165",
    );
    expect(describeBuildFailure(failure({ code: 1, killed: false, signal: null }), output, limits)).toBe(
      "index build exited with code 1: Error [SqliteError]: database or disk is full",
    );
  });

  it("gives the bare exit code when no line names an error", () => {
    const output = summarizeBuildOutput("WARNING: no docs.json found; deriving page versions from paths\nIndexing 5 mdx files");
    expect(describeBuildFailure(failure({ code: 1, killed: false, signal: null }), output, limits)).toBe(
      "index build exited with code 1",
    );
  });

  it("names the last Error line when there are several", () => {
    const output = summarizeBuildOutput("TypeError: first\nIndexing 5 mdx files\nSqliteError: second");
    expect(describeBuildFailure(failure({ code: 1, killed: false, signal: null }), output, limits)).toBe(
      "index build exited with code 1: SqliteError: second",
    );
  });

  it("does not take an Error named inside a WARNING line for the crash", () => {
    const output = summarizeBuildOutput(
      "WARNING: docs.json navigation could not be indexed (RangeError: Maximum call stack size exceeded); " +
        "deriving page versions from paths",
    );
    expect(describeBuildFailure(failure({ code: 1, killed: false, signal: null }), output, limits)).toBe(
      "index build exited with code 1",
    );
  });

  it("cuts the crash line to 200 code points", () => {
    const smile = String.fromCodePoint(0x1f600);
    const output = summarizeBuildOutput(`Error: ${smile.repeat(243)}`);
    expect(describeBuildFailure(failure({ code: 1, killed: false, signal: null }), output, limits)).toBe(
      `index build exited with code 1: Error: ${smile.repeat(192)}…`,
    );
  });

  it.each<[string, Shape, string]>([
    ["a timeout", { code: null, killed: true, signal: "SIGTERM" }, "index build timed out after 600000ms"],
    ["an external kill", { code: null, killed: false, signal: "SIGKILL" }, "index build was killed by SIGKILL"],
    // Through tsx, which relays the timeout's SIGTERM to the builder and exits 128 + 15.
    ["a timeout, as tsx reports it", { code: 143, killed: true, signal: null }, "index build timed out after 600000ms"],
    // tsx exits 128 + 9 when the builder is SIGKILLed, as the out-of-memory killer does.
    [
      "a SIGKILL of the builder, as tsx reports it",
      { code: 137, killed: false, signal: null },
      "index build was killed by SIGKILL",
    ],
    [
      "overflowing output",
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
      "index build output exceeded the 8388608-byte buffer",
    ],
    [
      "a missing binary",
      { code: "ENOENT", message: "spawn /nonexistent/node_modules/.bin/tsx ENOENT" },
      "index build could not start (ENOENT)",
    ],
    ["anything else", {}, "index build failed"],
  ])("describes %s", (_, shape, expected) => {
    const output = summarizeBuildOutput("");
    expect(describeBuildFailure(failure(shape), output, limits)).toBe(expected);
  });

  it.each<[string, Shape, BuildExit]>([
    [
      "a timeout of tsx itself",
      { code: null, killed: true, signal: "SIGTERM" },
      { exitCode: null, signal: "SIGTERM", timedOut: true },
    ],
    [
      "a timeout tsx relayed",
      { code: 143, killed: true, signal: null },
      { exitCode: 143, signal: "SIGTERM", timedOut: true },
    ],
    [
      "a SIGKILL of the builder",
      { code: 137, killed: false, signal: null },
      { exitCode: 137, signal: "SIGKILL", timedOut: false },
    ],
    ["a crash", { code: 1, killed: false, signal: null }, { exitCode: 1, signal: null, timedOut: false }],
    ["a missing binary", { code: "ENOENT" }, { exitCode: null, signal: null, timedOut: false }],
  ])("buildExit records how the build ended for %s", (_, shape, expected) => {
    expect(buildExit(failure(shape))).toEqual(expected);
  });
});

describe("index refresh configuration", () => {
  const KEYS = [
    "INDEX_AUTO_REFRESH",
    "INDEX_KEEP_GENERATIONS",
    "INDEX_POLL_INTERVAL_MS",
    "DOCS_COMMIT_PIN",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  it("defaults to disabled", () => {
    KEYS.forEach((k) => {
      saved[k] = process.env[k];
      delete process.env[k];
    });
    const c = loadConfig();
    expect(c.indexAutoRefresh).toBe(false);
    expect(c.indexPollIntervalMs).toBe(600_000);
    expect(c.indexKeepGenerations).toBe(2);
    expect(c.docsRepoUrl).toContain("cometchat/docs");
  });

  it("enables only on the literal string 'true'", () => {
    process.env.INDEX_AUTO_REFRESH = "true";
    expect(loadConfig().indexAutoRefresh).toBe(true);
    process.env.INDEX_AUTO_REFRESH = "yes";
    expect(loadConfig().indexAutoRefresh).toBe(false);
    process.env.INDEX_AUTO_REFRESH = "1";
    expect(loadConfig().indexAutoRefresh).toBe(false);
  });

  it("treats an orchestrator-injected empty value as unset", () => {
    process.env.INDEX_AUTO_REFRESH = "   ";
    expect(loadConfig().indexAutoRefresh).toBe(false);
  });

  it("reads the pin and generation count", () => {
    process.env.INDEX_AUTO_REFRESH = "true";
    process.env.DOCS_COMMIT_PIN = "deadbeef";
    process.env.INDEX_KEEP_GENERATIONS = "3";
    const c = loadConfig();
    expect(c.docsCommitPin).toBe("deadbeef");
    expect(c.indexKeepGenerations).toBe(3);
    KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    });
  });
});
