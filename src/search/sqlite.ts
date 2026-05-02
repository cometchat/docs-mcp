import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { logger } from "../lib/logger.js";
import { snippet, SEARCH_MAX_RESULTS } from "../lib/truncate.js";
import { BackendError } from "../lib/errors.js";
import type { SearchClient, SearchResponse, SearchResult } from "./types.js";

type Row = {
  title: string;
  url: string;
  section: string;
  body: string;
  version: string | null;
  rank: number;
};

const FTS_QUERY = `
  SELECT
    pages.title,
    pages.url,
    pages.section,
    pages.body,
    pages.version,
    bm25(pages_fts) AS rank
  FROM pages_fts
  JOIN pages ON pages.rowid = pages_fts.rowid
  WHERE pages_fts MATCH ?
    AND ($version IS NULL OR pages.version = $version)
  ORDER BY rank
  LIMIT $limit
`;

const COUNT_QUERY = `
  SELECT COUNT(*) AS total
  FROM pages_fts
  JOIN pages ON pages.rowid = pages_fts.rowid
  WHERE pages_fts MATCH ?
    AND ($version IS NULL OR pages.version = $version)
`;

type Prepared = {
  db: Database.Database;
  searchStmt: Database.Statement<[string, { version: string | null; limit: number }], Row>;
  countStmt: Database.Statement<[string, { version: string | null }], { total: number }>;
};

export class SqliteSearchClient implements SearchClient {
  private prepared: Prepared | null = null;
  private warned = false;

  constructor(private readonly indexPath: string) {}

  isReady(): boolean {
    return this.prepared !== null || existsSync(this.indexPath);
  }

  indexAgeSeconds(): number | null {
    try {
      const s = statSync(this.indexPath);
      const ageMs = Date.now() - s.mtimeMs;
      return Math.max(0, Math.floor(ageMs / 1000));
    } catch {
      return null;
    }
  }

  private open(): Prepared {
    if (this.prepared) return this.prepared;
    if (!existsSync(this.indexPath)) {
      throw new BackendError(
        `Search index not found at ${this.indexPath}. Run \`npm run build:index\` against a clone of cometchat/docs first.`,
      );
    }
    const db = new Database(this.indexPath, { readonly: true, fileMustExist: true });
    db.pragma("journal_mode = WAL");
    this.prepared = {
      db,
      searchStmt: db.prepare(FTS_QUERY),
      countStmt: db.prepare(COUNT_QUERY),
    };
    return this.prepared;
  }

  async search(query: string, opts: { version?: string; limit?: number } = {}): Promise<SearchResponse> {
    const limit = Math.min(opts.limit ?? 10, SEARCH_MAX_RESULTS);
    const version = opts.version ?? null;
    const tokens = tokenizeForFts(query);

    let prepared: Prepared;
    try {
      prepared = this.open();
    } catch (err) {
      if (!this.warned) {
        logger.warn({ indexPath: this.indexPath }, "sqlite_index_unavailable");
        this.warned = true;
      }
      throw err;
    }

    const runQuery = (ftsQuery: string) => {
      const rows = prepared.searchStmt.all(ftsQuery, { version, limit });
      const total = prepared.countStmt.get(ftsQuery, { version })?.total ?? 0;
      return { rows, total };
    };

    try {
      const andQuery = buildFtsQuery(tokens, "AND", query);
      let { rows, total } = runQuery(andQuery);

      if (rows.length === 0 && tokens.length > 1) {
        const orQuery = buildFtsQuery(tokens, "OR", query);
        ({ rows, total } = runQuery(orQuery));
      }

      const results: SearchResult[] = rows.map((r) => ({
        title: r.title,
        url: r.url,
        section: r.section,
        snippet: snippet(extractSnippet(r.body, tokens, query)),
      }));
      return { results, totalAvailable: total };
    } catch (err) {
      logger.error({ err, query }, "sqlite_search_failed");
      throw new BackendError();
    }
  }

  close() {
    this.prepared?.db.close();
    this.prepared = null;
  }
}

function tokenizeForFts(raw: string): string[] {
  return raw
    .replace(/"/g, "")
    .split(/\s+/)
    .map((t) => t.replace(/[^\w-]/g, ""))
    .filter((t) => t.length > 0);
}

function buildFtsQuery(tokens: string[], op: "AND" | "OR", raw: string): string {
  if (tokens.length === 0) {
    const safe = raw.replace(/"/g, "").trim();
    return safe.length > 0 ? `"${safe}"` : `""`;
  }
  const quoted = tokens.map((t) => `"${t}"`);
  return op === "AND" ? quoted.join(" ") : quoted.join(" OR ");
}

function extractSnippet(body: string, tokens: string[], rawQuery: string): string {
  const lowered = body.toLowerCase();
  let bestIdx = -1;
  for (const t of tokens) {
    const idx = lowered.indexOf(t.toLowerCase());
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx < 0) {
    const fallback = rawQuery.toLowerCase().split(/\s+/).find((s) => s.length > 0);
    if (fallback) bestIdx = lowered.indexOf(fallback);
  }
  if (bestIdx < 0) return body.slice(0, 400);
  const start = Math.max(0, bestIdx - 80);
  const end = Math.min(body.length, bestIdx + 220);
  return body.slice(start, end);
}
