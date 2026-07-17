#!/usr/bin/env tsx
/**
 * Build the SQLite FTS5 search index from a clone of github.com/cometchat/docs.
 *
 * Usage:
 *   DOCS_REPO=/path/to/cometchat-docs INDEX_PATH=./data/index.sqlite tsx scripts/build-index.ts
 *
 * The indexer walks the repo, parses MDX frontmatter + body, derives the Mintlify
 * URL from the file path, and writes one row per page into a `pages` table backed
 * by an FTS5 virtual table.
 */
import { readdir, readFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
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
  db.exec(`
    DROP TABLE IF EXISTS pages_fts;
    DROP TABLE IF EXISTS pages;
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
    `INSERT INTO pages (path, url, title, section, version, body) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((rows: Row[]) => {
    for (const r of rows) {
      try {
        insert.run(r.path, r.url, r.title, r.section, r.version, r.body);
      } catch (err) {
        // Skip duplicates from differing-case path collisions.
        const msg = (err as Error).message;
        if (!msg.includes("UNIQUE")) throw err;
      }
    }
  });

  const files = await collectMdx(DOCS_REPO);
  console.error(`Indexing ${files.length} mdx files from ${DOCS_REPO}`);

  const rows: Row[] = [];
  for (const abs of files) {
    const rel = path.relative(DOCS_REPO, abs);
    if (rel.startsWith("node_modules/") || rel.startsWith("snippets/")) continue;
    const raw = await readFile(abs, "utf8");
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const body = stripMdx(parsed.content);
    if (body.trim().length < 40) continue;
    const urlPath = "/" + rel.replace(/\.mdx$/, "");
    const segments = urlPath.split("/").filter(Boolean);
    const section = sectionFor(segments);
    const version = detectVersion(segments);
    rows.push({
      path: urlPath,
      url: `${DOCS_BASE_URL}${urlPath}`,
      title: typeof fm.title === "string" ? fm.title : titleFromPath(urlPath),
      section,
      version,
      body,
    });
  }

  insertMany(rows);
  db.exec(`INSERT INTO pages_fts(pages_fts) VALUES('optimize');`);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number };
  // Finalize out of WAL: a WAL-mode file needs writable -wal/-shm siblings even
  // for readonly opens, which breaks read-only index mounts in production.
  db.pragma("journal_mode = DELETE");
  db.close();
  console.error(`Index built: ${total.n} pages → ${INDEX_PATH}`);
}

type Row = {
  path: string;
  url: string;
  title: string;
  section: string;
  version: string | null;
  body: string;
};

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
    .replace(/`[^`]*`/g, " ")
    .replace(/\[(.+?)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionFor(segments: string[]): string {
  if (segments.length === 0) return "Documentation";
  const top = segments[0];
  const second = segments[1];
  const label = SECTION_LABELS[top] ?? capitalize(top);
  return second && !VERSION_RE.test(second) ? `${label} / ${capitalize(second)}` : label;
}

function detectVersion(segments: string[]): string | null {
  const found = segments.find((s) => VERSION_RE.test(s));
  return found ? found.toLowerCase() : null;
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
