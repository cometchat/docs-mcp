import { z } from "zod";
import { SearchInputSchema, fieldErrorFromZod } from "../lib/validation.js";
import { ValidationError } from "../lib/errors.js";
import type { SearchClient } from "../search/types.js";

export const SEARCH_TOOL_NAME = "search_cometchat_docs";

export const SEARCH_TOOL_DEFINITION = {
  name: SEARCH_TOOL_NAME,
  title: "Search CometChat Documentation",
  description:
    "Searches all of CometChat's documentation (SDKs, UI Kits, Calls, REST API, AI agents, notifications, moderation, the no-code widget, UI Kit Builder and more) for the pages covering a topic or API name, and returns ranked snippets with page urls. To read a page in full, pass its url to fetch_cometchat_doc_page; implementation bundles for common setups are listed by list_cometchat_bundles. Pages holding every keyword are favoured, with a fallback to any keyword when none holds them all; no match returns an empty list. Without the version filter, current-version pages are preferred, and each result reports isCurrent plus a version label when the page is versioned; when only older pages hold every keyword (as with a renamed API), current pages missing one keyword can be interleaved with them, for a query of 4 to 8 distinct keywords. Results come from a snapshot of the documentation repository, rebuilt periodically, so a page published since the last rebuild is missing until then; fetch_cometchat_doc_page reads the live site. Over HTTP, requests are rate-limited per client IP, by default 120 per 60 s across the tools, then HTTP 429 with Retry-After; no authentication.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Plain keywords, 1–500 characters; short queries work best. Name the platform or framework when the answer is platform-specific (\"iOS delete message\", \"React UI Kit message list\"); otherwise results span platforms. API names such as markAsRead are searchable. Quotes and operators such as OR have no special meaning. A version written in the query (\"v4\") is matched as a keyword: it favours pages mentioning it but does not restrict results to that version, even when it is the whole query. To get one version's pages, put the label in the version filter instead.",
      },
      version: {
        type: "string",
        description:
          "Version label from the docs version picker, e.g. 'v5' (the leading v is optional). Returns only pages carrying that label, current or older, from every product that uses it, since each SDK and UI Kit numbers its versions independently; unversioned pages such as the REST API are excluded, and a label no page carries returns no results. Omit to search all versions, with current versions preferred.",
      },
      limit: {
        type: "integer",
        description: "Maximum results, from 1 to 25; default 10. There is no offset; totalAvailable counts every match.",
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
              description:
                "Version label of the page's SDK or UI Kit, e.g. 'v7'. Omitted for pages that are not versioned, including the unversioned pages of a retired SDK or UI Kit.",
            },
            isCurrent: {
              type: "boolean",
              description:
                "False when the page documents an older version of its SDK or UI Kit, or one that is no longer listed in the docs navigation (a retired doc set, which may carry no version label).",
            },
          },
          required: ["title", "url", "snippet", "section", "isCurrent"],
          additionalProperties: false,
        },
      },
      totalAvailable: {
        type: "number",
        description:
          "Number of matching pages (may exceed the returned count). For a query of 4 to 8 distinct keywords — common words such as \"how\", \"is\" and \"can\" are not counted — it also counts pages holding all but one of them, and the languages of a page's code examples count as words of that page.",
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
