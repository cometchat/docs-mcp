import { z } from "zod";
import { BundleInputSchema, fieldErrorFromZod } from "../lib/validation.js";
import { UnknownBundleError, ValidationError } from "../lib/errors.js";
import type { BundleStore } from "../bundles/loader.js";

export const BUNDLE_TOOL_NAME = "get_cometchat_implementation_bundle";

export const BUNDLE_TOOL_DEFINITION = {
  name: BUNDLE_TOOL_NAME,
  title: "Get CometChat Implementation Bundle",
  description:
    "Returns a curated implementation bundle for a named CometChat integration scenario. Each bundle includes prerequisites, install commands, configuration, working code examples, and common pitfalls. Available bundles cover common integration patterns across React, Flutter, iOS, Android, React Native, and the JavaScript SDK.",
  inputSchema: {
    type: "object" as const,
    properties: {
      bundle: {
        type: "string",
        description: "Bundle name in lowercase kebab-case, e.g. 'react-uikit-quickstart'.",
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
      last_verified: { type: "string", description: "Date the bundle was last verified against live SDK versions." },
      content: { type: "string", description: "The full implementation recipe as markdown." },
    },
    required: ["bundle", "title", "framework", "prerequisites", "last_verified", "content"],
    additionalProperties: false,
  },
  annotations: {
    title: "Get CometChat Implementation Bundle",
    readOnlyHint: true,
  },
};

export function runBundle(input: unknown, store: BundleStore) {
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

  const found = store.get(parsed.bundle);
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
