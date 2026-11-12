// The connecting app's icon on the sign-in page: our icon for a known app
// (by return address, never by name), else its logo_uri (not for unverified
// apps; fetched by the server, guarded), else its initial.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LOGO_FETCHES, cachedClientLogo, clearClientLogoCache, fetchClientLogo, isPublicAddress, knownAppIcon } from "../src/dashboard/client-icon.js";
import { DashboardOAuthProvider } from "../src/dashboard/oauth.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082", "hex");

describe("known apps are matched by where the sign-in returns to", () => {
  it.each([
    ["https://claude.ai/api/mcp/auth_callback", "Claude"],
    ["https://claude.com/api/mcp/auth_callback", "Claude"],
    ["cursor://anysphere.cursor-mcp/oauth/callback", "Cursor"],
    ["windsurf://codeium.windsurf/mcp-callback", "Windsurf"],
    ["zed://mcp/oauth/callback", "Zed"],
  ])("%s → %s", (uri, app) => {
    expect(knownAppIcon(uri)).toMatchObject({ kind: "app", app });
  });

  it.each([
    "https://claude.ai/some/other/page", // only the connector callback
    "https://claude.ai:8443/api/mcp/auth_callback",
    "http://claude.ai/api/mcp/auth_callback",
    "https://evil.example/api/mcp/auth_callback",
    "http://127.0.0.1:5555/callback", // anything local can claim to be Claude Code
    "http://localhost:7777/callback",
  ])("%s → no bundled icon", (uri) => {
    expect(knownAppIcon(uri)).toBeUndefined();
  });
});

describe("logos are only fetched from public addresses", () => {
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s is public", (ip) => expect(isPublicAddress(ip)).toBe(true));
  it.each([
    "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "not-an-ip",
    "::7f00:1", "::ffff:0:7f00:1", "fec0::1", "::ffff:7f00:1", // deprecated IPv4-compatible/-translated, site-local, hex-mapped
  ])("%s is not", (ip) => expect(isPublicAddress(ip)).toBe(false));
});

/** A fake https.get answering with one response; records the pinned address it was asked to connect to. */
function fakeGet(status: number, headers: Record<string, string>, body: Buffer, seen: { lookup?: string; lookupAll?: string; calls: number } = { calls: 0 }) {
  return ((_url: URL, opts: { lookup: (h: string, o: object, cb: (e: null, a: unknown) => void) => void }, onRes: (r: unknown) => void) => {
    seen.calls++;
    // Node calls lookup both ways (all:true is the default with autoSelectFamily).
    opts.lookup("ignored", {}, (_e, a) => (seen.lookup = a as string));
    opts.lookup("ignored", { all: true }, (_e, a) => (seen.lookupAll = (a as Array<{ address: string }>)[0]!.address));
    const req = Object.assign(new EventEmitter(), { destroy: () => undefined });
    const res = Object.assign(new PassThrough(), { statusCode: status, headers });
    setImmediate(() => {
      onRes(res);
      res.end(body);
    });
    return req;
  }) as never;
}
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

describe("fetchClientLogo", () => {
  it("returns a small image as a data: URI, connecting to the address it checked", async () => {
    const seen = { calls: 0 } as { lookup?: string; lookupAll?: string; calls: number };
    const src = await fetchClientLogo("https://tool.example/logo.png", { resolve: publicDns, get: fakeGet(200, { "content-type": "image/png" }, PNG, seen) });
    expect(src).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(seen.lookup).toBe("93.184.216.34");
    expect(seen.lookupAll).toBe("93.184.216.34");
  });

  it.each(["https://[::1]/logo.png", "https://[::ffff:127.0.0.1]/logo.png", "https://[fd00::1]/logo.png", "https://[fe80::1]/logo.png", "https://169.254.169.254/logo.png"])(
    "refuses the IP literal %s without a request",
    async (uri) => {
      const seen = { calls: 0 };
      expect(await fetchClientLogo(uri, { resolve: publicDns, get: fakeGet(200, { "content-type": "image/png" }, PNG, seen) })).toBeUndefined();
      expect(seen.calls).toBe(0);
    },
  );

  it("the time limit includes DNS: a resolver that never answers can't hold the page", async () => {
    const seen = { calls: 0 };
    const started = Date.now();
    const never = () => new Promise<Array<{ address: string; family: number }>>(() => undefined);
    expect(await fetchClientLogo("https://slow.example/logo.png", { resolve: never, timeoutMs: 200, get: fakeGet(200, { "content-type": "image/png" }, PNG, seen) })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen.calls).toBe(0);
  });

  it.each([
    ["http://tool.example/logo.png", "not https"],
    ["https://user:pw@tool.example/logo.png", "credentials"],
    ["https://tool.example:8443/logo.png", "a non-443 port"],
    ["https://10.0.0.5/logo.png", "a private IP"],
    ["not a url", "not a URL"],
  ])("refuses %s (%s) without a request", async (uri) => {
    const seen = { calls: 0 };
    expect(await fetchClientLogo(uri, { resolve: publicDns, get: fakeGet(200, { "content-type": "image/png" }, PNG, seen) })).toBeUndefined();
    expect(seen.calls).toBe(0);
  });

  it("refuses a host that resolves to any private address, without a request", async () => {
    const seen = { calls: 0 };
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }];
    expect(await fetchClientLogo("https://tool.example/logo.png", { resolve, get: fakeGet(200, { "content-type": "image/png" }, PNG, seen) })).toBeUndefined();
    expect(seen.calls).toBe(0);
  });

  it.each<[number, Record<string, string>, Buffer, string]>([
    [302, { "content-type": "image/png", location: "https://10.0.0.1/x.png" }, PNG, "a redirect"],
    [200, { "content-type": "text/html" }, Buffer.from("<html>"), "not an image type"],
    [200, { "content-type": "image/png" }, Buffer.from("GIF89a....."), "bytes that aren't a PNG"],
    [200, { "content-type": "image/png", "content-length": "999999" }, PNG, "a declared size over the limit"],
    [200, { "content-type": "image/png" }, Buffer.concat([PNG, Buffer.alloc(70 * 1024)]), "a body over the limit"],
    [200, { "content-type": "image/png" }, Buffer.alloc(0), "an empty body"],
  ])("refuses a %s response (%s)", async (status, headers, body) => {
    expect(await fetchClientLogo("https://tool.example/logo.png", { resolve: publicDns, get: fakeGet(status, headers, body) })).toBeUndefined();
  });

  it("pages asking for the same logo at once share one fetch", async () => {
    clearClientLogoCache();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = async () => (calls++, await gate, "data:image/png;base64,AAAA");
    const all = Promise.all(Array.from({ length: 5 }, () => cachedClientLogo("https://tool.example/same.png", fetcher)));
    release();
    expect(await all).toEqual(Array(5).fill("data:image/png;base64,AAAA"));
    expect(calls).toBe(1);
  });

  it(`runs at most ${MAX_LOGO_FETCHES} logo fetches at once; beyond that the page shows the initial`, async () => {
    clearClientLogoCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const fetcher = async () => (calls++, await gate, "data:image/png;base64,AAAA");
    const running = Array.from({ length: MAX_LOGO_FETCHES }, (_, i) => cachedClientLogo(`https://tool.example/${i}.png`, fetcher));
    expect(await cachedClientLogo("https://tool.example/one-more.png", fetcher)).toBeUndefined();
    expect(calls).toBe(MAX_LOGO_FETCHES);
    release();
    await Promise.all(running);
  });

  it("caches results, so a sign-in page doesn't refetch the same logo", async () => {
    clearClientLogoCache();
    let calls = 0;
    const fetcher = async () => (calls++, "data:image/png;base64,AAAA");
    await cachedClientLogo("https://tool.example/a.png", fetcher);
    await cachedClientLogo("https://tool.example/a.png", fetcher);
    expect(calls).toBe(1);
  });
});

describe("the sign-in page shows the right icon", () => {
  afterEach(() => clearClientLogoCache());

  async function pageFor(client: Record<string, unknown>, redirectUri: string, fetchLogo?: (u: string) => Promise<string | undefined>, clientLogos?: boolean) {
    const provider = new DashboardOAuthProvider({
      secret: "icon-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
      apiHost: "http://dashboard.test",
      dashboardHost: "https://app.cometchat.com",
      issuer: "https://mcp.example.com/",
      trustedRedirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      ...(fetchLogo ? { fetchLogo } : {}),
      ...(clientLogos !== undefined ? { clientLogos } : {}),
      fetchImpl: (async () => new Response(JSON.stringify({ data: { sessionId: "sess-1" } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    let html = "";
    const res = { append: () => res, status: () => res, type: () => res, set: () => res, send: (b: string) => ((html = b), res), redirect: () => res };
    await provider.authorize({ client_id: "c1", redirect_uris: [redirectUri], ...client } as never, { redirectUri, codeChallenge: "x", scopes: [] }, res as never);
    return html;
  }
  const avatarOf = (html: string) => /<div class="client">(.*?)<div><strong>/s.exec(html)?.[1] ?? "";

  it("a known app gets our icon, whatever logo it sends", async () => {
    let fetched = 0;
    const html = await pageFor({ client_name: "Claude", logo_uri: "https://tool.example/logo.png" }, "https://claude.ai/api/mcp/auth_callback", async () => (fetched++, "data:image/png;base64,AAAA"));
    expect(avatarOf(html)).toContain('class="avatar app" title="Claude"');
    expect(avatarOf(html)).toContain("<svg");
    expect(fetched).toBe(0);
  });

  it("an app that isn't known but isn't unverified gets its own logo", async () => {
    const html = await pageFor({ client_name: "Codex", logo_uri: "https://tool.example/logo.png" }, "http://127.0.0.1:49170/callback", async () => "data:image/png;base64,AAAA");
    expect(avatarOf(html)).toBe('<img class="avatar logo" alt="" src="data:image/png;base64,AAAA">');
  });

  it("an unverified app never gets its logo, even a Claude lookalike", async () => {
    let fetched = 0;
    const html = await pageFor({ client_name: "Claude", logo_uri: "https://tool.example/claude.png" }, "https://evil.example/callback", async () => (fetched++, "data:image/png;base64,AAAA"));
    expect(avatarOf(html)).toBe('<div class="avatar" aria-hidden="true">C</div>');
    expect(fetched).toBe(0);
  });

  it("DASHBOARD_CLIENT_LOGOS=false never fetches and shows the initial", async () => {
    let fetched = 0;
    const html = await pageFor({ client_name: "Codex", logo_uri: "https://tool.example/logo.png" }, "http://127.0.0.1:49170/callback", async () => (fetched++, "data:image/png;base64,AAAA"), false);
    expect(avatarOf(html)).toBe('<div class="avatar" aria-hidden="true">C</div>');
    expect(fetched).toBe(0);
  });

  it("no logo, or one that can't be fetched, shows the initial", async () => {
    expect(avatarOf(await pageFor({ client_name: "Codex" }, "http://127.0.0.1:49170/callback"))).toBe('<div class="avatar" aria-hidden="true">C</div>');
    expect(avatarOf(await pageFor({ client_name: "Codex", logo_uri: "https://tool.example/broken.png" }, "http://127.0.0.1:49170/callback", async () => undefined))).toBe(
      '<div class="avatar" aria-hidden="true">C</div>',
    );
  });
});
