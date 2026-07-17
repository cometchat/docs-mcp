import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BundleStore } from "../src/bundles/loader.js";
import {
  LIST_BUNDLES_TOOL_DEFINITION,
  runListBundles,
} from "../src/tools/list-bundles.js";
import { SEARCH_TOOL_DEFINITION } from "../src/tools/search.js";
import { FETCH_TOOL_DEFINITION } from "../src/tools/fetch.js";
import { BUNDLE_TOOL_DEFINITION } from "../src/tools/bundle.js";

const bundlesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bundles",
);

describe("list_cometchat_bundles", () => {
  it("returns every bundle with summary fields, sorted by identifier", async () => {
    const store = await BundleStore.load(bundlesDir);
    const result = runListBundles(store);
    expect(result.total).toBe(store.list().length);
    expect(result.total).toBeGreaterThanOrEqual(10);
    const ids = result.bundles.map((b) => b.bundle);
    expect(ids).toEqual([...ids].sort());
    for (const b of result.bundles) {
      expect(b.bundle).toBeTruthy();
      expect(b.title).toBeTruthy();
      expect(b.framework).toBeTruthy();
      expect(b.last_verified).toBeTruthy();
      expect(b).not.toHaveProperty("content");
    }
  });

  it("takes no arguments", () => {
    expect(LIST_BUNDLES_TOOL_DEFINITION.inputSchema.properties).toEqual({});
  });
});

describe("output schemas", () => {
  it("every tool declares an object outputSchema with required fields", () => {
    for (const def of [
      SEARCH_TOOL_DEFINITION,
      FETCH_TOOL_DEFINITION,
      BUNDLE_TOOL_DEFINITION,
      LIST_BUNDLES_TOOL_DEFINITION,
    ]) {
      expect(def.outputSchema).toBeDefined();
      expect(def.outputSchema.type).toBe("object");
      expect(def.outputSchema.required.length).toBeGreaterThan(0);
      expect(def.outputSchema.additionalProperties).toBe(false);
    }
  });
});
