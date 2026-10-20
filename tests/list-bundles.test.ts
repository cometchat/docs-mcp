import { describe, expect, it } from "vitest";
import { stubBundleStore } from "./helpers/bundles.js";
import {
  LIST_BUNDLES_TOOL_DEFINITION,
  runListBundles,
} from "../src/tools/list-bundles.js";
import { SEARCH_TOOL_DEFINITION } from "../src/tools/search.js";
import { FETCH_TOOL_DEFINITION } from "../src/tools/fetch.js";
import { BUNDLE_TOOL_DEFINITION } from "../src/tools/bundle.js";

describe("list_cometchat_bundles", () => {
  it("returns every bundle with summary fields, sorted by identifier", async () => {
    const store = stubBundleStore();
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

  // get_cometchat_implementation_bundle's description enumerates the bundles by
  // hand. Tie the list to the store: a bundle added or removed, or a word
  // dropped from the sentence, fails here rather than in a directory review.
  const NAMED_IN_BUNDLE_DESCRIPTION: Record<string, string> = {
    "angular-uikit-quickstart": "Angular",
    "android-uikit-quickstart": "Android",
    "flutter-uikit-quickstart": "Flutter",
    "ios-uikit-quickstart": "iOS",
    "js-sdk-messaging-basics": "JavaScript SDK messaging",
    "moderation-setup": "moderation setup",
    "multi-tenant-chat": "multi-tenant chat",
    "presence-and-typing": "presence and typing",
    "react-native-uikit-quickstart": "React Native",
    "react-uikit-quickstart": "React",
    "widget-embed": "widget",
  };

  it("is described by a sentence naming every bundle the store holds, and no other", async () => {
    const store = stubBundleStore();
    expect(Object.keys(NAMED_IN_BUNDLE_DESCRIPTION).sort()).toEqual(store.list());
    for (const [id, words] of Object.entries(NAMED_IN_BUNDLE_DESCRIPTION)) {
      expect(BUNDLE_TOOL_DEFINITION.description, id).toContain(words);
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
