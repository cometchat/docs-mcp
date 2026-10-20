import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { inspectIndex } from "../src/index/refresher.js";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { SEARCH_TOOL_DEFINITION } from "../src/tools/search.js";
import { FETCH_TOOL_DEFINITION } from "../src/tools/fetch.js";

// Runs the real builder (as the in-container refresher does) over a small docs
// repo, so the navigation-derived metadata is proven end to end — not only in
// the pure resolver.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(root, "node_modules", ".bin", "tsx");
const BUILD = path.join(root, "scripts", "build-index.ts");
const BUILD_TIMEOUT_MS = 60_000;

const PAGES = [
  "ui-kit/react/overview",
  "ui-kit/react/v6/overview",
  "ui-kit/react/llms-react-v7",
  "ui-kit/angular/3.0/overview",
  "sdk/android/v5/send-message",
  "sdk/android/send-message",
  "calls/v4/javascript/setup",
  "fundamentals/overview",
];

const DOCS_JSON = {
  navigation: {
    products: [
      {
        product: "Chat & Messaging",
        tabs: [
          { tab: "Platform", pages: ["fundamentals/overview"] },
          {
            tab: "UI Kits",
            dropdowns: [
              {
                dropdown: "React",
                versions: [
                  { version: "v7", default: true, groups: [{ group: "Start", pages: ["ui-kit/react/overview"] }] },
                  { version: "v6", default: false, groups: [{ group: "Start", pages: ["ui-kit/react/v6/overview"] }] },
                ],
              },
              {
                dropdown: "Angular",
                versions: [{ version: "v3\u200e", groups: [{ group: "Start", pages: ["ui-kit/angular/3.0/overview"] }] }],
              },
            ],
          },
          {
            tab: "SDKs",
            dropdowns: [
              {
                dropdown: "Android",
                versions: [
                  { version: "v5\u200e\u200e", groups: [{ group: "Start", pages: ["sdk/android/v5/send-message"] }] },
                  { version: "v4\u200e\u200e", groups: [{ group: "Start", pages: ["sdk/android/send-message"] }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

type Stored = {
  path: string;
  section: string;
  product: string | null;
  version: string | null;
  is_current: number;
  body: string;
  languages: string;
};

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-build-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Writes PAGES plus `extra` (page path -> raw MDX) into a fresh repo. */
function makeRepo(name: string, docsJson: string | null, extra: Record<string, string> = {}): string {
  const repo = path.join(tmp, name);
  const files: Record<string, string> = {};
  for (const page of PAGES) {
    files[page] = `---\ntitle: ${page}\n---\n\nThis page explains how to send a message and install the kit (${page}).\n`;
  }
  for (const [page, raw] of Object.entries({ ...files, ...extra })) {
    const file = path.join(repo, `${page}.mdx`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, raw);
  }
  if (docsJson !== null) writeFileSync(path.join(repo, "docs.json"), docsJson);
  return repo;
}

/** Runs the builder; stderr is where it reports progress and warnings. */
function build(repo: string): { index: string; stderr: string } {
  const index = path.join(tmp, `${path.basename(repo)}.sqlite`);
  const run = spawnSync(TSX, [BUILD], {
    env: { ...process.env, DOCS_REPO: repo, INDEX_PATH: index },
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
  });
  if (run.status !== 0) throw new Error(`build-index exited ${run.status}: ${run.stderr}`);
  return { index, stderr: run.stderr };
}

function stored(index: string): Map<string, Stored> {
  const db = new Database(index, { readonly: true });
  const rows = db
    .prepare("SELECT path, section, product, version, is_current, body, languages FROM pages")
    .all() as Stored[];
  db.close();
  return new Map(rows.map((r) => [r.path, r]));
}

describe("build-index version metadata", () => {
  it(
    "derives product, version and currency from docs.json",
    async () => {
      const { index, stderr } = build(makeRepo("with-nav", JSON.stringify(DOCS_JSON)));
      const pages = stored(index);
      expect(pages.get("/ui-kit/react/overview")).toMatchObject({
        product: "Chat & Messaging / UI Kits / React",
        version: "v7",
        is_current: 1,
      });
      expect(pages.get("/ui-kit/react/v6/overview")).toMatchObject({ version: "v6", is_current: 0 });
      expect(pages.get("/ui-kit/react/llms-react-v7")).toMatchObject({ version: "v7", is_current: 1 });
      expect(pages.get("/ui-kit/angular/3.0/overview")).toMatchObject({ version: "v3", is_current: 1 });
      expect(pages.get("/sdk/android/v5/send-message")).toMatchObject({ version: "v5", is_current: 1 });
      expect(pages.get("/sdk/android/send-message")).toMatchObject({ version: "v4", is_current: 0 });
      expect(pages.get("/fundamentals/overview")).toMatchObject({ version: null, is_current: 1 });

      const db = new Database(index, { readonly: true });
      const ftsColumns = (db.prepare("PRAGMA table_info(pages_fts)").all() as { name: string }[]).map((c) => c.name);
      const journal = db.pragma("journal_mode", { simple: true });
      const names = db
        .prepare(
          `SELECT p.path, t.trail, l.trail AS label FROM pages p
           JOIN trails_fts t ON t.rowid = p.trail_id JOIN trails_fts l ON l.rowid = p.label_id`,
        )
        .all() as { path: string; trail: string; label: string }[];
      db.close();
      // The product boost matches the trail below the product family, and the folder section.
      const byPath = new Map(names.map((n) => [n.path, n]));
      expect(byPath.get("/ui-kit/react/overview")).toMatchObject({ trail: "UI Kits / React", label: "UI Kit / React" });
      expect(byPath.get("/fundamentals/overview")).toMatchObject({ trail: "Platform", label: "Fundamentals / Overview" });
      // docs.json lists nothing under calls/ here, so calls/ is inferred to be
      // retired — but it is not allowlisted, so it keeps the product boost its
      // folder section earns. Only KNOWN_RETIRED_DOC_SETS empties a trail.
      expect(byPath.get("/calls/v4/javascript/setup")).toMatchObject({
        trail: "Calls / Javascript",
        label: "Calls / Javascript",
      });
      // The version label is metadata, not searchable text; search keywords
      // and code languages are.
      expect(ftsColumns).toEqual(["title", "body", "section", "keywords", "languages"]);
      expect(String(journal).toLowerCase()).toBe("delete");
      // 6 listed pages, plus llms-react-v7 inheriting its folder's doc set;
      // calls/v4/javascript/setup falls back to its path.
      expect(stderr).toMatch(/Index built: 8 pages \(\d+ older-version, 7 from docs\.json navigation\)/);
      expect((await inspectIndex(index)).navPages).toBe(7);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "falls back to the path convention when the repo has no docs.json",
    async () => {
      const { index } = build(makeRepo("no-nav", null));
      const pages = stored(index);
      expect(pages.get("/ui-kit/react/overview")).toMatchObject({ product: null, version: null, is_current: 1 });
      expect(pages.get("/ui-kit/react/v6/overview")).toMatchObject({ version: "v6", is_current: 0 });
      expect(pages.get("/ui-kit/angular/3.0/overview")).toMatchObject({ version: "v3", is_current: 0 });
      // The section names the framework even behind a leading version folder.
      expect(pages.get("/calls/v4/javascript/setup")).toMatchObject({
        section: "Calls / Javascript",
        version: "v4",
        is_current: 0,
      });
      expect(pages.get("/ui-kit/react/v6/overview")).toMatchObject({ section: "UI Kit / React" });

      const client = new SqliteSearchClient(index);
      const r = await client.search("send message", { limit: 5 });
      client.close();
      expect(r.results.length).toBeGreaterThan(0);
      expect((await inspectIndex(index)).navPages).toBe(0);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "still builds from paths, loudly, when docs.json is not valid JSON",
    () => {
      const { index, stderr } = build(makeRepo("bad-nav", "{ not json"));
      expect(stderr).toContain("WARNING: docs.json is not valid JSON");
      expect(stored(index).get("/ui-kit/react/v6/overview")).toMatchObject({ version: "v6", is_current: 0 });
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "warns about docs.json version labels the search filter cannot match",
    () => {
      const nav = JSON.stringify(DOCS_JSON).replace('"version":"v7"', '"version":"Latest"');
      const { index, stderr } = build(makeRepo("odd-label", nav));
      expect(stored(index).get("/ui-kit/react/overview")).toMatchObject({ version: "latest", is_current: 1 });
      expect(stderr).toContain("WARNING: version label(s) the search version filter cannot match: latest");
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "caps the version label warning, since the refresher logs it",
    () => {
      const versions = Array.from({ length: 12 }, (_, i) => {
        const n = String(i).padStart(2, "0");
        return { version: `legacy-${n}-${"x".repeat(50)}`, groups: [{ group: "Start", pages: [`legacy/${n}/overview`] }] };
      });
      const extra = Object.fromEntries(
        versions.map((_, i) => [
          `legacy/${String(i).padStart(2, "0")}/overview`,
          `---\ntitle: Legacy ${i}\n---\n\nThis page explains how to send a message with legacy kit ${i}.\n`,
        ]),
      );
      const nav = { navigation: { tabs: [{ tab: "Legacy", dropdowns: [{ dropdown: "Kit", versions }] }] } };
      const { stderr } = build(makeRepo("many-labels", JSON.stringify(nav), extra));

      const prefix = "WARNING: version label(s) the search version filter cannot match: ";
      const line = stderr.split("\n").find((l) => l.startsWith(prefix)) ?? "";
      expect(line).toMatch(/ \(and 2 more\)$/);
      const labels = line.slice(prefix.length).replace(/ \(and 2 more\)$/, "").split(", ");
      expect(labels).toHaveLength(10);
      for (const label of labels) expect(Array.from(label).length).toBeLessThanOrEqual(40);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "names docs.json nesting too deep to index instead of calling it invalid JSON",
    () => {
      // JSON.parse accepts this; the recursive navigation walk overflows the stack.
      const deep = '{"navigation":' + "[".repeat(20_000) + "]".repeat(20_000) + "}";
      const { index, stderr } = build(makeRepo("deep-nav", deep));
      expect(stderr).toContain(
        "WARNING: docs.json navigation could not be indexed (RangeError: Maximum call stack size exceeded)",
      );
      expect(stderr).not.toContain("not valid JSON");
      expect(stored(index).get("/ui-kit/react/v6/overview")).toMatchObject({ product: null, version: "v6", is_current: 0 });
    },
    BUILD_TIMEOUT_MS,
  );

  it.each<[string, (repo: string) => void, string, string]>([
    [
      "is a directory",
      (repo) => mkdirSync(path.join(repo, "docs.json")),
      "WARNING: docs.json could not be read (EISDIR)",
      "no docs.json found",
    ],
    [
      "is null",
      (repo) => writeFileSync(path.join(repo, "docs.json"), "null"),
      "WARNING: docs.json navigation lists 0 pages",
      "no docs.json found",
    ],
    ["is absent", () => {}, "WARNING: no docs.json found", "could not be read"],
  ])(
    "warns when docs.json %s",
    (state, setup, warning, notWarning) => {
      const repo = makeRepo(`docs-json-${state.replace(/ /g, "-")}`, null);
      setup(repo);
      const { stderr } = build(repo);
      expect(stderr).toContain(warning);
      expect(stderr).not.toContain(notWarning);
      // Exactly one WARNING: a docs.json that lists no pages must not also be
      // reported as matching none of them.
      expect(stderr.split("\n").filter((l) => l.startsWith("WARNING:"))).toHaveLength(1);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "warns when docs.json navigation matches none of the indexed pages",
    async () => {
      const nav = { navigation: { tabs: [{ tab: "Docs", pages: ["missing/a", "missing/b"] }] } };
      const { index, stderr } = build(makeRepo("unmatched-nav", JSON.stringify(nav)));
      expect(stderr).toContain("WARNING: docs.json navigation lists 2 pages but none matched an indexed page");
      expect((await inspectIndex(index)).navPages).toBe(0);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "keeps the invalid JSON WARNING on one line when docs.json is pretty-printed",
    () => {
      // V8 quotes the source around the error, line breaks included, and the
      // refresher logs each stderr line on its own.
      const pretty = '{\n  "navigation": {\n    "pages": [\n      "a",\n      "b",\n    ]\n  }\n}\n';
      const { stderr } = build(makeRepo("pretty-bad-nav", pretty));
      const warning = stderr.split("\n").find((l) => l.startsWith("WARNING: docs.json is not valid JSON")) ?? "";
      expect(warning).toMatch(/; deriving page versions from paths$/);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "indexes an unlisted doc set that keeps older versions in version folders as retired",
    () => {
      const page = (title: string) => `---\ntitle: ${title}\n---\n\nCustomize the kit and enable or disable its features.\n`;
      const { index, stderr } = build(
        makeRepo("retired", JSON.stringify(DOCS_JSON), {
          "ui-kit/kotlin/customize-ui-kit": page("Customize UI Kit"),
          "ui-kit/kotlin/2.0/customize-ui-kit": page("Customize UI Kit"),
          // Unlisted too, but with no version folder: nothing says it is retired.
          "web-shared/receipts": page("Receipts"),
        }),
      );
      const pages = stored(index);
      expect(pages.get("/ui-kit/kotlin/customize-ui-kit")).toMatchObject({ product: null, version: null, is_current: 0 });
      expect(pages.get("/ui-kit/kotlin/2.0/customize-ui-kit")).toMatchObject({ version: "v2", is_current: 0 });
      expect(pages.get("/web-shared/receipts")).toMatchObject({ is_current: 1 });
      // Search keywords lead to the pages docs.json lists.
      const db = new Database(index, { readonly: true });
      const keywords = db.prepare("SELECT keywords FROM pages WHERE path = ?").pluck();
      expect(keywords.get("/web-shared/receipts")).toBe("[]");
      // A retired page keeps its section, but no query word names its product.
      const trails = db.prepare(
        `SELECT t.trail, l.trail AS label FROM pages p
         JOIN trails_fts t ON t.rowid = p.trail_id JOIN trails_fts l ON l.rowid = p.label_id WHERE p.path = ?`,
      );
      expect(trails.get("/ui-kit/kotlin/customize-ui-kit")).toEqual({ trail: "", label: "" });
      expect(trails.get("/ui-kit/kotlin/2.0/customize-ui-kit")).toEqual({ trail: "", label: "" });
      expect(pages.get("/ui-kit/kotlin/customize-ui-kit")).toMatchObject({ section: "UI Kit / Kotlin" });
      // An unlisted page outside a retired set keeps its folder section as its trail.
      expect(trails.get("/web-shared/receipts")).toEqual({ trail: "Web Shared / Receipts", label: "Web Shared / Receipts" });
      db.close();
      expect(pages.get("/ui-kit/react/overview")).toMatchObject({ is_current: 1 });
      expect(stderr).toMatch(/^retired doc sets, indexed as older versions: ui-kit\/kotlin$/m);
      // The fixture's unlisted calls/v4/ pages make "calls" look retired as
      // well. Nothing says it is retired rather than missing from docs.json,
      // so it is reported and left alone.
      expect(stderr).toMatch(
        /^WARNING: doc set\(s\) docs\.json does not list, left current: calls; add one to KNOWN_RETIRED_DOC_SETS/m,
      );
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "indexes a doc set's machine-readable page index by what it is, not by everything it lists",
    async () => {
      const listed = [
        "Message List — render a scrolling list of messages.",
        "Conversations — show the user's recent conversations.",
        "Threaded Messages — open a thread from a parent message.",
      ].join("\n");
      const { index } = build(
        makeRepo("llms-index", JSON.stringify(DOCS_JSON), {
          "ui-kit/vue/llms-vue-v4":
            '---\ntitle: "Vue UI Kit v4 — LLM docs index"\ndescription: "Machine-readable index of every Vue UI Kit page, built for AI coding agents."\n---\n\n' +
            `${listed}\n`,
          "ui-kit/vue/threaded-messages":
            "---\ntitle: Threaded Messages\n---\n\nOpen a thread from a parent message and post replies into it from the composer.\n",
        }),
      );
      const pages = stored(index);
      // Its own description is its text; the titles it lists are not.
      expect(pages.get("/ui-kit/vue/llms-vue-v4")?.body).toBe(
        "Machine-readable index of every Vue UI Kit page, built for AI coding agents.",
      );
      const client = new SqliteSearchClient(index);
      try {
        // A query about a page the index merely lists reaches that page.
        const r = await client.search("vue threaded messages", { limit: 2 });
        expect(r.results[0]?.url).toContain("/ui-kit/vue/threaded-messages");
        // The index page is still reachable as itself.
        const own = await client.search("vue llm docs index for ai coding agents", { limit: 3 });
        expect(own.results.map((x) => x.url)).toContain("https://www.cometchat.com/docs/ui-kit/vue/llms-vue-v4");
      } finally {
        client.close();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "leaves a doc set docs.json merely stopped listing current, with its product boost",
    async () => {
      // Unlisting a doc set is also what an ordinary navigation restructure
      // does. Demoting it on that alone empties its trail and clears
      // is_current, and the product drops out of its own results — while the
      // refresher's page counts, which do not change, wave the index through.
      const page = (title: string) => `---\ntitle: ${title}\n---\n\nInstall the kit and render the conversation list in a view.\n`;
      const { index, stderr } = build(
        makeRepo("unlisted-live", JSON.stringify(DOCS_JSON), {
          "ui-kit/vue/overview": page("Overview"),
          "ui-kit/vue/message-list": page("Message List"),
          "ui-kit/vue/v2/overview": page("Overview"),
        }),
      );
      const pages = stored(index);
      expect(pages.get("/ui-kit/vue/overview")).toMatchObject({ is_current: 1, version: null });
      expect(pages.get("/ui-kit/vue/message-list")).toMatchObject({ is_current: 1, version: null });
      // Only the version folder is older, by the path convention.
      expect(pages.get("/ui-kit/vue/v2/overview")).toMatchObject({ is_current: 0, version: "v2" });
      const db = new Database(index, { readonly: true });
      const trails = db.prepare(
        `SELECT t.trail, l.trail AS label FROM pages p
         JOIN trails_fts t ON t.rowid = p.trail_id JOIN trails_fts l ON l.rowid = p.label_id WHERE p.path = ?`,
      );
      expect(trails.get("/ui-kit/vue/overview")).toEqual({ trail: "UI Kit / Vue", label: "UI Kit / Vue" });
      db.close();
      expect(stderr).toMatch(/^WARNING: doc set\(s\) docs\.json does not list, left current: calls, ui-kit\/vue;/m);
      // And the product still answers a query that names it.
      const client = new SqliteSearchClient(index);
      const r = await client.search("vue message list", { limit: 3 });
      client.close();
      expect(r.results[0]?.url).toContain("/ui-kit/vue/message-list");
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "keeps version labels and page paths with line breaks on one WARNING line each",
    () => {
      const versions = [{ version: "Odd\nError: label", groups: [{ group: "Start", pages: ["ui-kit/react/overview"] }] }];
      const nav = { navigation: { tabs: [{ tab: "Docs", dropdowns: [{ dropdown: "Kit", versions }] }] } };
      const hostile = '---js\n{ title: "x" }\n---\n\nThis page has executable frontmatter, so the build skips it.\n';
      const { stderr } = build(makeRepo("line-breaks", JSON.stringify(nav), { "bad\nError: path": hostile }));
      const lines = stderr.split("\n");
      expect(lines).toContain("WARNING: version label(s) the search version filter cannot match: odd error: label");
      expect(lines).toContain("WARNING: skipped 1 page(s) with executable frontmatter: bad Error: path.mdx");
      expect(lines.filter((l) => /^error: /i.test(l))).toEqual([]);
    },
    BUILD_TIMEOUT_MS,
  );
});

describe("build-index search text", () => {
  it(
    "keeps the API names inline code carries, and nothing else from it",
    () => {
      const page =
        "---\ntitle: Receipts\n---\n\n| Method | Description |\n| --- | --- |\n" +
        "| `markAsRead(baseMessage:)` | Mark a message as read |\n\n" +
        "Use `markAsRead()` to mark messages as read, passing `CometChat.login(UID, authKey)` first.\n\n" +
        // Acronym-led names, and a digit before a capital.
        "Set the `UIColor` of the bubble and read `JSONObject` metadata, then pass `v4Settings` in.\n\n" +
        "Install `npm install @cometchat/chat-sdk-ios`, then edit `chat_builder/lib/utils/`, `UID` and `per_page`.\n";
      const { index } = build(makeRepo("mdx-inline-code", null, { "sdk/ios/delivery-read-receipts": page }));
      expect(stored(index).get("/sdk/ios/delivery-read-receipts")?.body).toBe(
        "| Method | Description | | --- | --- | | markAsRead(baseMessage:) | Mark a message as read | " +
          "Use markAsRead() to mark messages as read, passing CometChat authKey first. " +
          "Set the UIColor of the bubble and read JSONObject metadata, then pass v4Settings in. " +
          "Install , then edit , and .",
      );
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "drops a SCREAMING_SNAKE error code, so no tool may promise to search for one",
    async () => {
      // inlineCodeText keeps only compound identifiers; ERR_UID_NOT_FOUND
      // splits into ERR, UID, NOT and FOUND, none of them one, so the whole
      // span goes. Every error code in the docs is written this way, which is
      // why no tool description offers to find a page by its error code.
      const page =
        "---\ntitle: Error Guide\n---\n\nCommon error codes returned by the REST APIs and the SDKs.\n\n" +
        "| Error Code | Error Description |\n| --- | --- |\n" +
        "| `ERR_UID_NOT_FOUND` | Indicates that the user does not exist. |\n\n" +
        "A call that passes an unknown UID fails with `ERR_UID_NOT_FOUND`, and `CometChat.getUser()` rejects.\n";
      const { index } = build(makeRepo("mdx-error-codes", null, { "articles/error-guide": page }));
      const body = stored(index).get("/articles/error-guide")?.body ?? "";
      expect(body).not.toContain("ERR_UID_NOT_FOUND");
      expect(body).toContain("CometChat");
      const client = new SqliteSearchClient(index);
      try {
        expect(await client.search("ERR_UID_NOT_FOUND")).toEqual({ results: [], totalAvailable: 0 });
        // The prose around the code is what does find the page.
        expect((await client.search("error codes rest api")).results.map((x) => x.url)).toContain(
          "https://www.cometchat.com/docs/articles/error-guide",
        );
      } finally {
        client.close();
      }
      for (const d of [SEARCH_TOOL_DEFINITION, FETCH_TOOL_DEFINITION]) {
        expect(d.description, d.name).not.toMatch(/error (?:message|code)s?\b/i);
      }
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "names each language of a page's code tabs and fences once, apart from its text, leaving JavaScript and TypeScript out",
    async () => {
      const tabs =
        "---\ntitle: Presence\n---\n\nSubscribe to presence updates for the users in your app.\n\n<Tabs>\n" +
        '<Tab title="Swift">\n```swift\nlet a = 1\n```\n</Tab>\n<Tab title="Objective C">\n```objc\nint a = 1;\n```\n</Tab>\n</Tabs>\n';
      const android =
        "---\ntitle: Send\n---\n\nSend a text message to a user or a group.\n\n<Tabs>\n" +
        // The Kotlin tab wraps no fence: its title is the only evidence for Kotlin.
        '<Tab title="Kotlin (XML Views)">\nBind the view in the layout.\n</Tab>\n<Tab title="Java (User)">\n```java\nint a = 1;\n```\n</Tab>\n</Tabs>\n';
      const web =
        "---\ntitle: Setup\n---\n\nInstall the package, then initialise the SDK.\n\n" +
        '<Tab title="TypeScript">\n```ts\nconst a = 1;\n```\n</Tab>\n```javascript\nconst b = 2;\n```\n';
      // Fences alone name the language.
      const flutter = "---\ntitle: Typing\n---\n\nSend and receive typing indicators in a conversation.\n\n```dart\nfinal a = 1;\n```\n";
      // A tab title that is also an Object.prototype property names no language.
      const api =
        "---\ntitle: Settings Builder\n---\n\nThe builder's constructor and methods are described below.\n\n" +
        '<Tabs>\n<Tab title="Constructor">\n```swift\nlet b = Builder()\n```\n</Tab>\n<Tab title="toString">\nText.\n</Tab>\n</Tabs>\n';
      // Code alone is below the stub floor, whatever languages it names.
      const stub = "---\ntitle: Stub\n---\n\nShort.\n\n```swift\nlet a = 1\n```\n```kotlin\nval b = 2\n```\n";
      const { index } = build(
        makeRepo("mdx-code-languages", null, {
          "sdk/ios/user-presence": tabs,
          "sdk/android/send": android,
          "sdk/javascript/setup": web,
          "sdk/flutter/typing": flutter,
          "ui-kit/ios/settings-builder": api,
          "sdk/ios/stub": stub,
        }),
      );
      const pages = stored(index);
      expect(pages.get("/sdk/ios/user-presence")).toMatchObject({
        body: "Subscribe to presence updates for the users in your app.",
        languages: "Objective-C Swift",
      });
      expect(pages.get("/sdk/android/send")).toMatchObject({
        body: "Send a text message to a user or a group. Bind the view in the layout.",
        languages: "Java Kotlin",
      });
      expect(pages.get("/sdk/javascript/setup")).toMatchObject({
        body: "Install the package, then initialise the SDK.",
        languages: "",
      });
      expect(pages.get("/sdk/flutter/typing")?.languages).toBe("Dart");
      expect(pages.get("/ui-kit/ios/settings-builder")).toMatchObject({
        body: "The builder's constructor and methods are described below. Text.",
        languages: "Swift",
      });
      expect(pages.has("/sdk/ios/stub")).toBe(false);

      // A query naming a language matches, but the snippet is page text only.
      const client = new SqliteSearchClient(index);
      try {
        const r = await client.search("swift presence");
        expect(r.results.map((x) => x.url)).toEqual(["https://www.cometchat.com/docs/sdk/ios/user-presence"]);
        expect(r.results[0].snippet).toBe("Subscribe to presence updates for the users in your app.");
        expect((await client.search("dart typing")).results.map((x) => x.url)).toEqual([
          "https://www.cometchat.com/docs/sdk/flutter/typing",
        ]);
      } finally {
        client.close();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "leaves a closing Next Steps section out of the indexed text",
    () => {
      // The Delete Message page's card for the Edit page said "Edit sent
      // messages in conversations", so "iOS edit a sent message" found it.
      const withNextSteps =
        "---\ntitle: Delete Message\n---\n\nDeleting a message is straightforward.\n\n## Delete a Message\n\n" +
        "Call delete with the message ID.\n\n---\n\n## Next Steps\n\n<CardGroup cols={2}>\n" +
        '  <Card title="Edit a Message" href="/sdk/ios/edit-message">\n    Edit sent messages in conversations\n  </Card>\n' +
        "</CardGroup>\n";
      // Anything after it under a heading of its own stays.
      const followedByHeading =
        "---\ntitle: Guide\n---\n\nSet up the guide first.\n\n### Next steps\n\n- [Theme](/ui-kit/ios/theme) — colours\n\n" +
        "## Troubleshooting\n\nClear the build folder when the kit fails to load.\n";
      // A "## Next steps" line inside a code fence is example text, not a heading.
      const fenced =
        "---\ntitle: Readme Template\n---\n\nAdd a README to your sample app so teammates can run it.\n\n" +
        "```markdown\n# My Chat App\n\n## Next steps\n\nRun the app.\n```\n\n" +
        "After the template, configure push notifications before you ship.\n";
      const { index } = build(
        makeRepo("mdx-next-steps", null, {
          "sdk/ios/delete-message": withNextSteps,
          "ui-kit/ios/guide": followedByHeading,
          "sdk/ios/readme-template": fenced,
        }),
      );
      const pages = stored(index);
      expect(pages.get("/sdk/ios/readme-template")?.body).toBe(
        "Add a README to your sample app so teammates can run it. " +
          "After the template, configure push notifications before you ship.",
      );
      expect(pages.get("/sdk/ios/delete-message")?.body).toBe(
        "Deleting a message is straightforward. Delete a Message Call delete with the message ID. ---",
      );
      expect(pages.get("/ui-kit/ios/guide")?.body).toBe(
        "Set up the guide first. Troubleshooting Clear the build folder when the kit fails to load.",
      );
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "stores search keywords and title keys, OpenAPI reference pages included",
    async () => {
      const { index, stderr } = build(
        makeRepo("keywords", null, {
          // A guide, long enough to be one: only a page with real text earns
          // the whole-keyword bonus (KEYWORD_BONUS_MIN_BODY).
          "sdk/javascript/delete-message":
            "---\ntitle: Delete A Message\n---\n\nCall deleteMessage with the message ID to delete a message for all participants. " +
            "The call resolves with the deleted message, whose action tells every listener what happened, " +
            "so a client that is offline at the time still learns of it when it reconnects and syncs. " +
            "Only the sender of a message, or a moderator of the group it was sent to, may delete it; " +
            "anyone else receives a permission error, which the guide below shows how to surface.\n",
          "sdk/javascript/delivery-read-receipts":
            "---\ntitle: Delivery & Read Receipts\n---\n\nMark messages as delivered and read, and listen for receipt events.\n",
          // A title naming only its doc set has an empty key.
          "sdk/javascript/overview":
            "---\ntitle: JavaScript SDK\n---\n\nThe JavaScript SDK adds chat, calls and presence to a web app.\n",
          // A REST endpoint page: its indexed text is a line, and the consumer
          // words are the only way a query naming the REST API reaches it.
          "rest-api/messages/delete-message":
            '---\nopenapi: delete /messages/{id}\ndescription: "Delete a message."\n---\n\n' +
            "For the complete error reference, see [Error Guide](/articles/error-guide).\n",
          // An OpenAPI page with text of its own, past the stub floor: it can
          // be found by its own words, so it keeps the coinages only.
          "rest-api/messages/save-message":
            '---\nopenapi: post /messages/{id}/save\ntitle: "Save Message"\n---\n\n' +
            "A user can save up to 100 messages, and exceeding that returns an error. " +
            "Saved messages are private to the user they were saved for, so no one else " +
            "sees them in a list, and unsaving one removes it for that user alone. " +
            "The endpoint takes the message ID in the path and the user in the on-behalf-of " +
            "header, and answers with the saved message as the list endpoint returns it. " +
            "Saving a message a second time for the same user is accepted and changes nothing, " +
            "so a client that retries a request it never saw the answer to is safe. " +
            "A message deleted after it was saved stays in the list until it is unsaved, " +
            "and comes back with the deletion recorded on it rather than its original text.\n",
        }),
      );
      const db = new Database(index, { readonly: true });
      const row = (p: string) =>
        db.prepare("SELECT title_key, keywords FROM pages WHERE path = ?").get(p) as { title_key: string; keywords: string };
      try {
        expect(JSON.parse(row("/sdk/javascript/delete-message").keywords)).toEqual([
          "unsend",
          "unsent",
          "recall message",
          "recall a message",
          "retract message",
          "retract a message",
          "delete for everyone",
        ]);
        expect(row("/sdk/javascript/delete-message").title_key).toBe("delete message");
        expect(row("/sdk/javascript/delivery-read-receipts").title_key).toBe("delivery read receipts");
        expect(row("/sdk/javascript/overview").title_key).toBe("");
        expect(JSON.parse(row("/sdk/javascript/delivery-read-receipts").keywords)).toContain("blue ticks");
        // The REST endpoint's title earns the same rules. A stub of a line
        // gets all of them: they are the only words a query naming the REST
        // API can reach it by, and the stub factor holds them to that query.
        expect(JSON.parse(row("/rest-api/messages/delete-message").keywords)).toEqual([
          "unsend",
          "unsent",
          "recall message",
          "recall a message",
          "retract message",
          "retract a message",
          "delete for everyone",
        ]);
        // An OpenAPI page with text of its own keeps the coinages only: it can
        // be found without them, and one word of a multi-word keyword would
        // put it in front of every page that word belongs to.
        expect(JSON.parse(row("/rest-api/messages/save-message").keywords)).toEqual([]);
        expect(JSON.parse(row("/fundamentals/overview").keywords)).toEqual([]);
      } finally {
        db.close();
      }
      // Every rule that reaches a page here reaches a current one.
      expect(stderr).not.toContain("search keyword rule");
      const client = new SqliteSearchClient(index);
      try {
        const r = await client.search("unsend a message");
        // The guide leads, although the REST stub is shorter and carries the
        // same keywords: only the guide is long enough for the bonus.
        expect(r.results[0].url).toBe("https://www.cometchat.com/docs/sdk/javascript/delete-message");
        // The snippet is page text, never the keyword list.
        expect(r.results[0].snippet).not.toContain("retract");
        // Only the keywords column holds "unsend": it is searchable, on the
        // REST endpoint too, and still never part of a snippet.
        const alone = await client.search("unsend");
        expect(alone.results.map((x) => x.url)).toEqual([
          "https://www.cometchat.com/docs/sdk/javascript/delete-message",
          "https://www.cometchat.com/docs/rest-api/messages/delete-message",
        ]);
        expect(alone.results[0].snippet).not.toMatch(/retract|\[/);
      } finally {
        client.close();
      }
    },
    BUILD_TIMEOUT_MS,
  );
});

describe("build-index search keyword rules", () => {
  it(
    "warns when a rule reaches only older copies of its pages",
    () => {
      const presence = (title: string) =>
        `---\ntitle: ${title}\n---\n\nSubscribe to presence updates to learn when users come online.\n`;
      const { index, stderr } = build(
        makeRepo("keyword-retitled", null, {
          // The current page was retitled; the older copy still earns the keywords.
          "sdk/ios/user-presence": presence("Online Presence"),
          "sdk/ios/3.0/user-presence": presence("User Presence"),
        }),
      );
      expect(stderr).toMatch(
        /^WARNING: search keyword rule \/\^\(user \)\?presence\$\/i matches no current page, only 1 older one\(s\); were the current pages retitled\?$/m,
      );
      // Only that rule: the others reach no page at all here.
      expect(stderr.split("\n").filter((l) => l.includes("search keyword rule"))).toHaveLength(1);
      const db = new Database(index, { readonly: true });
      try {
        const keywords = db.prepare("SELECT keywords FROM pages WHERE path = ?").pluck();
        expect(JSON.parse(keywords.get("/sdk/ios/3.0/user-presence") as string)).toContain("last seen");
        expect(keywords.get("/sdk/ios/user-presence")).toBe("[]");
      } finally {
        db.close();
      }
    },
    BUILD_TIMEOUT_MS,
  );
});

describe("build-index MDX body", () => {
  it(
    "skips pages whose only content is an MDX import, and keeps imports out of indexed text",
    () => {
      const snippetOnly = "---\ntitle: AI Agent Actions\n---\n\nimport Actions from '/snippets/ai-agents/actions.mdx';\n\n<Actions />\n";
      const withProse =
        '---\ntitle: Advanced\n---\nimport AdvancedJSAPIs from "/snippets/widget/advanced-js-apis.mdx";\n\n' +
        "Configure the widget launcher, colours and default conversation for your site.\n\n<AdvancedJSAPIs />\n";
      // An import inside a code sample, right before the closing fence, must not
      // swallow the fence or the prose after it.
      const codeSample =
        "---\ntitle: Setup\n---\n\nInstall the package first.\n\n```js\nimport { CometChat } from '@cometchat/chat-sdk-javascript';\n```\n" +
        "Then initialise the SDK with your app ID and region before logging in.\n";
      const { index } = build(
        makeRepo("mdx-esm", null, {
          "ai-agents/crew-ai-actions": snippetOnly,
          "widget/html/advanced": withProse,
          "sdk/javascript/setup": codeSample,
        }),
      );
      const pages = stored(index);
      expect(pages.has("/ai-agents/crew-ai-actions")).toBe(false);
      expect(pages.get("/widget/html/advanced")?.body).toBe(
        "Configure the widget launcher, colours and default conversation for your site.",
      );
      expect(pages.get("/sdk/javascript/setup")?.body).toBe(
        "Install the package first. Then initialise the SDK with your app ID and region before logging in.",
      );
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "reads a '<' in prose as text, not as a tag running into the code fences",
    () => {
      // The React.js Integration page: a version range in a table, then fenced
      // code holding the next ">". Read as a tag, it swallowed a fence, and the
      // fence pairs after it dropped the prose instead of the code.
      const page =
        "---\ntitle: React.js Integration\n---\n\n" +
        "| Peer deps | `react` >=18 <21 |\n\n" +
        "Install the UI Kit before rendering.\n\n" +
        '<Tab title="npm">\n```bash\nnpm install kit\n```\n</Tab>\n\n' +
        "Initialise it with your app ID.\n\n" +
        "```tsx\nconst el = <div>{a > b}</div>;\n```\n\n" +
        "Then log in a user.\n";
      const { index } = build(makeRepo("mdx-angle", null, { "ui-kit/react/integration-react": page }));
      expect(stored(index).get("/ui-kit/react/integration-react")?.body).toBe(
        "| Peer deps | >=18 <21 | Install the UI Kit before rendering. Initialise it with your app ID. Then log in a user.",
      );
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "keeps a tab title that names more than a language or file",
    () => {
      const page =
        "---\ntitle: iOS Integration\n---\n\nAdd the UI Kit to your project.\n\n" +
        '<Tabs>\n<Tab title="Swift Package Manager">\nAdd the package URL in Xcode.\n</Tab>\n' +
        '<Tab title="Swift">\nImport the module.\n</Tab>\n' +
        '<Tab title="Kotlin (XML Views)">\nInflate the view.\n</Tab>\n</Tabs>\n';
      const { index } = build(makeRepo("mdx-tabs", null, { "ui-kit/ios/getting-started": page }));
      expect(stored(index).get("/ui-kit/ios/getting-started")?.body).toBe(
        "Add the UI Kit to your project. Swift Package Manager Add the package URL in Xcode. Import the module. Inflate the view.",
      );
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "keeps inline code, MDX comments and tab attributes from turning prose into tags",
    () => {
      const page =
        "---\ntitle: Users\n---\n\n" +
        "Call `getUsers()` to get an `Array<User>` back; check `count < limit` first.\n\n" +
        "Render `<CometChatMessageList user={user} />` with `List<CometChatOption>` options.\n\n" +
        "{/* Draft note: <b>remove</b> before launch > soon */}\n\n" +
        "Paginate with the request builder.\n\n" +
        '<Tabs>\n<Tab icon="box" title="Swift Package Manager">\nAdd the package.\n</Tab>\n' +
        "<Tab title='Gradle Version Catalog'>\nAdd the library.\n</Tab>\n</Tabs>\n";
      const { index } = build(makeRepo("mdx-inline", null, { "sdk/javascript/users": page }));
      expect(stored(index).get("/sdk/javascript/users")?.body).toBe(
        "Call getUsers() to get an back; check first. Render CometChatMessageList with CometChatOption options. " +
          "Paginate with the request builder. " +
          "Swift Package Manager Add the package. Gradle Version Catalog Add the library.",
      );
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "indexes imported snippets under the importing page, without their frontmatter or imports",
    () => {
      const { index } = build(
        makeRepo("mdx-snippets", null, {
          "snippets/ai-agents/actions":
            "---\ntitle: Shared Actions\ndescription: never indexed\n---\n\nimport Note from '/snippets/shared/note.mdx';\n\n" +
            "## Overview\n\nActions let your agent run predefined tasks during a conversation.\n\n<Note />\n",
          // Imports the snippet that imports it: the cycle must end.
          "snippets/shared/note":
            "---\ntitle: Note\n---\n\nimport Actions from '/snippets/ai-agents/actions.mdx';\n\n" +
            "Retries back off exponentially after a failed action.\n\n<Actions />\n",
          "ai-agents/crew-ai-actions":
            "---\ntitle: AI Agent Actions\n---\n\nimport Actions from '/snippets/ai-agents/actions.mdx';\n\n<Actions />\n",
        }),
      );
      const pages = stored(index);
      expect(pages.get("/ai-agents/crew-ai-actions")?.body).toBe(
        "Overview Actions let your agent run predefined tasks during a conversation. " +
          "Retries back off exponentially after a failed action.",
      );
      // Snippets are not pages of their own.
      expect([...pages.keys()].some((p) => p.startsWith("/snippets/"))).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "refuses snippet imports that leave the docs root or are not MDX",
    () => {
      const outside = path.join(tmp, "outside-secret.mdx");
      writeFileSync(outside, "---\ntitle: Secret\n---\n\nOUTSIDE_SECRET_TEXT must never be indexed.\n");
      const repo = makeRepo("mdx-traversal", null, {
        "guides/imports":
          "---\ntitle: Imports\n---\n\n" +
          "import Up from '/snippets/../../outside-secret.mdx';\n" +
          "import Linked from '/snippets/linked.mdx';\n" +
          "import Text from '/snippets/notes.txt';\n" +
          "import Hosts from '/etc/hosts';\n\n" +
          "This guide explains how imports resolve when the index is built.\n\n<Up />\n\n<Linked />\n\n<Text />\n\n<Hosts />\n",
      });
      mkdirSync(path.join(repo, "snippets"), { recursive: true });
      // In-root name, out-of-root target.
      symlinkSync(outside, path.join(repo, "snippets", "linked.mdx"));
      writeFileSync(path.join(repo, "snippets", "notes.txt"), "TXT_SECRET_TEXT");

      const { index } = build(repo);
      expect(stored(index).get("/guides/imports")?.body).toBe(
        "This guide explains how imports resolve when the index is built.",
      );
    },
    BUILD_TIMEOUT_MS,
  );
});
