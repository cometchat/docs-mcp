import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { logger } from "../lib/logger.js";
import { snippet, SEARCH_MAX_RESULTS } from "../lib/truncate.js";
import { BackendError } from "../lib/errors.js";
import { queryVersionLabel, queryVersionWord } from "./version.js";
import type { SearchClient, SearchResponse, SearchResult } from "./types.js";

type RankedRow = {
  id: number;
  title: string;
  url: string;
  section: string;
  version: string | null;
  isCurrent: number;
  body: string;
};

type SearchParams = {
  match: string;
  version: string | null;
  limit: number;
  legacyFactor: number;
  /** JSON array of the version labels the query names, or null. */
  named: string | null;
  terms: number;
  /** The query's terms as " term term ", to find whole page titles in it; null without terms. */
  titleText: string | null;
  /** JSON array of the MATCH phrases; only indexes with product trails read it. */
  phrases?: string;
};
type CountParams = { match: string; version: string | null };
type SnippetParams = { match: string; id: bigint };

// Ranking, tuned on the golden queries in scripts/eval-search.ts and checked on
// held-out queries; these values sit mid-plateau (title 3-8, section 0.5-1,
// boost 2-4 all pass). bm25 weights follow the FTS column order (title, body,
// section).
//
// FTS5's bm25 adds up a term's weighted count across columns before saturating
// it, then normalizes by the length of the whole row. A heavily weighted
// section label ("UI Kit / Vue") saturates every page of the product a query
// names, so the shortest pages won whatever their body said. The section
// therefore counts in bm25 like one more occurrence of a term (so SDK pages
// that never repeat "android" still match it), and the product match is a
// bounded multiplier: up to 1 + SECTION_BOOST when the page's product matches
// every query term. The product is its docs.json navigation trail ("Chat &
// Messaging / UI Kit Builder / React"), not the folder label: /chat-builder/
// pages document the UI Kit Builder, so "ui kit builder" must not favour
// every /ui-kit/ page over them.
const TITLE_WEIGHT = 5;
const BODY_WEIGHT = 1;
const SECTION_WEIGHT = 1;
const SECTION_BOOST = 2;
// Older doc versions outnumber current ones and their pages are shorter, so
// plain bm25 ranked them first. bm25 is negative (lower = better): scaling a
// legacy page's score toward zero ranks it below a comparably relevant current
// page without hiding a legacy page that is clearly the better match. Anything
// from 0.3 to 0.7 ranks the golden set identically. When the query names a
// version, the same factor instead demotes pages of every other version.
const LEGACY_FACTOR = 0.5;
// A query holding a page's whole multi-word title ("angular ui kit message
// list" / "Message List") names that page, but such titles are made of words
// nearly every page of the product uses, so title weight alone cannot lift it
// above shorter pages. One-word titles ("Theme", "Overview") match too many
// queries to count. On the held-out queries: 10 better, 8 worse, the worse by
// one to two places.
const TITLE_PHRASE_BONUS = 2;
// Distinct query tokens kept: MATCH and the product boost cost grow with each,
// and a 500-character query of repeated words must not multiply them.
export const MAX_QUERY_TOKENS = 32;
// Tokens of body text around the best-matching passage (FTS5 allows up to 64).
const SNIPPET_TOKENS = 40;
// FTS5's snippet() scores a window at every query-term instance in the page,
// so its cost grows with the square of the instance count: about 3 ms at 1,000
// instances and a second at 16,000. Real pages stay far below this (the most
// any one term occurs in a page is 464); a page above it gets the linear
// excerpt instead of stalling every search that returns it.
export const SNIPPET_MAX_MATCHES = 1000;
// Linear excerpt window around the first match, in characters.
const EXCERPT_BEFORE = 80;
const EXCERPT_AFTER = 210;

export type IndexSchema = {
  /** pages.is_current exists (indexes from builders with docs.json version metadata). */
  versionMetadata: boolean;
  /** trails_fts and pages.trail_id exist (product-trail boost). */
  productTrails: boolean;
};

/**
 * Indexes built before version metadata have no is_current column and still
 * index `version` as a fourth FTS column (bm25 weights it at the default 1.0).
 * There, an unversioned path is the best available signal for "current", and
 * the product boost falls back to the section label indexed in pages_fts.
 */
export function buildQueries(schema: IndexSchema) {
  const current = schema.versionMetadata ? "pages.is_current = 1" : "pages.version IS NULL";
  const filter = "pages_fts MATCH $match AND ($version IS NULL OR pages.version = $version)";
  // Query terms the page's product matches. With trails: one FTS lookup per
  // term in the small trails index, counting distinct terms, for the page's
  // navigation trail and its folder section, keeping the better. Without:
  // highlight() inserts one marker per matched term instance in the section column.
  const productHits = schema.productTrails
    ? "max(COALESCE(trail_hits.n, 0), COALESCE(label_hits.n, 0))"
    : "length(highlight(pages_fts, 2, char(1), '')) - length(pages.section)";
  const hits = schema.productTrails
    ? `hits AS MATERIALIZED (
      SELECT trails_fts.rowid AS trail_id, COUNT(*) AS n
      FROM json_each($phrases) AS q
      CROSS JOIN trails_fts
      WHERE trails_fts MATCH q.value
      GROUP BY trails_fts.rowid
    ),`
    : "";
  const versionFactor = `CASE
          WHEN $named IS NULL THEN (CASE WHEN ${current} THEN 1.0 ELSE $legacyFactor END)
          WHEN pages.version IN (SELECT value FROM json_each($named)) THEN 1.0
          ELSE $legacyFactor
        END`;
  // Rank ids first; the outer query then reads only the returned pages (a
  // body in the sorter would be copied for every matching row), and snippets
  // come from a per-page statement.
  const search = `
    WITH ${hits} ranked AS (
      SELECT
        pages.rowid AS id,
        bm25(pages_fts, ${TITLE_WEIGHT}, ${BODY_WEIGHT}, ${SECTION_WEIGHT})
          * (1.0 + ${SECTION_BOOST} * CAST(min(${productHits}, $terms) AS REAL) / $terms)
          * (${versionFactor})
          * (CASE WHEN instr(trim(pages.title), ' ') > 0 AND instr($titleText, ' ' || lower(pages.title) || ' ') > 0
              THEN ${TITLE_PHRASE_BONUS} ELSE 1.0 END) AS rank
      FROM pages_fts
      JOIN pages ON pages.rowid = pages_fts.rowid
      ${
        schema.productTrails
          ? `LEFT JOIN hits AS trail_hits ON trail_hits.trail_id = pages.trail_id
      LEFT JOIN hits AS label_hits ON label_hits.trail_id = pages.label_id`
          : ""
      }
      WHERE ${filter}
      ORDER BY rank
      LIMIT $limit
    )
    SELECT
      ranked.id,
      pages.title,
      pages.url,
      pages.section,
      pages.version,
      (${current}) AS isCurrent,
      pages.body
    FROM ranked
    CROSS JOIN pages ON pages.rowid = ranked.id
    ORDER BY ranked.rank
  `;
  // rowid = $id lets FTS5 seek the one page instead of scanning every match.
  const snippetSql = `
    SELECT snippet(pages_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS snippet
    FROM pages_fts
    WHERE pages_fts MATCH $match AND pages_fts.rowid = $id
  `;
  const count = `
    SELECT COUNT(*) AS total
    FROM pages_fts
    JOIN pages ON pages.rowid = pages_fts.rowid
    WHERE ${filter}
  `;
  return { search, snippet: snippetSql, count };
}

type Prepared = {
  db: Database.Database;
  schema: IndexSchema;
  /** Version labels some page carries; a version named in a query counts only if listed. */
  versionLabels: Set<string>;
  searchStmt: Database.Statement<[SearchParams], RankedRow>;
  snippetStmt: Database.Statement<[SnippetParams], { snippet: string | null }>;
  countStmt: Database.Statement<[CountParams], { total: number }>;
};

export class SqliteSearchClient implements SearchClient {
  private prepared: Prepared | null = null;
  private warned = false;

  constructor(private indexPath: string) {}

  /** Path of the index currently being served. */
  currentPath(): string {
    return this.indexPath;
  }

  /**
   * Point the client at a different index file (in-container hot refresh).
   * Safe without draining: better-sqlite3 is synchronous, so a query either
   * has completed or has not started — it can never be suspended mid-flight
   * across the tick on which this runs.
   */
  swapTo(newPath: string): void {
    const previous = this.prepared;
    this.prepared = null;
    this.indexPath = newPath;
    this.warned = false;
    previous?.db.close();
  }

  /** Row count of the served index; used to validate refresh candidates. */
  pageCount(): number | null {
    try {
      const row = this.open().db.prepare("SELECT COUNT(*) AS n FROM pages").get() as
        | { n: number }
        | undefined;
      return row?.n ?? null;
    } catch {
      return null;
    }
  }

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
    // No journal-mode pragma here: changing journal modes writes to the
    // database, which fails on a read-only index mount (SQLITE_READONLY_DIRECTORY).
    const db = new Database(this.indexPath, { readonly: true, fileMustExist: true });
    try {
      const columns = new Set((db.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).map((c) => c.name));
      const trailsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trails_fts'").get();
      const schema: IndexSchema = {
        versionMetadata: columns.has("is_current"),
        productTrails: columns.has("trail_id") && columns.has("label_id") && trailsTable !== undefined,
      };
      const labels = db.prepare("SELECT DISTINCT version FROM pages WHERE version IS NOT NULL").pluck().all() as string[];
      const queries = buildQueries(schema);
      this.prepared = {
        db,
        schema,
        versionLabels: new Set(labels),
        searchStmt: db.prepare(queries.search),
        snippetStmt: db.prepare(queries.snippet),
        countStmt: db.prepare(queries.count),
      };
    } catch (err) {
      db.close();
      throw err;
    }
    return this.prepared;
  }

  async search(query: string, opts: { version?: string; limit?: number } = {}): Promise<SearchResponse> {
    const limit = Math.min(opts.limit ?? 10, SEARCH_MAX_RESULTS);
    const version = opts.version ?? null;
    const { terms, versions } = parseQuery(query);
    // Version labels are metadata, not indexed text, and a page rarely spells
    // out its own version, so a version named in the query ("ios ui kit v4
    // theme") is a ranking preference rather than a required word, unless it is
    // all the query says.
    const phrases = terms.length > 0 ? terms : versions.map((v) => v.word);

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

    // A version filter has already answered "which version": across the
    // products sharing that label, being current is not a relevance signal.
    // Otherwise a version the query names wins over "current" ("upgrade from
    // v4 to v5" asks about the older pages), provided some page carries it.
    const named = version === null ? versions.map((v) => v.label).filter((l) => prepared.versionLabels.has(l)) : [];
    const base = {
      version,
      limit,
      legacyFactor: version === null ? LEGACY_FACTOR : 1,
      named: named.length > 0 ? JSON.stringify(named) : null,
      terms: Math.max(1, phrases.length),
      titleText: terms.length > 0 ? ` ${terms.join(" ").replace(/-/g, " ")} ` : null,
      ...(prepared.schema.productTrails ? { phrases: JSON.stringify(phrases.map((p) => `"${p}"`)) } : {}),
    };
    const keys = snippetKeyPattern(phrases);

    const runQuery = (match: string) => {
      const rows = prepared.searchStmt.all({ ...base, match });
      // A short page of results is every match; count only when it is full.
      const total = rows.length < limit ? rows.length : (prepared.countStmt.get({ match, version })?.total ?? 0);
      return { rows, total };
    };

    try {
      let match = buildFtsQuery(phrases, "AND", query);
      let { rows, total } = runQuery(match);

      if (rows.length === 0 && phrases.length > 1) {
        match = buildFtsQuery(phrases, "OR", query);
        ({ rows, total } = runQuery(match));
      }

      const results: SearchResult[] = rows.map((r) => ({
        title: r.title,
        url: r.url,
        section: r.section,
        snippet: snippet(excerpt(prepared, r, match, keys)),
        ...(r.version ? { version: r.version } : {}),
        isCurrent: r.isCurrent === 1,
      }));
      return { results, totalAvailable: total };
    } catch (err) {
      // Never log the query itself: it is caller free text and can carry
      // personal data. Its shape is enough to spot pathological inputs.
      logger.error({ err, queryLength: query.length, tokenCount: phrases.length }, "sqlite_search_failed");
      throw new BackendError();
    }
  }

  close() {
    this.prepared?.db.close();
    this.prepared = null;
  }

}

/** FTS5's best passage, unless the page holds too many term instances for snippet() to stay cheap. */
function excerpt(prepared: Prepared, row: RankedRow, match: string, keys: RegExp | null): string {
  if (keys && countKeyMatches(row.body, keys, SNIPPET_MAX_MATCHES) > SNIPPET_MAX_MATCHES) {
    return linearExcerpt(row.body, keys);
  }
  // BigInt, not number: better-sqlite3 binds a JS number as REAL, and FTS5
  // then silently ignores the rowid constraint and returns every match.
  return prepared.snippetStmt.get({ match, id: BigInt(row.id) })?.snippet ?? "";
}

/**
 * Query words, lowercased and de-duplicated, capped at MAX_QUERY_TOKENS.
 * Version words ('v4', '3.0') come back separately with their canonical label.
 */
export function parseQuery(raw: string): { terms: string[]; versions: { word: string; label: string }[] } {
  const terms: string[] = [];
  const versions: { word: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const word of raw.replace(/"/g, "").split(/\s+/)) {
    if (seen.size >= MAX_QUERY_TOKENS) break;
    const label = queryVersionLabel(word);
    const key = label === null ? word.replace(/[^\w-]/g, "").toLowerCase() : `version:${label}`;
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    if (label === null) terms.push(key);
    else versions.push({ word: queryVersionWord(word).toLowerCase(), label });
  }
  return { terms, versions };
}

function buildFtsQuery(phrases: string[], op: "AND" | "OR", raw: string): string {
  if (phrases.length === 0) {
    const safe = raw.replace(/"/g, "").trim();
    return safe.length > 0 ? `"${safe}"` : `""`;
  }
  const quoted = phrases.map((t) => `"${t}"`);
  return op === "AND" ? quoted.join(" ") : quoted.join(" OR ");
}

// Suffixes the porter stemmer can remove (steps 1-5), longest first.
const STEM_SUFFIXES = [
  "ational", "ization", "iveness", "fulness", "ousness", "biliti", "tional", "ation", "alism", "aliti", "iviti",
  "icate", "ative", "alize", "iciti", "ement", "entli", "ousli", "ator", "ical", "izer", "ment", "ness", "ance",
  "ence", "able", "ible", "enci", "anci", "abli", "alli", "logi", "ies", "ied", "ing", "ism", "ate", "iti", "ous",
  "ive", "ize", "ion", "ful", "ant", "ent", "eli", "bli", "al", "er", "ic", "ou", "ed", "es", "li", "s", "e", "y",
];

/** A prefix every word sharing `word`'s porter stem is expected to start with. */
function stemKey(word: string): string {
  let key = word;
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const suffix of STEM_SUFFIXES) {
      const rest = key.slice(0, -suffix.length);
      // The stemmer only strips once the rest has a vowel-consonant pair (its "measure").
      if (key.endsWith(suffix) && rest.length >= 2 && /[aeiouy][^aeiouy]/.test(rest)) {
        key = rest;
        stripped = true;
        break;
      }
    }
  }
  return key;
}

/**
 * Matches, at word starts, every body word the MATCH phrases can hit through
 * stemming ("messages" -> message, messaging), erring toward counting more:
 * it only decides whether snippet() is affordable. Null when nothing to match.
 */
export function snippetKeyPattern(phrases: string[]): RegExp | null {
  const alternatives = new Set<string>();
  for (const phrase of phrases) {
    for (const word of phrase.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length === 0) continue;
      // The stemmer leaves words under three letters alone.
      const key = word.length < 3 ? word : stemKey(word);
      if (key.length >= 3) {
        alternatives.add(key);
        continue;
      }
      // A one- or two-letter stem ("us" from "using") is matched by short words only.
      alternatives.add(`${key}(?:s|e|es|ed|ing)?(?![a-z0-9])`);
      if (word.length >= 3) alternatives.add(word.replace(/(?<=^[a-z0-9]{3,})(?:ing|es|ed|s)$/, ""));
    }
  }
  if (alternatives.size === 0) return null;
  return new RegExp(`(?<![a-z0-9])(?:${[...alternatives].join("|")})`, "gi");
}

// unicode61 folds Latin diacritics ("café" matches "cafe"); fold them before counting.
const LATIN_DIACRITIC_RE = /[À-ɏḀ-ỿ]/;
const COMBINING_MARK_RE = /[̀-ͯ]/g;

/** Word-start matches of `keys` in `body`, counting no further than max + 1. */
export function countKeyMatches(body: string, keys: RegExp, max: number): number {
  const text = LATIN_DIACRITIC_RE.test(body) ? body.normalize("NFD").replace(COMBINING_MARK_RE, "") : body;
  keys.lastIndex = 0;
  let n = 0;
  while (n <= max && keys.exec(text) !== null) n++;
  return n;
}

/** Fixed window around the first match (the pre-FTS5 extractor): linear in the body. */
function linearExcerpt(body: string, keys: RegExp): string {
  keys.lastIndex = 0;
  const at = keys.exec(body)?.index ?? 0;
  let start = Math.max(0, at - EXCERPT_BEFORE);
  let end = Math.min(body.length, at + EXCERPT_AFTER);
  // Never split a surrogate pair.
  if (start > 0 && isLowSurrogate(body.charCodeAt(start))) start += 1;
  if (end < body.length && isLowSurrogate(body.charCodeAt(end))) end -= 1;
  return `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
