import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFetch } from "../src/tools/fetch.js";
import { NotFoundError, ValidationError, BackendError } from "../src/lib/errors.js";
import { logger } from "../src/lib/logger.js";

const BASE = "https://www.cometchat.com/docs";
const opts = { docsBaseUrl: BASE, timeoutMs: 2000 };

type Route = { status: number; location?: string; body?: string };

// Serves canned responses keyed by the exact requested URL; anything else 404s.
function mockRoutes(routes: Record<string, Route>) {
  const mock = vi.fn(async (input: unknown) => {
    const route = routes[String(input)];
    if (!route) return new Response("", { status: 404 });
    return new Response(route.body ?? "", {
      status: route.status,
      headers: route.location ? { location: route.location } : undefined,
    });
  });
  globalThis.fetch = mock as any;
  return mock;
}

function requestedUrls(mock: ReturnType<typeof mockRoutes>): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

const HOMEPAGE = [
  "> ## Documentation Index",
  "> Fetch the complete documentation index at: https://www.cometchat.com/docs/llms.txt",
  "> Use this file to discover all available pages before exploring further.",
  "",
  "# Home",
  "> Technical documentation & Implementation guides to add In-app Messaging & Voice & Video Calling to your apps and websites in minutes.",
].join("\n");

describe("runFetch", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects empty path with ValidationError", async () => {
    await expect(runFetch({ path: "" }, opts)).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns parsed page on 200", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("# React Overview\n\nHello docs.", { status: 200 }),
    ) as any;
    const r = await runFetch({ path: "/sdk/javascript/overview" }, opts);
    expect(r.title).toBe("React Overview");
    expect(r.url).toBe("https://www.cometchat.com/docs/sdk/javascript/overview");
    expect(r.section).toBe("SDK / javascript");
    expect(r).not.toHaveProperty("redirectedFrom");
  });

  it("translates 404 to NotFoundError", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as any;
    await expect(runFetch({ path: "/does/not/exist" }, opts)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("translates non-OK 5xx to BackendError", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 502 })) as any;
    await expect(runFetch({ path: "/x" }, opts)).rejects.toBeInstanceOf(BackendError);
  });

  it("strips full URL down to path", async () => {
    globalThis.fetch = vi.fn(async () => new Response("# X\n", { status: 200 })) as any;
    const r = await runFetch(
      { path: "https://www.cometchat.com/docs/ui-kit/react/overview" },
      opts,
    );
    expect(r.url).toBe("https://www.cometchat.com/docs/ui-kit/react/overview");
  });

  it("strips .md/.mdx suffix", async () => {
    globalThis.fetch = vi.fn(async () => new Response("# X\n", { status: 200 })) as any;
    const r = await runFetch({ path: "/sdk/javascript/overview.mdx" }, opts);
    expect(r.url).toBe("https://www.cometchat.com/docs/sdk/javascript/overview");
  });

  it("translates 3xx redirect without a Location to NotFoundError", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 307 })) as any;
    await expect(runFetch({ path: "/missing/page" }, opts)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("treats docs-homepage payload as NotFoundError", async () => {
    globalThis.fetch = vi.fn(async () => new Response(HOMEPAGE, { status: 200 })) as any;
    await expect(runFetch({ path: "/missing/page" }, opts)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("runFetch redirects", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("follows a moved page's 308 and reports the original path", async () => {
    const mock = mockRoutes({
      [`${BASE}/extensions/giphy.md`]: { status: 308, location: "/docs/fundamentals/giphy.md" },
      [`${BASE}/fundamentals/giphy.md`]: { status: 200, body: "# Giphy\n\nSend GIFs in chat." },
    });
    const r = await runFetch({ path: "/extensions/giphy" }, opts);
    expect(r.title).toBe("Giphy");
    expect(r.url).toBe(`${BASE}/fundamentals/giphy`);
    expect(r.section).toBe("Fundamentals / giphy");
    expect(r.redirectedFrom).toBe("/extensions/giphy");
    expect(requestedUrls(mock)).toEqual([`${BASE}/extensions/giphy.md`, `${BASE}/fundamentals/giphy.md`]);
  });

  it("resolves a relative Location against the current request URL", async () => {
    const mock = mockRoutes({
      [`${BASE}/old/page.md`]: { status: 308, location: "/docs/new/section/page.md" },
      [`${BASE}/new/section/page.md`]: { status: 307, location: "../final.md" },
      [`${BASE}/new/final.md`]: { status: 200, body: "# Final\n" },
    });
    const r = await runFetch({ path: "/old/page" }, opts);
    expect(r.url).toBe(`${BASE}/new/final`);
    expect(r.redirectedFrom).toBe("/old/page");
    expect(requestedUrls(mock)).toEqual([
      `${BASE}/old/page.md`,
      `${BASE}/new/section/page.md`,
      `${BASE}/new/final.md`,
    ]);
  });

  it("drops a fragment that Mintlify placed before .md in the Location", async () => {
    const mock = mockRoutes({
      [`${BASE}/sdk/flutter/login-listeners.md`]: {
        status: 307,
        location: "/docs/sdk/flutter/authentication-overview#login-listener.md",
      },
      [`${BASE}/sdk/flutter/authentication-overview.md`]: { status: 200, body: "# Authentication\n" },
    });
    const r = await runFetch({ path: "/sdk/flutter/login-listeners" }, opts);
    expect(r.url).toBe(`${BASE}/sdk/flutter/authentication-overview`);
    expect(r.section).toBe("SDK / flutter");
    expect(r.redirectedFrom).toBe("/sdk/flutter/login-listeners");
    expect(requestedUrls(mock)).toEqual([
      `${BASE}/sdk/flutter/login-listeners.md`,
      `${BASE}/sdk/flutter/authentication-overview.md`,
    ]);
  });

  it("follows a chain of exactly 3 hops", async () => {
    const mock = mockRoutes({
      [`${BASE}/a.md`]: { status: 308, location: "/docs/b.md" },
      [`${BASE}/b.md`]: { status: 307, location: "/docs/c.md" },
      [`${BASE}/c.md`]: { status: 301, location: "/docs/d.md" },
      [`${BASE}/d.md`]: { status: 200, body: "# D\n" },
    });
    const r = await runFetch({ path: "/a" }, opts);
    expect(r.url).toBe(`${BASE}/d`);
    expect(r.redirectedFrom).toBe("/a");
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it("gives up with NotFoundError after more than 3 hops", async () => {
    const mock = mockRoutes({
      [`${BASE}/a.md`]: { status: 308, location: "/docs/b.md" },
      [`${BASE}/b.md`]: { status: 307, location: "/docs/c.md" },
      [`${BASE}/c.md`]: { status: 307, location: "/docs/d.md" },
      [`${BASE}/d.md`]: { status: 307, location: "/docs/e.md" },
      [`${BASE}/e.md`]: { status: 200, body: "# E\n" },
    });
    await expect(runFetch({ path: "/a" }, opts)).rejects.toMatchObject({ name: "NotFoundError", path: "/a" });
    expect(requestedUrls(mock)).not.toContain(`${BASE}/e.md`);
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it.each(["/docs/.md", "/docs/", "/docs", "/docs.md", "https://www.cometchat.com/docs/.md"])(
    "treats a redirect to the docs root (%s) as NotFoundError without following it",
    async (location) => {
      const mock = mockRoutes({
        [`${BASE}/does-not-exist.md`]: { status: 307, location },
        [`${BASE}.md`]: { status: 200, body: HOMEPAGE },
        [`${BASE}/.md`]: { status: 200, body: HOMEPAGE },
      });
      await expect(runFetch({ path: "/does-not-exist" }, opts)).rejects.toMatchObject({
        name: "NotFoundError",
        path: "/does-not-exist",
      });
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "https://assets.cometchat.io/legacy-docs/notifications/push-notification-extension-legacy.html",
    "https://evil.example.com/docs/fundamentals/giphy.md",
    "//evil.example.com/docs/fundamentals/giphy.md",
    "http://www.cometchat.com/docs/fundamentals/giphy.md",
    "/pricing.md",
    "/docs/../pricing.md",
    "/docs-legacy/giphy.md",
  ])("treats a redirect off the docs origin or base path (%s) as NotFoundError", async (location) => {
    const mock = mockRoutes({
      [`${BASE}/extensions/giphy.md`]: { status: 307, location },
    });
    await expect(runFetch({ path: "/extensions/giphy" }, opts)).rejects.toBeInstanceOf(NotFoundError);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("reports the original path when a redirect chain ends in 404", async () => {
    mockRoutes({
      [`${BASE}/extensions/gone.md`]: { status: 308, location: "/docs/fundamentals/gone.md" },
    });
    await expect(runFetch({ path: "/extensions/gone" }, opts)).rejects.toMatchObject({
      name: "NotFoundError",
      path: "/extensions/gone",
    });
  });

  it("still rejects a homepage payload reached through a redirect", async () => {
    mockRoutes({
      [`${BASE}/extensions/giphy.md`]: { status: 308, location: "/docs/fundamentals/giphy.md" },
      [`${BASE}/fundamentals/giphy.md`]: { status: 200, body: HOMEPAGE },
    });
    await expect(runFetch({ path: "/extensions/giphy" }, opts)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("applies one timeout to the whole redirect chain", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(new Response("", { status: 307, headers: { location: "/docs/next.md" } }));
      }
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
      );
    }) as any;
    const started = Date.now();
    await expect(runFetch({ path: "/slow" }, { docsBaseUrl: BASE, timeoutMs: 150 })).rejects.toBeInstanceOf(BackendError);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(calls).toBe(2);
  });

  it("logs a refused off-site redirect but not the ordinary docs-root one", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    try {
      mockRoutes({ [`${BASE}/a.md`]: { status: 307, location: "https://evil.example.com/x.md" } });
      await expect(runFetch({ path: "/a" }, opts)).rejects.toBeInstanceOf(NotFoundError);
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ path: "/a", location: "https://evil.example.com/x.md" }), "fetch_redirect_refused");
      info.mockClear();
      mockRoutes({ [`${BASE}/b.md`]: { status: 307, location: "/docs/.md" } });
      await expect(runFetch({ path: "/b" }, opts)).rejects.toBeInstanceOf(NotFoundError);
      expect(info).not.toHaveBeenCalledWith(expect.anything(), "fetch_redirect_refused");
    } finally {
      info.mockRestore();
    }
  });
});

describe("runFetch path validation", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    "/../pricing",
    "/ui-kit/../../pricing",
    "/%2e%2e/pricing",
    "/%2E%2E/pricing",
    "/.%2e/pricing",
    "..\\pricing",
    "\\..\\pricing",
    "/ui-kit/%2e%2e%2f%2e%2e/pricing",
    "/ui-kit/..%5c..%5cpricing",
    "/docs/../pricing",
    "https://www.cometchat.com/docs/../pricing",
    "https://www.cometchat.com/docs/%2e%2e/pricing",
    "https://www.cometchat.com/docs/x%2f..%2f..%2fpricing",
  ])("rejects %s as resolving outside the docs base path", async (path) => {
    const mock = mockRoutes({});
    await expect(runFetch({ path }, opts)).rejects.toMatchObject({ name: "ValidationError", field: "path" });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example.com/docs/sdk/javascript/overview",
    "https://www.cometchat.com.evil.example.com/docs/sdk/javascript/overview",
    "https://notcometchat.com/docs/sdk/javascript/overview",
    "https://www.cometchat.com:8443/docs/sdk/javascript/overview",
    "ftp://www.cometchat.com/docs/sdk/javascript/overview",
  ])("rejects full URL %s on another origin", async (path) => {
    const mock = mockRoutes({});
    await expect(runFetch({ path }, opts)).rejects.toBeInstanceOf(ValidationError);
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    "https://www.cometchat.com/pricing",
    "https://www.cometchat.com/docs-legacy/sdk/javascript/overview",
    "https://www.cometchat.com/docsx",
  ])("rejects full URL %s on the docs origin but outside /docs", async (path) => {
    const mock = mockRoutes({});
    await expect(runFetch({ path }, opts)).rejects.toBeInstanceOf(ValidationError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects malformed percent-encoding", async () => {
    const mock = mockRoutes({});
    await expect(runFetch({ path: "/sdk/%E0%A4%A" }, opts)).rejects.toBeInstanceOf(ValidationError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects a lone surrogate as invalid input, not an internal error", async () => {
    const mock = mockRoutes({});
    await expect(runFetch({ path: "/sdk/\uD800" }, opts)).rejects.toBeInstanceOf(ValidationError);
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    "https://www.cometchat.com/docs/ui-kit/react/overview",
    "https://www.cometchat.com/docs/ui-kit/react/overview.md",
    "https://www.cometchat.com/docs/ui-kit/react/overview#props",
    "https://WWW.CometChat.com:443/docs/ui-kit/react/overview?ref=search",
    "https://cometchat.com/docs/ui-kit/react/overview",
    "http://www.cometchat.com/docs/ui-kit/react/overview",
    "https://www.cometchat.com/docs/ui-kit/angular/../react/overview",
    "/docs/ui-kit/react/overview",
    "ui-kit/react/overview",
    "/ui-kit/react/./overview/",
    "\\ui-kit\\react\\overview",
    "/ui-kit/%72eact/overview",
    "/ui-kit/react/overview#props",
  ])("accepts %s as a docs page", async (path) => {
    const mock = mockRoutes({
      [`${BASE}/ui-kit/react/overview.md`]: { status: 200, body: "# Overview\n" },
    });
    const r = await runFetch({ path }, opts);
    expect(r.url).toBe(`${BASE}/ui-kit/react/overview`);
    expect(r).not.toHaveProperty("redirectedFrom");
    expect(requestedUrls(mock)).toEqual([`${BASE}/ui-kit/react/overview.md`]);
  });
});
