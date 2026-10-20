import { z } from "zod";
import { BundleInputSchema, fieldErrorFromZod } from "../lib/validation.js";
import { UnknownBundleError, ValidationError } from "../lib/errors.js";
import type { BundleStore } from "../bundles/loader.js";

export const BUNDLE_TOOL_NAME = "get_cometchat_implementation_bundle";

export const BUNDLE_TOOL_DEFINITION = {
  name: BUNDLE_TOOL_NAME,
  title: "Get CometChat Implementation Bundle",
  description:
    "Returns one CometChat implementation bundle: the scenario's current documentation pages (for a UI Kit: its integration guide, then the platform's AI reference page) compiled into one markdown document, each headed by its source URL, plus paths of related pages, prerequisites and a last_verified date. Bundles cover UI Kit quickstarts (React, Angular, React Native, Flutter, iOS, Android), JavaScript SDK messaging, the no-code widget, moderation setup, multi-tenant chat, and presence and typing. Identifiers come from list_cometchat_bundles; a well-formed identifier that names no bundle returns an unknown_bundle error listing the valid ones, and any other value invalid_input. For topics no bundle covers, search_cometchat_docs searches the documentation. Pages are read from the live docs site and cached for a few minutes; when they cannot be loaded the call returns backend_unavailable.",
  inputSchema: {
    type: "object" as const,
    properties: {
      bundle: {
        type: "string",
        description:
          "Bundle identifier as list_cometchat_bundles returns it, e.g. 'react-uikit-quickstart': lowercase letters, digits and hyphens, up to 100 characters.",
      },
    },
    required: ["bundle"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      bundle: { type: "string", description: "Bundle identifier." },
      title: { type: "string", description: "Human-readable bundle title." },
      framework: { type: "string", description: "Target framework/platform." },
      prerequisites: { type: "array", items: { type: "string" }, description: "Prerequisites before applying the bundle." },
      last_verified: { type: "string", description: "Date this bundle's list of documentation pages was last reviewed. The content is read from the live documentation on each call." },
      content: { type: "string", description: "The bundle's documentation pages as markdown, each headed by its source URL." },
    },
    required: ["bundle", "title", "framework", "prerequisites", "last_verified", "content"],
    additionalProperties: false,
  },
  annotations: {
    title: "Get CometChat Implementation Bundle",
    readOnlyHint: true,
  },
};

export async function runBundle(input: unknown, store: BundleStore) {
  let parsed;
  try {
    parsed = BundleInputSchema.parse(input);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const f = fieldErrorFromZod(err);
      throw new ValidationError(f.field, f.reason);
    }
    throw err;
  }

  const found = await store.get(parsed.bundle);
  if (!found) {
    throw new UnknownBundleError(parsed.bundle, store.list());
  }
  return {
    bundle: found.name,
    title: found.title,
    framework: found.framework,
    prerequisites: found.prerequisites,
    last_verified: found.last_verified,
    content: found.content,
  };
}
