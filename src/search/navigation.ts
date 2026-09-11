// Version metadata for docs pages, derived from the Mintlify docs.json
// navigation. Pure (no I/O) so every rule is unit-testable without a clone.
//
// The docs usually keep the CURRENT version of each SDK / UI Kit at the
// unversioned path and move older versions under /vN/ or N.0/ — but not
// always: the Android Chat SDK lists v5, under /sdk/android/v5/, ahead of the
// unversioned v4. The version picker in docs.json is the source of truth; the
// path is only the fallback for repos or pages it does not cover.
import { VERSION_LABEL_RE, normalizeVersionLabel } from "./version.js";

export type PageVersion = {
  /** Navigation trail of the page's doc set, e.g. "Chat & Messaging / UI Kits / React". */
  product: string | null;
  /** Version picker label, e.g. "v7"; null for docs that are not versioned. */
  version: string | null;
  /** False when the page documents an older version of its product. */
  isCurrent: boolean;
};

export type NavigationIndex = {
  /** Page path (no leading slash) -> metadata of its navigation listing. */
  pages: Map<string, PageVersion>;
  /** Folder -> the versioned doc set most of its listed pages belong to. */
  folders: Map<string, PageVersion>;
};

const TRAIL_KEYS = ["product", "tab", "anchor", "dropdown", "item"] as const;
// Mintlify requires version labels to be unique across dropdowns, so docs.json
// pads repeated labels ("v4") with invisible U+200E marks.
const INVISIBLE_RE = /[\u200b-\u200f\u2060\ufeff]/g;

type Scope = { version: string | null; isCurrent: boolean };

/** Builds the lookup from a parsed docs.json; anything else yields an empty index. */
export function indexNavigation(docsJson: unknown): NavigationIndex {
  const pages = new Map<string, PageVersion>();
  if (isRecord(docsJson)) walk(docsJson.navigation, [], { version: null, isCurrent: true }, pages);
  return { pages, folders: folderOwners(pages) };
}

/**
 * Metadata for one page: its navigation listing, else the doc set owning its
 * folder (unlisted pages such as the per-version llms index pages), else the
 * path convention.
 */
export function resolvePageVersion(pagePath: string, nav: NavigationIndex): PageVersion {
  const key = normalizePagePath(pagePath);
  const listed = nav.pages.get(key);
  if (listed) return listed;
  const folders = key.split("/").slice(0, -1);
  while (folders.length > 0) {
    const owner = nav.folders.get(folders.join("/"));
    if (owner) return owner;
    // Never climb out of a version folder: an unlisted /sdk/android/v9/ page
    // must not inherit the metadata of the unversioned pages above it.
    if (isVersionSegment(folders[folders.length - 1])) break;
    folders.pop();
  }
  return versionFromPath(key);
}

/** Path convention: a vN/ or N.0/ folder marks an older version. */
export function versionFromPath(pagePath: string): PageVersion {
  const found = normalizePagePath(pagePath).split("/").slice(0, -1).find(isVersionSegment);
  return found
    ? { product: null, version: versionLabel(found), isCurrent: false }
    : { product: null, version: null, isCurrent: true };
}

/**
 * Canonical label: invisible padding stripped; labels the search filter accepts
 * normalized as 'v7' / 'v3.5'. Anything else is kept readable, and the builder
 * warns about it because no `version` argument can match it.
 */
export function versionLabel(raw: string): string {
  const cleaned = raw.replace(INVISIBLE_RE, "").trim().toLowerCase();
  return VERSION_LABEL_RE.test(cleaned) ? normalizeVersionLabel(cleaned) : cleaned;
}

function isVersionSegment(segment: string): boolean {
  return /^v\d+(\.\d+)?$/i.test(segment) || /^\d+\.\d+$/.test(segment);
}

function walk(node: unknown, trail: string[], scope: Scope, out: Map<string, PageVersion>): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, trail, scope, out);
    return;
  }
  if (!isRecord(node)) return;
  const label = TRAIL_KEYS.map((k) => node[k]).find((v): v is string => typeof v === "string");
  const here = label ? [...trail, label.replace(INVISIBLE_RE, "").trim()] : trail;
  for (const [key, value] of Object.entries(node)) {
    if (key === "versions" && Array.isArray(value)) {
      const entries = value.filter(isRecord);
      // Current = the entry marked default, else the first listed (which is
      // what the version picker shows when nothing is marked).
      const hasDefault = entries.some((v) => v.default === true);
      entries.forEach((entry, i) => {
        const version = typeof entry.version === "string" ? versionLabel(entry.version) : null;
        walk(entry, here, { version, isCurrent: hasDefault ? entry.default === true : i === 0 }, out);
      });
    } else if (key === "pages" && Array.isArray(value)) {
      for (const page of value) {
        if (typeof page === "string") record(out, page, { product: here.join(" / ") || null, ...scope });
        else walk(page, here, scope, out);
      }
    } else if (value !== null && typeof value === "object") {
      walk(value, here, scope, out);
    }
  }
}

/** A page listed in several places keeps its most current, most specific listing. */
function record(out: Map<string, PageVersion>, page: string, meta: PageVersion): void {
  const key = normalizePagePath(page);
  const existing = out.get(key);
  const rank = (m: PageVersion) => (m.isCurrent ? 2 : 0) + (m.version ? 1 : 0);
  if (!existing || rank(meta) > rank(existing)) out.set(key, meta);
}

function folderOwners(pages: Map<string, PageVersion>): Map<string, PageVersion> {
  const votes = new Map<string, Map<string, { meta: PageVersion; n: number }>>();
  for (const [page, meta] of pages) {
    const folder = page.split("/").slice(0, -1).join("/");
    if (!meta.version || !folder) continue;
    const tally = votes.get(folder) ?? new Map<string, { meta: PageVersion; n: number }>();
    const id = `${meta.product}|${meta.version}|${meta.isCurrent}`;
    const entry = tally.get(id) ?? { meta, n: 0 };
    entry.n += 1;
    tally.set(id, entry);
    votes.set(folder, tally);
  }
  const owners = new Map<string, PageVersion>();
  for (const [folder, tally] of votes) {
    const best = [...tally.values()].reduce((a, b) => (b.n > a.n ? b : a));
    owners.set(folder, best.meta);
  }
  return owners;
}

function normalizePagePath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\.mdx$/, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
