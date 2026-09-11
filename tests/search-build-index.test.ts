import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SqliteSearchClient } from "../src/search/sqlite.js";

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
  const rows = db.prepare("SELECT path, section, product, version, is_current, body FROM pages").all() as Stored[];
  db.close();
  return new Map(rows.map((r) => [r.path, r]));
}

describe("build-index version metadata", () => {
  it(
    "derives product, version and currency from docs.json",
    () => {
      const { index } = build(makeRepo("with-nav", JSON.stringify(DOCS_JSON)));
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
      expect(byPath.get("/calls/v4/javascript/setup")).toMatchObject({
        trail: "Calls / Javascript",
        label: "Calls / Javascript",
      });
      // The version label is metadata, not searchable text.
      expect(ftsColumns).toEqual(["title", "body", "section"]);
      expect(String(journal).toLowerCase()).toBe("delete");
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
