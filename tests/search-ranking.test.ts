import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import {
  MAX_QUERY_TOKENS,
  SNIPPET_MAX_MATCHES,
  SqliteSearchClient,
  buildQueries,
  countKeyMatches,
  parseQuery,
  snippetKeyPattern,
} from "../src/search/sqlite.js";
import { runSearch } from "../src/tools/search.js";
import { BackendError } from "../src/lib/errors.js";
import { logger } from "../src/lib/logger.js";

// Index schema written by scripts/build-index.ts: version metadata lives in
// `pages`, only title/body/section are searchable, and each page points at its
// navigation trail and folder section in trails_fts.
type Page = {
  path: string;
  title: string;
  section: string;
  /** docs.json trail below the product family; defaults to the section. */
  trail?: string;
  version: string | null;
  isCurrent: boolean;
  body: string;
};

// Words that stem to nothing any test queries for, so a snippet that falls
// back to the start of the body is easy to tell apart from a real match.
const BOILERPLATE = "Field Value Package Import Purpose Requirements Xcode Swift Init Login Rendering ".repeat(6);

const PAGES: Page[] = [
  // Adversarial for plain bm25: the legacy page is much shorter, so it wins
  // on length normalization with equal column weights.
  {
    path: "/ui-kit/react/v4/getting-started",
    title: "Getting Started",
    section: "UI Kit / React",
    version: "v4",
    isCurrent: false,
    body: "Install the React UI Kit with npm to add chat.",
  },
  {
    path: "/ui-kit/react/integration-react",
    title: "Getting Started",
    section: "UI Kit / React",
    version: "v7",
    isCurrent: true,
    body: `Install the React UI Kit with npm to add chat. ${BOILERPLATE}`,
  },
  // Same label, different products: Android v6 is current, React v6 is not.
  {
    path: "/ui-kit/react/v6/message-list",
    title: "Message List",
    section: "UI Kit / React",
    version: "v6",
    isCurrent: false,
    body: "Render the message list for a conversation.",
  },
  {
    path: "/ui-kit/android/message-list",
    title: "Message List",
    section: "UI Kit / Android",
    version: "v6",
    isCurrent: true,
    body: `Render the message list for a conversation. ${BOILERPLATE}`,
  },
  // Title vs body: equal-length bodies, one names the term in its title.
  {
    path: "/sdk/javascript/presence",
    title: "Presence",
    section: "SDK / Javascript",
    version: "v4",
    isCurrent: true,
    body: `Subscribe to online status updates for users. ${BOILERPLATE}`,
  },
  {
    path: "/sdk/javascript/users",
    title: "Users",
    section: "SDK / Javascript",
    version: "v4",
    isCurrent: true,
    body: `Retrieve users and their presence for a list view. ${BOILERPLATE}`,
  },
  {
    path: "/sdk/javascript/2.0/legacyonly",
    title: "Cordova Plugin",
    section: "SDK / Javascript",
    version: "v2",
    isCurrent: false,
    body: "The cordovaplugin bridge exists only in the oldest SDK.",
  },
  // Snippet targets: the matching word only appears after the boilerplate.
  {
    path: "/fundamentals/send",
    title: "Sending",
    section: "Fundamentals",
    version: null,
    isCurrent: true,
    body: `${BOILERPLATE} To send a message, call the send API with a receiver and text.`,
  },
  {
    path: "/fundamentals/setup",
    title: "Setup",
    section: "Fundamentals",
    version: null,
    isCurrent: true,
    body: `${BOILERPLATE} Run npm install to add the package to your project.`,
  },
  // Product-name query: the short page matches "vue ui kit" only through its
  // section label, while the overview is about the Vue UI Kit.
  {
    path: "/ui-kit/vue/shared-elements",
    title: "Shared Elements",
    section: "UI Kit / Vue",
    version: null,
    isCurrent: true,
    body: "Elements reused across this kit.",
  },
  {
    path: "/ui-kit/vue/overview",
    title: "Overview",
    section: "UI Kit / Vue",
    version: null,
    isCurrent: true,
    body: "The Vue UI Kit gives Vue apps ready-made chat screens. Add the Vue UI Kit to a project, register its components in your Vue app and theme them.",
  },
  // Identical text in two products' sections.
  {
    path: "/sdk/android/call-alerts",
    title: "Call Alerts",
    section: "SDK / Android",
    version: "v5",
    isCurrent: true,
    body: "Show incoming call alerts on android and flutter devices while the app runs in the background.",
  },
  {
    path: "/sdk/flutter/call-alerts",
    title: "Call Alerts",
    section: "SDK / Flutter",
    version: "v5",
    isCurrent: true,
    body: "Show incoming call alerts on android and flutter devices while the app runs in the background.",
  },
  // Same upgrade text; the legacy page is shorter, so it is the better bm25 match.
  {
    path: "/ui-kit/react/v5/upgrading-from-v4",
    title: "Upgrading From V4",
    section: "UI Kit / React",
    version: "v5",
    isCurrent: false,
    body: "Steps to upgrade from v4 to v5, with renamed props.",
  },
  {
    path: "/ui-kit/react/upgrading",
    title: "Upgrading",
    section: "UI Kit / React",
    version: "v7",
    isCurrent: true,
    body: `Steps to upgrade from v4 to v5, with renamed props. ${BOILERPLATE}`,
  },
  // A legacy page that never mentions its own version, and its current twin.
  {
    path: "/ui-kit/ios/v4/theme",
    title: "Theme",
    section: "UI Kit / Ios",
    trail: "UI Kits / iOS",
    version: "v4",
    isCurrent: false,
    body: "Customize the colors and fonts of the iOS kit with a theme.",
  },
  {
    path: "/ui-kit/ios/theme",
    title: "Theme",
    section: "UI Kit / Ios",
    trail: "UI Kits / iOS",
    version: "v5",
    isCurrent: true,
    body: `Customize the colors and fonts of the iOS kit with a theme. ${BOILERPLATE}`,
  },
  // A query naming a component page by its title, against a shorter page that
  // uses the same common words.
  {
    path: "/ui-kit/angular/v4/getting-started",
    title: "Getting Started",
    section: "UI Kit / Angular",
    version: "v4",
    isCurrent: false,
    body: "Add the Angular UI Kit, then render a message list for each chat.",
  },
  {
    path: "/ui-kit/angular/v4/message-list",
    title: "Message List",
    section: "UI Kit / Angular",
    version: "v4",
    isCurrent: false,
    body: `The message list component renders the messages of a chat. ${BOILERPLATE}`,
  },
  // The UI Kit Builder lives under /chat-builder/: its folder label says
  // "Chat Builder", its navigation trail says "UI Kit Builder".
  {
    path: "/ui-kit/react/components",
    title: "Components",
    section: "UI Kit / React",
    trail: "UI Kits / React",
    version: "v7",
    isCurrent: true,
    body: "Every UI Kit component can be configured with a builder.",
  },
  {
    path: "/chat-builder/react/overview",
    title: "Overview",
    section: "Chat Builder / React",
    trail: "UI Kit Builder / React",
    version: null,
    isCurrent: true,
    body: "Design chat screens in the UI Kit Builder, then export the builder output.",
  },
  {
    path: "/widget/html/overview",
    title: "Overview",
    section: "Widget / Html",
    trail: "Widget Builder / HTML",
    version: null,
    isCurrent: true,
    body: "Use the widget builder to embed chat on any HTML site.",
  },
];

let tmpDir: string;
let indexPath: string;
let client: SqliteSearchClient;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-ranking-"));
  indexPath = path.join(tmpDir, "index.sqlite");
  buildIndex(indexPath, PAGES);
  client = new SqliteSearchClient(indexPath);
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const pathOf = (url: string) => url.replace("https://www.cometchat.com/docs", "");
const paths = (r: { results: { url: string }[] }) => r.results.map((x) => pathOf(x.url));

describe("ranking with version metadata", () => {
  it("ranks the current version above a shorter legacy page that plain bm25 prefers", async () => {
    const db = new Database(indexPath, { readonly: true });
    const plain = db
      .prepare(
        `SELECT pages.path FROM pages_fts JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH '"install" "react"' ORDER BY bm25(pages_fts)`,
      )
      .all() as { path: string }[];
    db.close();
    // Guard: the fixture really is adversarial, or this test proves nothing.
    expect(plain[0].path).toBe("/ui-kit/react/v4/getting-started");

    const r = await client.search("install react", { limit: 5 });
    expect(paths(r)).toEqual(["/ui-kit/react/integration-react", "/ui-kit/react/v4/getting-started"]);
  });

  it("boosts pages whose title carries the query term", async () => {
    const r = await client.search("presence", { limit: 5 });
    expect(pathOf(r.results[0].url)).toBe("/sdk/javascript/presence");
    expect(paths(r)).toContain("/sdk/javascript/users");
  });

  it("still returns a legacy page when it is the only match", async () => {
    const r = await client.search("cordovaplugin");
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ version: "v2", isCurrent: false });
  });

  it("ranks the page whose multi-word title the query contains above a shorter page with the same words", async () => {
    const db = new Database(indexPath, { readonly: true });
    const plain = db
      .prepare(
        `SELECT pages.path FROM pages_fts JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH '"angular" "ui" "kit" "message" "list"' AND pages.version = 'v4'
         ORDER BY bm25(pages_fts, 5, 1, 1)`,
      )
      .all() as { path: string }[];
    db.close();
    // Guard: on weighted bm25 alone the short getting-started page wins.
    expect(plain.map((p) => p.path)).toEqual(["/ui-kit/angular/v4/getting-started", "/ui-kit/angular/v4/message-list"]);

    const r = await client.search("angular ui kit message list", { version: "v4" });
    expect(paths(r)).toEqual(["/ui-kit/angular/v4/message-list", "/ui-kit/angular/v4/getting-started"]);
  });

  it("reports version and isCurrent, omitting version for unversioned pages", async () => {
    const r = await client.search("install", { limit: 10 });
    const byPath = new Map(r.results.map((x) => [pathOf(x.url), x]));
    expect(byPath.get("/ui-kit/react/integration-react")).toMatchObject({ version: "v7", isCurrent: true });
    expect(byPath.get("/ui-kit/react/v4/getting-started")).toMatchObject({ version: "v4", isCurrent: false });
    const unversioned = byPath.get("/fundamentals/setup");
    expect(unversioned).toMatchObject({ isCurrent: true });
    expect(unversioned).not.toHaveProperty("version");
  });
});

describe("a version named in the query", () => {
  it("prefers pages of that version, which rarely spell it out", async () => {
    const legacy = PAGES.find((p) => p.path === "/ui-kit/ios/v4/theme")!;
    // Guards: the page never says "v4", and without a version current-first wins.
    expect(`${legacy.title} ${legacy.body}`.toLowerCase()).not.toContain("v4");
    expect(paths(await client.search("ios ui kit theme"))[0]).toBe("/ui-kit/ios/theme");

    // Written the ways the version filter accepts it.
    for (const query of ["ios ui kit v4 theme", "ios ui kit V4 theme", "ios ui kit v4.0 theme", "(v4) ios ui kit theme", "ios ui kit 4.0 theme"]) {
      expect(paths(await client.search(query))[0], query).toBe("/ui-kit/ios/v4/theme");
    }
  });

  it("demotes pages of every other version alike", async () => {
    // Neither upgrade page is labelled v4, so relevance decides: the shorter legacy page.
    const named = await client.search("upgrade from v4", { limit: 5 });
    expect(pathOf(named.results[0].url)).toBe("/ui-kit/react/v5/upgrading-from-v4");
    const unnamed = await client.search("upgrade renamed props", { limit: 5 });
    expect(pathOf(unnamed.results[0].url)).toBe("/ui-kit/react/upgrading");
  });

  it("matches as text when it is the whole query", async () => {
    const r = await client.search("v4", { limit: 10 });
    expect(paths(r)).toContain("/ui-kit/react/v5/upgrading-from-v4");
  });

  it("leaves current-first ranking alone when no page carries that version", async () => {
    expect(paths(await client.search("ios ui kit v9 theme"))[0]).toBe("/ui-kit/ios/theme");
  });

  it("is ignored once the version filter is set", async () => {
    const r = await client.search("ios ui kit v4 theme", { version: "v5" });
    expect(paths(r)).toEqual(["/ui-kit/ios/theme"]);
  });
});

describe("query tokens", () => {
  it("are de-duplicated case-insensitively, with versions kept apart", () => {
    expect(parseQuery('Message message "MESSAGE" list v4 V4 4.0')).toEqual({
      terms: ["message", "list"],
      versions: [{ word: "v4", label: "v4" }],
    });
  });

  it("are capped", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
    const { terms } = parseQuery(words.join(" "));
    expect(terms).toEqual(words.slice(0, MAX_QUERY_TOKENS));
  });

  it("rank a repeated-word query like its distinct words", async () => {
    const repeated = await client.search(`${"presence users Presence ".repeat(20)}`.slice(0, 500), { limit: 10 });
    const distinct = await client.search("presence users", { limit: 10 });
    expect(paths(repeated)).toEqual(paths(distinct));
  });
});

describe("query plan", () => {
  it("scans the FTS index once and reads only the returned pages", () => {
    const db = new Database(indexPath, { readonly: true });
    const { search } = buildQueries({ versionMetadata: true, productTrails: true });
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${search}`).all({
        match: '"theme"',
        version: null,
        limit: 25,
        legacyFactor: 0.5,
        named: null,
        terms: 1,
        titleText: " theme ",
        phrases: '["\\"theme\\""]',
      }) as { detail: string }[]
    ).map((r) => r.detail);
    db.close();
    expect(plan.filter((d) => /^SCAN pages_fts\b/.test(d))).toHaveLength(1);
    expect(plan.some((d) => /^SCAN pages\b(?!_fts)/.test(d))).toBe(false);
    expect(plan).toContain("SEARCH pages USING INTEGER PRIMARY KEY (rowid=?)");
  });
});

describe("snippets", () => {
  it("anchor on stemmed matches: 'messages' finds 'message'", async () => {
    const r = await client.search("messages receiver", { limit: 5 });
    const hit = r.results.find((x) => pathOf(x.url) === "/fundamentals/send");
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain("send a message");
    expect(hit!.snippet.startsWith("Field Value")).toBe(false);
  });

  it("anchor on stemmed matches: 'installing' finds 'install'", async () => {
    const r = await client.search("installing package", { limit: 5 });
    const hit = r.results.find((x) => pathOf(x.url) === "/fundamentals/setup");
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain("npm install");
  });

  it("come from the page they are returned with", async () => {
    const r = await client.search("install", { limit: 10 });
    expect(r.results.length).toBeGreaterThan(1);
    const flat = (s: string) => s.replace(/…/g, "").replace(/\s+/g, " ").trim();
    for (const x of r.results) {
      const page = PAGES.find((p) => p.path === pathOf(x.url))!;
      expect(flat(page.body), x.url).toContain(flat(x.snippet).slice(0, 40));
    }
  });

  it("stay within the snippet length budget", async () => {
    const r = await client.search("install", { limit: 10 });
    for (const x of r.results) expect(x.snippet.length).toBeLessThanOrEqual(300);
  });

  it("count the inflected forms the stemmer matches when deciding whether snippet() is affordable", () => {
    expect(countKeyMatches("Messages, message and messaging.", snippetKeyPattern(["messages"])!, 100)).toBe(3);
    expect(countKeyMatches("Use it: used, uses, using.", snippetKeyPattern(["using"])!, 100)).toBe(4);
    expect(countKeyMatches("Café and cafe", snippetKeyPattern(["cafe"])!, 100)).toBe(2);
    expect(countKeyMatches("a b ".repeat(5000), snippetKeyPattern(["a"])!, 10)).toBe(11);
  });
});

describe("a page with very many query-term instances", () => {
  let dir: string;
  let big: SqliteSearchClient;
  // snippet() scores every instance against every other: this page would take
  // FTS5 minutes. The linear excerpt must keep the search fast.
  const body = "zqx sdk setup guide. ".repeat(20_000);

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-bigpage-"));
    const at = path.join(dir, "index.sqlite");
    buildIndex(at, [
      { path: "/big/page", title: "Big", section: "Big", version: null, isCurrent: true, body },
      { path: "/small/page", title: "Small", section: "Small", version: null, isCurrent: true, body: "One zqx sdk mention." },
    ]);
    big = new SqliteSearchClient(at);
  });

  afterAll(() => {
    big.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gets a linear excerpt in bounded time", async () => {
    expect(countKeyMatches(body, snippetKeyPattern(["zqx", "sdk"])!, SNIPPET_MAX_MATCHES)).toBeGreaterThan(SNIPPET_MAX_MATCHES);
    await big.search("warm up");
    const started = performance.now();
    const r = await big.search("zqx sdk", { limit: 5 });
    const elapsed = performance.now() - started;
    expect(paths(r).sort()).toEqual(["/big/page", "/small/page"]);
    for (const x of r.results) {
      expect(x.snippet).toContain("zqx");
      expect(x.snippet.length).toBeLessThanOrEqual(300);
    }
    // Generous: typically a few milliseconds; snippet() would need minutes.
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("product (section) matches", () => {
  it("do not let a product's shortest page win on its section label alone", async () => {
    const db = new Database(indexPath, { readonly: true });
    const saturated = db
      .prepare(
        `SELECT pages.path FROM pages_fts JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH '"vue" "ui" "kit"' ORDER BY bm25(pages_fts, 5, 1, 8)`,
      )
      .all() as { path: string }[];
    db.close();
    // Guard: with the section weighted heavily inside bm25 (the earlier 5/1/8
    // weights), its saturated term counts leave row length to decide.
    expect(saturated[0].path).toBe("/ui-kit/vue/shared-elements");

    const r = await client.search("vue ui kit", { limit: 5 });
    expect(paths(r)).toEqual(["/ui-kit/vue/overview", "/ui-kit/vue/shared-elements"]);
  });

  it("rank the product a query names above the same text in another product", async () => {
    for (const product of ["android", "flutter"]) {
      const r = await client.search(`call alerts ${product}`, { limit: 5 });
      expect(paths(r)[0]).toBe(`/sdk/${product}/call-alerts`);
    }
  });

  it("credit the navigation trail as well as the folder label", async () => {
    // Guard: boosting on folder labels alone (an index without trails) puts
    // the UI Kit page first, because "ui kit" is in its label.
    const legacyDir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-notrails-"));
    const at = path.join(legacyDir, "index.sqlite");
    buildIndex(at, PAGES, { trails: false });
    const folderOnly = new SqliteSearchClient(at);
    try {
      expect(paths(await folderOnly.search("ui kit builder"))[0]).toBe("/ui-kit/react/components");
    } finally {
      folderOnly.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }

    expect(paths(await client.search("ui kit builder"))[0]).toBe("/chat-builder/react/overview");
    // The folder label still names the product the trail does not.
    expect(paths(await client.search("chat builder"))[0]).toBe("/chat-builder/react/overview");
  });
});

describe("version filter", () => {
  it("matches the stored label across every product that uses it", async () => {
    const r = await client.search("message list", { version: "v6", limit: 10 });
    expect(paths(r).sort()).toEqual(["/ui-kit/android/message-list", "/ui-kit/react/v6/message-list"]);
    expect(r.totalAvailable).toBe(2);
  });

  it("ranks by relevance alone once a version is chosen", async () => {
    // The shorter legacy React v6 page is the better bm25 match; the filter
    // already picked the version, so current-first must not reorder it.
    const r = await client.search("message list", { version: "v6", limit: 10 });
    expect(pathOf(r.results[0].url)).toBe("/ui-kit/react/v6/message-list");
  });

  it("accepts loosely written labels through the tool input ('V7', '7', 'v7.0')", async () => {
    for (const version of ["V7", "7", "v7.0"]) {
      const r = await runSearch({ query: "install react", version }, client);
      expect(paths(r)).toEqual(["/ui-kit/react/integration-react"]);
    }
  });

  it("returns nothing for a label no page carries", async () => {
    const r = await client.search("install", { version: "v99" });
    expect(r.results).toEqual([]);
    expect(r.totalAvailable).toBe(0);
  });

  it("counts every match when the page of results is full", async () => {
    const r = await client.search("field", { limit: 2 });
    expect(r.results).toHaveLength(2);
    expect(r.totalAvailable).toBe(PAGES.filter((p) => p.body.includes("Field")).length);
  });
});

describe("indexes built before version metadata", () => {
  let legacyDir: string;
  let legacyClient: SqliteSearchClient;

  beforeAll(() => {
    legacyDir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-oldschema-"));
    const at = path.join(legacyDir, "index.sqlite");
    const db = new Database(at);
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
    const insert = db.prepare("INSERT INTO pages (path, url, title, section, version, body) VALUES (?, ?, ?, ?, ?, ?)");
    for (const p of PAGES.slice(0, 2)) {
      const oldVersion = p.path.includes("/v4/") ? "v4" : null;
      insert.run(p.path, `https://www.cometchat.com/docs${p.path}`, p.title, p.section, oldVersion, p.body);
    }
    db.close();
    legacyClient = new SqliteSearchClient(at);
  });

  afterAll(() => {
    legacyClient.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });

  it("keeps serving, treating unversioned paths as current", async () => {
    const r = await legacyClient.search("install react", { limit: 5 });
    expect(paths(r)).toEqual(["/ui-kit/react/integration-react", "/ui-kit/react/v4/getting-started"]);
    expect(r.results[0]).toMatchObject({ isCurrent: true });
    expect(r.results[0]).not.toHaveProperty("version");
    expect(r.results[1]).toMatchObject({ version: "v4", isCurrent: false });
  });

  it("still filters by the stored version", async () => {
    const r = await legacyClient.search("install", { version: "v4" });
    expect(paths(r)).toEqual(["/ui-kit/react/v4/getting-started"]);
  });

  it("prefers a version named in the query", async () => {
    const r = await legacyClient.search("install react v4", { limit: 5 });
    expect(paths(r)[0]).toBe("/ui-kit/react/v4/getting-started");
  });
});

describe("search failure logging", () => {
  it("does not log the query text", async () => {
    const c = new SqliteSearchClient(indexPath);
    await c.search("install");
    // Force a failure after the index opened, as a corrupt page would.
    const internals = c as unknown as { prepared: { searchStmt: { all: () => never } } };
    internals.prepared.searchStmt = {
      all: () => {
        throw new Error("database disk image is malformed");
      },
    };
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const query = "jane.doe@example.com reset my password";
    try {
      await expect(c.search(query)).rejects.toBeInstanceOf(BackendError);
      expect(spy).toHaveBeenCalledTimes(1);
      const [fields, msg] = spy.mock.calls[0] as unknown as [Record<string, unknown>, string];
      expect(msg).toBe("sqlite_search_failed");
      expect(fields).toMatchObject({ queryLength: query.length });
      expect(JSON.stringify(fields)).not.toContain("jane.doe");
      expect(fields).not.toHaveProperty("query");
    } finally {
      spy.mockRestore();
      c.close();
    }
  });
});

/** Writes the builder's schema; `trails: false` omits the product trails (an older index). */
function buildIndex(at: string, pages: Page[], opts: { trails?: boolean } = {}) {
  const trails = opts.trails ?? true;
  const db = new Database(at);
  db.exec(`
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      section TEXT NOT NULL,
      product TEXT,
      version TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
      ${trails ? "trail_id INTEGER NOT NULL, label_id INTEGER NOT NULL," : ""}
      body TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      title, body, section,
      content='pages', content_rowid='id', tokenize='porter unicode61'
    );
    ${trails ? "CREATE VIRTUAL TABLE trails_fts USING fts5(trail, tokenize='porter unicode61');" : ""}
    CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, body, section)
      VALUES (new.id, new.title, new.body, new.section);
    END;
  `);
  const ids = new Map<string, number>();
  const trailId = (trail: string) => {
    if (!ids.has(trail)) {
      ids.set(trail, ids.size + 1);
      db.prepare("INSERT INTO trails_fts (rowid, trail) VALUES (?, ?)").run(ids.size, trail);
    }
    return ids.get(trail)!;
  };
  for (const p of pages) {
    const url = `https://www.cometchat.com/docs${p.path}`;
    const common = [p.path, url, p.title, p.section, null, p.version, p.isCurrent ? 1 : 0] as const;
    if (trails) {
      db.prepare(
        "INSERT INTO pages (path, url, title, section, product, version, is_current, trail_id, label_id, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(...common, trailId(p.trail ?? p.section), trailId(p.section), p.body);
    } else {
      db.prepare(
        "INSERT INTO pages (path, url, title, section, product, version, is_current, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(...common, p.body);
    }
  }
  db.close();
}
