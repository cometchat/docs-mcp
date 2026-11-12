// OAuth 2.1 authorization server for the /mcp/dashboard endpoint, bridging the
// MCP client's sign-in to CometChat's dashboard device login. Everything it
// issues is a sealed value (see seal.ts), so it needs no database. One thing is
// held per process: the authorization codes already redeemed (single use), so
// production runs one replica (DEPLOY.md, "Before enabling", item 8).
//
// Flow: client registers (DCR) → /authorize renders a "Sign in to CometChat"
// page and marks this browser with a cookie → the user signs in on
// app.cometchat.com and allows the tool there → the dashboard sends the same
// browser back to /oauth/cometchat/callback with a one-time verifier → this
// server collects the dashboard token with it and redirects to the client with
// a short-lived code → the client exchanges it (PKCE) for an access token that
// wraps the dashboard token.
//
// Why the callback and not polling: a dashboard sign-in link can be sent to
// someone else. With polling, whoever started the sign-in collected the token
// once that person signed in. Now the token is only released to the browser
// that both started the sign-in (cookie) and allowed it (verifier).
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Sealer, nowSeconds } from "./seal.js";
import { createHash, randomBytes } from "node:crypto";
import { DashboardClient } from "./client.js";
import { DashboardAuthError } from "../lib/errors.js";
import { createDeviceSession, dashboardLoginUrl, pollDeviceSession, type PollResult } from "./device.js";
import { COMETCHAT_WORDMARK } from "./brand.js";
import { signInActor } from "./actor.js";
import { cachedClientLogo, initialIcon, knownAppIcon, type ClientIcon } from "./client-icon.js";
import { cookie, readCookie, scriptJson } from "./approval.js";

export const READ_SCOPE = "dashboard:read";
export const WRITE_SCOPE = "dashboard:write";

/** Requested scopes → granted scopes. Nothing recognisable (or the legacy
 *  "dashboard") means read + write; write always implies read. */
export function grantScopes(requested: string[] | undefined): string[] {
  const asked = new Set(requested ?? []);
  if (asked.has("dashboard") || (!asked.has(READ_SCOPE) && !asked.has(WRITE_SCOPE))) return [READ_SCOPE, WRITE_SCOPE];
  return asked.has(WRITE_SCOPE) ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE];
}

// How long a started sign-in (its page, poll handle and sign-in-browser cookie)
// stays usable. MCP clients stop waiting after about 5 minutes (Claude Code),
// so a sign-in finished later would only reach a closed callback. It is shorter
// than the dashboard's own session (mgmt-api SESSION_EXPIRY_SECONDS, 30 min),
// and also limits how long a forwarded sign-in link is worth anything here.
const PENDING_TTL = 5 * 60;
const CODE_TTL = 60; // the client exchanges it immediately; short limits replay
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
/** Public help page on removing a connection, linked from the sign-in page. */
export const DISCONNECT_PATH = "/oauth/cometchat/disconnect";

interface PendingAuth {
  sid: string; // dashboard device-session id
  cid: string; // OAuth client id
  ru: string; // redirect URI (already validated by the SDK against the client)
  cc: string; // PKCE code challenge
  st?: string; // client state
  rs?: string; // RFC 8707 resource
  sc: string[]; // scopes the client asked for (granted)
  uv?: boolean; // the redirect isn't a known AI tool
  bb?: boolean; // browser-bound: finishes only through the callback, never the poll
  cn?: string; // browser-bound: this sign-in's callback path nonce
}

interface Grant {
  dt: string; // dashboard token
  cid: string;
  em?: string; // email, for display only
  ru?: string;
  cc?: string;
  rs?: string;
  sc: string[];
  ia?: number; // when the user signed in (epoch seconds); kept through refreshes
  ci?: string; // authorization codes only: random id, so each code can be redeemed once
}

/** Most redeemed authorization codes remembered per process (a memory bound; far above real use). */
export const MAX_REDEEMED_CODES = 50_000;

/** "Sign-ins by `actor` before `before` are cut off" (`*` = everyone). */
export interface Revocation {
  actor: string;
  before: number;
}

/** Parses DASHBOARD_REVOKED_SIGN_INS: comma-separated `actor:unixSeconds`. Throws on a malformed entry. */
export function parseRevocations(raw: string): Revocation[] {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const m = /^([0-9a-f]{16}|\*):(\d{9,11})$/.exec(e);
      if (!m) throw new Error(`DASHBOARD_REVOKED_SIGN_INS: bad entry "${e}" (want <16-hex actor or *>:<unix seconds>)`);
      return { actor: m[1]!, before: Number(m[2]) };
    });
}

export type SignInStatus =
  | PollResult
  | { status: "redirect"; location: string; actor?: string; approverTtl?: number }
  | { status: "invalid" }
  | { status: "wrong_browser" };

export interface DashboardAuthOptions {
  secret: string;
  apiHost: string;
  dashboardHost: string;
  fetchImpl?: typeof fetch;
  revocations?: Revocation[];
  /** Previous DASHBOARD_TOKEN_SECRET values still accepted for opening (rotation). */
  previousSecrets?: string[];
  /** This server's protected resource (/mcp/dashboard). Tokens are only issued and accepted for it (and alsoResources). */
  resource?: URL;
  /** Other endpoints that serve the account tools (/mcp when DASHBOARD_ON_MCP is on). */
  alsoResources?: URL[];
  /** The issuer (RFC 9207 `iss` on the redirect back to the client). */
  issuer?: string;
  /** Exact https callback addresses (origin + path) that count as known AI tools (see redirectTrust). */
  trustedRedirectUris?: string[];
  /** Let unverified apps get write access too. */
  allowUnverifiedWrite?: boolean;
  /** DASHBOARD_READ_ONLY: the sign-in page describes read-only access (tools enforce it). */
  readOnly?: boolean;
  /**
   * "poll" (default until mgmt-api#935 and customer-dashboard#2602 ship): the
   * sign-in page polls for the token; a forwarded sign-in link hands it to
   * whoever started the sign-in. "confirm": the user allows the tool on the
   * dashboard, which sends the same browser back to the callback with a
   * one-time verifier, and only that browser gets the code.
   */
  signInFlow?: "confirm" | "poll";
  /** DASHBOARD_CLIENT_LOGOS: show an app's registered logo_uri (fetched by this server). Default true. */
  clientLogos?: boolean;
  /** Test hook: fetches a logo_uri as a data: URI. */
  fetchLogo?: (uri: string) => Promise<string | undefined>;
}

/** Cookie marking the browser that loaded a sign-in page, so only that browser is later trusted to approve changes. */
export const SIGNIN_BROWSER_COOKIE = "cc_mcp_signin";
/** Path of a browser-bound sign-in's own callback: its cookie is scoped to it. */
export function signInCallbackPath(nonce: string): string {
  return `${CALLBACK_PATH}/${nonce}`;
}
/** The random segment of a browser-bound sign-in's callback path. */
export const CALLBACK_NONCE = /^[A-Za-z0-9_-]{16}$/;
export const POLL_PATH = "/oauth/cometchat/poll";
/** Where the dashboard returns the browser after the user allows a browser-bound sign-in. */
export const CALLBACK_PATH = "/oauth/cometchat/callback";

export class DashboardOAuthProvider implements OAuthServerProvider {
  readonly sealer: Sealer;
  private readonly opts: DashboardAuthOptions;

  constructor(opts: DashboardAuthOptions) {
    this.opts = opts;
    this.sealer = new Sealer(opts.secret, opts.previousSecrets ?? []);
  }

  // Dashboard tokens the dashboard has rejected (401), by hash, until their own
  // expiry. Per replica: a hit turns the next call into an HTTP 401 so the
  // client refreshes, and the refresh re-checks the token with the dashboard.
  private readonly rejected = new Map<string, number>();

  // Authorization codes already exchanged, until they expire (CODE_TTL), so a
  // code works once (OAuth 2.1). Per process, like `rejected`: production runs
  // one replica. Keyed by the id sealed inside the code, not the code's text:
  // the same sealed value has more than one valid spelling.
  private readonly redeemed = new Map<string, number>();

  /** Marks a code used; false if it already was. Synchronous, so two concurrent exchanges can't both pass. */
  private redeemCode(g: Grant, exp: number): boolean {
    // Look the code up before pruning: the clock can tick past exp between
    // opening the code and here, and pruning first would drop its entry.
    const key = g.ci ?? createHash("sha256").update(JSON.stringify(g)).digest("base64url");
    if (this.redeemed.has(key)) return false;
    const now = nowSeconds();
    for (const [k, until] of this.redeemed) {
      // Every code lives CODE_TTL, so insertion order is close to expiry order:
      // stop at the first live one. An expired one left behind is harmless
      // (an expired code no longer opens) and goes on a later pass.
      if (until > now) break;
      this.redeemed.delete(k);
    }
    // Still full of unexpired codes: forget only the oldest, never all of them.
    while (this.redeemed.size >= MAX_REDEEMED_CODES) this.redeemed.delete(this.redeemed.keys().next().value!);
    // A code still opens in its last second (seal.ts refuses only exp < now), so keep it one second longer.
    this.redeemed.set(key, exp + 1);
    return true;
  }

  /** Called when a tool call gets a 401 from the dashboard for this token. */
  rejectDashboardToken(dashboardToken: string): void {
    const now = nowSeconds();
    if (this.rejected.size >= 10_000) {
      for (const [k, until] of this.rejected) if (until <= now) this.rejected.delete(k);
      if (this.rejected.size >= 10_000) this.rejected.clear();
    }
    const left = dashboardTokenSecondsLeft(dashboardToken);
    this.rejected.set(tokenHash(dashboardToken), now + (left !== undefined && left > 0 ? left : 24 * 3600));
  }

  private isRejected(dashboardToken: string): boolean {
    const until = this.rejected.get(tokenHash(dashboardToken));
    if (until === undefined) return false;
    if (until <= nowSeconds()) {
      this.rejected.delete(tokenHash(dashboardToken));
      return false;
    }
    return true;
  }

  private dashboard(token: string): DashboardClient {
    return new DashboardClient({ apiHost: this.opts.apiHost, token, ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}) });
  }

  private get secureCookies(): boolean {
    return (this.opts.issuer ?? "").startsWith("https:");
  }

  /** True when the request's cookie shows it comes from the browser that loaded this sign-in page. */
  isSignInBrowser(handle: string, cookieHeader: string | undefined): boolean {
    const raw = readCookie(cookieHeader, SIGNIN_BROWSER_COOKIE);
    const opened = raw ? this.sealer.open<{ h: string }>("signin-browser", raw) : null;
    return !!opened && opened.data.h === handleHash(handle);
  }

  /** Whether sign-ins finish through the callback (not the legacy poll). */
  private get browserBound(): boolean {
    return this.opts.signInFlow !== "poll" && !!this.opts.issuer;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const sealer = this.sealer;
    return {
      // The client id IS the sealed registration, so nothing is stored.
      getClient(clientId: string) {
        const opened = sealer.open<Omit<OAuthClientInformationFull, "client_id">>("client", clientId);
        return opened ? { ...opened.data, client_id: clientId } : undefined;
      },
      registerClient(client) {
        // Plain http only to this machine (RFC 8252 loopback); anything else
        // would send codes across the network unencrypted.
        for (const uri of client.redirect_uris ?? []) {
          let u: URL;
          try {
            u = new URL(String(uri));
          } catch {
            throw new InvalidClientMetadataError(`Invalid redirect_uri: ${String(uri)}`);
          }
          if (u.protocol === "http:" && !LOOPBACK_HOSTS.has(u.hostname)) {
            throw new InvalidClientMetadataError("redirect_uri must use https, a loopback address (localhost, 127.0.0.1, [::1]) or an app scheme.");
          }
          // Schemes that hand the URL (and the code in it) to a web page or the browser.
          if (HANDOFF_SCHEMES.test(u.protocol)) {
            throw new InvalidClientMetadataError(`redirect_uri scheme ${u.protocol} isn't allowed.`);
          }
        }
        const clientId = sealer.seal("client", client, 0);
        return { ...client, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) };
      },
    };
  }

  private servesResource(href: string): boolean {
    return href === this.opts.resource?.href || (this.opts.alsoResources ?? []).some((r) => r.href === href);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // RFC 8707: a token asked for some other resource must not be minted here.
    if (params.resource && this.opts.resource && !this.servesResource(params.resource.href)) {
      const back = new URL(params.redirectUri);
      back.searchParams.set("error", "invalid_target");
      back.searchParams.set("error_description", "This server only issues tokens for its own MCP endpoints.");
      if (params.state !== undefined) back.searchParams.set("state", params.state);
      if (this.opts.issuer) back.searchParams.set("iss", this.opts.issuer);
      res.redirect(302, back.href);
      return;
    }
    const trust = redirectTrust(params.redirectUri, this.opts.trustedRedirectUris ?? []);
    const unverified = trust === "unverified";
    // Started now, used when the page renders; it never rejects.
    const icon = this.clientIcon(client, params.redirectUri, unverified);
    // Each sign-in returns to its own path, and its cookie is scoped to that
    // path: a callback only ever carries its own cookie, however many sign-ins
    // were started (or abandoned) in the browser.
    const nonce = this.browserBound ? randomBytes(12).toString("base64url") : undefined;
    const callbackPath = nonce ? signInCallbackPath(nonce) : undefined;
    const callbackUrl = callbackPath ? new URL(callbackPath, this.opts.issuer).href : undefined;
    const name = (client.client_name?.trim() || "An AI tool").slice(0, 100);
    let sessionId: string;
    try {
      sessionId = await createDeviceSession(
        this.opts.apiHost,
        this.opts.fetchImpl,
        // Shown to the user on the dashboard before they allow the sign-in.
        callbackUrl ? { returnUrl: callbackUrl, clientName: name, returnTo: returnHost(params.redirectUri), verified: !unverified } : {},
      );
    } catch (err) {
      sendHtml(res, 502, page("Sign-in is unavailable", `<h1>Sign-in is unavailable</h1><p>${esc((err as Error).message)} Try again in a moment.</p>`));
      return;
    }
    const pending: PendingAuth = {
      sid: sessionId,
      cid: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      ...(params.state !== undefined ? { st: params.state } : {}),
      ...(params.resource ? { rs: params.resource.href } : {}),
      // An app this server can't vouch for gets read-only access: a lookalike
      // "Claude" registered by anyone must not be able to collect write access.
      sc: unverified && !this.opts.allowUnverifiedWrite ? [READ_SCOPE] : grantScopes(params.scopes),
      ...(unverified ? { uv: true } : {}),
      ...(nonce ? { bb: true, cn: nonce } : {}),
    };
    const handle = this.sealer.seal("pending", pending, PENDING_TTL);
    if (callbackUrl) {
      // The sign-in finishes only in this browser: the callback needs this
      // cookie (Lax, so it rides the dashboard's top-level redirect back).
      res.append(
        "Set-Cookie",
        cookie(SIGNIN_BROWSER_COOKIE, this.sealer.seal("signin-browser", { hd: handle }, PENDING_TTL), callbackPath!, PENDING_TTL, this.secureCookies, "Lax"),
      );
    } else {
      // Only the browser that loaded this page is later trusted to approve high-risk changes.
      res.append(
        "Set-Cookie",
        cookie(SIGNIN_BROWSER_COOKIE, this.sealer.seal("signin-browser", { h: handleHash(handle) }, PENDING_TTL), POLL_PATH, PENDING_TTL, this.secureCookies),
      );
    }
    const loginUrl = dashboardLoginUrl(this.opts.dashboardHost, sessionId, "login");
    const signupUrl = dashboardLoginUrl(this.opts.dashboardHost, sessionId, "signup");
    sendHtml(
      res,
      200,
      signInPage(client, params.redirectUri, loginUrl, signupUrl, handle, pending.sc.includes(WRITE_SCOPE) && !this.opts.readOnly, unverified, !!callbackUrl, this.cancelUrl(params), await icon),
    );
  }

  /**
   * The connecting app's icon: ours for a known app (by where the sign-in
   * returns to, never by its name), else its registered logo_uri unless it's
   * unverified (anyone could register a lookalike logo), else its initial.
   */
  private async clientIcon(client: OAuthClientInformationFull, redirectUri: string, unverified: boolean): Promise<ClientIcon> {
    const fallback = initialIcon(client.client_name?.trim() || "An AI tool");
    if (unverified) return fallback;
    const app = knownAppIcon(redirectUri);
    if (app) return app;
    const logo = typeof client.logo_uri === "string" ? client.logo_uri.trim() : "";
    if (!logo || this.opts.clientLogos === false) return fallback;
    try {
      const src = await cachedClientLogo(logo, this.opts.fetchLogo);
      return src ? { kind: "logo", src } : fallback;
    } catch {
      return fallback;
    }
  }

  /** RFC 6749 §4.1.2.1: send the client access_denied (no code), so it stops waiting. */
  private cancelUrl(params: AuthorizationParams): string {
    const back = new URL(params.redirectUri);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_description", "The user cancelled the CometChat sign-in.");
    if (params.state !== undefined) back.searchParams.set("state", params.state);
    if (this.opts.issuer) back.searchParams.set("iss", this.opts.issuer);
    return back.href;
  }

  /** Called by the sign-in page; returns where to send the browser once signed in. */
  async pollSignIn(handle: string): Promise<SignInStatus> {
    const opened = this.sealer.open<PendingAuth>("pending", handle);
    // A browser-bound sign-in is never released to a poll: whoever polls may
    // not be the person who signed in.
    if (!opened || opened.data.bb) return { status: "invalid" };
    const p = opened.data;
    const result = await pollDeviceSession(this.opts.apiHost, p.sid, this.opts.fetchImpl);
    if (result.status !== "authorized") return result;
    return this.finishSignIn(p, result);
  }

  /**
   * The dashboard sent the browser back after the user allowed the sign-in.
   * Released only when this browser also started it (cookie) and the dashboard
   * gave it the session's one-time verifier.
   */
  async completeBrowserSignIn(nonce: string, sessionId: string, verifier: string, cookieHeader: string | undefined): Promise<SignInStatus> {
    const raw = readCookie(cookieHeader, SIGNIN_BROWSER_COOKIE);
    const marker = raw ? this.sealer.open<{ hd?: string }>("signin-browser", raw) : null;
    const opened = marker?.data.hd ? this.sealer.open<PendingAuth>("pending", marker.data.hd) : null;
    if (!opened || !opened.data.bb || opened.data.cn !== nonce || opened.data.sid !== sessionId) {
      // The user allowed a sign-in this browser didn't start: someone may have
      // sent them the link. Use the session up now, so the verifier in this
      // URL (browser history, access logs) can't be redeemed later. The
      // token this mints is dropped here, never stored or logged.
      await pollDeviceSession(this.opts.apiHost, sessionId, this.opts.fetchImpl, verifier).catch(() => undefined);
      return { status: "wrong_browser" };
    }
    const result = await pollDeviceSession(this.opts.apiHost, sessionId, this.opts.fetchImpl, verifier);
    if (result.status !== "authorized") return result;
    return this.finishSignIn(opened.data, result);
  }

  private async finishSignIn(p: PendingAuth, result: Extract<PollResult, { status: "authorized" }>): Promise<SignInStatus> {
    // The email keys the audit actor and per-user revocation; if the sign-in
    // response doesn't carry it, ask the dashboard who this is.
    let email = result.email;
    if (!email) {
      try {
        email = (await this.dashboard(result.token).getCurrentUser()).email;
      } catch {
        email = undefined;
      }
    }
    const code = this.sealer.seal<Grant>(
      "code",
      {
        dt: result.token,
        cid: p.cid,
        ru: p.ru,
        cc: p.cc,
        sc: p.sc,
        ia: nowSeconds(),
        ci: randomBytes(16).toString("base64url"),
        ...(p.rs ? { rs: p.rs } : {}),
        ...(email ? { em: email } : {}),
      },
      CODE_TTL,
    );
    const target = new URL(p.ru);
    target.searchParams.set("code", code);
    if (p.st !== undefined) target.searchParams.set("state", p.st);
    if (this.opts.issuer) target.searchParams.set("iss", this.opts.issuer);
    // The browser that signed in can later approve this user's high-risk changes.
    const left = dashboardTokenSecondsLeft(result.token);
    return { status: "redirect", location: target.href, actor: signInActor(email, p.cid), ...(left !== undefined ? { approverTtl: left } : {}) };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.openCode(client, code).data.cc ?? "";
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const { data: g, exp } = this.openCode(client, code);
    if (redirectUri !== undefined && g.ru !== undefined && redirectUri !== g.ru) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    }
    // Called only after the PKCE check passed, so a wrong verifier can't use up someone's code.
    if (!this.redeemCode(g, exp)) throw new InvalidGrantError("This authorization code was already used. Sign in again.");
    return this.issueTokens(g);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const opened = this.sealer.open<Grant>("refresh", refreshToken);
    if (!opened || opened.data.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token.");
    if (this.isRevoked(opened.data)) throw new InvalidGrantError("This sign-in was revoked. Sign in again.");
    // The dashboard can end a sign-in early (password change, logout). Check
    // before minting another hour; a dashboard outage doesn't sign anyone out.
    try {
      await this.dashboard(opened.data.dt).getCurrentUser();
    } catch (err) {
      if (err instanceof DashboardAuthError) throw new InvalidGrantError("Your CometChat sign-in has ended. Sign in again.");
    }
    return this.issueTokens(opened.data);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const opened = this.sealer.open<Grant>("access", token);
    if (!opened) throw new InvalidTokenError("Invalid or expired access token.");
    if (this.isRevoked(opened.data)) throw new InvalidTokenError("This sign-in was revoked. Sign in again.");
    if (this.isRejected(opened.data.dt)) throw new InvalidTokenError("Your CometChat sign-in has ended. Sign in again.");
    if (opened.data.rs && this.opts.resource && !this.servesResource(opened.data.rs)) {
      throw new InvalidTokenError("This token was issued for a different resource.");
    }
    return {
      token,
      clientId: opened.data.cid,
      scopes: Array.isArray(opened.data.sc) && opened.data.sc.length ? opened.data.sc : [READ_SCOPE],
      expiresAt: opened.exp,
      ...(opened.data.rs ? { resource: new URL(opened.data.rs) } : {}),
      extra: { dashboardToken: opened.data.dt, ...(opened.data.em ? { email: opened.data.em } : {}), ...(opened.data.ia ? { signedInAt: opened.data.ia } : {}) },
    };
  }

  /** Sign-ins with no recorded time (issued before revocation support) count as time 0. */
  private isRevoked(g: Grant): boolean {
    const list = this.opts.revocations;
    if (!list?.length) return false;
    const actor = signInActor(g.em, g.cid);
    const at = g.ia ?? 0;
    return list.some((r) => (r.actor === "*" || r.actor === actor) && at < r.before);
  }

  private openCode(client: OAuthClientInformationFull, code: string): { data: Grant; exp: number } {
    const opened = this.sealer.open<Grant>("code", code);
    if (!opened || opened.data.cid !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    return opened;
  }

  private issueTokens(g: Grant): OAuthTokens {
    const grant: Grant = { dt: g.dt, cid: g.cid, sc: g.sc?.length ? g.sc : [READ_SCOPE], ...(g.em ? { em: g.em } : {}), ...(g.rs ? { rs: g.rs } : {}), ...(g.ia ? { ia: g.ia } : {}) };
    // Never outlive the dashboard token inside (a JWT, 7 days today). Once it is
    // gone the refresh is refused, so the client starts a fresh sign-in on its
    // own instead of failing every call with a dead token.
    const left = dashboardTokenSecondsLeft(g.dt);
    if (left !== undefined && left <= 0) throw new InvalidGrantError("Your CometChat sign-in has expired. Sign in again.");
    const accessTtl = left === undefined ? ACCESS_TTL : Math.min(ACCESS_TTL, left);
    const refreshTtl = left === undefined ? REFRESH_TTL : Math.min(REFRESH_TTL, left);
    return {
      access_token: this.sealer.seal("access", grant, accessTtl),
      token_type: "bearer",
      expires_in: accessTtl,
      refresh_token: this.sealer.seal("refresh", grant, refreshTtl),
      scope: grant.sc.join(" "),
    };
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * "known": the code can only reach a tool on the user's own machine (loopback,
 * or the app scheme of a known MCP client / a reverse-domain app scheme), or an
 * exact callback in the trusted list. Anything
 * else is "unverified": anyone can register a client with any name and their
 * own https redirect, so the page warns and only read access is granted.
 */
export function redirectTrust(redirectUri: string, trustedUris: string[]): "known" | "unverified" {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return "unverified";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    if (HANDOFF_SCHEMES.test(u.protocol)) return "unverified";
    return KNOWN_APP_SCHEMES.has(u.protocol.toLowerCase()) || /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+:$/i.test(u.protocol) ? "known" : "unverified";
  }
  if (LOOPBACK_HOSTS.has(u.hostname)) return "known";
  // A trusted entry is an exact callback (origin + path): any other page on
  // the same site might let an attacker read the code from its URL.
  if (u.protocol !== "https:" || u.username || u.password) return "unverified";
  const at = `${u.origin}${u.pathname}`;
  return trustedUris.some((t) => {
    try {
      const x = new URL(t.trim());
      return x.protocol === "https:" && `${x.origin}${x.pathname}` === at;
    } catch {
      return false;
    }
  })
    ? "known"
    : "unverified";
}

const tokenHash = (t: string) => createHash("sha256").update(t).digest("base64url");
const handleHash = (h: string) => createHash("sha256").update(`signin:${h}`).digest("base64url");

/** Schemes that pass the URL to a browser or web page (Android intents, iOS browser hand-offs). */
const HANDOFF_SCHEMES = /^(intent|x-safari-https?|googlechromes?|microsoft-edge(-https?)?|firefox|opera-https?|brave|javascript|data|vbscript|file|blob|about):$/i;
/** App schemes of known MCP clients. Other app schemes count only in reverse-domain form (RFC 8252 §7.1). */
const KNOWN_APP_SCHEMES = new Set(["cursor:", "vscode:", "vscode-insiders:", "windsurf:", "claude:", "zed:", "kiro:"]);

/**
 * Seconds until the dashboard token expires, read from its JWT `exp` claim.
 * Only used to cap our own token lifetimes; the dashboard API still verifies
 * the token on every call. Undefined when the token isn't a readable JWT.
 */
export function dashboardTokenSecondsLeft(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? Math.floor(exp - nowSeconds()) : undefined;
  } catch {
    return undefined;
  }
}

// ── sign-in page ────────────────────────────────────────────────────────────

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const PRIVACY_URL = "https://www.cometchat.com/legal-privacy-policy";
const SIGN_IN_FOOTER = `Only connect tools you trust. You can disconnect at any time. <a href="${DISCONNECT_PATH}" target="_blank" rel="noopener">How to disconnect</a> · <a href="${PRIVACY_URL}" target="_blank" rel="noopener">Privacy</a>`;

/**
 * Headers for every HTML page: no framing (clickjacking), no referrer (the
 * authorize URL carries the client's state), and a CSP that only runs this
 * page's own script, identified by `nonce`.
 */
export function sendHtml(res: Response, status: number, html: { nonce: string; body: string }, cache = "no-store"): void {
  res
    .status(status)
    .type("html")
    .set({
      "Cache-Control": cache,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${html.nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    })
    .send(html.body);
}

export function page(title: string, body: string, script = "", footer = SIGN_IN_FOOTER): { nonce: string; body: string } {
  const nonce = randomBytes(16).toString("base64");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">
<style>
:root{--bg:#f6f6f9;--card:#fff;--border:#e6e6ec;--text:#141419;--muted:#6b6b76;--soft:#f3f1fd;--brand:#6851d6;--brand-hover:#5a43c9;--ok:#16a34a;--warn:#b45309;--danger:#dc2626;--shadow:0 1px 2px rgba(20,20,25,.04),0 12px 32px -12px rgba(20,20,25,.12)}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e11;--card:#17171b;--border:#2a2a31;--text:#f4f4f6;--muted:#9a9aa6;--soft:#211d36;--brand:#7c68e8;--brand-hover:#8d7bf0;--ok:#4ade80;--warn:#fbbf24;--danger:#f87171;--shadow:0 1px 2px rgba(0,0,0,.3),0 16px 40px -16px rgba(0,0,0,.6)}}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:32px 16px;background:var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wordmark{display:block;color:var(--text)}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);padding:28px}
h1{font-size:20px;line-height:1.3;font-weight:650;letter-spacing:-.01em;margin:0 0 6px}
p{margin:0 0 12px;color:var(--muted)}
.client{display:flex;align-items:center;gap:12px;padding:12px;margin:0 0 20px;border:1px solid var(--border);border-radius:12px}
.avatar{flex:none;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--soft);color:var(--brand);font-weight:700}
.avatar.app{color:var(--text)}.avatar.app svg{width:22px;height:22px}
img.avatar{object-fit:contain;padding:4px;box-sizing:border-box}
.client strong{display:block;font-size:15px;font-weight:600;color:var(--text);overflow-wrap:anywhere}
.client span{display:block;font-size:13px;color:var(--muted)}
.label{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
ul{list-style:none;margin:0 0 20px;padding:0;display:grid;gap:10px}
li{display:flex;gap:10px;align-items:flex-start;font-size:14px}
li svg{flex:none;margin-top:2px;width:16px;height:16px}
li.can svg{color:var(--ok)}li.guard svg{color:var(--muted)}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:12px 16px;border-radius:10px;background:var(--brand);color:#fff;font-weight:600;font-size:15px;text-decoration:none;transition:background .15s}
.btn:hover{background:var(--brand-hover)}.btn:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.alt{text-align:center;font-size:14px;margin:14px 0 0}
.note{font-size:14px;margin:0 0 14px}
a{color:var(--brand);font-weight:500;text-decoration:none}a:hover{text-decoration:underline}
#status{display:none;align-items:center;gap:10px;margin:16px 0 0;padding:10px 12px;border-radius:10px;background:var(--soft);font-size:14px;color:var(--text)}
#status.show{display:flex}#status.ok{color:var(--ok)}#status.err{color:var(--danger)}
.spin{flex:none;width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:r .8s linear infinite}
#status.ok .spin,#status.err .spin{display:none}
@keyframes r{to{transform:rotate(360deg)}}
h2{font-size:15px;font-weight:600;margin:20px 0 6px}ol{margin:0;padding-left:20px;color:var(--muted)}ol li{display:list-item;font-size:14px;margin:0 0 4px}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);color:var(--text);padding:1px 5px;border-radius:5px}
footer{max-width:420px;text-align:center;font-size:12px;color:var(--muted)}
.warn{margin:0 0 20px;padding:12px;border:1px solid var(--warn);border-radius:12px;font-size:14px;color:var(--text)}.warn strong{display:block;color:var(--warn);margin:0 0 4px}
.code{font:600 28px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-align:center;padding:16px;margin:0 0 12px;border:1px dashed var(--border);border-radius:12px;color:var(--text);user-select:all}
table{width:100%;border-collapse:collapse;margin:0 0 20px;font-size:13px}td{padding:6px 8px;border-top:1px solid var(--border);vertical-align:top;overflow-wrap:anywhere}td:first-child{color:var(--muted);white-space:nowrap;width:1%}
button.btn{border:0;cursor:pointer;font:inherit;font-weight:600}button.btn[disabled]{opacity:.6;cursor:default}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
</head><body>${COMETCHAT_WORDMARK}<main>${body}</main><footer>${footer}</footer>${script.replace("<script>", `<script nonce="${nonce}">`)}</body></html>`;
  return { nonce, body: html };
}

const CHECK = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SHIELD = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.75l5 2v4.1c0 3-2.1 5.4-5 6.4-2.9-1-5-3.4-5-6.4v-4.1l5-2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

/** Where the browser returns after sign-in (scheme, host and port), shown so users can spot an unexpected tool. */
function returnHost(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : `${u.protocol}//${u.host}`;
  } catch {
    return redirectUri;
  }
}

function signInPage(
  client: OAuthClientInformationFull,
  redirectUri: string,
  loginUrl: string,
  signupUrl: string,
  handle: string,
  write: boolean,
  unverified = false,
  browserBound = false,
  cancelUrl = "",
  icon: ClientIcon = initialIcon(client.client_name?.trim() || "An AI tool"),
): { nonce: string; body: string } {
  const name = client.client_name?.trim() || "An AI tool";
  const avatar =
    icon.kind === "app"
      ? `<div class="avatar app" title="${esc(icon.app)}" aria-hidden="true">${icon.svg}</div>`
      : icon.kind === "logo"
        ? `<img class="avatar logo" alt="" src="${esc(icon.src)}">`
        : `<div class="avatar" aria-hidden="true">${esc(icon.letter)}</div>`;
  const can = (t: string, cls = "") => `<li class="can${cls}">${CHECK}<span>${t}</span></li>`;
  const guard = (t: string, cls = "") => `<li class="guard${cls}">${SHIELD}<span>${t}</span></li>`;
  const body = `<h1>Connect to CometChat</h1>
<p>Sign in to give this tool access to your CometChat account.</p>
<div class="client">${avatar}<div><strong>${esc(name)}${unverified ? " (unverified)" : ""}</strong><span>Returns to ${esc(returnHost(redirectUri))} after sign-in</span></div></div>
${unverified ? `<div class="warn" role="alert"><strong>Unverified app</strong>CometChat can't confirm this is the tool it says it is: anyone can choose that name. Only continue if you started this from your own AI tool and recognise ${esc(returnHost(redirectUri))}. It gets read-only access.</div>` : ""}
<div class="label">It will be able to</div>
<ul>
${can("View your apps, credentials and usage analytics")}
${can("View users, groups, messages and moderation")}
${write ? can("Create apps, API keys, webhooks and users, and change settings") : ""}
${write ? can("Delete users, groups, messages, keys, webhooks and other data you choose") : ""}
${write ? guard("Risky changes and every delete, like webhooks, new keys, team invites and deleting data, need your approval in this browser. It can't delete apps, change billing or ban users.") : ""}
${write ? "" : guard("Read-only: it can't change your account. It can still read app credentials, including the Auth Key; other API key values stay hidden.")}
</ul>
${browserBound ? `<p class="note">CometChat will ask you to allow ${esc(name)}, then bring you back to it.</p>` : ""}
<a class="btn" id="signin" href="${esc(loginUrl)}"${browserBound ? "" : ' target="_blank" rel="noopener"'}>Sign in to CometChat</a>
<p class="alt">New to CometChat? <a href="${esc(signupUrl)}"${browserBound ? "" : ' target="_blank" rel="noopener"'}>Create a free account</a></p>
${cancelUrl ? `<p class="alt"><a id="cancel" href="${esc(cancelUrl)}">Cancel</a></p>` : ""}
<div id="status" role="status" aria-live="polite"><span class="spin" aria-hidden="true"></span><span id="status-text"></span></div>`;
  // Browser-bound: the dashboard brings this tab back to the callback, so there's nothing to poll.
  if (browserBound) return page("Connect to CometChat", body);
  const script = `<script>
(function(){var h=${scriptJson(handle)},c=${scriptJson(cancelUrl)},box=document.getElementById("status"),t=document.getElementById("status-text"),done=false;
function show(msg,kind){t.textContent=msg;box.className="show"+(kind?" "+kind:"")}
document.querySelectorAll("a[target=_blank]").forEach(function(a){a.addEventListener("click",function(){if(!done)show("Finish signing in on the new tab. This page continues automatically.")})});
function tick(){if(done)return;fetch(${scriptJson(POLL_PATH)}+"?handle="+encodeURIComponent(h),{cache:"no-store"}).then(function(r){return r.json()}).then(function(r){
if(r.status==="redirect"){done=true;show("Signed in. Returning to your AI tool…","ok");location.replace(r.location);return}
if(r.status==="denied"){done=true;show("Sign-in was cancelled. Telling your AI tool…","err");location.replace(c);return}
if(r.status==="expired"||r.status==="invalid"){done=true;show("This sign-in link has expired. Close this tab and connect again from your AI tool.","err");return}
if(r.status==="error"){show(r.message||"Something went wrong. Retrying…","err")}
setTimeout(tick,3000)}).catch(function(){setTimeout(tick,5000)})}
setTimeout(tick,3000)})();
</script>`;
  return page("Connect to CometChat", body, script);
}

/** Public help page linked from the sign-in page: how to remove a connection and what that does. */
export function disconnectPage(): { nonce: string; body: string } {
  const body = `<h1>Disconnect an AI tool</h1>
<p>Your AI tool is the only place your CometChat sign-in is stored. Remove the CometChat connection there and the tool loses access.</p>
<h2>Claude Code</h2>
<ol><li>Run <code>/mcp</code>, pick the CometChat server and choose <strong>Clear authentication</strong>, or run <code>claude mcp logout &lt;name&gt;</code>.</li><li>Or remove it completely: <code>claude mcp remove &lt;name&gt;</code>.</li></ol>
<h2>Codex</h2>
<ol><li>Run <code>codex mcp logout &lt;name&gt;</code>.</li><li>Or remove it completely: <code>codex mcp remove &lt;name&gt;</code>.</li></ol>
<h2>Claude (desktop app or claude.ai)</h2>
<ol><li>Open <strong>Settings → Connectors</strong>.</li><li>Find CometChat and choose <strong>Remove</strong>.</li></ol>
<h2>Cursor, Windsurf and VS Code</h2>
<ol><li>Open the editor's MCP settings or MCP server list.</li><li>Delete the CometChat entry, then restart the agent session.</li></ol>
<h2>What happens next</h2>
<ol><li>Removing the connection stops that tool from using it.</li><li>A sign-in that was copied off your device keeps working until it expires: each access token lasts 1 hour, and a sign-in lasts at most 7 days.</li><li>To cut off every copy now, change your CometChat password: connected AI tools are signed out within an hour. Logging out of the dashboard doesn't do this.</li><li>Nothing in your CometChat apps changes when you disconnect.</li></ol>
<p class="alt">Think a sign-in was copied from your device? Change your password, and contact CometChat support so it can be cut off straight away.</p>`;
  return page("Disconnect an AI tool", body, "", `<a href="https://www.cometchat.com/docs/mcp-server" target="_blank" rel="noopener">CometChat MCP server docs</a>`);
}
