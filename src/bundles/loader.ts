import { logger } from "../lib/logger.js";
import { BackendError, NotFoundError } from "../lib/errors.js";
import { BUNDLE_MAX_BYTES, byteLength, truncateAtParagraph } from "../lib/truncate.js";
import { runFetch, type FetchOpts } from "../tools/fetch.js";
import { BUNDLES, BUNDLES_REVIEWED, type BundleSpec } from "./manifest.js";
import type { Bundle } from "./types.js";

/** One docs page as the fetch tool returns it, untruncated. */
export type DocsPage = { title: string; url: string; content: string };
export type PageFetcher = (path: string) => Promise<DocsPage>;

export type BundleStoreOptions = {
  /** How long a built bundle is served before its pages are read again. */
  cacheTtlMs?: number;
  /** First wait before retrying a build that hit an unavailable page; doubles up to the TTL. */
  retryBaseMs?: number;
  now?: () => number;
};

/** One build of a bundle, with the pages that didn't make it in. */
export type BuildResult = {
  bundle: Bundle;
  /** Pages the docs no longer serve (404): the manifest is out of date. */
  missing: string[];
  /** Pages that failed for a reason that may pass (timeout, 5xx). */
  unavailable: string[];
  /** Loaded pages left out for size and listed by path instead. */
  deferred: string[];
  /** The first page was cut to fit (it alone is over the budget). */
  truncated: boolean;
  /** No page loaded: every one is 404. */
  empty: boolean;
};

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_BASE_MS = 30 * 1000;
// The docs .md export starts every page with this blockquote pointing at
// llms.txt. Only that block is stripped: a page may open with a real callout.
const INDEX_PREAMBLE_RE = /^> ## Documentation Index\n(?:>[^\n]*\n)*\s*/;
// ...and ends it with this line, which would repeat between every section.
const HOST_FOOTER_RE = /\s*This documentation is built and hosted on \[Mintlify\]\(https:\/\/mintlify\.com\), a developer documentation platform\.\s*$/;
const INTRO =
  "Compiled from the current CometChat docs. Each section below is one docs page, headed by its source URL. Check commands against the official install instructions before running them.";

type Entry = {
  bundle?: Bundle;
  /** The bundle came from a build where every page loaded or is gone for good (404). */
  settled: boolean;
  /** No new build starts before this time. */
  retryAt: number;
  /** Consecutive builds that hit an unavailable page, for the backoff. */
  failures: number;
  /** Set when no build has produced any bundle yet. */
  error?: Error;
  /** Pages the cached bundle is missing (404). */
  missing: string[];
  /** Pages a newer build saw as 404 once; a second build in a row confirms it. */
  suspect?: string[];
};

/**
 * Implementation bundles compiled from live docs pages (see manifest.ts).
 * Listing is static; get() reads the pages, so a bundle says what the docs
 * say now.
 *
 * A build "settles" when every page either loaded or is gone (404): that is
 * what the docs say, so it is served for the cache lifetime and replaces the
 * previous bundle. A 404 has to show up on two builds in a row before it is
 * settled (a page a cached bundle has, or any page on a first build), so a
 * blip during a docs deploy doesn't drop a page, or empty a bundle, for the
 * whole cache lifetime. A build that hit an unavailable page (timeout, 5xx) never
 * replaces a settled bundle; the old one keeps being served and the next
 * build waits out a backoff (30 s, doubling, capped at the cache lifetime).
 * Before anything has settled, the partial bundle or the error is kept for
 * that backoff too, so a page that is down doesn't make every call refetch.
 * Once something is cached, calls never wait for a rebuild: it runs in the
 * background, one per bundle at a time.
 */
export class BundleStore {
  private readonly specs = new Map<string, BundleSpec>();
  private readonly entries = new Map<string, Entry>();
  private readonly building = new Map<string, Promise<Entry>>();
  private readonly ttl: number;
  private readonly retryBase: number;
  private readonly now: () => number;

  constructor(
    specs: readonly BundleSpec[],
    private readonly fetchPage: PageFetcher,
    opts: BundleStoreOptions = {},
  ) {
    for (const s of specs) this.specs.set(s.name, s);
    this.ttl = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.retryBase = Math.min(opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, this.ttl);
    this.now = opts.now ?? Date.now;
  }

  /** The production store: the manifest, read through the fetch tool without its page-size cut. */
  static fromDocs(fetchOpts: FetchOpts, opts: BundleStoreOptions = {}): BundleStore {
    return new BundleStore(BUNDLES, (path) => runFetch({ path }, fetchOpts, { maxBytes: Infinity }), opts);
  }

  list(): string[] {
    return Array.from(this.specs.keys()).sort();
  }

  spec(name: string): BundleSpec | undefined {
    return this.specs.get(name);
  }

  /** Bundles cached from a settled build with every page in it (none 404). */
  readyCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.settled && e.bundle && e.missing.length === 0) n++;
    return n;
  }

  async get(name: string): Promise<Bundle | undefined> {
    const spec = this.specs.get(name);
    if (!spec) return undefined;
    const e = this.entries.get(name);
    if (e && (e.bundle || this.now() < e.retryAt)) {
      if (this.now() >= e.retryAt) {
        this.refresh(spec).catch(() => undefined); // record() never throws; belt and braces
      }
      if (e.bundle) return e.bundle;
      throw e.error ?? unavailableError();
    }
    const fresh = await this.refresh(spec);
    if (fresh.bundle) return fresh.bundle;
    throw fresh.error ?? unavailableError();
  }

  /** Builds a bundle from its pages now, bypassing the cache. For the verify script. */
  async build(name: string): Promise<BuildResult | undefined> {
    const spec = this.specs.get(name);
    return spec ? this.compile(spec) : undefined;
  }

  // One build per bundle at a time; concurrent callers share it. Resolves to
  // the entry now cached, which may still hold the previous bundle.
  private refresh(spec: BundleSpec): Promise<Entry> {
    const running = this.building.get(spec.name);
    if (running) return running;
    const p = this.compile(spec)
      .then(
        (r) => this.record(spec.name, r),
        (err: Error) => this.record(spec.name, err),
      )
      .finally(() => this.building.delete(spec.name));
    this.building.set(spec.name, p);
    return p;
  }

  private record(name: string, r: BuildResult | Error): Entry {
    const now = this.now();
    const prev = this.entries.get(name);
    let next: Entry;
    if (r instanceof Error || r.unavailable.length > 0) {
      const failures = (prev?.failures ?? 0) + 1;
      const retryAt = now + Math.min(this.ttl, this.retryBase * 2 ** (failures - 1));
      // A settled bundle is never replaced by a build that hit a passing failure.
      const bundle = prev?.settled ? prev.bundle : r instanceof Error ? prev?.bundle : r.bundle;
      next = {
        ...(bundle ? { bundle } : {}),
        settled: prev?.settled ?? false,
        retryAt,
        failures,
        missing: prev?.settled ? prev.missing : r instanceof Error ? (prev?.missing ?? []) : r.missing,
        ...(r instanceof Error ? { error: r } : {}),
      };
      logger.warn(
        {
          bundle: name,
          failures,
          retryInMs: retryAt - now,
          serving: prev?.settled ? "previous" : bundle ? "partial" : "none",
          ...(r instanceof Error ? { err: r.message } : { unavailable: r.unavailable }),
        },
        "bundle_build_incomplete",
      );
      this.entries.set(name, next);
      return next;
    }
    // Every page loaded or is 404. A 404 the cached bundle doesn't already
    // account for may be a blip during a docs deploy: a second build in a row
    // has to agree before it is what gets served for the cache lifetime.
    const known = prev?.settled ? prev.missing : [];
    const newlyMissing = r.missing.filter((p) => !known.includes(p));
    if (newlyMissing.every((p) => prev?.suspect?.includes(p))) {
      next = { bundle: r.bundle, settled: true, retryAt: now + this.ttl, failures: 0, missing: r.missing };
    } else if (prev?.settled) {
      // Every page answered, so the outage backoff starts over.
      next = { ...prev, retryAt: now + this.retryBase, failures: 0, suspect: newlyMissing };
    } else {
      // Nothing settled yet: serve what loaded until the second build. If no
      // page loaded, there is nothing to serve, so the call fails as before.
      next = {
        ...(r.empty ? (prev?.bundle ? { bundle: prev.bundle } : { error: unavailableError() }) : { bundle: r.bundle }),
        settled: false,
        retryAt: now + this.retryBase,
        failures: 0,
        missing: r.missing,
        suspect: newlyMissing,
      };
    }
    if (!next.settled || next.suspect) {
      logger.warn({ bundle: name, missing: newlyMissing, retryInMs: this.retryBase }, "bundle_page_missing_unconfirmed");
    }
    this.entries.set(name, next);
    return next;
  }

  private async compile(spec: BundleSpec): Promise<BuildResult> {
    const results = await Promise.allSettled(spec.pages.map((p) => this.fetchPage(p)));
    const sections: Array<{ path: string; url: string; text: string }> = [];
    const missing: string[] = [];
    const unavailable: string[] = [];
    results.forEach((r, i) => {
      const path = spec.pages[i];
      if (r.status === "rejected") {
        const err = r.reason as Error;
        // A missing page means the manifest is out of date: alert on it.
        const gone = err instanceof NotFoundError;
        (gone ? missing : unavailable).push(path);
        logger[gone ? "error" : "warn"]({ bundle: spec.name, path, err: err.message }, "bundle_page_unavailable");
        return;
      }
      const body = r.value.content.replace(INDEX_PREAMBLE_RE, "").replace(HOST_FOOTER_RE, "").trim();
      sections.push({ path, url: r.value.url, text: `Source: ${r.value.url}\n\n${body}\n` });
    });
    // Nothing loaded. If only because the pages are gone (404), build a bundle
    // that names them: record() then drops a cached bundle once a second build
    // agrees, and it stops counting as ready. Otherwise the failure may pass.
    if (sections.length === 0 && unavailable.length > 0) throw unavailableError();

    const list = (paths: string[]) => paths.map((p) => `\`${p}\``).join(", ");
    const assemble = (parts: string[], deferred: string[]) => {
      const more = [...deferred, ...spec.related];
      const tail = [
        // A 404 is gone from the docs: fetching it again won't help, searching might.
        ...(missing.length > 0 ? [`No longer in the docs: ${list(missing)}. Search the docs for where this moved.`, ""] : []),
        ...(unavailable.length > 0 ? [`Could not load right now: ${list(unavailable)}. Fetch them by path.`, ""] : []),
        ...(more.length > 0 ? ["## More pages", "", ...more.map((p) => `- \`${p}\``)] : []),
      ];
      const body = parts.length > 0 ? [parts.join("\n---\n\n")] : [];
      // With every page gone there are no sections to introduce.
      const intro = parts.length > 0 ? INTRO : "None of this bundle's pages are in the current CometChat docs.";
      return [`# ${spec.title}`, "", intro, "", ...body, ...(tail.length > 0 ? ["---", "", ...tail] : [])].join("\n");
    };

    // Whole pages, in order, while the WHOLE bundle (title, separators and the
    // closing list included) fits BUNDLE_MAX_BYTES. A page that doesn't fit is
    // listed under "More pages" by path, never cut. The first page is the one
    // exception: a bundle can't be empty, so if it alone is too big it is cut
    // at a paragraph and ends with a link to the full page.
    const parts: string[] = [];
    const deferred: string[] = [];
    let truncated = false;
    sections.forEach((s, i) => {
      const later = sections.slice(i + 1).map((x) => x.path);
      if (byteLength(assemble([...parts, s.text], [...deferred, ...later])) <= BUNDLE_MAX_BYTES) {
        parts.push(s.text);
      } else if (parts.length === 0) {
        // Room for the cut text and the newline after it.
        const room = BUNDLE_MAX_BYTES - byteLength(assemble([""], later)) - 1;
        parts.push(`${truncateAtParagraph(s.text, room, s.url)}\n`);
        truncated = true;
      } else {
        deferred.push(s.path);
      }
    });
    return {
      bundle: {
        name: spec.name,
        title: spec.title,
        framework: spec.framework,
        prerequisites: spec.prerequisites,
        last_verified: BUNDLES_REVIEWED,
        content: assemble(parts, deferred),
      },
      missing,
      unavailable,
      deferred,
      truncated,
      empty: sections.length === 0,
    };
  }
}

function unavailableError(): BackendError {
  return new BackendError("The documentation pages for this bundle could not be loaded. Retry shortly.");
}
