import matter from "gray-matter";

/**
 * Safe frontmatter parsing.
 *
 * gray-matter selects its parser from the language tag written INSIDE the
 * file (`---js`, `---coffee`, `---cson`), and its built-in `javascript`
 * engine is a literal `eval()`. Any file we parse is therefore code
 * execution unless the executable engines are removed — and passing
 * `language: "yaml"` does NOT remove them, because a tag in the file wins
 * over the option. This matters most for the index build, which parses
 * ~3k files fetched from a public repo inside the live serving container.
 *
 * Two layers, because either alone is brittle:
 *  1. Detect the tag ourselves and refuse anything that is not YAML/JSON.
 *  2. Replace every executable engine, so a tag spelling we failed to
 *     anticipate throws instead of running.
 */

const DELIMITER = "---";
const SAFE_LANGUAGES = new Set(["", "yaml", "yml", "json"]);

class UnsafeFrontmatterError extends Error {}

/** Engines that can execute their input, neutralised. */
const DENY = {
  javascript: refuse("javascript"),
  js: refuse("js"),
  coffee: refuse("coffee"),
  cson: refuse("cson"),
  toml: refuse("toml"),
} as const;

function refuse(lang: string) {
  const parse = () => {
    throw new UnsafeFrontmatterError(`refusing to evaluate '${lang}' frontmatter`);
  };
  // gray-matter reads `.parse` off the engine when the engine is an object and
  // calls it directly when it is a function; cover both shapes.
  return Object.assign(parse, { parse, stringify: () => "" });
}

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
  /** Set when a non-YAML/JSON tag was present; `data` is empty in that case. */
  unsafeLanguage?: string;
}

/**
 * The language tag gray-matter would use: the text after the opening `---`
 * on the first line. gray-matter requires the delimiter at offset 0 (after a
 * BOM), so anything else has no frontmatter at all.
 */
function detectLanguage(raw: string): string | undefined {
  const str = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!str.startsWith(DELIMITER)) return undefined;
  const nl = str.indexOf("\n");
  const firstLine = nl === -1 ? str : str.slice(0, nl);
  return firstLine.slice(DELIMITER.length).trim().toLowerCase();
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const language = detectLanguage(raw);

  if (language !== undefined && !SAFE_LANGUAGES.has(language)) {
    // Re-tag as plain YAML and force the parser to yield nothing, so
    // gray-matter still splits body from frontmatter correctly while the
    // hostile block itself is never interpreted.
    const str = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const nl = str.indexOf("\n");
    const neutralised = nl === -1 ? DELIMITER : DELIMITER + str.slice(nl);
    const parsed = matter(neutralised, {
      engines: { ...DENY, yaml: { parse: () => ({}), stringify: () => "" } },
    });
    return { data: {}, content: parsed.content, unsafeLanguage: language };
  }

  try {
    const parsed = matter(raw, { language: "yaml", engines: { ...DENY } });
    return {
      data: (parsed.data ?? {}) as Record<string, unknown>,
      content: parsed.content,
    };
  } catch (err) {
    if (err instanceof UnsafeFrontmatterError) {
      return { data: {}, content: "", unsafeLanguage: language ?? "unknown" };
    }
    // Malformed YAML: a bad page must not abort a 3k-page build.
    return { data: {}, content: raw };
  }
}
