export const FETCH_MAX_BYTES = 50 * 1024;
export const BUNDLE_MAX_BYTES = 60 * 1024;
export const SNIPPET_MAX_CHARS = 300;
export const SEARCH_MAX_RESULTS = 25;

export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function truncateAtParagraph(content: string, maxBytes: number, fullUrl: string): string {
  if (byteLength(content) <= maxBytes) return content;

  const marker = `\n\n[Content truncated — full page available at ${fullUrl}]`;
  const markerBytes = byteLength(marker);
  const budget = maxBytes - markerBytes;

  let candidate = content.slice(0, budget);
  while (byteLength(candidate) > budget) {
    candidate = candidate.slice(0, candidate.length - 32);
  }

  const lastBreak = candidate.lastIndexOf("\n\n");
  if (lastBreak > budget * 0.5) {
    candidate = candidate.slice(0, lastBreak);
  }

  return candidate + marker;
}

export function snippet(text: string, maxChars = SNIPPET_MAX_CHARS): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars - 1) + "…";
}
