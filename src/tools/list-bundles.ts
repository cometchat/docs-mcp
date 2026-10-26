import type { BundleStore } from "../bundles/loader.js";
import { BUNDLES_REVIEWED } from "../bundles/manifest.js";

export const LIST_BUNDLES_TOOL_NAME = "list_cometchat_bundles";

export const LIST_BUNDLES_TOOL_DEFINITION = {
  name: LIST_BUNDLES_TOOL_NAME,
  title: "List CometChat Implementation Bundles",
  description:
    "Lists every CometChat implementation bundle: the setup scenarios whose current docs pages get_cometchat_implementation_bundle compiles by identifier, with each one's title, framework ('any' when platform-neutral) and last_verified date.\n\n" +
    "No parameters are required: one call returns the complete set, ordered by identifier, with no filter, paging or cap. The set is fixed at startup, since only page content is read from the docs site; the listing itself opens no connection and needs no key or account, so repeat calls return the same bundles.\n\n" +
    "For a topic no bundle covers, or for one reference page rather than a setup's pages, search_cometchat_docs searches the documentation.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      bundles: {
        type: "array",
        description: "Every bundle, ordered by identifier.",
        items: {
          type: "object",
          properties: {
            bundle: { type: "string", description: "Bundle identifier to pass to get_cometchat_implementation_bundle." },
            title: { type: "string", description: "Human-readable bundle title." },
            framework: {
              type: "string",
              description: "One of android, angular, any, flutter, ios, javascript, react, react-native, or widget.",
            },
            last_verified: { type: "string", description: "ISO date this bundle's list of documentation pages was last reviewed." },
          },
          required: ["bundle", "title", "framework", "last_verified"],
          additionalProperties: false,
        },
      },
      total: { type: "number", description: "Number of bundles." },
    },
    required: ["bundles", "total"],
    additionalProperties: false,
  },
  annotations: {
    title: "List CometChat Implementation Bundles",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

export function runListBundles(store: BundleStore) {
  const bundles = store
    .list()
    .map((name) => {
      const b = store.spec(name);
      if (!b) return undefined;
      return {
        bundle: b.name,
        title: b.title,
        framework: b.framework,
        last_verified: BUNDLES_REVIEWED,
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== undefined)
    .sort((a, b) => a.bundle.localeCompare(b.bundle));
  return { bundles, total: bundles.length };
}
