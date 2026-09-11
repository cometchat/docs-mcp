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
  outputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Page title." },
      url: { type: "string", description: "Canonical page URL." },
      section: { type: "string", description: "Documentation section the page belongs to." },
      content: { type: "string", description: "Full page content as markdown (truncated if very large)." },
      contentLength: { type: "number", description: "Content length in bytes after truncation." },
      redirectedFrom: {
        type: "string",
        description:
          "Path originally requested, present only when that page has moved. url and section describe the page it moved to.",
      },
    },
    required: ["title", "url", "section", "content", "contentLength"],
    additionalProperties: false,
  },
  annotations: {
    title: "Fetch CometChat Documentation Page",
    readOnlyHint: true,
  },
};

const HEADING_RE = /^#\s+(.+)$/m;
// RFC 3986 scheme prefix: the input is a full URL rather than a docs path.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// Moved pages redirect to their new path; docs.json chains are at most 2 long.
const MAX_REDIRECTS = 3;

export type FetchOpts = {
  docsBaseUrl: string;
  timeoutMs: number;
};

type DocsBase = {
  origin: string;
  /** Base path without a trailing slash: "/docs", or "" for an origin-root base. */
  basePath: string;
  url: string;
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

  const base = parseDocsBase(opts.docsBaseUrl);
  const requestedPath = resolveInputPath(parsed.path, base);
  const { response, urlPath } = await fetchFollowingRedirects(requestedPath, base, opts.timeoutMs);
  const url = `${base.url}${urlPath}`;

  if (response.status === 404) {
    throw new NotFoundError(requestedPath);
  }
  if (!response.ok) {
    logger.warn({ status: response.status, mdUrl: `${url}.md` }, "fetch_non_ok");
    throw new BackendError();
  }

  const fullText = await response.text();
  if (looksLikeDocsHomepage(fullText, urlPath)) {
    throw new NotFoundError(requestedPath);
  }
  const title = extractTitle(fullText, urlPath);
  const section = extractSection(urlPath);
  const safe = truncateAtParagraph(fullText, FETCH_MAX_BYTES, url);

  return {
    title,
    url,
    section,
    content: safe,
    contentLength: byteLength(safe),
    ...(urlPath !== requestedPath ? { redirectedFrom: requestedPath } : {}),
  };
}

// Requests <page>.md and follows redirects by hand. Moved pages 307/308 to
// their new path, but unknown pages redirect to the docs root, which serves
// the homepage with 200 — so a redirect is only followed while it lands on
// another docs page, and every other 3xx is not-found.
async function fetchFollowingRedirects(
  requestedPath: string,
  base: DocsBase,
  timeoutMs: number,
): Promise<{ response: Response; urlPath: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let urlPath = requestedPath;
    for (let hops = 0; ; hops++) {
      const mdUrl = `${base.url}${urlPath}.md`;
      let response: Response;
      try {
        response = await fetch(mdUrl, {
          signal: controller.signal,
          redirect: "manual",
          headers: { Accept: "text/markdown, text/plain;q=0.9" },
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          throw new BackendError("Documentation fetch timed out. Retry shortly.");
        }
        logger.error({ err, mdUrl }, "fetch_failed");
        throw new BackendError();
      }
      if (response.status < 300 || response.status >= 400) {
        return { response, urlPath };
      }
      response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      const next = hops < MAX_REDIRECTS ? redirectTarget(location, mdUrl, base) : null;
      if (next === null) {
        // A redirect to the docs root is how the site says "no such page"; any
        // other refusal (a loop, an off-site hop) points at a docs misconfiguration.
        if (!(hops < MAX_REDIRECTS && location && isDocsRootRedirect(location, mdUrl, base))) {
          logger.info(
            { path: requestedPath, status: response.status, location, hops: hops + 1 },
            "fetch_redirect_refused",
          );
        }
        throw new NotFoundError(requestedPath);
      }
      urlPath = next;
    }
  } finally {
    clearTimeout(timer);
  }
}

function isDocsRootRedirect(location: string, currentUrl: string, base: DocsBase): boolean {
  try {
    const target = new URL(location, currentUrl);
    return target.origin === base.origin && stripBasePath(target.pathname.replace(/\.mdx?$/, "").replace(/\/+$/, ""), base.basePath) === "";
  } catch {
    return false;
  }
}

// Maps a redirect Location to the next page path, or null when it is not a
// docs page: missing, another origin, outside the base path, or the docs root.
// Mintlify puts ".md" after a fragment ("page#anchor.md"); URL parsing moves
// that into the hash, which is dropped, and the next request targets <path>.md.
function redirectTarget(location: string | null, currentUrl: string, base: DocsBase): string | null {
  if (!location) return null;
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  const rest = stripBasePath(target.pathname.replace(/\.mdx?$/, ""), base.basePath);
  if (rest === null) return null;
  try {
    const next = normaliseDocPath(rest, base);
    return next === "" ? null : next;
  } catch {
    return null;
  }
}

// Turns the tool input into a canonical page path under the docs base ("" for
// the docs root). Full URLs must be on the docs origin; either form is
// rejected if it resolves outside the base path, so the tool cannot be pointed
// at other pages on the site.
function resolveInputPath(input: string, base: DocsBase): string {
  const raw = input.trim();

  if (SCHEME_RE.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new ValidationError("path", "must be a documentation path or a valid URL");
    }
    if (!isDocsSiteUrl(u, base)) {
      throw new ValidationError("path", `must be a relative path or a URL under ${base.url}`);
    }
    const rest = stripBasePath(u.pathname, base.basePath);
    if (rest === null) {
      throw new ValidationError("path", `must not resolve outside ${base.url}`);
    }
    return normaliseDocPath(rest, base);
  }

  let urlPath = raw.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  if (!urlPath.startsWith("/")) urlPath = "/" + urlPath;
  // Strip the docs prefix if user passes /docs/...
  urlPath = urlPath.replace(/^\/docs(\/|$)/, "/");
  return normaliseDocPath(urlPath, base);
}

// Canonicalises a path relative to the docs base: percent-decoded once,
// backslashes read as separators, ".md"/".mdx" dropped, dot segments resolved
// and each segment re-encoded. ".." above the docs root is rejected rather
// than clamped, because the docs root is not the site root.
function normaliseDocPath(path: string, base: DocsBase): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new ValidationError("path", "contains malformed percent-encoding");
  }
  const segments: string[] = [];
  for (const segment of decoded.replace(/\\/g, "/").replace(/\.mdx?\/*$/, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new ValidationError("path", `must not resolve outside ${base.url}`);
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  try {
    return segments.map((s) => `/${encodeURIComponent(s)}`).join("");
  } catch {
    // encodeURIComponent throws on a lone UTF-16 surrogate.
    throw new ValidationError("path", "contains invalid characters");
  }
}

// The docs site also answers on http:// and on the bare domain, 301-ing both to
// the canonical origin, and those URLs circulate. Accept them as input; the
// fetch itself always targets the canonical base, and redirect Locations are
// still held to the exact origin.
function isDocsSiteUrl(u: URL, base: DocsBase): boolean {
  if (u.origin === base.origin) return true;
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const canonical = new URL(base.origin);
  if (u.port !== "" || canonical.port !== "") return false;
  const bare = (host: string) => host.replace(/^www\./, "");
  return bare(u.hostname) === bare(canonical.hostname);
}

function stripBasePath(pathname: string, basePath: string): string | null {
  if (pathname === basePath) return "";
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
}

function parseDocsBase(docsBaseUrl: string): DocsBase {
  const u = new URL(docsBaseUrl);
  const basePath = u.pathname.replace(/\/+$/, "");
  return { origin: u.origin, basePath, url: `${u.origin}${basePath}` };
}

const HOMEPAGE_MARKERS = [
  "Documentation Index",
  "Fetch the complete documentation index",
  "Technical documentation & Implementation guides to add In-app Messaging",
];

function looksLikeDocsHomepage(body: string, urlPath: string): boolean {
  if (urlPath === "" || urlPath === "/") return false;
  const head = body.slice(0, 1200);
  return HOMEPAGE_MARKERS.every((marker) => head.includes(marker));
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
