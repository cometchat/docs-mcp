#!/usr/bin/env tsx
/**
 * Build the SQLite FTS5 search index from a clone of github.com/cometchat/docs.
 *
 * Usage:
 *   DOCS_REPO=/path/to/cometchat-docs INDEX_PATH=./data/index.sqlite tsx scripts/build-index.ts
 *
 * The indexer walks the repo, parses MDX frontmatter + body, derives the Mintlify
 * URL from the file path, and writes one row per page into a `pages` table backed
 * by an FTS5 virtual table. Each page's product, version label and whether it is
 * the current version come from the docs.json navigation, falling back to the
 * path for repos (or pages) it does not cover — see src/search/navigation.ts.
 * Shared snippets a page imports from /snippets/ are indexed as part of it.
 *
 * Diagnostics go to stderr, one line each; nothing goes to stdout. A line
 * starting "WARNING: " marks a degraded build, and the in-container refresher
 * logs such a build at warn. A docs.json problem never fails the build: the
 * index is still written, with versions derived from paths.
 */
import { readdir, readFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "../src/lib/frontmatter.js";
import { SnippetInliner } from "../src/search/mdx-imports.js";
import {
  indexNavigation,
  isInFolder,
  resolvePageVersion,
  retiredFolders,
  type NavigationIndex,
} from "../src/search/navigation.js";
import { VERSION_LABEL_RE } from "../src/search/version.js";
import {
  FEATURE_KEYWORDS,
  keywordRules,
  pageKeywords,
  REFERENCE_STUB_BODY,
  type FeatureKeywords,
} from "../src/search/keywords.js";
import { indexedTitleKey } from "../src/search/phrasing.js";
import Database from "better-sqlite3";

const DOCS_REPO = process.env.DOCS_REPO ?? "../cometchat-docs-repo";
const INDEX_PATH = process.env.INDEX_PATH ?? "./data/index.sqlite";
const DOCS_BASE_URL =
  process.env.DOCS_BASE_URL ?? "https://www.cometchat.com/docs";

const SECTION_LABELS: Record<string, string> = {
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
  "on-premise-deployment": "On-Premise Deployment",
  "web-elements": "Web Elements",
  "web-shared": "Web Shared",
};

const VERSION_RE = /^v\d+(\.\d+)?$/i;

// A per-doc-set machine-readable page index (/ui-kit/react/llms-react-v7).
const DOCS_INDEX_PAGE_RE = /\/llms-[^/]*$/;

// Below this much text a page answers nothing and is left out.
const STUB_BODY_CHARS = 40;

async function main() {
  const repoStat = await stat(DOCS_REPO).catch(() => null);
  if (!repoStat || !repoStat.isDirectory()) {
    console.error(
      `DOCS_REPO not found or not a directory: ${DOCS_REPO}\n` +
        `Clone github.com/cometchat/docs first:\n` +
        `  git clone --depth 1 https://github.com/cometchat/docs.git cometchat-docs-repo`,
    );
    process.exit(1);
  }
  await mkdir(path.dirname(INDEX_PATH), { recursive: true });

  const db = new Database(INDEX_PATH);
  db.pragma("journal_mode = WAL");
  // product/version/is_current are filters and ranking inputs, not search
  // text: an indexed "v4" token matched the label instead of page content.
  // trails_fts holds each distinct product name once: a page points at its
  // navigation trail (trail_id) and its folder section (label_id), and the
  // search boosts it by how many query terms the better of the two matches
  // (see src/search/sqlite.ts). keywords holds a page's search keywords
  // (src/search/keywords.ts) as a JSON array, and languages the languages of
  // its code examples (codeLanguages below): each searchable through its own
  // FTS column, and never part of a snippet. title_key is the title as the
  // search compares it with a query (src/search/phrasing.ts indexedTitleKey).
  db.exec(`
    DROP TABLE IF EXISTS pages_fts;
    DROP TABLE IF EXISTS trails_fts;
    DROP TABLE IF EXISTS pages;
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      title_key TEXT NOT NULL DEFAULT '',
      section TEXT NOT NULL,
      product TEXT,
      version TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
      trail_id INTEGER NOT NULL,
      label_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      languages TEXT NOT NULL DEFAULT ''
    );
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      title, body, section, keywords, languages,
      content='pages', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE trails_fts USING fts5(trail, tokenize='porter unicode61');
    CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, body, section, keywords, languages)
      VALUES (new.id, new.title, new.body, new.section, new.keywords, new.languages);
    END;
  `);

  const insert = db.prepare(
    `INSERT INTO pages (path, url, title, title_key, section, product, version, is_current, trail_id, label_id, body, keywords, languages)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTrail = db.prepare(`INSERT INTO trails_fts (rowid, trail) VALUES (?, ?)`);
  const trailIds = new Map<string, number>();
  const trailId = (trail: string): number => {
    let id = trailIds.get(trail);
    if (id === undefined) {
      id = trailIds.size + 1;
      insertTrail.run(id, trail);
      trailIds.set(trail, id);
    }
    return id;
  };
  const insertMany = db.transaction((rows: Row[]) => {
    for (const r of rows) {
      // A retired doc set's pages keep their section ("UI Kit / Kotlin"), but
      // point at an empty trail: no query word names their product, so the
      // product boost never cancels their legacy factor.
      const ids = r.retired
        ? ([trailId(""), trailId("")] as const)
        : ([trailId(productTrail(r)), trailId(r.section)] as const);
      try {
        insert.run(
          r.path,
          r.url,
          r.title,
          indexedTitleKey(r.title),
          r.section,
          r.product,
          r.version,
          r.isCurrent ? 1 : 0,
          ...ids,
          r.body,
          r.keywords,
          r.languages,
        );
      } catch (err) {
        // Skip duplicates from differing-case path collisions.
        const msg = (err as Error).message;
        if (!msg.includes("UNIQUE")) throw err;
      }
    }
  });

  const nav = await loadNavigation(DOCS_REPO);
  const files = await collectMdx(DOCS_REPO);
  const inliner = await SnippetInliner.create(DOCS_REPO);
  console.error(`Indexing ${files.length} mdx files from ${DOCS_REPO}`);

  const rows: Row[] = [];
  const unsafeFrontmatter: string[] = [];
  const inferred = retiredFolders(files.map((f) => path.relative(DOCS_REPO, f)), nav);
  // Not listing a doc set is how the docs retire one, but it is also what an
  // ordinary navigation restructure looks like, and a demoted set leaves the
  // results altogether: its pages lose is_current and point at an empty trail,
  // so every query about the product answers with a neighbouring one (React UI
  // Kit unlisted -> "install react ui kit" returns only React Native pages).
  // Nothing downstream would catch it: the refresher validates page counts, and
  // one doc set's pages leaving the navigation stays under its drop ratio. So
  // only an allowlisted set is demoted; the rest are reported and left current.
  const retired = new Set([...inferred].filter((f) => KNOWN_RETIRED_DOC_SETS.has(f)));
  const [known, unexpected] = partition([...inferred].sort(), (f) => KNOWN_RETIRED_DOC_SETS.has(f));
  if (known.length > 0) console.error(`retired doc sets, indexed as older versions: ${known.join(", ")}`);
  if (unexpected.length > 0) {
    // Folder names are docs text, and the refresher logs this line: one line, capped.
    const shown = unexpected.slice(0, 10).map((f) => Array.from(oneLine(f)).slice(0, 60).join(""));
    const more = unexpected.length > 10 ? ` (and ${unexpected.length - 10} more)` : "";
    console.error(
      `WARNING: doc set(s) docs.json does not list, left current: ${shown.join(", ")}${more}; ` +
        "add one to KNOWN_RETIRED_DOC_SETS in scripts/build-index.ts to index it as retired",
    );
  }
  // Per keyword rule, the listed pages it reaches: current, and older.
  const ruleReach = new Map<FeatureKeywords, { current: number; older: number }>(
    FEATURE_KEYWORDS.map((rule) => [rule, { current: 0, older: 0 }]),
  );
  for (const abs of files) {
    const rel = path.relative(DOCS_REPO, abs);
    if (rel.startsWith("node_modules/") || rel.startsWith("snippets/")) continue;
    const raw = await readFile(abs, "utf8");
    const parsed = parseFrontmatter(raw);
    if (parsed.unsafeLanguage) {
      // Docs come from a public repo and are rebuilt inside the serving
      // container: skip the page, never evaluate it, and keep the build going.
      unsafeFrontmatter.push(rel);
      continue;
    }
    const fm = parsed.data as Record<string, unknown>;
    const content = await inliner.inline(parsed.content, abs);
    const urlPath = "/" + rel.replace(/\.mdx$/, "");
    // An llms-*.mdx page is a machine-readable index: a few kilobytes listing
    // the title and description of every page in its doc set. Indexed whole it
    // holds the words of all of them, so it took rank 1 on ordinary queries
    // about the doc set ("angular ui kit guides", "flutter chat sdk send
    // custom message type") ahead of the page that answers them, and every
    // title it lists has its own indexed page anyway. The pages say in their
    // own comments that they are meant to stay discoverable, so they are
    // indexed by what they are — their title and frontmatter description —
    // rather than dropped.
    const description = typeof fm.description === "string" ? fm.description : "";
    const indexPage = DOCS_INDEX_PAGE_RE.test(urlPath) && description.trim().length >= STUB_BODY_CHARS;
    const body = indexPage ? description : stripMdx(content);
    // Too little text to answer anything. An index page falls back to its full
    // body rather than through this floor: dropping a page is not the point.
    if (body.trim().length < STUB_BODY_CHARS) continue;
    const segments = urlPath.split("/").filter(Boolean);
    const section = sectionFor(segments);
    const resolved = resolvePageVersion(urlPath, nav);
    const { product, version } = resolved;
    // An unlisted page of a retired doc set is not current, whatever its path.
    const isRetired = product === null && isInFolder(urlPath, retired);
    const isCurrent = resolved.isCurrent && !isRetired;
    const title = typeof fm.title === "string" ? fm.title : titleFromPath(urlPath);
    const keywordOpts = {
      path: urlPath,
      openapi: typeof fm.openapi === "string",
      // The same measure the stub factor reads back (length(pages.body)).
      stub: body.length < REFERENCE_STUB_BODY,
      listed: product !== null || nav.pages.size === 0,
    };
    for (const rule of keywordRules(title, keywordOpts)) ruleReach.get(rule)![isCurrent ? "current" : "older"]++;
    rows.push({
      path: urlPath,
      url: `${DOCS_BASE_URL}${urlPath}`,
      title,
      section,
      product,
      version,
      isCurrent,
      retired: isRetired,
      body,
      keywords: pageKeywords(title, keywordOpts),
      languages: codeLanguages(content).join(" "),
    });
  }

  insertMany(rows);
  db.exec(`INSERT INTO pages_fts(pages_fts) VALUES('optimize');`);
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(is_current = 0), 0) AS legacy,
         COALESCE(SUM(product IS NOT NULL), 0) AS nav FROM pages`,
    )
    .get() as { n: number; legacy: number; nav: number };
  // Finalize out of WAL: a WAL-mode file needs writable -wal/-shm siblings even
  // for readonly opens, which breaks read-only index mounts in production.
  db.pragma("journal_mode = DELETE");
  db.close();
  if (nav.pages.size > 0 && total.nav === 0) {
    // docs.json was read, but its page paths no longer match the files (a move
    // or a reshaped repo), so every version still comes from the path.
    console.error(
      `WARNING: docs.json navigation lists ${nav.pages.size} pages but none matched an indexed page; ` +
        "page versions come from paths",
    );
  }
  unsafeFrontmatter.push(...inliner.unsafe);
  if (unsafeFrontmatter.length > 0) {
    // Loud on purpose: docs pages never legitimately use an executable
    // frontmatter language, so this is either a mistake or an attack.
    console.error(
      `WARNING: skipped ${unsafeFrontmatter.length} page(s) with executable frontmatter: ` +
        unsafeFrontmatter.slice(0, 10).map(oneLine).join(", "),
    );
  }
  for (const [rule, reach] of ruleReach) {
    // The rules key on page titles. When the docs retitle the current pages,
    // only their older copies keep the keywords, and a keyword query then
    // finds nothing current. Rules no page matches at all stay quiet: a
    // small or partial docs repo has none of these pages.
    if (reach.current === 0 && reach.older > 0) {
      console.error(
        `WARNING: search keyword rule ${rule.title} matches no current page, only ${reach.older} older one(s); ` +
          "were the current pages retitled?",
      );
    }
  }
  const unfilterable = [...new Set(rows.flatMap((r) => (r.version && !VERSION_LABEL_RE.test(r.version) ? [r.version] : [])))];
  if (unfilterable.length > 0) {
    // Stored and reported on results, but SearchInputSchema rejects them.
    // Capped: the labels are docs text, and the refresher logs this line.
    const shown = unfilterable.slice(0, 10).map((l) => Array.from(oneLine(l)).slice(0, 40).join(""));
    const more = unfilterable.length > 10 ? ` (and ${unfilterable.length - 10} more)` : "";
    console.error(`WARNING: version label(s) the search version filter cannot match: ${shown.join(", ")}${more}`);
  }
  console.error(
    `Index built: ${total.n} pages (${total.legacy} older-version, ${total.nav} from docs.json navigation) → ${INDEX_PATH}`,
  );
}

type Row = {
  path: string;
  url: string;
  title: string;
  section: string;
  product: string | null;
  version: string | null;
  isCurrent: boolean;
  /** In a doc set docs.json no longer lists (see retiredFolders). */
  retired: boolean;
  body: string;
  /** Search keywords as a JSON array (src/search/keywords.ts). */
  keywords: string;
  /** The languages of the page's code examples, space-separated (codeLanguages). */
  languages: string;
};

// Doc sets known to be retired: docs.json no longer lists them, and their
// older versions sit in version folders (the Kotlin UI Kit: v3 at the root, v2
// under 2.0/). Another set inferred to be retired is reported as a WARNING.
const KNOWN_RETIRED_DOC_SETS = new Set(["ui-kit/kotlin"]);

function partition<T>(items: T[], test: (item: T) => boolean): [T[], T[]] {
  return [items.filter(test), items.filter((item) => !test(item))];
}

/**
 * docs.json navigation is the source of truth for versions. A repo without a
 * usable one (the refresh E2E fixture has none) still builds, with versions
 * derived from paths alone. Each way it can be unusable prints its own WARNING,
 * so the refresher's logs say which one happened.
 */
async function loadNavigation(repo: string): Promise<NavigationIndex> {
  let raw: string;
  try {
    raw = await readFile(path.join(repo, "docs.json"), "utf8");
  } catch (err) {
    // The errno code only: the message would add the clone's temporary path.
    const code = (err as NodeJS.ErrnoException).code;
    console.error(
      code === "ENOENT"
        ? "WARNING: no docs.json found; deriving page versions from paths"
        : `WARNING: docs.json could not be read (${code ?? "unknown error"}); deriving page versions from paths`,
    );
    return indexNavigation(null);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `WARNING: docs.json is not valid JSON (${oneLine((err as Error).message)}); deriving page versions from paths`,
    );
    return indexNavigation(null);
  }
  let nav: NavigationIndex;
  try {
    nav = indexNavigation(parsed);
  } catch (err) {
    // Valid JSON the recursive walk cannot handle, such as nesting deep enough
    // to overflow the stack: calling it invalid JSON would send someone looking
    // for a syntax error that is not there.
    const e = err as Error;
    console.error(
      `WARNING: docs.json navigation could not be indexed (${oneLine(`${e.name}: ${e.message}`)}); ` +
        "deriving page versions from paths",
    );
    return indexNavigation(null);
  }
  if (nav.pages.size === 0) {
    console.error("WARNING: docs.json navigation lists 0 pages; deriving page versions from paths");
    return nav;
  }
  console.error(`docs.json navigation lists ${nav.pages.size} pages`);
  return nav;
}

/**
 * Docs text (a JSON.parse excerpt, a label, a file name) folded onto one line:
 * the refresher logs each stderr line on its own, so a line break would split
 * a WARNING and could pass the rest off as a line of its own.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
}

async function collectMdx(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "images" ||
          entry.name === "assets" ||
          entry.name === "html-files" ||
          entry.name === "snippets"
        ) {
          continue;
        }
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        out.push(abs);
      }
    }
  }
  await walk(root);
  return out;
}

// A closing "Next Steps" section links to other pages with a line about each
// ("Edit sent messages in conversations" on the Delete Message page): indexed,
// it matches queries about those pages instead of this one. It runs to the next
// heading or the end of the page. stripMdx removes it only once code fences
// are gone, so a "## Next steps" line in a fenced README example neither
// starts nor ends it.
const NEXT_STEPS_RE = /^#{1,6}[ \t]+next steps\b[^\n]*(?:\n(?!#{1,6}[ \t])[^\n]*)*/gim;

// Code tabs and fences name the language of each example (<Tab title="Swift">,
// ```kotlin), and stripMdx drops both: an iOS page read as text almost never
// says "Swift". Each language a page's examples use is stored once, in the
// `languages` column, so a query naming it matches the page without the count
// weighing on bm25, and snippets (drawn from the body) never show the names as
// if the page said them. JavaScript and TypeScript are left out: every web UI
// Kit's examples use them, and in a query "javascript" names the JavaScript
// SDK (the search widens "js" to it instead; see src/search/phrasing.ts).
const CODE_LANGUAGES: Record<string, string> = {
  swift: "Swift",
  "objective-c": "Objective-C",
  "objective c": "Objective-C",
  objectivec: "Objective-C",
  objc: "Objective-C",
  kotlin: "Kotlin",
  java: "Java",
  dart: "Dart",
};

/**
 * The languages a page's code tabs and fences name, each once — but only the
 * ones the page is written in. A guide for one platform that quotes a single
 * snippet of another is not about that other platform:
 * /notifications/flutter-push-notifications-ios is a Flutter guide with one
 * iOS AppDelegate block among four Dart ones, yet it was indexed "Dart Swift",
 * and 46 pages outside /sdk/ios, /ui-kit/ios and /calls/ios claimed Swift the
 * same way. A language is kept when it names LANGUAGE_MIN_BLOCKS of the
 * page's blocks, or LANGUAGE_MIN_SHARE of the ones naming a language at all —
 * so an iOS page showing Swift and Objective-C side by side keeps both, and a
 * page whose only example is Swift keeps it, while a lone foreign snippet
 * among a platform's own goes.
 *
 * Own properties of CODE_LANGUAGES only: a tab may be titled "Constructor".
 */
function codeLanguages(content: string): string[] {
  const names = [
    ...[...content.matchAll(/^[ \t]*```([A-Za-z-]+)/gm)].map((m) => m[1]),
    // "Kotlin (XML Views)", "Java (User)": the language is the part before the parenthesis.
    ...[...content.matchAll(/<Tab\s+title="([^"(]+)/g)].map((m) => m[1]),
  ];
  const counts = new Map<string, number>();
  let blocks = 0;
  for (const name of names) {
    const key = name.trim().toLowerCase();
    const language = Object.hasOwn(CODE_LANGUAGES, key) ? CODE_LANGUAGES[key] : undefined;
    if (language) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
      blocks++;
    }
  }
  return [...counts]
    .filter(([, n]) => n >= LANGUAGE_MIN_BLOCKS || n >= blocks * LANGUAGE_MIN_SHARE)
    .map(([language]) => language)
    .sort();
}

// How much of a page's code a language must account for to be one the page is
// written in: two blocks, or a quarter of the ones naming a language. Blocks
// in no tracked language (bash, json, the page's own framework) are not
// counted, so a lone Swift example on an iOS page whose others are all shell
// still makes the page a Swift page.
const LANGUAGE_MIN_BLOCKS = 2;
const LANGUAGE_MIN_SHARE = 0.25;

// A compound identifier: camelCase, PascalCase or an acronym run into a word
// ("markAsRead", "CometChat", "UIKitSettings").
const COMPOUND_IDENTIFIER = /[a-z0-9][A-Z]|[A-Z]{2}[a-z]/;

/**
 * What inline code contributes to the indexed text: the API names in it.
 * Current docs name their methods only in code ("Use `markAsRead()` to mark
 * messages as read") where older versions wrote them in prose, so dropping
 * inline code left a query naming an API matching only older pages. Only
 * compound identifiers are kept: each is one token no prose query word
 * collides with, whereas file paths, package names and commands
 * (`chat_builder/lib/`, `npm install @cometchat/chat-uikit-react`) split into
 * the common words every product page already repeats. A span made only of
 * such identifiers stays as written, so snippets read `markAsRead()`.
 * Fenced code blocks stay out: adding their identifiers measured worse.
 * Inline code holding a JSX tag (`<CometChatMessageList />`) keeps the tag's
 * name (tagName), the component a query names it by.
 */
function inlineCodeText(code: string): string {
  const words = code.match(/[A-Za-z0-9]+/g) ?? [];
  const identifiers = words.filter((w) => COMPOUND_IDENTIFIER.test(w));
  if (identifiers.length === 0) return "";
  return identifiers.length === words.length ? code.replace(/[*_~]/g, " ") : identifiers.join(" ");
}

// A JSX/HTML tag, fragment (<>, </>) or HTML comment. A "<" that starts none
// of these is prose ("react >=18 <21"), not a tag: matched as one, it ran to
// the next ">" anywhere on the page -- usually inside a code fence -- and the
// unbalanced fences that left then dropped the prose between them instead of
// the code (the React.js Integration page indexed only its inline code).
const MDX_TAG_RE = /<(?:\/?[A-Za-z][^>]*|\/?|!--[\s\S]*?--)>/g;

// A tab's title is a heading the page shows above its content, and some say
// what no other text on the page does: the iOS UI Kit's install steps are tabs
// titled "CocoaPods" and "Swift Package Manager", so "ios swift package
// manager" found its getting-started page by one passing mention. Most tabs
// name a language or file ("Kotlin", "JavaScript (User)", "App.tsx"), which
// the languages column covers or which would only repeat across a doc set, so
// a title is kept as text only when, without a parenthesized suffix, it is two
// words or more and not a code language.
// The title may follow other attributes and be quoted either way or written
// as a string expression (title={"..."}).
const TAB_TITLE_RE = /<Tab\b[^>]*?\btitle=(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)')\s*\})/g;

// A tag in inline code is the API it names: `<CometChatMessageList />`,
// `List<CometChatOption>`. Its name stays, its attributes go.
function tagName(tag: string): string {
  return ` ${/[A-Za-z][\w.]*/.exec(tag)?.[0] ?? ""} `;
}

// An MDX comment, {/* ... */}: never shown, and it may hold "<" or ">".
const MDX_COMMENT_RE = /\{\/\*[\s\S]*?\*\/\}/g;

function tabTitleText(title: string): string {
  const head = title.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length < 2 || Object.hasOwn(CODE_LANGUAGES, head.toLowerCase())) return " ";
  return ` ${head} `;
}

function stripMdx(content: string): string {
  return content
    // Code first: fences and inline spans hold "<" and ">" that are not tags
    // (`Array<string>`, `a < b`), and a "<" left behind would run a tag
    // match out of the span into the prose. A tag inside a span
    // (`<CometChatMessageList />`) leaves its name (tagName).
    .replace(/```[\s\S]*?```/g, " ")
    .replace(MDX_COMMENT_RE, " ")
    .replace(/`([^`]*)`/g, (_span, code: string) => ` ${inlineCodeText(code.replace(MDX_TAG_RE, tagName))} `)
    .replace(TAB_TITLE_RE, (tag, ...titles: unknown[]) => {
      const title = titles.slice(0, 4).find((t): t is string => typeof t === "string") ?? "";
      return `${tabTitleText(title)}${tag}`;
    })
    .replace(MDX_TAG_RE, " ")
    .replace(NEXT_STEPS_RE, " ")
    // MDX ESM: an import/export at the start of a line runs to the next blank
    // line. A page that only imports a shared snippet must fall under the
    // stub floor, not be indexed with the import statement as its body.
    .replace(/^(?:import|export)[ \t].*(?:\n[ \t]*\S.*)*/gm, " ")
    .replace(/\[(.+?)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The page's product as the docs.json navigation names it, below the product
 * family: "UI Kit Builder / React" from "Chat & Messaging / UI Kit Builder /
 * React". The family is shared by most pages ("chat" would favour Widget
 * Builder as much as the UI Kit Builder), so it is left out. The boost also
 * tries the folder section ("Chat Builder / React", "Mcp-Server"), which names
 * products the trail does not, and keeps the better match of the two: merging
 * both into one label would credit "flutter chat ui kit" to /chat-builder/.
 * Pages the navigation does not cover have only the section.
 */
function productTrail(row: Row): string {
  return row.product?.split(" / ").slice(1).join(" / ") || row.section;
}

function sectionFor(segments: string[]): string {
  if (segments.length === 0) return "Documentation";
  const top = segments[0];
  // Look past a version folder (/calls/v4/javascript/...): the section is a
  // weighted ranking input, so legacy pages must name their framework too.
  const second = VERSION_RE.test(segments[1] ?? "") ? segments[2] : segments[1];
  const label = SECTION_LABELS[top] ?? capitalize(top);
  return second ? `${label} / ${capitalize(second)}` : label;
}

function titleFromPath(urlPath: string): string {
  const last = urlPath.split("/").filter(Boolean).pop() ?? "Documentation";
  return capitalize(last.replace(/-/g, " "));
}

function capitalize(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
