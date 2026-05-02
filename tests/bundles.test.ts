import { describe, it, expect } from "vitest";
import { BundleStore } from "../src/bundles/loader.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlesDir = path.resolve(here, "../bundles");

describe("BundleStore", () => {
  it("loads all v1 bundles from the repo", async () => {
    const store = await BundleStore.load(bundlesDir);
    const names = store.list();
    const expected = [
      "react-uikit-quickstart",
      "react-native-uikit-quickstart",
      "flutter-uikit-quickstart",
      "ios-uikit-quickstart",
      "android-uikit-quickstart",
      "js-sdk-messaging-basics",
      "widget-embed",
      "moderation-setup",
      "multi-tenant-chat",
      "presence-and-typing",
    ];
    for (const e of expected) expect(names).toContain(e);
  });

  it("returns frontmatter fields for each bundle", async () => {
    const store = await BundleStore.load(bundlesDir);
    for (const name of store.list()) {
      const b = store.get(name)!;
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.framework.length).toBeGreaterThan(0);
      expect(Array.isArray(b.prerequisites)).toBe(true);
      expect(b.prerequisites.length).toBeGreaterThan(0);
      expect(/^\d{4}-\d{2}-\d{2}/.test(b.last_verified)).toBe(true);
    }
  });

  it("returns undefined for unknown bundle", async () => {
    const store = await BundleStore.load(bundlesDir);
    expect(store.get("does-not-exist")).toBeUndefined();
  });
});
