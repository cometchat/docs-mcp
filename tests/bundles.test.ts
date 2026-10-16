import { describe, it, expect, vi } from "vitest";
import { BundleStore } from "../src/bundles/loader.js";
import { BUNDLES } from "../src/bundles/manifest.js";
import { BackendError, NotFoundError } from "../src/lib/errors.js";
import { BUNDLE_MAX_BYTES, byteLength } from "../src/lib/truncate.js";
import { stubBundleStore, stubPage } from "./helpers/bundles.js";

const EXPECTED = [
  "android-uikit-quickstart",
  "angular-uikit-quickstart",
  "flutter-uikit-quickstart",
  "ios-uikit-quickstart",
  "js-sdk-messaging-basics",
  "moderation-setup",
  "multi-tenant-chat",
  "presence-and-typing",
  "react-native-uikit-quickstart",
  "react-uikit-quickstart",
  "widget-embed",
];

describe("bundle manifest", () => {
  it("keeps every published bundle name (agents ask for them by name)", () => {
    expect(BUNDLES.map((b) => b.name).sort()).toEqual(EXPECTED);
  });

  it("gives every bundle a title, framework, prerequisites and at least one page", () => {
    for (const b of BUNDLES) {
      expect(b.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.framework.length).toBeGreaterThan(0);
      expect(b.prerequisites.length).toBeGreaterThan(0);
      expect(b.pages.length).toBeGreaterThan(0);
      for (const p of [...b.pages, ...b.related]) expect(p, `${b.name}: ${p}`).toMatch(/^\/[a-z0-9][a-z0-9/._-]*[a-z0-9]$/);
    }
  });
});

describe("BundleStore", () => {
  it("compiles a bundle from its docs pages, in order, with source URLs", async () => {
    const b = (await stubBundleStore().get("react-uikit-quickstart"))!;
    expect(b).toMatchObject({ name: "react-uikit-quickstart", title: "React UI Kit Quickstart", framework: "react" });
    const first = b.content.indexOf("Source: https://www.cometchat.com/docs/ui-kit/react/integration-react");
    const second = b.content.indexOf("Source: https://www.cometchat.com/docs/ui-kit/react/llms-react-v7");
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    // The llms.txt pointer each .md export starts with is dropped.
    expect(b.content).not.toContain("Documentation Index");
    // Related pages are listed by path.
    expect(b.content).toContain("- `/ui-kit/react/components-overview`");
  });

  it("returns undefined for an unknown bundle without fetching anything", async () => {
    const fetchPage = vi.fn(async (p: string) => stubPage(p));
    expect(await stubBundleStore(fetchPage).get("does-not-exist")).toBeUndefined();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("reuses a compiled bundle until the cache expires, sharing concurrent fetches", async () => {
    let now = 0;
    const fetchPage = vi.fn(async (p: string) => stubPage(p));
    const store = new BundleStore(BUNDLES, fetchPage, { cacheTtlMs: 1000, now: () => now });
    await Promise.all([store.get("ios-uikit-quickstart"), store.get("ios-uikit-quickstart")]);
    const pages = BUNDLES.find((b) => b.name === "ios-uikit-quickstart")!.pages.length;
    expect(fetchPage).toHaveBeenCalledTimes(pages);
    now = 999;
    await store.get("ios-uikit-quickstart");
    expect(fetchPage).toHaveBeenCalledTimes(pages);
    now = 1000;
    await store.get("ios-uikit-quickstart");
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(2 * pages);
  });

  it("keeps serving the last complete bundle while the docs site is down", async () => {
    let now = 0;
    let down = false;
    const fetchPage = vi.fn(async (p: string) => {
      if (down) throw new BackendError();
      return stubPage(p, `v${now}`);
    });
    const store = new BundleStore(BUNDLES, fetchPage, { cacheTtlMs: 1000, now: () => now });
    const first = (await store.get("widget-embed"))!;
    down = true;
    now = 5000;
    expect(await store.get("widget-embed")).toEqual(first);
    await flush();
    expect(await store.get("widget-embed")).toEqual(first);
    await flush();
    // Back up: the next call still answers from the old copy and swaps in the new one.
    down = false;
    now = 6000;
    expect(await store.get("widget-embed")).toEqual(first);
    await flush();
    expect((await store.get("widget-embed"))!.content).toContain("v6000");
  });

  it("does not replace a complete bundle with a rebuild that hit an unavailable page", async () => {
    let now = 0;
    let missing = false;
    const fetchPage = vi.fn(async (p: string) => {
      if (missing && p === "/ui-kit/flutter/llms-flutter-v6") throw new BackendError();
      return stubPage(p);
    });
    const store = new BundleStore(BUNDLES, fetchPage, { cacheTtlMs: 1000, now: () => now });
    const first = (await store.get("flutter-uikit-quickstart"))!;
    missing = true;
    now = 2000;
    await store.get("flutter-uikit-quickstart");
    await flush();
    const after = (await store.get("flutter-uikit-quickstart"))!;
    expect(after).toEqual(first);
    expect(after.content).not.toContain("Could not load right now");
  });

  it("answers from the old copy at once while a slow rebuild runs", async () => {
    let now = 0;
    let release: (() => void) | undefined;
    const fetchPage = vi.fn(async (p: string) => {
      if (now > 0) await new Promise<void>((r) => (release = r));
      return stubPage(p);
    });
    const store = new BundleStore(BUNDLES, fetchPage, { cacheTtlMs: 1000, now: () => now });
    const first = (await store.get("moderation-setup"))!;
    now = 2000;
    // Resolves although the rebuild's page fetch has not.
    const results = await Promise.all([store.get("moderation-setup"), store.get("moderation-setup")]);
    expect(results).toEqual([first, first]);
    expect(fetchPage).toHaveBeenCalledTimes(2); // one initial fetch, one shared rebuild
    release?.();
    await flush();
  });

  it("serves the pages that loaded and names a deleted one, then keeps that bundle for the cache lifetime", async () => {
    const fetchPage = vi.fn(async (p: string) => {
      if (p === "/ui-kit/flutter/llms-flutter-v6") throw new NotFoundError(p);
      return stubPage(p);
    });
    const store = stubBundleStore(fetchPage);
    const b = (await store.get("flutter-uikit-quickstart"))!;
    expect(b.content).toContain("Source: https://www.cometchat.com/docs/ui-kit/flutter/getting-started");
    expect(b.content).toContain("Could not load right now: `/ui-kit/flutter/llms-flutter-v6`");
    // A 404 is what the docs say now, not a passing failure: no refetch storm.
    await store.get("flutter-uikit-quickstart");
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("replaces a cached bundle when one of its pages is deleted, so edits to the other pages still arrive", async () => {
    let now = 0;
    let deleted = false;
    const fetchPage = vi.fn(async (p: string) => {
      if (deleted && p === "/ui-kit/flutter/llms-flutter-v6") throw new NotFoundError(p);
      return stubPage(p, deleted ? "edited" : "");
    });
    const store = new BundleStore(BUNDLES, fetchPage, { cacheTtlMs: 1000, retryBaseMs: 100, now: () => now });
    const before = (await store.get("flutter-uikit-quickstart"))!;
    expect(store.readyCount()).toBe(1);
    deleted = true;
    now = 2000;
    await store.get("flutter-uikit-quickstart");
    await flush();
    // One 404 could be a blip during a docs deploy: the bundle keeps the page.
    expect(await store.get("flutter-uikit-quickstart")).toEqual(before);
    now = 2100; // a second build in a row agrees: the page is gone
    await store.get("flutter-uikit-quickstart");
    await flush();
    const after = (await store.get("flutter-uikit-quickstart"))!;
    expect(after.content).toContain("edited");
    expect(after.content).toContain("Could not load right now: `/ui-kit/flutter/llms-flutter-v6`");
    // Served, but not counted as ready: it's missing a page.
    expect(store.readyCount()).toBe(0);
  });

  it("keeps a page through a one-build 404 blip", async () => {
    let now = 0;
    let blip = false;
    const fetchPage = vi.fn(async (p: string) => {
      if (blip && p === "/ui-kit/flutter/llms-flutter-v6") throw new NotFoundError(p);
      return stubPage(p);
    });
    const store = new BundleStore(BUNDLES, fetchPage, { cacheTtlMs: 1000, retryBaseMs: 100, now: () => now });
    const before = (await store.get("flutter-uikit-quickstart"))!;
    blip = true;
    now = 2000;
    await store.get("flutter-uikit-quickstart");
    await flush();
    blip = false;
    now = 2100;
    await store.get("flutter-uikit-quickstart");
    await flush();
    expect(await store.get("flutter-uikit-quickstart")).toEqual(before);
    expect(store.readyCount()).toBe(1);
  });

  it("backs off instead of rebuilding on every call while a page stays unavailable", async () => {
    let now = 0;
    let down = false;
    const fetchPage = vi.fn(async (p: string) => {
      if (down && p === "/ui-kit/flutter/llms-flutter-v6") throw new BackendError();
      return stubPage(p);
    });
    const store = new BundleStore(BUNDLES, fetchPage, { cacheTtlMs: 60_000, retryBaseMs: 1000, now: () => now });
    await store.get("flutter-uikit-quickstart");
    expect(fetchPage).toHaveBeenCalledTimes(2);
    down = true;
    now = 60_000; // expired: one background rebuild, which fails
    await store.get("flutter-uikit-quickstart");
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(4);
    for (const t of [60_100, 60_500, 60_999]) {
      now = t; // inside the 1 s backoff: no rebuild
      await store.get("flutter-uikit-quickstart");
      await flush();
    }
    expect(fetchPage).toHaveBeenCalledTimes(4);
    now = 61_000; // backoff over: one rebuild, which fails again
    await store.get("flutter-uikit-quickstart");
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(6);
    now = 62_000; // the backoff doubled to 2 s
    await store.get("flutter-uikit-quickstart");
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(6);
    down = false;
    now = 63_000;
    await store.get("flutter-uikit-quickstart");
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(8);
    expect(store.readyCount()).toBe(1);
  });

  it("keeps a cold partial bundle, and a cold failure, for the backoff instead of refetching on every call", async () => {
    let now = 0;
    const fetchPage = vi.fn(async (p: string) => {
      if (p === "/ui-kit/flutter/llms-flutter-v6") throw new BackendError();
      return stubPage(p);
    });
    const store = new BundleStore(BUNDLES, fetchPage, { cacheTtlMs: 60_000, retryBaseMs: 1000, now: () => now });
    const partial = (await store.get("flutter-uikit-quickstart"))!;
    expect(partial.content).toContain("Could not load right now");
    expect(await store.get("flutter-uikit-quickstart")).toBe(partial);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(store.readyCount()).toBe(0);

    const down = vi.fn(async () => {
      throw new BackendError();
    });
    const dead = new BundleStore(BUNDLES, down, { cacheTtlMs: 60_000, retryBaseMs: 1000, now: () => now });
    await expect(dead.get("widget-embed")).rejects.toBeInstanceOf(BackendError);
    await expect(dead.get("widget-embed")).rejects.toBeInstanceOf(BackendError);
    expect(down).toHaveBeenCalledTimes(1);
    now = 1000;
    await expect(dead.get("widget-embed")).rejects.toBeInstanceOf(BackendError);
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("keeps a callout at the top of a page; strips only the llms.txt preamble", async () => {
    const store = stubBundleStore(async (p) => ({
      ...stubPage(p),
      content: `> ## Documentation Index\n> Fetch the complete documentation index at: https://www.cometchat.com/docs/llms.txt\n\n> **Note:** v4 is deprecated.\n\n# ${p}\n`,
    }));
    const b = (await store.get("widget-embed"))!;
    expect(b.content).not.toContain("Documentation Index");
    expect(b.content).toContain("> **Note:** v4 is deprecated.");
    // No preamble (the export changed): a leading callout is page content.
    const bare = stubBundleStore(async (p) => ({ ...stubPage(p), content: `> **Warning:** v4 is end of life.\n\n# ${p}\n` }));
    expect((await bare.get("widget-embed"))!.content).toContain("> **Warning:** v4 is end of life.");
  });

  it("fails with backend_unavailable when no page loads", async () => {
    const store = stubBundleStore(async () => {
      throw new BackendError();
    });
    await expect(store.get("widget-embed")).rejects.toBeInstanceOf(BackendError);
  });

  it("never exceeds the size budget, counting the title, separators and the closing list", async () => {
    // Pages sized so the sections alone fit but the whole bundle wouldn't.
    const filler = "y".repeat(Math.floor(BUNDLE_MAX_BYTES / 3) - 200);
    const store = stubBundleStore(async (p) => ({ ...stubPage(p), content: `# ${p}\n\n${filler}\n` }));
    for (const name of BUNDLES.map((b) => b.name)) {
      const b = (await store.get(name))!;
      expect(byteLength(b.content), name).toBeLessThanOrEqual(BUNDLE_MAX_BYTES);
    }
  });

  it("cuts only a first page that alone is over the budget, and links to the full page", async () => {
    const huge = Array.from({ length: 4000 }, (_, i) => `Paragraph ${i} ${"z".repeat(20)}`).join("\n\n");
    const store = stubBundleStore(async (p) => ({ ...stubPage(p), content: `# ${p}\n\n${huge}\n` }));
    const b = (await store.get("js-sdk-messaging-basics"))!;
    expect(byteLength(b.content)).toBeLessThanOrEqual(BUNDLE_MAX_BYTES);
    expect(b.content).toContain("[Content truncated — full page available at https://www.cometchat.com/docs/sdk/javascript/setup-sdk]");
    expect(b.content).toContain("- `/sdk/javascript/send-message`");
  });

  it("lists pages past the size budget instead of cutting them", async () => {
    const big = "x".repeat(Math.floor(BUNDLE_MAX_BYTES * 0.6));
    const store = stubBundleStore(async (p) => ({ ...stubPage(p), content: `# ${p}\n\n${big}\n` }));
    const b = (await store.get("js-sdk-messaging-basics"))!;
    expect(b.content).toContain("Source: https://www.cometchat.com/docs/sdk/javascript/setup-sdk");
    expect(b.content).not.toContain("Source: https://www.cometchat.com/docs/sdk/javascript/send-message");
    expect(b.content).toContain("- `/sdk/javascript/send-message`");
    expect(b.content).toContain("- `/sdk/javascript/receive-message`");
  });
});

// Lets a background rebuild settle.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}
