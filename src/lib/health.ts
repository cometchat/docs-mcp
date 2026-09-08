import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { RefresherState } from "../index/refresher.js";

/**
 * `/health` is unauthenticated and internet-facing in production, so the
 * refresher's diagnostic fields are split in two:
 *
 *   public   — freshness facts a monitor legitimately needs
 *   detailed — operational internals, released only against HEALTH_DETAIL_TOKEN
 *
 * `lastError` carries sanitized-but-still-internal strings (filesystem paths,
 * errno codes, git output). `poisoned` is only a count, but it answers a
 * question no public consumer can act on — `lastRefreshOk` already tells them
 * whether refreshing is working.
 */
export interface PublicRefreshView {
  docsCommit: string | null;
  builtAt: string | null;
  lastCheckedAt: string | null;
  generations: number;
  /** false when the most recent refresh attempt failed. */
  lastRefreshOk: boolean;
}

export interface DetailedRefreshView extends PublicRefreshView {
  poisoned: number;
  lastError: string | null;
}

export function refreshView(
  state: RefresherState,
  detailed: boolean,
): PublicRefreshView | DetailedRefreshView {
  const base: PublicRefreshView = {
    docsCommit: state.docsCommit,
    builtAt: state.builtAt,
    lastCheckedAt: state.lastCheckedAt,
    generations: state.generations,
    lastRefreshOk: state.lastError === null,
  };
  if (!detailed) return base;
  return { ...base, poisoned: state.poisoned, lastError: state.lastError };
}

/**
 * Detail is released only on an exact token match. Fails closed: with no
 * token configured, detail is unreachable by any request.
 *
 * The header is preferred over the query parameter — query strings land in
 * load-balancer and proxy access logs, headers usually do not.
 */
export function wantsDetail(req: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = req.header("x-health-token");
  const query = typeof req.query.detail === "string" ? req.query.detail : undefined;
  const provided = header ?? query;
  if (!provided) return false;
  return safeEqual(provided, token);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch; compare lengths first, which
  // leaks only the length — never the contents.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
