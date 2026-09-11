// Version label grammar shared by the index builder and the search tool input,
// so every label the builder stores is one a caller can filter on. Kept free
// of dependencies: the builder runs as a child process inside the container.

/** Labels the `version` search filter accepts: 'v7', '7', 'v3.5', 'v3.0.1'. */
export const VERSION_LABEL_RE = /^v?\d+(\.\d+){0,2}$/i;

/**
 * Canonical version label, as stored in the search index: lowercase 'v', no
 * leading zeros, no trailing '.0' segments. 'V7', '7' and 'v7.0' all mean
 * 'v7', and a docs folder named '3.0' is 'v3' as the version picker labels it.
 */
export function normalizeVersionLabel(raw: string): string {
  const parts = raw.trim().replace(/^v/i, "").split(".").map((p) => String(Number(p)));
  while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
  return `v${parts.join(".")}`;
}

// In free query text a bare integer is not a version ("error 404"), so a word
// must carry the 'v' prefix or a dotted number the docs use for folders ('3.0').
const QUERY_VERSION_RE = /^(?:v\d+(?:\.\d+){0,2}|\d+\.\d+(?:\.\d+)?)$/i;

/**
 * The version a query word names ('v4', 'V5', 'v3.0', '3.0', '(v4),'), as the
 * canonical label the version filter uses; null when the word is not a version.
 */
export function queryVersionLabel(word: string): string | null {
  const cleaned = queryVersionWord(word);
  return QUERY_VERSION_RE.test(cleaned) ? normalizeVersionLabel(cleaned) : null;
}

/** The word without surrounding punctuation: '(v3.0),' -> 'v3.0'. */
export function queryVersionWord(word: string): string {
  return word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
}
