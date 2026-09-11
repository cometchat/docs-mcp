// Inlines shared MDX snippets into the pages that import them, so a page whose
// body is `import Actions from '/snippets/ai-agents/actions.mdx'` + `<Actions />`
// is indexed with the text the docs site renders for it.
//
// The index is rebuilt inside the serving container from a cloned public repo,
// so an import path is untrusted input: it is resolved against the docs root,
// must stay inside it after following symlinks, and must name a .md/.mdx file.
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "../lib/frontmatter.js";

/** Import nesting followed; a page's own imports are depth 1. */
export const MAX_IMPORT_DEPTH = 4;
/** Snippet files larger than this are not read. */
export const MAX_SNIPPET_BYTES = 256 * 1024;
/** Snippet text inlined into one page, across all of its imports. */
export const MAX_INLINED_CHARS = 512 * 1024;

// A default import on its own line. Named imports ({ x }) pull in variables, not page text.
const IMPORT_RE = /^[ \t]*import[ \t]+([A-Za-z_$][\w$]*)[ \t]+from[ \t]+(['"])([^'"\r\n]+)\2[ \t]*;?[ \t]*$/gm;
const ESM_IMPORT_LINE_RE = /^[ \t]*import[ \t][^\n]*[ \t]from[ \t]+['"][^'"\r\n]+['"][ \t]*;?[ \t]*$/gm;
const SNIPPET_EXT_RE = /\.mdx?$/i;

export class SnippetInliner {
  /** Snippet files whose frontmatter declares an executable language; never inlined. */
  readonly unsafe = new Set<string>();
  private readonly files = new Map<string, Promise<string | null>>();

  private constructor(private readonly root: string) {}

  /** `docsRoot` is resolved to its real path: containment is checked against it. */
  static async create(docsRoot: string): Promise<SnippetInliner> {
    return new SnippetInliner(await realpath(docsRoot));
  }

  /** `content` with each used snippet import replaced by the snippet's body (frontmatter and imports removed). */
  async inline(content: string, pagePath?: string): Promise<string> {
    const stack = new Set<string>(pagePath ? [path.resolve(pagePath)] : []);
    return this.expand(content, 1, stack, { chars: MAX_INLINED_CHARS });
  }

  private async expand(content: string, depth: number, stack: Set<string>, budget: { chars: number }): Promise<string> {
    if (depth > MAX_IMPORT_DEPTH) return content;
    let out = content;
    for (const [, name, , spec] of content.matchAll(IMPORT_RE)) {
      // Cheap checks first: most imports are code samples ('react', './App').
      if (!spec.startsWith("/") || !SNIPPET_EXT_RE.test(spec)) continue;
      const usage = new RegExp(`<${name.replace(/\$/g, "\\$")}(?:\\s[^<>]*)?/?>`);
      if (!usage.test(out)) continue;
      const file = await this.resolve(spec);
      if (file === null || stack.has(file)) continue;
      const text = await this.load(file);
      if (text === null || text.length > budget.chars) continue;
      budget.chars -= text.length;
      const nested = await this.expand(text, depth + 1, new Set([...stack, file]), budget);
      // Blank lines around the text keep the page's own import block from running into it.
      const body = nested.replace(ESM_IMPORT_LINE_RE, "");
      out = out.replace(usage, () => `\n\n${body}\n\n`);
    }
    return out;
  }

  /** Real path of a root-relative import ('/snippets/x.mdx'), or null when it is unsafe or missing. */
  private async resolve(spec: string): Promise<string | null> {
    const candidate = path.resolve(this.root, `.${spec}`);
    if (!within(this.root, candidate)) return null;
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      return null;
    }
    // A symlink must not lead out of the checkout or to another kind of file.
    if (!within(this.root, real) || !SNIPPET_EXT_RE.test(real)) return null;
    return real;
  }

  private load(file: string): Promise<string | null> {
    let pending = this.files.get(file);
    if (!pending) {
      pending = this.read(file);
      this.files.set(file, pending);
    }
    return pending;
  }

  private async read(file: string): Promise<string | null> {
    let handle;
    try {
      handle = await open(file, "r");
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_SNIPPET_BYTES) return null;
      const parsed = parseFrontmatter(await handle.readFile("utf8"));
      if (parsed.unsafeLanguage) {
        this.unsafe.add(path.relative(this.root, file));
        return null;
      }
      return parsed.content;
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }
}

function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
