import type { Request, Response, NextFunction } from "express";

export type RateLimitOptions = {
  windowMs: number;
  max: number;
  keyFor?: (req: Request) => string;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const SWEEP_INTERVAL_MS = 60_000;

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max } = opts;
  const keyFor = opts.keyFor ?? clientIp;
  const buckets = new Map<string, Bucket>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  if (typeof sweep.unref === "function") sweep.unref();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = keyFor(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too many requests. Retry after the window resets." },
        id: null,
      });
      return;
    }
    next();
  };
}

// Shared client-IP extraction, used by rate limiting AND analytics
// fingerprinting/egress classification — the two must never diverge.
//
// We take the RIGHTMOST X-Forwarded-For hop: proxies APPEND to the header
// (ALB default mode, nginx proxy_add_x_forwarded_for), so the last entry is
// the address our own proxy observed on the socket — the only hop a client
// cannot forge. The first hop is attacker-chosen whenever a client sends its
// own XFF header, which would let anyone mint unlimited fingerprints, spoof
// is_anthropic_egress, and rotate around per-IP rate limits.
//
// Assumes exactly one trusted proxy in front (ALB or nginx). Adding a CDN
// layer makes the last hop the CDN's address — revisit this then.
export function clientIp(req: Request): string {
  const fwd = req.header("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",");
    const last = hops[hops.length - 1]?.trim();
    if (last) return last;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}
