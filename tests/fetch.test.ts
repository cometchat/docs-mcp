import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFetch } from "../src/tools/fetch.js";
import { NotFoundError, ValidationError, BackendError } from "../src/lib/errors.js";

const opts = { docsBaseUrl: "https://www.cometchat.com/docs", timeoutMs: 2000 };

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

  it("translates 3xx redirect to NotFoundError", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 307 })) as any;
    await expect(runFetch({ path: "/missing/page" }, opts)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("treats docs-homepage payload as NotFoundError", async () => {
    const homepage = [
      "> ## Documentation Index",
      "> Fetch the complete documentation index at: https://www.cometchat.com/docs/llms.txt",
      "> Use this file to discover all available pages before exploring further.",
      "",
      "# Home",
      "> Technical documentation & Implementation guides to add In-app Messaging & Voice & Video Calling to your apps and websites in minutes.",
    ].join("\n");
    globalThis.fetch = vi.fn(async () => new Response(homepage, { status: 200 })) as any;
    await expect(runFetch({ path: "/missing/page" }, opts)).rejects.toBeInstanceOf(NotFoundError);
  });
});
