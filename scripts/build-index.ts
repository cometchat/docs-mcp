#!/usr/bin/env tsx
/**
 * Build the SQLite FTS5 search index from a clone of github.com/cometchat/docs.
 *
 * Usage:
 *   DOCS_REPO=/path/to/cometchat-docs INDEX_PATH=./data/index.sqlite tsx scripts/build-index.ts
 *
 * The indexer walks the repo, parses MDX frontmatter + body, derives the Mintlify
 * URL from the file path, and writes one row per page into a `pages` table backed
 * by an FTS5 virtual table. Each page's product, version label and whether it is
 * the current version come from the docs.json navigation, falling back to the
 * path for repos (or pages) it does not cover — see src/search/navigation.ts.
 * Shared snippets a page imports from /snippets/ are indexed as part of it.
 */
import { readdir, readFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "../src/lib/frontmatter.js";
import { SnippetInliner } from "../src/search/mdx-imports.js";
import { indexNavigation, resolvePageVersion, type NavigationIndex } from "../src/search/navigation.js";
import { VERSION_LABEL_RE } from "../src/search/version.js";
import Database from "better-sqlite3";

const DOCS_REPO = process.env.DOCS_REPO ?? "../cometchat-docs-repo";
const INDEX_PATH = process.env.INDEX_PATH ?? "./data/index.sqlite";
const DOCS_BASE_URL =
  process.env.DOCS_BASE_URL ?? "https://www.cometchat.com/docs";

const SECTION_LABELS: Record<string, string> = {
  sdk: "SDK",
  "ui-kit": "UI Kit",
  "rest-api": "REST API",
  "chat-builder": "Chat Builder",
  moderation: "Moderation",
  notifications: "Notifications",
  widget: "Widget",
  "ai-agents": "AI Agents",
  "ai-chatbots": "AI Chatbots",
  fundamentals: "Fundamentals",
  calls: "Calls",
  articles: "Articles",
  "on-premise-deployment": "On-Premise Deployment",
  "web-elements": "Web Elements",
  "web-shared": "Web Shared",
};

const VERSION_RE = /^v\d+(\.\d+)?$/i;

async function main() {
  const repoStat = await stat(DOCS_REPO).catch(() => null);
  if (!repoStat || !repoStat.isDirectory()) {
    console.error(
      `DOCS_REPO not found or not a directory: ${DOCS_REPO}\n` +
        `Clone github.com/cometchat/docs first:\n` +
        `  git clone --depth 1 https://github.com/cometchat/docs.git cometchat-docs-repo`,
    );
    process.exit(1);
  }
  await mkdir(path.dirname(INDEX_PATH), { recursive: true });

  const db = new Database(INDEX_PATH);
  db.pragma("journal_mode = WAL");
  // product/version/is_current are filters and ranking inputs, not search
  // text: an indexed "v4" token matched the label instead of page content.
  // trails_fts holds each distinct product name once: a page points at its
  // navigation trail (trail_id) and its folder section (label_id), and the
  // search boosts it by how many query terms the better of the two matches
  // (see src/search/sqlite.ts).
  db.exec(`
    DROP TABLE IF EXISTS pages_fts;
    DROP TABLE IF EXISTS trails_fts;
    DROP TABLE IF EXISTS pages;
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      section TEXT NOT NULL,
      product TEXT,
      version TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
      trail_id INTEGER NOT NULL,
      label_id INTEGER NOT NULL,
      body TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      title, body, section,
      content='pages', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE trails_fts USING fts5(trail, tokenize='porter unicode61');
    CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, body, section)
      VALUES (new.id, new.title, new.body, new.section);
    END;
  `);

  const insert = db.prepare(
    `INSERT INTO pages (path, url, title, section, product, version, is_current, trail_id, label_id, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTrail = db.prepare(`INSERT INTO trails_fts (rowid, trail) VALUES (?, ?)`);
  const trailIds = new Map<string, number>();
  const trailId = (trail: string): number => {
    let id = trailIds.get(trail);
    if (id === undefined) {
      id = trailIds.size + 1;
      insertTrail.run(id, trail);
      trailIds.set(trail, id);
    }
    return id;
  };
  const insertMany = db.transaction((rows: Row[]) => {
    for (const r of rows) {
      const ids = [trailId(productTrail(r)), trailId(r.section)] as const;
      try {
        insert.run(r.path, r.url, r.title, r.section, r.product, r.version, r.isCurrent ? 1 : 0, ...ids, r.body);
      } catch (err) {
        // Skip duplicates from differing-case path collisions.
        const msg = (err as Error).message;
        if (!msg.includes("UNIQUE")) throw err;
      }
    }
  });

  const nav = await loadNavigation(DOCS_REPO);
  const files = await collectMdx(DOCS_REPO);
  const inliner = await SnippetInliner.create(DOCS_REPO);
  console.error(`Indexing ${files.length} mdx files from ${DOCS_REPO}`);

  const rows: Row[] = [];
  const unsafeFrontmatter: string[] = [];
  for (const abs of files) {
    const rel = path.relative(DOCS_REPO, abs);
    if (rel.startsWith("node_modules/") || rel.startsWith("snippets/")) continue;
    const raw = await readFile(abs, "utf8");
    const parsed = parseFrontmatter(raw);
    if (parsed.unsafeLanguage) {
      // Docs come from a public repo and are rebuilt inside the serving
      // container: skip the page, never evaluate it, and keep the build going.
      unsafeFrontmatter.push(rel);
      continue;
    }
    const fm = parsed.data as Record<string, unknown>;
    const body = stripMdx(await inliner.inline(parsed.content, abs));
    if (body.trim().length < 40) continue;
    const urlPath = "/" + rel.replace(/\.mdx$/, "");
    const segments = urlPath.split("/").filter(Boolean);
    const section = sectionFor(segments);
    const { product, version, isCurrent } = resolvePageVersion(urlPath, nav);
    rows.push({
      path: urlPath,
      url: `${DOCS_BASE_URL}${urlPath}`,
      title: typeof fm.title === "string" ? fm.title : titleFromPath(urlPath),
      section,
      product,
      version,
      isCurrent,
      body,
    });
  }

  insertMany(rows);
  db.exec(`INSERT INTO pages_fts(pages_fts) VALUES('optimize');`);
  const total = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(is_current = 0), 0) AS legacy FROM pages`)
    .get() as { n: number; legacy: number };
  // Finalize out of WAL: a WAL-mode file needs writable -wal/-shm siblings even
  // for readonly opens, which breaks read-only index mounts in production.
  db.pragma("journal_mode = DELETE");
  db.close();
  unsafeFrontmatter.push(...inliner.unsafe);
  if (unsafeFrontmatter.length > 0) {
    // Loud on purpose: docs pages never legitimately use an executable
    // frontmatter language, so this is either a mistake or an attack.
    console.error(
      `WARNING: skipped ${unsafeFrontmatter.length} page(s) with executable frontmatter: ` +
        unsafeFrontmatter.slice(0, 10).join(", "),
    );
  }
  const unfilterable = [...new Set(rows.flatMap((r) => (r.version && !VERSION_LABEL_RE.test(r.version) ? [r.version] : [])))];
  if (unfilterable.length > 0) {
    // Stored and reported on results, but SearchInputSchema rejects them.
    console.error(`WARNING: version label(s) the search version filter cannot match: ${unfilterable.join(", ")}`);
  }
  console.error(`Index built: ${total.n} pages (${total.legacy} older-version) → ${INDEX_PATH}`);
}

type Row = {
  path: string;
  url: string;
  title: string;
  section: string;
  product: string | null;
  version: string | null;
  isCurrent: boolean;
  body: string;
};

/**
 * docs.json navigation is the source of truth for versions. A repo without one
 * (the refresh E2E fixture) or with an unparseable one still builds, with
 * versions derived from paths alone.
 */
async function loadNavigation(repo: string): Promise<NavigationIndex> {
  let raw: string;
  try {
    raw = await readFile(path.join(repo, "docs.json"), "utf8");
  } catch {
    console.error("No docs.json found; deriving page versions from paths");
    return indexNavigation(null);
  }
  try {
    const nav = indexNavigation(JSON.parse(raw));
    console.error(`docs.json navigation lists ${nav.pages.size} pages`);
    return nav;
  } catch (err) {
    console.error(
      `WARNING: docs.json is not valid JSON (${(err as Error).message}); deriving page versions from paths`,
    );
    return indexNavigation(null);
  }
}

async function collectMdx(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "images" ||
          entry.name === "assets" ||
          entry.name === "html-files" ||
          entry.name === "snippets"
        ) {
          continue;
        }
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        out.push(abs);
      }
    }
  }
  await walk(root);
  return out;
}

function stripMdx(content: string): string {
  return content
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    // MDX ESM: an import/export at the start of a line runs to the next blank
    // line. A page that only imports a shared snippet must fall under the
    // stub floor, not be indexed with the import statement as its body.
    .replace(/^(?:import|export)[ \t].*(?:\n[ \t]*\S.*)*/gm, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[(.+?)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The page's product as the docs.json navigation names it, below the product
 * family: "UI Kit Builder / React" from "Chat & Messaging / UI Kit Builder /
 * React". The family is shared by most pages ("chat" would favour Widget
 * Builder as much as the UI Kit Builder), so it is left out. The boost also
 * tries the folder section ("Chat Builder / React", "Mcp-Server"), which names
 * products the trail does not, and keeps the better match of the two: merging
 * both into one label would credit "flutter chat ui kit" to /chat-builder/.
 * Pages the navigation does not cover have only the section.
 */
function productTrail(row: Row): string {
  return row.product?.split(" / ").slice(1).join(" / ") || row.section;
}

function sectionFor(segments: string[]): string {
  if (segments.length === 0) return "Documentation";
  const top = segments[0];
  // Look past a version folder (/calls/v4/javascript/...): the section is a
  // weighted ranking input, so legacy pages must name their framework too.
  const second = VERSION_RE.test(segments[1] ?? "") ? segments[2] : segments[1];
  const label = SECTION_LABELS[top] ?? capitalize(top);
  return second ? `${label} / ${capitalize(second)}` : label;
}

function titleFromPath(urlPath: string): string {
  const last = urlPath.split("/").filter(Boolean).pop() ?? "Documentation";
  return capitalize(last.replace(/-/g, " "));
}

function capitalize(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
