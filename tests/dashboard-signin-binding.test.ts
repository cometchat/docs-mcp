// Sign-in phishing: a dashboard sign-in link can be forwarded to someone else.
// The token must only reach the browser that both started the sign-in (cookie)
// and allowed it on the dashboard (one-time verifier), never a poller.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { stubBundleStore } from "./helpers/bundles.js";
import { ResourceRegistry } from "../src/resources/registry.js";
import { BB_SESSION, BB_VERIFIER, callbackFromDashboard, cookiePairOf, startDashboardMock } from "./dashboard-mock.js";
import { testSecret } from "./secrets.js";
import { Sealer } from "../src/dashboard/seal.js";
import { CALLBACK_NONCE } from "../src/dashboard/oauth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REDIRECT = "http://localhost:7777/callback";
let mock: Awaited<ReturnType<typeof startDashboardMock>>;
const servers: http.Server[] = [];

async function start(overrides: Partial<Config> = {}): Promise<string> {
  const bundleStore = stubBundleStore();
  const app = createApp({
    config: {
      ...loadConfig(),
      indexAutoRefresh: false,
      rateLimitEnabled: false,
      dashboardEnabled: true,
      dashboardTokenSecret: testSecret("b"),
      publicUrl: "http://localhost",
      dashboardApiHost: mock.url,
      dashboardHost: "https://app.cometchat.com",
      dashboardSignInFlow: "confirm",
      ...overrides,
    },
    searchClient: new SqliteSearchClient(path.join(ROOT, "does-not-exist", "index.sqlite")),
    bundleStore,
    resources: await ResourceRegistry.load(path.join(ROOT, "skills"), bundleStore),
    refresher: null,
    allowedHosts: [],
    allowedOrigins: [],
    dnsRebindingProtection: false,
  });
  const server = await new Promise<http.Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The attacker's own client and sign-in page: what they get to see and keep. */
async function startSignIn(base: string, clientName = "Claude") {
  const reg = (await (
    await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: clientName, token_endpoint_auth_method: "none" }),
    })
  ).json()) as { client_id: string };
  const u = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", state: "st" }))
    u.searchParams.set(k, v);
  const page = await fetch(u);
  const html = await page.text();
  return { html, setCookie: page.headers.get("set-cookie") ?? "", cookie: cookiePairOf(page.headers.get("set-cookie")) };
}

let base: string;
beforeAll(async () => {
  mock = await startDashboardMock();
  base = await start();
});
afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  await mock.close();
});
beforeEach(() => {
  mock.state.authorized = false;
  mock.state.denied = false;
});

describe("browser-bound dashboard sign-in (DASHBOARD_SIGNIN_FLOW=confirm)", () => {
  it("tells the dashboard who is asking and where to send the browser back", async () => {
    const s = await startSignIn(base, "Vitest Agent");
    const returnUrl = String(mock.state.sessionMetadata?.returnUrl);
    const nonce = returnUrl.split("/").pop()!;
    expect(returnUrl).toBe(`http://localhost/oauth/cometchat/callback/${nonce}`);
    expect(nonce).toMatch(CALLBACK_NONCE);
    expect(mock.state.sessionMetadata).toEqual({
      platform: "mcp",
      returnUrl,
      clientName: "Vitest Agent",
      returnTo: "http://localhost:7777",
      verified: true,
    });
    expect(s.html).toContain(`https://app.cometchat.com/login?sessionId=${BB_SESSION}`);
    expect(s.html).toContain("CometChat will ask you to allow Vitest Agent");
    // Same tab: the dashboard brings this tab back. No poller exists to hand anything to.
    expect(s.html).toMatch(/id="signin" href="[^"]+">Sign in to CometChat<\/a>/);
    expect(s.html).not.toContain("<script");
    // The marker cookie is Lax so it rides the dashboard's redirect back, and scoped to the sign-in paths.
    // Scoped to this sign-in's own callback path, lasting as long as the sign-in (5 minutes).
    expect(s.setCookie).toBe(`${s.cookie}; Path=/oauth/cometchat/callback/${nonce}; Max-Age=300; HttpOnly; SameSite=Lax`);
    expect(s.cookie.startsWith("cc_mcp_signin=")).toBe(true);
  });

  it("gives a forwarded link's victim nothing to hand over, and the attacker nothing to collect", async () => {
    const attacker = await startSignIn(base);
    const handle = /handle=|var h="/.test(attacker.html) ? /var h="([^"]+)"/.exec(attacker.html)?.[1] : undefined;
    expect(handle).toBeUndefined(); // the page carries no pollable handle
    // The victim opens the forwarded dashboard link and presses Allow.
    mock.state.authorized = true;
    // The dashboard sends the victim's browser back with the verifier; that browser didn't start the sign-in.
    const victim = await callbackFromDashboard(base, undefined);
    expect(victim.res.status).toBe(403);
    expect(await victim.res.text()).toContain("This sign-in was started in a different browser, so nothing was shared.");
    expect(victim.location).toBeUndefined();
    // The attacker has the sign-in cookie but never sees the verifier.
    const guess = await callbackFromDashboard(base, attacker.cookie, { verifier: "d".repeat(64) });
    expect(guess.res.status).toBe(502);
    expect(guess.location).toBeUndefined();
    // Polling, the old way to collect a sign-in, hands out nothing either, even with the real pending handle.
    const marker = new Sealer(testSecret("b")).open<{ hd: string }>("signin-browser", attacker.cookie.slice(attacker.cookie.indexOf("=") + 1));
    expect(marker?.data.hd).toBeTruthy();
    const poll = (await (await fetch(`${base}/oauth/cometchat/poll?handle=${encodeURIComponent(marker!.data.hd)}`)).json()) as { status: string };
    expect(poll.status).toBe("invalid");
  });

  it("finishes in the browser that started and allowed it, and clears the marker cookie", async () => {
    const s = await startSignIn(base);
    mock.state.authorized = true;
    const done = await callbackFromDashboard(base, s.cookie);
    expect(done.res.status).toBe(302);
    const back = new URL(done.location!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(back.searchParams.get("state")).toBe("st");
    const nonce = String(mock.state.sessionMetadata?.returnUrl).split("/").pop();
    expect(done.setCookie).toContain(`cc_mcp_signin=; Path=/oauth/cometchat/callback/${nonce}; Max-Age=0`);
  });

  it("uses up a sign-in allowed in the wrong browser, so its verifier can't be redeemed later", async () => {
    const s = await startSignIn(base);
    mock.state.authorized = true;
    // The victim's browser gets the 403; the callback URL (with the verifier) stays in its history.
    expect((await callbackFromDashboard(base, undefined)).res.status).toBe(403);
    expect(mock.state.bbUsed).toBe(true);
    // Even the browser that started it can no longer finish with that verifier.
    const late = await callbackFromDashboard(base, s.cookie);
    expect(late.res.status).toBe(502);
    expect(late.location).toBeUndefined();
  });

  it("gives every sign-in its own callback path, and clears its cookie whatever the outcome", async () => {
    const first = await startSignIn(base);
    const firstPath = new URL(String(mock.state.sessionMetadata?.returnUrl)).pathname;
    const second = await startSignIn(base);
    const secondPath = new URL(String(mock.state.sessionMetadata?.returnUrl)).pathname;
    expect(firstPath).not.toBe(secondPath);
    // A callback at one sign-in's path doesn't accept another sign-in's cookie.
    mock.state.authorized = true;
    const crossed = await callbackFromDashboard(base, first.cookie, { path: secondPath });
    expect(crossed.res.status).toBe(403);
    expect(crossed.setCookie).toContain(`cc_mcp_signin=; Path=${secondPath}; Max-Age=0`);
    expect(second.cookie).toBeTruthy();
  });

  it("refuses a callback for a different sign-in than this browser started", async () => {
    const s = await startSignIn(base);
    mock.state.authorized = true;
    const other = await callbackFromDashboard(base, s.cookie, { sessionId: "e".repeat(64) });
    expect(other.res.status).toBe(403);
  });

  it("says so when the user pressed Cancel on the dashboard", async () => {
    const s = await startSignIn(base);
    mock.state.denied = true;
    const done = await callbackFromDashboard(base, s.cookie);
    expect(done.res.status).toBe(403);
    expect(await done.res.text()).toContain("Sign-in cancelled");
  });

  it("rejects malformed callback parameters before calling the dashboard", async () => {
    const before = mock.state.calls.length;
    const bad = await callbackFromDashboard(base, undefined, { sessionId: "sess-1", verifier: BB_VERIFIER });
    expect(bad.res.status).toBe(400);
    expect(mock.state.calls.length).toBe(before);
  });
});

describe("poll flow (the default until mgmt-api#935 and customer-dashboard#2602 ship)", () => {
  it("is the default", () => {
    expect(loadConfig().dashboardSignInFlow).toBe("poll");
  });

  it("still works for a dashboard without the confirmation step, and sends no return URL", async () => {
    const legacy = await start({ dashboardSignInFlow: "poll" });
    const s = await startSignIn(legacy);
    expect(mock.state.sessionMetadata).toEqual({ platform: "mcp" });
    const handle = /var h="([^"]+)"/.exec(s.html)![1]!;
    mock.state.authorized = true;
    const done = (await (await fetch(`${legacy}/oauth/cometchat/poll?handle=${encodeURIComponent(handle)}`, { headers: { cookie: s.cookie } })).json()) as { status: string };
    expect(done.status).toBe("redirect");
  });
});
