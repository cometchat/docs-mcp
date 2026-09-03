import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { inspectIndex } from "../src/index/refresher.js";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { loadConfig } from "../src/config.js";

let workDir: string;

/** Builds a miniature index with the production schema. */
function makeIndex(file: string, rows: Array<{ title: string; body: string }>): void {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
      title TEXT NOT NULL, section TEXT NOT NULL, version TEXT, body TEXT NOT NULL
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
  const ins = db.prepare(
    "INSERT INTO pages (path,url,title,section,version,body) VALUES (?,?,?,?,?,?)",
  );
  rows.forEach((r, i) => ins.run(`/p${i}`, `https://x/p${i}`, r.title, "Sec", null, r.body));
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
