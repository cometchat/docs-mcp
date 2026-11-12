// An authorization code works once (OAuth 2.1), for its whole life, including
// its last second: seal.ts still opens a code when exp == now (review of PR #35).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { DashboardOAuthProvider, MAX_REDEEMED_CODES } from "../src/dashboard/oauth.js";

const SECRET = "code-once-test-secret-0123456789-abcdefghijklmnopqrstuv";
const client = { client_id: "client-1", redirect_uris: ["http://127.0.0.1:5555/cb"] } as OAuthClientInformationFull;

function setup() {
  const provider = new DashboardOAuthProvider({ secret: SECRET, apiHost: "https://api.example.com", dashboardHost: "https://app.example.com" });
  const grant = { dt: "dash-token", cid: client.client_id, ru: client.redirect_uris[0], sc: ["dashboard:read"], ci: "code-id-1" };
  return { provider, code: provider.sealer.seal("code", grant, 60) };
}

describe("authorization code expiry boundary", () => {
  afterEach(() => vi.useRealTimers());

  it("refuses a replay in the code's last second", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 10, 12, 12, 0, 0);
    vi.setSystemTime(start);
    const { provider, code } = setup();
    await expect(provider.exchangeAuthorizationCode(client, code)).resolves.toHaveProperty("access_token");
    vi.setSystemTime(start + 60_500); // now == exp: the code still opens
    await expect(provider.challengeForAuthorizationCode(client, code)).resolves.toBe("");
    // Another sign-in finishing in this same second prunes the redeemed list;
    // the used code's entry must survive that pass.
    const other = provider.sealer.seal("code", { dt: "dash-token", cid: client.client_id, sc: ["dashboard:read"], ci: "code-id-9" }, 60);
    await provider.exchangeAuthorizationCode(client, other);
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/already used/);
    vi.setSystemTime(start + 61_500); // past exp: refused as expired
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/Invalid or expired/);
  });

  it("each code is its own: a second code from the same sign-in still works", async () => {
    const { provider, code } = setup();
    const other = provider.sealer.seal("code", { dt: "dash-token", cid: client.client_id, sc: ["dashboard:read"], ci: "code-id-2" }, 60);
    await provider.exchangeAuthorizationCode(client, code);
    await expect(provider.exchangeAuthorizationCode(client, other)).resolves.toHaveProperty("access_token");
  });
});

describe("single-use codes: edges", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("two sign-ins finishing in the same second get codes that each work once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 12, 12, 0, 0));
    const { provider } = setup();
    type Finish = (p: object, r: object) => Promise<{ location: string }>;
    const finish = (provider as unknown as { finishSignIn: Finish }).finishSignIn.bind(provider);
    const pending = { sid: "s", cid: client.client_id, ru: client.redirect_uris[0], cc: "challenge", sc: ["dashboard:read"] };
    const result = { status: "authorized", token: "dash-token", email: "dev@example.com" };
    const codeOf = async () => new URL((await finish(pending, result)).location).searchParams.get("code")!;
    const [a, b] = [await codeOf(), await codeOf()]; // same user, same client, same second
    await expect(provider.exchangeAuthorizationCode(client, a)).resolves.toHaveProperty("access_token");
    await expect(provider.exchangeAuthorizationCode(client, b)).resolves.toHaveProperty("access_token");
    await expect(provider.exchangeAuthorizationCode(client, b)).rejects.toThrow(/already used/);
  });

  it("a wrong client or redirect_uri doesn't use the code up", async () => {
    const { provider, code } = setup();
    const stranger = { ...client, client_id: "client-2" } as OAuthClientInformationFull;
    await expect(provider.exchangeAuthorizationCode(stranger, code)).rejects.toThrow(/Invalid or expired/);
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, "http://127.0.0.1:6666/cb")).rejects.toThrow(/redirect_uri/);
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0])).resolves.toHaveProperty("access_token");
  });

  it("refuses a replay when the clock ticks past exp between opening the code and the check", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 10, 12, 12, 0, 0);
    vi.setSystemTime(start);
    const { provider, code } = setup();
    await provider.exchangeAuthorizationCode(client, code);
    vi.setSystemTime(start + 60_999); // now == exp when the code opens…
    const realNow = Date.now;
    let calls = 0;
    // …and exp + 1 by the time the redeemed list is checked.
    vi.spyOn(Date, "now").mockImplementation(() => (++calls > 1 ? start + 61_000 : realNow()));
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/already used/);
  });

  it("lets only one of many concurrent exchanges of a code through", async () => {
    const { provider, code } = setup();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => provider.exchangeAuthorizationCode(client, code)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("keeps the code id out of the access and refresh tokens", async () => {
    const { provider, code } = setup();
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    for (const [kind, value] of [["access", tokens.access_token], ["refresh", tokens.refresh_token!]] as const) {
      const opened = provider.sealer.open<Record<string, unknown>>(kind, value);
      expect(opened?.data).toBeDefined();
      expect(opened!.data).not.toHaveProperty("ci");
    }
  });

  it("still makes a code without an id (issued before this change) single-use", async () => {
    const provider = new DashboardOAuthProvider({ secret: SECRET, apiHost: "https://api.example.com", dashboardHost: "https://app.example.com" });
    const legacy = provider.sealer.seal("code", { dt: "dash-token", cid: client.client_id, sc: ["dashboard:read"] }, 60);
    await provider.exchangeAuthorizationCode(client, legacy);
    await expect(provider.exchangeAuthorizationCode(client, legacy)).rejects.toThrow(/already used/);
  });

  it("when the list is full, forgets only the oldest code", async () => {
    const { provider, code } = setup();
    const redeemed = (provider as unknown as { redeemed: Map<string, number> }).redeemed;
    const until = Math.floor(Date.now() / 1000) + 3600;
    for (let i = 0; i < MAX_REDEEMED_CODES - 1; i++) redeemed.set(`filler-${i}`, until);
    await provider.exchangeAuthorizationCode(client, code); // the list is now full
    const other = provider.sealer.seal("code", { dt: "dash-token", cid: client.client_id, sc: ["dashboard:read"], ci: "code-id-3" }, 60);
    await provider.exchangeAuthorizationCode(client, other); // over the cap: the oldest filler goes
    expect(redeemed.size).toBeLessThanOrEqual(MAX_REDEEMED_CODES);
    expect(redeemed.has("filler-0")).toBe(false);
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/already used/);
    await expect(provider.exchangeAuthorizationCode(client, other)).rejects.toThrow(/already used/);
  });
});
