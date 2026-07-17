import { describe, it, expect } from "vitest";
import {
  LIST_BUNDLES_TOOL_DEFINITION,
} from "../src/tools/list-bundles.js";
import {
  SEARCH_TOOL_DEFINITION,
  runSearch,
} from "../src/tools/search.js";
import {
  BUNDLE_TOOL_DEFINITION,
  runBundle,
} from "../src/tools/bundle.js";
import { FETCH_TOOL_DEFINITION } from "../src/tools/fetch.js";
import { BundleStore } from "../src/bundles/loader.js";
import {
  ValidationError,
  UnknownBundleError,
} from "../src/lib/errors.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlesDir = path.resolve(here, "../bundles");

describe("tool definitions", () => {
  it("expose title + readOnlyHint annotations", () => {
    for (const t of [SEARCH_TOOL_DEFINITION, FETCH_TOOL_DEFINITION, BUNDLE_TOOL_DEFINITION, LIST_BUNDLES_TOOL_DEFINITION]) {
      expect(t.annotations.title.length).toBeGreaterThan(0);
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.name.length).toBeLessThanOrEqual(64);
    }
  });

  it("descriptions do not contain prompt-injection patterns", () => {
    const banlist = [
      /use this tool when/i,
      /always prefer/i,
      /workflow:/i,
      /first call/i,
      /after .* call/i,
      /if you need/i,
    ];
    for (const t of [SEARCH_TOOL_DEFINITION, FETCH_TOOL_DEFINITION, BUNDLE_TOOL_DEFINITION, LIST_BUNDLES_TOOL_DEFINITION]) {
      for (const re of banlist) {
        expect(t.description).not.toMatch(re);
      }
    }
  });
});

describe("runSearch input validation", () => {
  const stubClient = {
    async search() {
      return { results: [], totalAvailable: 0 };
    },
  };

  it("rejects missing query with ValidationError", async () => {
    await expect(runSearch({}, stubClient)).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns empty result set without throwing", async () => {
    const r = await runSearch({ query: "anything" }, stubClient);
    expect(r.results).toEqual([]);
    expect(r.totalAvailable).toBe(0);
  });
});

describe("runBundle", () => {
  it("returns the bundle for a known name", async () => {
    const store = await BundleStore.load(bundlesDir);
    const r = runBundle({ bundle: "react-uikit-quickstart" }, store);
    expect(r.bundle).toBe("react-uikit-quickstart");
    expect(r.framework).toBe("react");
    expect(r.content.length).toBeGreaterThan(100);
  });

  it("throws UnknownBundleError listing all available bundles", async () => {
    const store = await BundleStore.load(bundlesDir);
    try {
      runBundle({ bundle: "does-not-exist" }, store);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownBundleError);
      const e = err as UnknownBundleError;
      expect(e.available.length).toBeGreaterThanOrEqual(10);
    }
  });

  it("rejects malformed bundle name", async () => {
    const store = await BundleStore.load(bundlesDir);
    expect(() => runBundle({ bundle: "Bad Name!" }, store)).toThrow(ValidationError);
  });
});
