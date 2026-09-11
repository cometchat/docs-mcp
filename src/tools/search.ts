import { z } from "zod";
import { SearchInputSchema, fieldErrorFromZod } from "../lib/validation.js";
import { ValidationError } from "../lib/errors.js";
import type { SearchClient } from "../search/types.js";

export const SEARCH_TOOL_NAME = "search_cometchat_docs";

export const SEARCH_TOOL_DEFINITION = {
  name: SEARCH_TOOL_NAME,
  title: "Search CometChat Documentation",
  description:
    "Searches CometChat documentation including SDK guides (JavaScript, React, iOS, Android, Flutter, React Native), UI Kit references, REST API documentation, integration tutorials, and OpenAPI specs. Returns ranked snippets with titles and direct links to source pages. Pages for the current version of each SDK and UI Kit are preferred over older versions, and each result reports its version label and whether it is current. To reach older docs, pass the `version` filter with that version's label.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Search query. 1–500 characters.",
      },
      version: {
        type: "string",
        description:
          "Optional version label from the docs version picker, e.g. 'v7' or 'v5'. Each SDK and UI Kit numbers its versions independently, so a label matches every product that uses it. Omit to search all versions, with current versions preferred.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return. Default 10, maximum 25.",
        minimum: 1,
        maximum: 25,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      results: {
        type: "array",
        description: "Ranked search results.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Page title." },
            url: { type: "string", description: "Direct link to the source page." },
            snippet: { type: "string", description: "Matched excerpt with context." },
            section: { type: "string", description: "Documentation section the page belongs to." },
            version: {
              type: "string",
              description: "Version label of the page's SDK or UI Kit, e.g. 'v7'. Omitted for pages that are not versioned.",
            },
            isCurrent: {
              type: "boolean",
              description: "False when the page documents an older version of its SDK or UI Kit.",
            },
          },
          required: ["title", "url", "snippet", "section", "isCurrent"],
          additionalProperties: false,
        },
      },
      totalAvailable: {
        type: "number",
        description: "Total matching pages available (may exceed the returned count).",
      },
    },
    required: ["results", "totalAvailable"],
    additionalProperties: false,
  },
  annotations: {
    title: "Search CometChat Documentation",
    readOnlyHint: true,
  },
};

export async function runSearch(input: unknown, client: SearchClient) {
  let parsed;
  try {
    parsed = SearchInputSchema.parse(input);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const f = fieldErrorFromZod(err);
      throw new ValidationError(f.field, f.reason);
    }
    throw err;
  }

  const response = await client.search(parsed.query, {
    version: parsed.version,
    limit: parsed.limit,
  });

  return response;
}
