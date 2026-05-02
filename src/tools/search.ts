import { z } from "zod";
import { SearchInputSchema, fieldErrorFromZod } from "../lib/validation.js";
import { ValidationError } from "../lib/errors.js";
import type { SearchClient } from "../search/types.js";

export const SEARCH_TOOL_NAME = "search_cometchat_docs";

export const SEARCH_TOOL_DEFINITION = {
  name: SEARCH_TOOL_NAME,
  title: "Search CometChat Documentation",
  description:
    "Searches CometChat documentation including SDK guides (JavaScript, React, iOS, Android, Flutter, React Native), UI Kit references, REST API documentation, integration tutorials, and OpenAPI specs. Returns ranked snippets with titles and direct links to source pages. Supports an optional `version` filter to scope results to a specific documentation version.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Search query. 1–500 characters.",
      },
      version: {
        type: "string",
        description: "Optional documentation version filter, e.g. 'v4' or 'v3'.",
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
