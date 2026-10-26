import { z } from "zod";
import { SearchInputSchema, fieldErrorFromZod } from "../lib/validation.js";
import { ValidationError } from "../lib/errors.js";
import type { SearchClient } from "../search/types.js";

export const SEARCH_TOOL_NAME = "search_cometchat_docs";

export const SEARCH_TOOL_DEFINITION = {
  name: SEARCH_TOOL_NAME,
  title: "Search CometChat Documentation",
  description:
    "Searches all of CometChat's documentation (SDKs, UI Kits, Calls, REST API, AI agents, notifications, moderation, the no-code widget, UI Kit Builder and more) for the pages covering a topic or API name, and returns ranked excerpts with each page's url.\n\n" +
    "When a page's url or path is already in hand, fetch_cometchat_doc_page returns that page in full; for a common setup scenario (a UI Kit quickstart, SDK messaging, the widget, moderation), list_cometchat_bundles names the implementation bundles, each the scenario's current docs pages compiled into one document.\n\n" +
    "Pages holding every keyword rank first, falling back to any keyword when no page holds them all; no match is an empty results list, not an error. For a query of 4 to 8 distinct keywords, pages missing one incidental keyword join the ranking at half weight, which is how an API renamed between versions is still found; a platform or language word is never the one dropped. Without the version filter, current-version pages lead, and each result reports isCurrent plus a version label when the page is versioned; the filter restricts results to pages carrying that label, so unversioned pages such as the REST API reference are excluded. limit caps the rows returned, never the totalAvailable count, and there is no offset.\n\n" +
    "Results come from a snapshot of the documentation repository, rebuilt periodically, so a page published since the last rebuild is missing until then; fetch_cometchat_doc_page reads the live site. Errors: invalid_input for a malformed argument, backend_unavailable when the index cannot be read. Over HTTP, every MCP request counts against one per-client-IP limit, initialize and tools/list included, by default 120 per 60 s, then HTTP 429 with Retry-After; no authentication.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Plain keywords, 1–500 characters; short queries work best. Name the platform or framework when the answer is platform-specific (\"iOS delete message\", \"React UI Kit message list\"); otherwise results span platforms. API names such as markAsRead are searchable, as are the languages of a page's code examples. Quotes and operators such as OR have no special meaning, and common words such as \"how\", \"is\" and \"can\" are not counted as keywords. A version written in the query (\"v4\") is matched as a keyword: it favours pages mentioning it but does not restrict results to that version, even when it is the whole query. To get one version's pages, put the label in the version filter instead.",
      },
      version: {
        type: "string",
        description:
          "Version label from the docs version picker, e.g. 'v5'. The leading v is optional and case does not matter, so V7, 7 and v7.0 all name v7. Each SDK and UI Kit numbers its versions independently, so one label spans every product that uses it. A label no page carries returns no results rather than an error.",
      },
      limit: {
        type: "integer",
        description: "Maximum results, from 1 to 25; default 10.",
        minimum: 1,
        maximum: 25,
        default: 10,
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
        description: "Matching pages, best first.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Page title." },
            url: {
              type: "string",
              description: "Absolute page url, accepted as-is by fetch_cometchat_doc_page.",
            },
            snippet: { type: "string", description: "Matched excerpt with context, up to 300 characters." },
            section: {
              type: "string",
              description: "Documentation section the page belongs to, e.g. 'UI Kit / React'.",
            },
            version: {
              type: "string",
              description:
                "Version label of the page's SDK or UI Kit, e.g. 'v7'. Absent on a page that carries no version, including the pages of a retired SDK or UI Kit.",
            },
            isCurrent: {
              type: "boolean",
              description:
                "False when the page documents an older version of its SDK or UI Kit, or a doc set retired from the docs navigation, which may carry no version label.",
            },
          },
          required: ["title", "url", "snippet", "section", "isCurrent"],
          additionalProperties: false,
        },
      },
      totalAvailable: {
        type: "number",
        description:
          "Number of matching pages, which can exceed the rows returned. For a query of 4 to 8 distinct keywords it also counts the pages holding all but one of them.",
      },
    },
    required: ["results", "totalAvailable"],
    additionalProperties: false,
  },
  annotations: {
    title: "Search CometChat Documentation",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
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
