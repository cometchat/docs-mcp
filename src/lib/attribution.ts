// Install/usage attribution (ENG-37100): links we control append
// ?ref=<source> to the connect URL (e.g. /mcp?ref=producthunt). The value is
// captured once at session initialize and tagged onto every tool-invocation
// log line for that session. Marketplace installs use the bare URL and fall
// back to clientInfo attribution.
//
// Strict FORMAT check (not a minted-set allowlist): any conforming value on
// the wire is accepted and logged — spoofed/fabricated refs are inherent to
// URL-based attribution and tolerated; the pattern only blocks injection-
// shaped junk and unbounded cardinality (64-char cap).
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function sanitizeRef(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return REF_PATTERN.test(v) ? v : undefined;
}

// Per-session attribution context threaded into the MCP server so tool logs
// can carry session identity without the tools knowing about transports.
export interface Attribution {
  ref?: string;
  sessionId?: () => string | undefined;
}
