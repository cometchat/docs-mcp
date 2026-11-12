// Browser approval for high-risk account changes (webhooks, API keys, login
// tokens, team invites, app settings, the OpenAI key).
//
// `confirm: true` is set by the model, so text the model reads (an end user's
// message, a user name) could talk it into a change that leaks the app's data.
// These changes instead need a code the user gets by approving the exact
// change on a page served here, in the browser that connected the AI tool:
// sign-in leaves an HttpOnly cookie in that browser (bound to the browser that
// loaded the sign-in page), and only a request carrying it gets a code.
//
// What this can't close on its own: the dashboard's device login shows nothing
// about who is asking, so a model that runs its own OAuth sign-in with a
// cookie-keeping HTTP client and gets the user to sign in on its link can still
// end up with that cookie. DASHBOARD_SIGNIN_FLOW=confirm closes that once the
// dashboard confirmation screen and mgmt-api verifier ship (deferred release).
//
// Stateless like the rest of the sign-in: the approval link is a sealed value
// and the code is an HMAC over (user, tool, exact arguments, 5-minute window).
// Each code works once per server process.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Sealer } from "./seal.js";
import { nowSeconds } from "./seal.js";
import { ValidationError } from "../lib/errors.js";

export const APPROVE_PATH = "/oauth/cometchat/approve";
export const APPROVER_COOKIE = "cc_mcp_approver";

const REQUEST_TTL = 15 * 60; // the approval link
const CODE_WINDOW = 5 * 60; // a code works in its window and the next one: 5-10 minutes
const APPROVER_MAX_TTL = 7 * 24 * 60 * 60;
/** Most used codes remembered per process (a memory bound; far above real use). */
export const MAX_USED_CODES = 50_000;
/** A value longer than this can't be shown in full, so it can't be approved. */
const MAX_DISPLAY = 2000;

interface ApprovalRequest {
  a: string; // actor the change is for
  t: string; // tool name
  tt: string; // tool title, for the page
  s: string; // summary, for the page
  d: string; // digest of the exact arguments
  x: Array<[string, string]>; // arguments for display (secrets masked)
}

export type ApprovalRejectReason = "mismatch" | "expired" | "used";

export type ApprovalResult =
  | { status: "approved"; code: string }
  | { status: "sign_in_required"; reason: "no_session" | "different_account" }
  | { status: "expired" };

export interface ApprovalOptions {
  sealer: Sealer;
  /** DASHBOARD_TOKEN_SECRET; keys the approval codes. */
  secret: string;
  publicUrl: string;
}

export class ApprovalService {
  private readonly key: Buffer;
  readonly secureCookie: boolean;
  // Codes already used, until their window ends. Per process: with more than
  // one replica a code could run once on each, inside its 10 minutes.
  private readonly used = new Map<string, number>();

  constructor(private readonly opts: ApprovalOptions) {
    this.key = createHash("sha256").update(`approval-code:${opts.secret}`).digest();
    this.secureCookie = new URL(opts.publicUrl).protocol === "https:";
  }

  /** The link the user opens to approve this exact change. Throws if a value is too long to show in full. */
  requestUrl(actor: string, tool: string, title: string, summary: string, args: Record<string, unknown>): string {
    const req: ApprovalRequest = { a: actor, t: tool, tt: title, s: summary, d: argsDigest(args), x: displayArgs(args) };
    const sealed = this.opts.sealer.seal("approval", req, REQUEST_TTL);
    // Sealed values over 16 KB don't open; refuse here rather than hand out a dead link.
    if (sealed.length > 15_000) throw new ValidationError("arguments", "are too large to show for approval; split the change into smaller ones");
    const url = new URL(APPROVE_PATH, this.opts.publicUrl);
    url.searchParams.set("r", sealed);
    return url.href;
  }

  /**
   * True when `code` approves this user running this tool with exactly these
   * arguments, and hasn't been used. `consume` marks it used (call it only when
   * the change is about to run).
   */
  check(actor: string, tool: string, args: Record<string, unknown>, code: unknown, consume = true): boolean {
    if (typeof code !== "string") return false;
    const given = normalizeCode(code);
    if (given.length !== 8) return false;
    const d = argsDigest(args);
    const w = Math.floor(nowSeconds() / CODE_WINDOW);
    const win = [w, w - 1].find((x) => safeEqual(given, this.rawCode(actor, tool, d, x)));
    if (win === undefined) return false;
    const key = `${actor}|${tool}|${d}|${given}`;
    this.sweep();
    if (this.used.has(key)) return false;
    if (consume) this.used.set(key, (win + 2) * CODE_WINDOW);
    return true;
  }

  /**
   * Why `check` refused a code, so the user and the agent know whether to
   * approve again (expired), redo the exact same call (mismatch) or stop
   * reusing it (used). Only call it after `check` returned false.
   */
  rejectReason(actor: string, tool: string, args: Record<string, unknown>, code: unknown): ApprovalRejectReason {
    if (typeof code !== "string") return "mismatch";
    const given = normalizeCode(code);
    if (given.length !== 8) return "mismatch";
    const d = argsDigest(args);
    const w = Math.floor(nowSeconds() / CODE_WINDOW);
    const matches = (x: number) => safeEqual(given, this.rawCode(actor, tool, d, x));
    if (matches(w) || matches(w - 1)) return "used";
    // A code for these exact arguments from an earlier window (the link itself lasts 15 minutes).
    for (let x = w - 2; x >= w - 2 - Math.ceil(REQUEST_TTL / CODE_WINDOW); x--) if (matches(x)) return "expired";
    return "mismatch";
  }

  /**
   * Gives a used code back when the change never reached CometChat (the tool
   * rejected its own input), so the user isn't asked to approve again.
   */
  release(actor: string, tool: string, args: Record<string, unknown>, code: unknown): void {
    if (typeof code !== "string") return;
    this.used.delete(`${actor}|${tool}|${argsDigest(args)}|${normalizeCode(code)}`);
  }

  openRequest(r: unknown): ApprovalRequest | null {
    return typeof r === "string" ? (this.opts.sealer.open<ApprovalRequest>("approval", r)?.data ?? null) : null;
  }

  /** Approve with the browser's approver cookie. */
  approveWithCookie(r: unknown, cookieHeader: string | undefined): ApprovalResult {
    const req = this.openRequest(r);
    if (!req) return { status: "expired" };
    const approver = this.approverFrom(cookieHeader);
    if (!approver) return { status: "sign_in_required", reason: "no_session" };
    if (approver !== req.a) return { status: "sign_in_required", reason: "different_account" };
    return { status: "approved", code: this.codeFor(req) };
  }

  /** Set-Cookie value marking this browser as `actor`'s, for later approvals. */
  approverCookie(actor: string, ttlSeconds = APPROVER_MAX_TTL): string {
    const ttl = Math.max(60, Math.min(APPROVER_MAX_TTL, Math.floor(ttlSeconds)));
    return cookie(APPROVER_COOKIE, this.opts.sealer.seal("approver", { a: actor }, ttl), APPROVE_PATH, ttl, this.secureCookie);
  }

  private approverFrom(cookieHeader: string | undefined): string | undefined {
    const raw = readCookie(cookieHeader, APPROVER_COOKIE);
    return raw ? this.opts.sealer.open<{ a: string }>("approver", raw)?.data.a : undefined;
  }

  private codeFor(req: ApprovalRequest): string {
    const raw = this.rawCode(req.a, req.t, req.d, Math.floor(nowSeconds() / CODE_WINDOW));
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }

  private rawCode(actor: string, tool: string, digest: string, window: number): string {
    const mac = createHmac("sha256", this.key).update(`${actor}|${tool}|${digest}|${window}`).digest();
    let out = "";
    for (let i = 0; i < 8; i++) out += CODE_ALPHABET[mac[i]! % 32];
    return out;
  }

  private sweep(): void {
    const now = nowSeconds();
    for (const [k, until] of this.used) if (until <= now) this.used.delete(k);
    // Still full of unexpired codes: forget only the oldest (a Map keeps
    // insertion order), never all of them. A forgotten code works again until
    // its window ends, so clearing the map would reopen every recent code.
    while (this.used.size >= MAX_USED_CODES) this.used.delete(this.used.keys().next().value!);
  }
}

/** A Set-Cookie value: HttpOnly, SameSite=Strict, scoped to one path. */
export function cookie(name: string, value: string, path: string, maxAge: number, secure: boolean, sameSite: "Strict" | "Lax" = "Strict"): string {
  return [`${name}=${value}`, `Path=${path}`, `Max-Age=${maxAge}`, "HttpOnly", `SameSite=${sameSite}`, ...(secure ? ["Secure"] : [])].join("; ");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

// No I, O, 0 or 1, so a code read aloud or retyped can't be misread.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Order-independent digest of the arguments, so the code covers exactly this change. */
export function argsDigest(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(args)).digest("base64url");
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** A field name that holds a secret: matched on how the name ends, so "apiKey" is masked and "keywords" isn't. */
const SECRET_FIELD = /(key|secret|token|password|passwd|pwd|credentials?|authorization|auth|bearer|cookie|session)$/i;
const DISPLAY_DEPTH = 4;

const mask = (v: unknown): string => (typeof v === "string" && v.length > 8 ? `••••${v.slice(-4)}` : "••••");

/** Makes invisible and direction-changing characters visible, so a value can't read differently from what it is. */
function visible(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);
}

/**
 * The arguments as the approval page shows them: every field in full, objects
 * and arrays one row per element (so nothing hides past a cut-off), secret-named
 * fields masked at any depth, invisible characters made visible. Anything that
 * can't be shown that way (too long, too deep, too many rows) is refused, since
 * the user can't approve what they can't see.
 */
export function displayArgs(args: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const walk = (path: string, name: string, v: unknown, depth: number): void => {
    if (v === undefined) return;
    if (SECRET_FIELD.test(name) && v !== null && v !== "") {
      rows.push([path, typeof v === "object" ? "•••• (hidden)" : mask(v)]);
      return;
    }
    if (v && typeof v === "object") {
      if (depth >= DISPLAY_DEPTH) throw new ValidationError(path, "is nested too deeply to show for approval");
      const entries: Array<[string, unknown]> = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]);
      if (entries.length === 0) rows.push([path, Array.isArray(v) ? "[]" : "{}"]);
      for (const [k, x] of entries) walk(Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`, Array.isArray(v) ? name : k, x, depth + 1);
      return;
    }
    const text = typeof v === "string" ? v : JSON.stringify(v);
    if (text.length > MAX_DISPLAY) throw new ValidationError(path, `is too long to show for approval (${text.length} characters, max ${MAX_DISPLAY})`);
    rows.push([path, visible(text)]);
  };
  for (const k of Object.keys(args).sort()) walk(k, k, args[k], 0);
  if (rows.length > 100) throw new ValidationError("arguments", "have too many fields to show for approval");
  return rows;
}

/** A copy with every secret-looking value (any depth) masked, for building summaries people see. */
export function maskSecrets<T>(v: T, depth = 0): T {
  if (Array.isArray(v)) return v.map((x) => maskSecrets(x, depth + 1)) as T;
  if (v && typeof v === "object" && depth < 6) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        SECRET_FIELD.test(k) && x !== null && x !== undefined && x !== "" ? (typeof x === "object" ? "•••• (hidden)" : mask(x)) : maskSecrets(x, depth + 1),
      ]),
    ) as T;
  }
  return v;
}

/** Strips control and bidi-override characters and caps length, for summaries built from model-supplied arguments. */
export function cleanSummary(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
}

/** JSON for an inline <script>: `<` escaped, so a value can never close the script element. */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
