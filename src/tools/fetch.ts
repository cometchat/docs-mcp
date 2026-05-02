import { z } from "zod";
import { FetchInputSchema, fieldErrorFromZod } from "../lib/validation.js";
import { NotFoundError, ValidationError, BackendError } from "../lib/errors.js";
import { FETCH_MAX_BYTES, byteLength, truncateAtParagraph } from "../lib/truncate.js";
import { logger } from "../lib/logger.js";

export const FETCH_TOOL_NAME = "fetch_cometchat_doc_page";

export const FETCH_TOOL_DEFINITION = {
  name: FETCH_TOOL_NAME,
  title: "Fetch CometChat Documentation Page",
  description:
    "Fetches the full content of a single CometChat documentation page by URL or path. Returns the page content as markdown along with title and section metadata. Path can be passed as a full https://www.cometchat.com/docs URL or as a relative path such as '/sdk/javascript/overview'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description:
          "Documentation path or full URL. Relative paths like '/sdk/javascript/overview' and full URLs both work.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: {
    title: "Fetch CometChat Documentation Page",
    readOnlyHint: true,
  },
};

const HEADING_RE = /^#\s+(.+)$/m;

export type FetchOpts = {
  docsBaseUrl: string;
  timeoutMs: number;
};

export async function runFetch(input: unknown, opts: FetchOpts) {
  let parsed;
  try {
    parsed = FetchInputSchema.parse(input);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const f = fieldErrorFromZod(err);
      throw new ValidationError(f.field, f.reason);
    }
    throw err;
  }

  const { url, mdUrl, urlPath } = resolvePath(parsed.path, opts.docsBaseUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let response: Response;
  try {
    response = await fetch(mdUrl, {
      signal: controller.signal,
      headers: { Accept: "text/markdown, text/plain;q=0.9" },
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new BackendError("Documentation fetch timed out. Retry shortly.");
    }
    logger.error({ err, mdUrl }, "fetch_failed");
    throw new BackendError();
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    throw new NotFoundError(urlPath);
  }
  if (!response.ok) {
    logger.warn({ status: response.status, mdUrl }, "fetch_non_ok");
    throw new BackendError();
  }

  const fullText = await response.text();
  const title = extractTitle(fullText, urlPath);
  const section = extractSection(urlPath);
  const safe = truncateAtParagraph(fullText, FETCH_MAX_BYTES, url);

  return {
    title,
    url,
    section,
    content: safe,
    contentLength: byteLength(safe),
  };
}

function resolvePath(input: string, docsBaseUrl: string): { url: string; mdUrl: string; urlPath: string } {
  let urlPath = input.trim();

  if (urlPath.startsWith("http://") || urlPath.startsWith("https://")) {
    const u = new URL(urlPath);
    urlPath = u.pathname;
  }

  if (!urlPath.startsWith("/")) urlPath = "/" + urlPath;
  // Strip the docs prefix if user passes /docs/...
  urlPath = urlPath.replace(/^\/docs(\/|$)/, "/");
  if (urlPath.endsWith("/")) urlPath = urlPath.slice(0, -1);
  if (urlPath.endsWith(".md") || urlPath.endsWith(".mdx")) {
    urlPath = urlPath.replace(/\.(md|mdx)$/, "");
  }

  const url = `${docsBaseUrl}${urlPath}`;
  const mdUrl = `${docsBaseUrl}${urlPath}.md`;
  return { url, mdUrl, urlPath };
}

function extractTitle(content: string, fallback: string): string {
  const m = HEADING_RE.exec(content);
  if (m) return m[1].trim();
  const last = fallback.split("/").filter(Boolean).pop() ?? "Documentation";
  return last
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractSection(urlPath: string): string {
  const segments = urlPath.split("/").filter(Boolean);
  if (segments.length === 0) return "Documentation";
  const top = segments[0];
  const sub = segments[1];
  const sectionMap: Record<string, string> = {
    sdk: "SDK",
    "ui-kit": "UI Kit",
    "rest-api": "REST API",
    "chat-builder": "Chat Builder",
    moderation: "Moderation",
    notifications: "Notifications",
    widget: "Widget",
    "ai-agents": "AI Agents",
    "ai-chatbots": "AI Chatbots",
    fundamentals: "Fundamentals",
    calls: "Calls",
    articles: "Articles",
  };
  const top2 = sectionMap[top] ?? top.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return sub ? `${top2} / ${sub}` : top2;
}
