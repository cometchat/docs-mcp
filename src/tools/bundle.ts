import { z } from "zod";
import { BundleInputSchema, fieldErrorFromZod } from "../lib/validation.js";
import { UnknownBundleError, ValidationError } from "../lib/errors.js";
import type { BundleStore } from "../bundles/loader.js";

export const BUNDLE_TOOL_NAME = "get_cometchat_implementation_bundle";

export const BUNDLE_TOOL_DEFINITION = {
  name: BUNDLE_TOOL_NAME,
  title: "Get a CometChat Implementation Bundle",
  description:
    "Returns one CometChat implementation bundle: the scenario's current documentation pages (for a UI Kit, its integration guide, then the platform's AI reference page) compiled into one markdown document, each headed by its source URL, plus paths of related pages, the prerequisites, and a last_verified date.\n\n" +
    "Eleven bundles cover UI Kit quickstarts (React, Angular, React Native, Flutter, iOS, Android), JavaScript SDK messaging, the no-code widget, moderation setup, multi-tenant chat, and presence and typing. list_cometchat_bundles names them all; for a topic no bundle covers, or for one reference page rather than a setup's pages, search_cometchat_docs searches the documentation.\n\n" +
    "bundle is an identifier, not a title and not a framework: 'react-uikit-quickstart', rather than 'React UI Kit' or 'react'. One that is well-formed but names no bundle returns unknown_bundle listing every valid one; anything else, invalid_input. Pages are included whole, in order, while the document fits in 60 KiB; a page that does not fit is listed by path under More pages rather than cut, except a first page too big on its own, which is cut at a paragraph and ends with a link to the full page. Pages are read from the live docs site; no key or account is needed. A built bundle is served for 10 minutes, then refreshed in the background. A page that cannot be loaded does not fail the call: the previous bundle, or a partial one naming the pages it lacks, is served instead, and backend_unavailable is returned only when no page loads and nothing is cached yet.",
  inputSchema: {
    type: "object" as const,
    properties: {
      bundle: {
        type: "string",
        description:
          "Bundle identifier as list_cometchat_bundles returns it, e.g. 'react-uikit-quickstart': lowercase letters, digits and hyphens, opening with a letter or digit, up to 100 characters.",
      },
    },
    required: ["bundle"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      bundle: { type: "string", description: "Bundle identifier, as passed in." },
      title: { type: "string", description: "Human-readable bundle title." },
      framework: {
        type: "string",
        description: "Framework or platform the bundle targets; 'any' when platform-neutral.",
      },
      prerequisites: {
        type: "array",
        items: { type: "string" },
        description: "What must be in place before following the bundle's pages, such as a runtime version or CometChat app credentials.",
      },
      last_verified: {
        type: "string",
        description:
          "ISO date this bundle's list of documentation pages was last reviewed. The page content itself is read from the live documentation.",
      },
      content: {
        type: "string",
        description:
          "The bundle's documentation pages as markdown, each headed by its source URL, followed by the paths of related pages and of any page that did not fit or could not be loaded.",
      },
    },
    required: ["bundle", "title", "framework", "prerequisites", "last_verified", "content"],
    additionalProperties: false,
  },
  annotations: {
    title: "Get a CometChat Implementation Bundle",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
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
