// A started sign-in lasts 5 minutes, about as long as MCP clients (Claude Code)
// wait for it. Finishing it later must show "expired", never hand a code to a
// client that has stopped listening.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { DashboardOAuthProvider, POLL_PATH } from "../src/dashboard/oauth.js";
import { BB_SESSION, BB_VERIFIER, startDashboardMock } from "./dashboard-mock.js";
import { testSecret } from "./secrets.js";

const REDIRECT = "http://localhost:7777/callback";
const T0 = new Date("2026-11-11T10:00:00Z").getTime();

let mock: Awaited<ReturnType<typeof startDashboardMock>>;
beforeAll(async () => {
  mock = await startDashboardMock();
});
afterAll(() => mock.close());
afterEach(() => {
  vi.useRealTimers();
  mock.state.authorized = false;
});

/** Just enough of an Express response to capture what authorize() sends. */
function fakeResponse() {
  const out = { status: 0, cookies: [] as string[], body: "" };
  const res = {
    append(name: string, value: string) {
      if (name.toLowerCase() === "set-cookie") out.cookies.push(value);
      return res;
    },
    status(code: number) {
      out.status = code;
      return res;
    },
    type: () => res,
    set: () => res,
    send(body: string) {
      out.body = body;
      return res;
    },
    redirect(_code: number, url: string) {
      out.body = url;
      return res;
    },
  };
  return { res: res as unknown as Response, out };
}

async function startSignIn(signInFlow: "poll" | "confirm" = "poll") {
  // Only Date is faked, so the mock dashboard's sockets and timeouts still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const provider = new DashboardOAuthProvider({
    secret: testSecret("w"),
    apiHost: mock.url,
    dashboardHost: "https://app.cometchat.com",
    issuer: "https://mcp.example.com/",
    signInFlow,
  });
  const client = { client_id: "c1", client_name: "Test tool", redirect_uris: [REDIRECT] } as unknown as OAuthClientInformationFull;
  const { res, out } = fakeResponse();
  await provider.authorize(client, { redirectUri: REDIRECT, codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", scopes: [] }, res);
  expect(out.status).toBe(200);
  const handle = signInFlow === "poll" ? /var h="([^"]+)"/.exec(out.body)?.[1] : "";
  if (signInFlow === "poll") expect(handle).toBeTruthy();
  return { provider, handle: handle!, out };
}

describe("pending sign-in window", () => {
  it("marks the sign-in browser for 5 minutes", async () => {
    const { out } = await startSignIn();
    const signin = out.cookies.find((c) => c.startsWith("cc_mcp_signin="));
    expect(signin).toContain(`Path=${POLL_PATH}`);
    expect(signin).toContain("Max-Age=300;");
  });

  it("is still pending just under 5 minutes", async () => {
    const { provider, handle } = await startSignIn();
    vi.setSystemTime(T0 + 299_000);
    expect(await provider.pollSignIn(handle)).toEqual({ status: "pending" });
  });

  it("finishes if the user signs in just under 5 minutes", async () => {
    const { provider, handle } = await startSignIn();
    vi.setSystemTime(T0 + 299_000);
    mock.state.authorized = true;
    const r = (await provider.pollSignIn(handle)) as { status: string; location: string };
    expect(r.status).toBe("redirect");
    expect(r.location.startsWith(`${REDIRECT}?code=`)).toBe(true);
  });

  it("has expired just over 5 minutes, even if the user then signs in, so no code goes to a client that stopped waiting", async () => {
    const { provider, handle, out } = await startSignIn();
    vi.setSystemTime(T0 + 301_000);
    mock.state.authorized = true;
    expect(await provider.pollSignIn(handle)).toEqual({ status: "invalid" });
    // The sign-in page shows the expired message for that status, not success.
    expect(out.body).toContain('r.status==="expired"||r.status==="invalid"');
    expect(out.body).toContain("This sign-in link has expired.");
  });

  it("browser-bound (callback) sign-ins last 5 minutes too", async () => {
    for (const [at, finishes] of [[299_000, true], [301_000, false]] as const) {
      const { provider, out } = await startSignIn("confirm");
      const cookie = out.cookies.find((c) => c.startsWith("cc_mcp_signin="))!;
      expect(cookie).toContain("Max-Age=300;");
      const nonce = /Path=\/oauth\/cometchat\/callback\/([^;]+)/.exec(cookie)![1]!;
      vi.setSystemTime(T0 + at);
      mock.state.authorized = true;
      const r = await provider.completeBrowserSignIn(nonce, BB_SESSION, BB_VERIFIER, cookie.split(";")[0]);
      expect(r.status).toBe(finishes ? "redirect" : "wrong_browser");
      mock.state.authorized = false;
    }
  });
});
