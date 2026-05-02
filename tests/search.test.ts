import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { BackendError } from "../src/lib/errors.js";

type Fixture = {
  path: string;
  url: string;
  title: string;
  section: string;
  version: string | null;
  body: string;
};

const FIXTURES: Fixture[] = [
  {
    path: "/sdk/javascript/overview",
    url: "https://www.cometchat.com/docs/sdk/javascript/overview",
    title: "JavaScript SDK Overview",
    section: "SDK / javascript",
    version: "v4",
    body: "Install the JavaScript SDK to add real-time chat to your web app. The SDK exposes login, send message, and receive message APIs.",
  },
  {
    path: "/ui-kit/react/overview",
    url: "https://www.cometchat.com/docs/ui-kit/react/overview",
    title: "React UI Kit Overview",
    section: "UI Kit / react",
    version: "v4",
    body: "The React UI Kit ships pre-built conversation list, message thread, and group call components. Install it via npm and wire your CometChat App ID to render a working chat in minutes.",
  },
  {
    path: "/sdk/ios/presence",
    url: "https://www.cometchat.com/docs/sdk/ios/presence",
    title: "iOS Presence Indicators",
    section: "SDK / ios",
    version: "v4",
    body: "Presence indicators surface user online status. Subscribe to typing events with addPresenceListener to get realtime updates.",
  },
  {
    path: "/sdk/javascript/v3/legacy",
    url: "https://www.cometchat.com/docs/sdk/javascript/v3/legacy",
    title: "JavaScript SDK v3 Legacy",
    section: "SDK / javascript",
    version: "v3",
    body: "Legacy v3 documentation. Prefer v4 for new integrations.",
  },
];

let tmpDir: string;
let indexPath: string;
let client: SqliteSearchClient;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-search-"));
  indexPath = path.join(tmpDir, "index.sqlite");
  buildFixtureIndex(indexPath, FIXTURES);
  client = new SqliteSearchClient(indexPath);
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteSearchClient", () => {
  it("returns BackendError when the index file is missing", async () => {
    const broken = new SqliteSearchClient(path.join(tmpDir, "does-not-exist.sqlite"));
    await expect(broken.search("anything")).rejects.toBeInstanceOf(BackendError);
  });

  it("AND-by-default narrows multi-token queries", async () => {
    const all = await client.search("react", { limit: 10 });
    const reactCount = all.results.length;
    expect(reactCount).toBeGreaterThan(0);

    const intersected = await client.search("react conversation", { limit: 10 });
    expect(intersected.results.length).toBeGreaterThan(0);
    expect(intersected.results.length).toBeLessThanOrEqual(reactCount);
    for (const r of intersected.results) {
      expect(r.title.toLowerCase()).toContain("react");
    }
  });

  it("falls back to OR when AND would return zero hits", async () => {
    const r = await client.search("react thisWordDefinitelyDoesNotExist");
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.some((x) => x.title.toLowerCase().includes("react"))).toBe(true);
  });

  it("does not drop short tokens like 'v4'", async () => {
    const r = await client.search("v4 sdk", { limit: 10 });
    expect(r.results.length).toBeGreaterThan(0);
  });

  it("filters by version when supplied", async () => {
    const r = await client.search("javascript", { version: "v3", limit: 10 });
    expect(r.results.length).toBe(1);
    expect(r.results[0].title).toBe("JavaScript SDK v3 Legacy");
  });

  it("snippet anchors on any matched query token, not just the first", async () => {
    const r = await client.search("typing presence", { limit: 5 });
    expect(r.results.length).toBeGreaterThan(0);
    const ios = r.results.find((x) => x.title.includes("iOS"));
    expect(ios).toBeDefined();
    expect(ios!.snippet.toLowerCase()).toMatch(/typing|presence/);
  });

  it("returns empty results without throwing for a query that matches nothing", async () => {
    const r = await client.search("zzzzzunmatchablezzzz");
    expect(r.results).toEqual([]);
    expect(r.totalAvailable).toBe(0);
  });

  it("isReady reflects the file presence", () => {
    expect(client.isReady()).toBe(true);
  });

  it("indexAgeSeconds returns a non-negative integer when index exists", () => {
    const age = client.indexAgeSeconds();
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
  });

  it("indexAgeSeconds returns null when index missing", () => {
    const broken = new SqliteSearchClient(path.join(tmpDir, "nope.sqlite"));
    expect(broken.indexAgeSeconds()).toBeNull();
  });
});

function buildFixtureIndex(at: string, rows: Fixture[]) {
  const db = new Database(at);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      section TEXT NOT NULL,
      version TEXT,
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
  const insert = db.prepare(
    "INSERT INTO pages (path, url, title, section, version, body) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const tx = db.transaction((items: Fixture[]) => {
    for (const r of items) insert.run(r.path, r.url, r.title, r.section, r.version, r.body);
  });
  tx(rows);
  db.exec("INSERT INTO pages_fts(pages_fts) VALUES('optimize');");
  db.close();
}
