import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  ALL_CASES,
  CASES,
  ISSUE_CASES,
  evaluate,
  groundingProblems,
  type Check,
  type GoldenCase,
} from "../scripts/eval-search.js";

// The golden set is only as good as its grounding: a check whose pattern no
// real page matches can never pass, and one naming a deleted page proves nothing.
describe("eval-search grounding", () => {
  it("grounds every check in pages its pattern matches", () => {
    expect(groundingProblems(ALL_CASES, () => true)).toEqual([]);
  });

  it("runs the golden and issue cases, each id once, without changing the golden set", () => {
    expect(ALL_CASES).toEqual([...CASES, ...ISSUE_CASES]);
    expect(CASES.some((c) => ISSUE_CASES.includes(c))).toBe(false);
    const ids = ALL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("flags missing pages, grounding outside the pattern, and ungrounded checks", () => {
    const cases: GoldenCase[] = [
      {
        id: "x",
        query: "q",
        checks: [
          { kind: "inTop", k: 1, pattern: /^\/a\//, grounding: ["/a/one", "/b/two", "/a/gone"], label: "in" },
          { kind: "notInTop", k: 1, pattern: /^\/c\//, grounding: [], label: "not" },
          { kind: "above", current: "/a/one", legacy: "/a/old", label: "above" },
        ],
      },
    ];
    const existing = new Set(["/a/one", "/b/two"]);
    expect(groundingProblems(cases, (p) => existing.has(p))).toEqual([
      "x: /b/two does not match /^\\/a\\//",
      "x: /a/gone does not exist",
      'x: "not" names no grounding page',
      "x: /a/old does not exist",
    ]);
  });

  it("does not let an older copy or a REST reference stub pass for a current guide", () => {
    const first = (id: string) => ALL_CASES.find((c) => c.id === id)!.checks[0];
    const passes = (id: string, paths: string[]) => evaluate(first(id), paths).pass;
    expect(
      passes("phrasing-unsend", [
        "/sdk/ios/2.0/delete-a-message",
        "/rest-api/messages/delete-message",
        "/sdk/javascript/3.0/messaging-delete-message",
      ]),
    ).toBe(false);
    expect(passes("phrasing-pinned", ["/rest-api/messages/pin-message"])).toBe(false);
    expect(passes("phrasing-starred", ["/rest-api/messages/save-message"])).toBe(false);
    expect(passes("phrasing-dm", ["/rest-api/messages/send-message", "/sdk/javascript/2.0/messaging-send-message"])).toBe(
      false,
    );
    // The unversioned Android SDK is v4; docs.json lists v5, under /v5/, as current.
    expect(passes("phrasing-last-seen", ["/sdk/ios/2.0/user-presence", "/sdk/android/user-presence"])).toBe(false);
    expect(passes("phrasing-blue-ticks", ["/sdk/javascript/2.0/messaging-receipts"])).toBe(false);
    expect(passes("phrasing-typing-bubble", ["/sdk/react-native/2.0/messaging-typing-indicators"])).toBe(false);

    expect(passes("phrasing-last-seen", ["/sdk/android/v5/user-presence"])).toBe(true);
    expect(passes("phrasing-unsend", ["/sdk/flutter/delete-message"])).toBe(true);
    expect(passes("phrasing-pinned", ["/fundamentals/pin-message"])).toBe(true);
    expect(passes("phrasing-dm", ["/ui-kit/react/react-one-to-one-chat"])).toBe(true);
  });
});

// The scorer decides whether CI's search-eval job goes red, and the job is the
// only gate on four of the ranking rules (TITLE_WEIGHT, LANGUAGE_WEIGHT, the
// named-version factor and the platform words). Nothing exercised the notInTop,
// allInTop and above branches or the exit codes, so relaxing any of them —
// `offenders.length >= 0`, `hits > 0`, dropping `c >= 0`, `passed < 0` — left
// the whole suite green while the gate did nothing.
describe("eval-search scoring", () => {
  const notInTop: Check = { kind: "notInTop", k: 3, pattern: /^\/rest-api\//, grounding: ["/rest-api/x"], label: "n" };
  const inTop: Check = { kind: "inTop", k: 2, pattern: /^\/sdk\/ios\//, grounding: ["/sdk/ios/a"], label: "i" };
  const allInTop: Check = { kind: "allInTop", k: 3, pattern: /^\/campaigns\//, grounding: ["/campaigns/a"], label: "a" };
  const above: Check = { kind: "above", current: "/sdk/ios/a", legacy: "/sdk/ios/2.0/a", label: "v" };

  it("fails a notInTop check whose top k holds an offender", () => {
    expect(evaluate(notInTop, ["/sdk/ios/a", "/rest-api/x", "/sdk/ios/b"]).pass).toBe(false);
    expect(evaluate(notInTop, ["/sdk/ios/a", "/sdk/ios/b", "/sdk/ios/c", "/rest-api/x"]).pass).toBe(true);
    // A result list shorter than k, with no offender, still passes.
    expect(evaluate(notInTop, ["/sdk/ios/a"]).pass).toBe(true);
  });

  it("fails an inTop check whose page is below k or absent", () => {
    expect(evaluate(inTop, ["/sdk/ios/a"]).pass).toBe(true);
    expect(evaluate(inTop, ["/rest-api/x", "/rest-api/y", "/sdk/ios/a"]).pass).toBe(false);
    expect(evaluate(inTop, []).pass).toBe(false);
  });

  it("fails an allInTop check unless every one of the top k matches", () => {
    expect(evaluate(allInTop, ["/campaigns/a", "/campaigns/b", "/campaigns/c"]).pass).toBe(true);
    expect(evaluate(allInTop, ["/campaigns/a", "/campaigns/b", "/sdk/ios/a"]).pass).toBe(false);
    // One match out of one is not the same as k matches: an empty result list
    // must not pass, and neither must a single hit.
    expect(evaluate(allInTop, []).pass).toBe(false);
  });

  it("fails an above check when the current page is absent", () => {
    expect(evaluate(above, ["/sdk/ios/a", "/sdk/ios/2.0/a"]).pass).toBe(true);
    // The legacy copy alone: the current page never ranked, so nothing is proven.
    expect(evaluate(above, ["/sdk/ios/2.0/a"]).pass).toBe(false);
    expect(evaluate(above, ["/sdk/ios/2.0/a", "/sdk/ios/a"]).pass).toBe(false);
    // Only the current page ranked, which is the ordering the check wants.
    expect(evaluate(above, ["/sdk/ios/a"]).pass).toBe(true);
  });
});

describe("eval-search exit codes", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "eval-exit-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /**
   * An index the client can open, holding nothing any golden case asks for.
   * It carries this release's columns, so the eval scores it instead of
   * stopping at the stale-index guard below.
   */
  const index = path.join(tmp, "index.sqlite");
  const db = new Database(index);
  db.exec(`
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT NOT NULL,
      section TEXT NOT NULL, product TEXT, version TEXT, is_current INTEGER NOT NULL DEFAULT 1,
      title_key TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '', languages TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      title, body, section, keywords, languages,
      content='pages', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, body, section, keywords, languages)
      VALUES (new.id, new.title, new.body, new.section, new.keywords, new.languages);
    END;
  `);
  db.prepare("INSERT INTO pages (path, url, title, section, product, version, is_current, body) VALUES (?,?,?,?,?,?,?,?)").run(
    "/zzz/unrelated",
    "https://www.cometchat.com/docs/zzz/unrelated",
    "Unrelated",
    "Zzz",
    null,
    null,
    1,
    "Nothing here answers any golden query about chat, calls or the kits.",
  );
  db.close();

  const run = (env: Record<string, string>) =>
    spawnSync(path.join(root, "node_modules", ".bin", "tsx"), [path.join(root, "scripts", "eval-search.ts")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  it("exits 1 when a check fails", () => {
    const r = run({ INDEX_PATH: index, DOCS_REPO: "" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL/);
  }, 60_000);

  it("exits 2, naming the rebuild, when the index predates this release", () => {
    const old = path.join(tmp, "old-index.sqlite");
    const db = new Database(old);
    db.exec(`
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
        title TEXT NOT NULL, section TEXT NOT NULL, version TEXT, body TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE pages_fts USING fts5(
        title, body, section, version,
        content='pages', content_rowid='id', tokenize='porter unicode61'
      );
    `);
    db.close();
    const r = run({ INDEX_PATH: old, DOCS_REPO: "" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/built by an older release/);
    expect(r.stderr).toMatch(/keywords, title_key, languages/);
    expect(r.stderr).toMatch(/scripts\/build-index\.ts/);
    expect(r.stdout).not.toMatch(/FAIL/);
  }, 60_000);

  it("exits 2 when a case names a page the docs checkout lacks", () => {
    const docs = path.join(tmp, "docs");
    mkdirSync(docs, { recursive: true });
    const r = run({ INDEX_PATH: index, DOCS_REPO: docs });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not grounded/);
  }, 60_000);
});
