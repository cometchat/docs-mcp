// Release hardening for the sign-in endpoints: per-client-IP rate limits
// behind a load balancer, anti-framing/CSP headers on the HTML pages, and
// token lifetimes capped at the dashboard token's own expiry.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { stubBundleStore } from "./helpers/bundles.js";
import { ResourceRegistry } from "../src/resources/registry.js";
import { DashboardOAuthProvider, READ_SCOPE, dashboardTokenSecondsLeft, parseRevocations, type Revocation } from "../src/dashboard/oauth.js";
import { signInActor } from "../src/dashboard/actor.js";
import { startDashboardMock } from "./dashboard-mock.js";
import { testSecret } from "./secrets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REDIRECT = "http://localhost:7777/callback";
const AUTH_LIMIT = 3;

let mock: Awaited<ReturnType<typeof startDashboardMock>>;
let server: http.Server;
let base: string;

beforeAll(async () => {
  mock = await startDashboardMock();
  const bundleStore = stubBundleStore();
  const app = createApp({
    config: {
      ...loadConfig(),
      indexAutoRefresh: false,
      rateLimitEnabled: false,
      dashboardEnabled: true,
      dashboardTokenSecret: testSecret("h"),
      publicUrl: "http://localhost",
      dashboardApiHost: mock.url,
      dashboardHost: "https://app.cometchat.com",
      dashboardAuthRequestsPerMinute: AUTH_LIMIT,
    },
    searchClient: new SqliteSearchClient(path.join(ROOT, "does-not-exist", "index.sqlite")),
    bundleStore,
    resources: await ResourceRegistry.load(path.join(ROOT, "skills"), bundleStore),
    refresher: null,
    allowedHosts: [],
    allowedOrigins: [],
    dnsRebindingProtection: false,
  });
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await mock.close();
});

const register = (ip: string) =>
  fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Hardening", token_endpoint_auth_method: "none" }),
  });

describe("sign-in rate limits are per client IP, not per load balancer", () => {
  it("limits one client IP without blocking others behind the same proxy", async () => {
    for (let i = 0; i < AUTH_LIMIT; i++) expect((await register("203.0.113.7")).status).toBe(201);
    expect((await register("203.0.113.7")).status).toBe(429);
    // Same socket address (the "load balancer"), different real client: own bucket.
    expect((await register("198.51.100.20")).status).toBe(201);
  });

  it("uses the rightmost X-Forwarded-For hop, so a client can't spoof its way around the limit", async () => {
    for (let i = 0; i < AUTH_LIMIT; i++) expect((await register(`10.0.0.${i}, 192.0.2.50`)).status).toBe(201);
    expect((await register("10.9.9.9, 192.0.2.50")).status).toBe(429);
  });

  it("caps the sign-in status poll per client IP", async () => {
    const poll = () => fetch(`${base}/oauth/cometchat/poll?handle=x`, { headers: { "x-forwarded-for": "192.0.2.99" } });
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) statuses.push((await poll()).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
  });
});

describe("HTML pages can't be framed and only run their own script", () => {
  it("sign-in page", async () => {
    const reg = (await (await register("198.51.100.77")).json()) as { client_id: string };
    const u = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" })) u.searchParams.set(k, v);
    const res = await fetch(u, { headers: { "x-forwarded-for": "198.51.100.77" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(await res.text()).toContain(`<script nonce="${nonce}">`);
  });

  it("disconnect help page", async () => {
    const res = await fetch(`${base}/oauth/cometchat/disconnect`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("tokens never outlive the dashboard token inside", () => {
  const jwt = (exp: number) =>
    ["e30", Buffer.from(JSON.stringify({ sub: "u1", exp })).toString("base64url"), "sig"].join(".");
  const now = () => Math.floor(Date.now() / 1000);
  const provider = new DashboardOAuthProvider({ secret: testSecret("p"), apiHost: "http://127.0.0.1:9", dashboardHost: "https://app.cometchat.com" });
  const client = { client_id: "c1", redirect_uris: [REDIRECT] } as any;
  const code = (dt: string) => provider.sealer.seal("code", { dt, cid: "c1", sc: [READ_SCOPE] }, 300);

  it("reads the expiry from a JWT and ignores opaque tokens", () => {
    expect(dashboardTokenSecondsLeft(jwt(now() + 100))).toBeGreaterThan(90);
    expect(dashboardTokenSecondsLeft("opaque-token")).toBeUndefined();
    expect(dashboardTokenSecondsLeft("a.not-json.c")).toBeUndefined();
  });

  it("shortens the access token when the dashboard token expires sooner", async () => {
    const t = await provider.exchangeAuthorizationCode(client, code(jwt(now() + 600)));
    expect(t.expires_in).toBeLessThanOrEqual(600);
    expect(t.expires_in).toBeGreaterThan(590);
    const refresh = provider.sealer.open("refresh", t.refresh_token!);
    expect(refresh!.exp).toBeLessThanOrEqual(now() + 600);
  });

  it("keeps the normal 1 hour / 30 day lifetimes when the dashboard token lasts longer", async () => {
    const t = await provider.exchangeAuthorizationCode(client, code(jwt(now() + 7 * 24 * 3600)));
    expect(t.expires_in).toBe(3600);
  });

  it("refuses a refresh once the dashboard token has expired, so the client signs in again", async () => {
    const refresh = provider.sealer.seal("refresh", { dt: jwt(now() - 5), cid: "c1", sc: [READ_SCOPE] }, 3600);
    await expect(provider.exchangeRefreshToken(client, refresh)).rejects.toThrow(/expired/);
  });
});

describe("per-user revocation without a database", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const client = { client_id: "c1", redirect_uris: [REDIRECT] } as any;
  // Computed per test: actor ids are keyed once the app has started.
  const actorOf = () => signInActor("Dev@Example.com", "c1");
  const make = (revocations: Revocation[]) =>
    new DashboardOAuthProvider({ secret: testSecret("r"), apiHost: "http://127.0.0.1:9", dashboardHost: "https://app.cometchat.com", revocations });
  const grant = (ia: number | undefined, em = "dev@example.com") => ({ dt: "opaque", cid: "c1", sc: [READ_SCOPE], em, ...(ia ? { ia } : {}) });

  it("parses entries and rejects malformed ones at startup", () => {
    expect(parseRevocations("")).toEqual([]);
    expect(parseRevocations(` ${actorOf()}:1791356353 , *:1700000000`)).toEqual([
      { actor: actorOf(), before: 1791356353 },
      { actor: "*", before: 1700000000 },
    ]);
    expect(() => parseRevocations("someone@example.com:1791356353")).toThrow(/bad entry/);
    expect(() => parseRevocations(`${actorOf()}:soon`)).toThrow(/bad entry/);
  });

  it("cuts off that user's earlier sign-ins (access and refresh), case-insensitively by email", async () => {
    const p = make([{ actor: actorOf(), before: now() }]);
    const access = p.sealer.seal("access", grant(now() - 60), 3600);
    await expect(p.verifyAccessToken(access)).rejects.toThrow(/revoked/);
    const refresh = p.sealer.seal("refresh", grant(now() - 60), 3600);
    await expect(p.exchangeRefreshToken(client, refresh)).rejects.toThrow(/revoked/);
  });

  it("treats tokens from before revocation support (no sign-in time) as revocable", async () => {
    const p = make([{ actor: actorOf(), before: now() }]);
    await expect(p.verifyAccessToken(p.sealer.seal("access", grant(undefined), 3600))).rejects.toThrow(/revoked/);
  });

  it("leaves later sign-ins and other users alone; * cuts off everyone", async () => {
    const p = make([{ actor: actorOf(), before: now() - 120 }]);
    await expect(p.verifyAccessToken(p.sealer.seal("access", grant(now() - 10), 3600))).resolves.toBeTruthy();
    await expect(p.verifyAccessToken(p.sealer.seal("access", grant(now() - 600, "other@example.com"), 3600))).resolves.toBeTruthy();
    const all = make([{ actor: "*", before: now() }]);
    await expect(all.verifyAccessToken(all.sealer.seal("access", grant(now() - 60, "other@example.com"), 3600))).rejects.toThrow(/revoked/);
  });

  it("records the sign-in time and keeps it through a refresh", async () => {
    const p = make([]);
    const code = p.sealer.seal("code", { ...grant(1_800_000_000), dt: "opaque" }, 300);
    const t = await p.exchangeAuthorizationCode(client, code);
    const refreshed = await p.exchangeRefreshToken(client, t.refresh_token!);
    expect(p.sealer.open<{ ia?: number }>("access", refreshed.access_token)!.data.ia).toBe(1_800_000_000);
  });
});

// ── Chief Engineer review fixes ─────────────────────────────────────────────

let ipSeq = 0;
const nextIp = () => `198.18.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`;
const ACCEPT_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };

/** Full sign-in over HTTP: register → authorize → dashboard approves → poll → token. */
async function signInOverHttp(opts: { confidential?: boolean } = {}) {
  const ip = nextIp();
  const reg = (await (
    await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Review", ...(opts.confidential ? {} : { token_endpoint_auth_method: "none" }) }),
    })
  ).json()) as { client_id: string; client_secret?: string; client_secret_expires_at?: number };
  const verifier = "v".repeat(64);
  const challenge = (await import("node:crypto")).createHash("sha256").update(verifier).digest("base64url");
  const u = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" })) u.searchParams.set(k, v);
  const html = await (await fetch(u, { headers: { "x-forwarded-for": ip } })).text();
  const handle = /var h="([^"]+)"/.exec(html)![1]!;
  mock.state.authorized = true;
  const done = (await (await fetch(`${base}/oauth/cometchat/poll?handle=${encodeURIComponent(handle)}`, { headers: { "x-forwarded-for": ip } })).json()) as { location: string };
  mock.state.authorized = false;
  const code = new URL(done.location).searchParams.get("code")!;
  const form = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT, ...(reg.client_secret ? { client_secret: reg.client_secret } : {}) });
  const tok = (await (await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: form })).json()) as { access_token: string; refresh_token: string };
  return { ...tok, reg, ip };
}

describe("client registration", () => {
  it("never expires a confidential client's secret (it's sealed into the client id and can't rotate)", async () => {
    const { reg, access_token } = await signInOverHttp({ confidential: true });
    expect(reg.client_secret).toBeTruthy();
    expect(reg.client_secret_expires_at).toBe(0);
    expect(access_token).toBeTruthy();
  });

  it("accepts https, loopback http and app schemes; rejects plain http to other hosts", async () => {
    const reg = (uri: string) =>
      fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": nextIp() }, body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: "none" }) });
    for (const ok of ["https://app.example.com/cb", "http://localhost:7777/cb", "http://127.0.0.1:9/cb", "http://[::1]:9/cb", "cursor://anysphere.cursor-mcp/oauth/callback"]) {
      expect((await reg(ok)).status, ok).toBe(201);
    }
    const bad = await reg("http://evil.example/cb");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_client_metadata");
  });
});

describe("a sign-in the dashboard ends early", () => {
  it("turns the next call into HTTP 401 and refuses the refresh, so the client signs in again", async () => {
    const t = await signInOverHttp();
    const call = (token: string) =>
      fetch(`${base}/mcp/dashboard`, { method: "POST", headers: { ...ACCEPT_HEADERS, authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cometchat_whoami", arguments: {} } }) });
    // Read the whole response: the SDK sends 200 headers before the tool has
    // finished, so revoking before the body arrives would race this call.
    const before = await call(t.access_token);
    expect(before.status).toBe(200);
    expect(await before.text()).toContain("dev@example.com");

    mock.state.tokenRevoked = true; // password change / logout on the dashboard
    try {
      const first = await call(t.access_token);
      expect(first.status).toBe(200); // this call reports `unauthorized` as a tool error…
      expect(await first.text()).toContain("unauthorized");
      const next = await call(t.access_token); // …and the next one is a real 401
      expect(next.status).toBe(401);
      expect(next.headers.get("www-authenticate")).toContain("invalid_token");
      const refresh = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": nextIp() },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.reg.client_id }),
      });
      expect(refresh.status).toBe(400);
      expect(((await refresh.json()) as { error: string }).error).toBe("invalid_grant");
    } finally {
      mock.state.tokenRevoked = false;
    }
  });
});

describe("sign-in identity", () => {
  it("looks the email up when the sign-in response doesn't carry it, so audit and revocation work per person", async () => {
    const p = new DashboardOAuthProvider({ secret: testSecret("e"), apiHost: mock.url, dashboardHost: "https://app.cometchat.com" });
    const handle = p.sealer.seal("pending", { sid: "sess-1", cid: "c1", ru: REDIRECT, cc: "x", sc: [READ_SCOPE] }, 600);
    mock.state.authorized = true;
    mock.state.omitSignInEmail = true;
    try {
      const r = (await p.pollSignIn(handle)) as { status: string; location: string };
      expect(r.status).toBe("redirect");
      const code = new URL(r.location).searchParams.get("code")!;
      expect(p.sealer.open<{ em?: string }>("code", code)!.data.em).toBe("dev@example.com");
    } finally {
      mock.state.authorized = false;
      mock.state.omitSignInEmail = false;
    }
  });
});

describe("secret rotation", () => {
  it("opens values sealed with the previous secret and seals new ones with the current one", () => {
    const old = new DashboardOAuthProvider({ secret: testSecret("o"), apiHost: "http://127.0.0.1:9", dashboardHost: "https://app.cometchat.com" });
    const rotated = new DashboardOAuthProvider({ secret: testSecret("n"), previousSecrets: [testSecret("o")], apiHost: "http://127.0.0.1:9", dashboardHost: "https://app.cometchat.com" });
    const fresh = new DashboardOAuthProvider({ secret: testSecret("n"), apiHost: "http://127.0.0.1:9", dashboardHost: "https://app.cometchat.com" });
    const client = old.sealer.seal("client", { redirect_uris: [REDIRECT] }, 0);
    expect(rotated.sealer.open("client", client)).not.toBeNull();
    expect(fresh.sealer.open("client", client)).toBeNull();
    const sealedNow = rotated.sealer.seal("access", { x: 1 }, 60);
    expect(fresh.sealer.open("access", sealedNow)).not.toBeNull();
  });
});

describe("read-only consent copy", () => {
  it("says a read-only grant can still read the Auth Key", async () => {
    const reg = (await (await register(nextIp())).json()) as { client_id: string };
    const u = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", scope: READ_SCOPE })) u.searchParams.set(k, v);
    const html = await (await fetch(u, { headers: { "x-forwarded-for": nextIp() } })).text();
    expect(html).toContain("It can still read app credentials, including the Auth Key; other API key values stay hidden.");
  });
});

describe("pinned OAuth behaviour (stateless trade-offs)", () => {
  it("issues sign-in codes valid for 60 seconds", async () => {
    const p = new DashboardOAuthProvider({ secret: testSecret("c"), apiHost: mock.url, dashboardHost: "https://app.cometchat.com" });
    const handle = p.sealer.seal("pending", { sid: "sess-1", cid: "c1", ru: REDIRECT, cc: "x", sc: [READ_SCOPE] }, 600);
    mock.state.authorized = true;
    try {
      const r = (await p.pollSignIn(handle)) as { location: string };
      const opened = p.sealer.open("code", new URL(r.location).searchParams.get("code")!)!;
      expect(opened.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
    } finally {
      mock.state.authorized = false;
    }
  });
});
