import { describe, expect, it } from "vitest";
import { DashboardClient } from "../src/dashboard/client.js";
import { DashboardUnavailableError } from "../src/lib/errors.js";

// A fetch that never answers until its abort signal fires; records each call's method.
function hangingFetch(calls: string[]) {
  return (async (_url: string, init?: RequestInit) => {
    calls.push(String(init?.method));
    await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    throw new Error("unreachable");
  }) as unknown as typeof fetch;
}

describe("dashboard client timeouts", () => {
  it("tells the agent a timed-out change may have been made, so it checks before retrying", async () => {
    const calls: string[] = [];
    const c = new DashboardClient({ apiHost: "http://x", token: "t", timeoutMs: 20, fetchImpl: hangingFetch(calls) });
    const err = await c.request("POST", "/apps/a/roles", { role: "r" }).catch((e) => e);
    expect(err).toBeInstanceOf(DashboardUnavailableError);
    expect((err as Error).message).toContain("The change may still have been made");
    expect(calls).toEqual(["POST"]); // writes are never retried
  });

  it("keeps the plain retry message for reads", async () => {
    const calls: string[] = [];
    const c = new DashboardClient({ apiHost: "http://x", token: "t", timeoutMs: 20, fetchImpl: hangingFetch(calls) });
    const err = await c.request("GET", "/apps").catch((e) => e);
    expect((err as Error).message).toBe("The CometChat dashboard API is unreachable. Retry shortly.");
    expect(calls).toEqual(["GET", "GET"]);
  });

  it("gives app creation longer than the default timeout", async () => {
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      // The Auth Key comes from the new app's API keys, a normal (fast) call.
      if (new URL(String(url)).pathname === "/apps/new1") return json({ appId: "new1", region: "us", version: "3" });
      if (String(url).endsWith("/apps/new1/chat-api/v3.0/apikeys?per_page=100&page=1")) return json([{ apiKey: "k", scope: "authOnly", createdAt: 1 }]);
      await new Promise((r) => setTimeout(r, 60)); // slower than the 20 ms default below
      if (init?.signal?.aborted) throw new Error("aborted");
      return json({ appId: "new1", region: "us" });
    }) as unknown as typeof fetch;
    const c = new DashboardClient({ apiHost: "http://x", token: "t", timeoutMs: 20, fetchImpl });
    await expect(c.createApp({ name: "n", region: "us" })).resolves.toEqual({ appId: "new1", region: "us", authKey: "k" });
  });
});
