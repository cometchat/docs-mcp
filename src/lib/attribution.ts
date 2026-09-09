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

/**
 * Accept an echoed MCP session id only in the shape the server mints (a UUID).
 * Anything else is treated as absent.
 *
 * The value is reflected back in a response header and written into log lines
 * and analytics properties, so unvalidated free text would be an injection
 * sink and an unbounded field. The server always mints a fresh id at
 * `initialize`; this guards the echo on subsequent requests.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeSessionId(raw: unknown): string | undefined {
  return typeof raw === "string" && SESSION_ID_RE.test(raw) ? raw.toLowerCase() : undefined;
}
