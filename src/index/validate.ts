// Pure validation + retention logic for in-container index refresh.
// Deliberately free of I/O so every rule is unit-testable without a clone,
// a database, or a network call.

export interface IndexStats {
  /** Row count of the `pages` table. */
  pages: number;
  /** SQLite journal_mode as reported by the file (lowercase). */
  journalMode: string;
  bytes: number;
  /**
   * Pages whose version metadata came from docs.json navigation
   * (`pages.product IS NOT NULL`); null or absent for an index without that
   * column. Optional so stats written before it existed still type-check.
   */
  navPages?: number | null;
}

export interface ValidationPolicy {
  /** Absolute floor: an index smaller than this is broken, not merely thin. */
  minPages: number;
  /**
   * Relative floor: reject a candidate that loses more than this fraction of
   * the currently-served page count, or of its pages versioned by docs.json
   * navigation. Catches "docs merge dropped 40% of pages" — a regression an
   * absolute floor alone waves through.
   */
  maxDropRatio: number;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

export const DEFAULT_POLICY: ValidationPolicy = {
  minPages: 2000,
  maxDropRatio: 0.2,
};

export function validateCandidate(
  candidate: IndexStats,
  current: IndexStats | null,
  policy: ValidationPolicy = DEFAULT_POLICY,
): ValidationResult {
  // WAL leaves side files (-wal/-shm); the container mounts the index
  // read-only, where that combination fails at query time.
  if (candidate.journalMode.toLowerCase() === "wal") {
    return {
      ok: false,
      code: "wal_journal",
      reason: "candidate index is still in WAL mode; unsafe for a read-only mount",
    };
  }
  if (!Number.isFinite(candidate.pages) || candidate.pages < policy.minPages) {
    return {
      ok: false,
      code: "below_min_pages",
      reason: `candidate has ${candidate.pages} pages, below floor of ${policy.minPages}`,
    };
  }
  if (candidate.bytes <= 0) {
    return { ok: false, code: "empty_file", reason: "candidate index file is empty" };
  }
  if (current && current.pages > 0) {
    const floor = current.pages * (1 - policy.maxDropRatio);
    if (candidate.pages < floor) {
      return {
        ok: false,
        code: "page_count_regression",
        reason:
          `candidate has ${candidate.pages} pages vs ${current.pages} currently served ` +
          `(more than ${Math.round(policy.maxDropRatio * 100)}% drop)`,
      };
    }
  }
  // A docs.json the builder cannot use still builds every page, so the page
  // rules pass while versions silently fall back to paths. Measured against the
  // served index rather than required outright, so fixtures without docs.json
  // and indexes from before version metadata keep working.
  const servedNav = current?.navPages ?? 0;
  if (servedNav > 0) {
    const candidateNav = candidate.navPages ?? 0; // unknown fails closed
    if (candidateNav < servedNav * (1 - policy.maxDropRatio)) {
      return {
        ok: false,
        code: "navigation_regression",
        reason:
          `candidate takes page versions from docs.json navigation for ${candidateNav} pages vs ` +
          `${servedNav} currently served (more than ${Math.round(policy.maxDropRatio * 100)}% drop)`,
      };
    }
  }
  return { ok: true };
}

export interface Generation {
  path: string;
  docsCommit: string;
  createdAt: number;
}

/**
 * Newest `keep` generations survive; the rest are returned for deletion.
 * The currently-served generation is never pruned, even if it is old.
 */
export function generationsToPrune(
  generations: Generation[],
  keep: number,
  currentPath?: string,
): Generation[] {
  const sorted = [...generations].sort((a, b) => b.createdAt - a.createdAt);
  const survivors = new Set(sorted.slice(0, Math.max(0, keep)).map((g) => g.path));
  if (currentPath) survivors.add(currentPath);
  return sorted.filter((g) => !survivors.has(g.path));
}

/**
 * Remembers docs commits that produced a bad index so the poller does not
 * rebuild the same failure every interval. Bounded so a long-lived task cannot
 * grow it without limit.
 */
export class PoisonedCommits {
  private readonly order: string[] = [];
  private readonly set = new Set<string>();

  constructor(private readonly max = 20) {}

  mark(sha: string): void {
    if (this.set.has(sha)) return;
    this.set.add(sha);
    this.order.push(sha);
    while (this.order.length > this.max) {
      const evicted = this.order.shift();
      if (evicted) this.set.delete(evicted);
    }
  }

  has(sha: string): boolean {
    return this.set.has(sha);
  }

  get size(): number {
    return this.set.size;
  }
}
