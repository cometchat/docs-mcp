// How query words become MATCH terms, and how titles are compared with a
// query. Pure (no I/O), so every rule is unit-testable without an index.

// Plain-language queries ("when was someone online", "how do I unsend a
// message") carry words that say nothing about which page answers them. Every
// query word is a required MATCH term, so each such word also removes every
// page that happens not to contain it, the answer included. These words are
// dropped from MATCH; the title and keyword bonuses still see them.
//
// Kept deliberately short: only words with no meaning of their own in the
// docs. Articles, prepositions and words that are product vocabulary even when
// they look generic ("a", "the", "to", "in", "out", "up", "on", "off", "all",
// "new", "user", "use", "get", "set") stay: dropping them let short REST pages
// outrank the SDK pages "send a message" and "ban a user from a group" name.
export const STOPWORDS = new Set([
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "have", "has", "had",
  "i", "me", "my", "we", "our", "you", "your", "it", "its", "they", "them", "their",
  "he", "she", "his", "her", "him",
  "this", "that", "these", "those",
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "if", "so", "than", "then",
  "someone", "somebody", "anyone", "anybody", "something",
  "please", "just", "between",
  // Request verbs: "show last seen", "check if a user is online".
  "show", "check", "see", "know", "tell", "want", "need",
]);

/**
 * Query terms that gate MATCH: the terms minus stopwords, or all of them when
 * every term is one. A term with no letter or digit ("-") matches nothing.
 */
export function contentTerms(terms: string[]): string[] {
  const words = terms.filter((t) => /[\p{L}\p{N}]/u.test(t));
  const kept = words.filter((t) => !STOPWORDS.has(t));
  return kept.length > 0 ? kept : words;
}

// A language names its platform's docs: each is widened to (language OR
// platform), so the term matches every page of that platform and not only the
// ones whose examples happen to use the language.
//
// "js" needs the alias because the JavaScript SDK pages seldom write it (the
// hundred-odd that do mostly say "Next.js" or "Node.js"). The rest need it
// because the index builder's `languages` column covers a doc set only in
// part: 24 of the 57 current iOS SDK pages carry an Objective-C tab, 45 of 55
// Android v5 pages Kotlin, 40 of 47 Flutter pages Dart. Without the alias the
// language is a hard filter over that part — "objective-c rate limits"
// matched 24 pages and could not reach /sdk/ios/rate-limits at any limit,
// because the strict AND was no longer empty and the OR fallback that used to
// answer such a query never fired.
//
// "ts" and "typescript" get none: they mostly ask about the web UI Kits
// ("typescript message composer"), which the alias sent to JavaScript SDK
// pages instead.
export const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  js: "javascript",
  swift: "ios",
  swiftui: "ios",
  "objective-c": "ios",
  objectivec: "ios",
  objc: "ios",
  "obj-c": "ios",
  kotlin: "android",
  java: "android",
  dart: "flutter",
};

// Words that already say which platform or web framework the query is about
// ("react js", "vue js", "react-native js"): there the alias stays a plain
// word. Hyphenated terms are checked word by word.
export const PLATFORM_WORDS = new Set([
  "ios", "android", "flutter", "javascript", "react", "reactjs", "rn", "angular", "angularjs",
  "vue", "vuejs", "nuxt", "nuxtjs", "nextjs", "nodejs", "expressjs", "nestjs", "remixjs", "ionic",
  "capacitor", "cordova", "expo", "astro", "electron", "svelte", "unreal",
]);

// Frameworks whose name is also an ordinary word ("fetch the next page", "a
// node in the tree"): they name a platform only right before "js" ("next js",
// "node-js").
const JS_FRAMEWORK_WORDS = new Set(["next", "node", "express", "nest", "remix"]);

// Languages that name one platform's docs.
export const LANGUAGE_WORDS = new Set([
  "swift", "swiftui", "objective-c", "objectivec", "objc", "obj-c", "kotlin", "java", "dart", "js", "ts", "typescript",
]);

/** Whether a query names a platform or web framework itself, which turns the language aliases off. */
export function namesPlatform(terms: string[]): boolean {
  const words = terms.flatMap((t) => t.split("-"));
  return words.some((w, i) => PLATFORM_WORDS.has(w) || (JS_FRAMEWORK_WORDS.has(w) && words[i + 1] === "js"));
}

// Words that name a doc set only as part of its name: the "native" of "react
// native", and the Calls SDK ("android calls migration guide" asks for the
// Calls SDK's guide, not the Chat SDK's).
const DOC_SET_WORDS = new Set(["native", "calls", "calling"]);

// Words that name an area of the docs rather than a feature of the product:
// the REST API reference, webhooks, the chat widget. Like a platform word,
// such a word says which pages the query is about rather than what it asks of
// them -- "retract a message rest api" asks the REST reference for the same
// thing "retract a message" asks an SDK guide. They are compared with a page's
// section label (areaTerms below), so only words a section label writes are
// worth listing; plurals are matched there, not here.
const AREA_WORDS = new Set(["rest", "api", "webhook", "widget"]);

/**
 * The query's area words, singular: the words of AREA_WORDS it holds, with a
 * plural folded back ("apis" -> "api"). Empty when the query names no area.
 */
export function areaTerms(terms: string[]): string[] {
  const areas = new Set<string>();
  for (const term of terms) {
    for (const word of term.split("-")) {
      const singular = word.endsWith("s") ? word.slice(0, -1) : word;
      if (AREA_WORDS.has(singular)) areas.add(singular);
    }
  }
  return [...areas];
}

/**
 * Whether a MATCH term names a platform or doc set: a platform, language or
 * doc set word. Relaxed matching never drops one (see src/search/sqlite.ts): a
 * page missing it is about another platform. Only these curated words count.
 * Words that merely appear in some docs.json trail ("chat" in "Chat &
 * Messaging", "on" in "On-Premise Deployment") are what a page most often
 * lacks while answering the query ("android chat ui kit mentions formatter").
 */
export function isPlatformTerm(term: string): boolean {
  return LANGUAGE_WORDS.has(term) || term.split("-").some((w) => PLATFORM_WORDS.has(w) || DOC_SET_WORDS.has(w));
}

// Platforms named by a longer platform name: "react" is the first word of
// "React Native". A query saying "react" without "native" (or "rn") asks about
// React, yet the React Native trail ("UI Kits / React Native") held its word
// as fully as React's own, so the product boost could not tell them apart and
// "react ui kit install" answered with React Native pages. The longer name
// stays a match for every query that writes it.
//
// The other way round, "native" names a platform only beside "react": "native
// ios ui kit getting started" asks for the iOS UI Kit, and the React Native
// trail must not be credited with its "native".
const LONGER_PLATFORM_NAMES: Readonly<Record<string, readonly { name: string; words: readonly string[] }[]>> = {
  react: [{ name: "react native", words: ["native", "rn"] }],
  native: [{ name: "react native", words: ["react"] }],
};

/** Whether a query word names a platform only as part of a longer name the query does not write ("native" without "react"). */
export function isStrayPlatformPart(word: string, terms: string[]): boolean {
  return word === "native" && excludedPlatformNames(word, terms).length > 0;
}

/**
 * The longer platform names a query term must not be credited for, as FTS
 * phrases: ["react native"] for "react" unless the query also says "native"
 * or "rn". Empty for every other term.
 */
export function excludedPlatformNames(term: string, terms: string[]): string[] {
  const words = new Set(terms.flatMap((t) => t.split(/[-\s]+/)));
  const longer = Object.hasOwn(LONGER_PLATFORM_NAMES, term) ? LONGER_PLATFORM_NAMES[term] : [];
  return longer.filter((l) => !l.words.some((w) => words.has(w))).map((l) => l.name);
}

/**
 * One group of alternatives per MATCH term: [word, "javascript"] for a
 * language alias, [word] otherwise. Aliases apply only when no term names a
 * platform itself. Own properties only: "constructor" is a query word too.
 */
export function termGroups(terms: string[]): string[][] {
  const named = namesPlatform(terms);
  return terms.map((t) => {
    const platform = named || !Object.hasOwn(LANGUAGE_ALIASES, t) ? undefined : LANGUAGE_ALIASES[t];
    if (platform !== undefined) return [t, platform];
    // "rn" is how people write React Native; the docs never do.
    if (t === "rn") return [t, "react native"];
    // The docs write "Next.js", which the index reads as "next js": a query
    // word run together ("nextjs") also matches the phrase.
    const stem = jsFrameworkStem(t);
    return stem === null ? [t] : [t, `${stem} js`];
  });
}

/** "next" for "nextjs", when the word is a platform or framework name run into "js"; else null. */
function jsFrameworkStem(word: string): string | null {
  const m = /^([a-z]+)js$/.exec(word);
  return m && PLATFORM_WORDS.has(word) && (PLATFORM_WORDS.has(m[1]) || JS_FRAMEWORK_WORDS.has(m[1])) ? m[1] : null;
}

// A title and a query are also compared by their title keys: words only, with
// "and" and articles left out, so "delivery and read receipts" names "Delivery
// & Read Receipts" and "iOS delete a message" names the iOS "Delete Message".
const TITLE_KEY_SKIP = new Set(["and", "a", "an", "the"]);

/** The words of a title or query that its title key keeps, lowercase. */
export function titleKeyWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && !TITLE_KEY_SKIP.has(w));
}

/** A page title's key: "Delivery & Read Receipts" -> "delivery read receipts". The index stores indexedTitleKey. */
export function titleKey(title: string): string {
  return titleKeyWords(title).join(" ");
}

// Words naming a product rather than a feature. A title made only of them and
// platform words ("iOS SDK", "React Native UI Kit", "Calls SDK") names a whole
// doc set: nearly every query about that platform holds its words.
const PRODUCT_WORDS = new Set(["sdk", "chat", "ui", "kit"]);

/**
 * The title key the index stores: empty for a title naming a whole doc set, so
 * that neither the title-key bonus nor relaxed matching's in-order rule lifts
 * an overview page over the feature page a longer query asks for ("ios sdk
 * block a user by uid"). The search asks the same of a query: one whose key
 * is empty only names a doc set ("react native sdk"), and only such a query
 * gives a doc-set title its exact-title bonus.
 */
export function indexedTitleKey(title: string): string {
  const words = titleKeyWords(title);
  return words.every(isProductWord) ? "" : words.join(" ");
}

/** Whether a word names a product or platform rather than a feature. */
function isProductWord(w: string): boolean {
  return isPlatformTerm(w) || PRODUCT_WORDS.has(w) || JS_FRAMEWORK_WORDS.has(w);
}

/**
 * What a query asks for once the doc set it names is taken away: its title-key
 * words minus the product and platform words. "angular ui kit guides" -> the
 * page whose title key is "guides". Empty when the query only names a doc set.
 */
export function featureKey(text: string): string {
  const words = titleKeyWords(text);
  const feature = words.filter((w) => !isProductWord(w));
  return feature.length === words.length ? "" : feature.join(" ");
}

// Getting-started pages. Each doc set has one page that installs and sets up
// the product, and the docs title it in whatever way reads best in its own
// sidebar: "iOS Integration", "React.js Integration", "Setup", "Quickstart",
// "Getting Started With CometChat Flutter UI Kit V6". People ask for it in
// fewer ways ("ios ui kit getting started", "react ui kit install"), and none
// of those titles holds the words: the current iOS page never says "started",
// so "ios ui kit getting started" could not match it at all and answered with
// the v4 page, whose title is still "Getting Started". A page whose title,
// without its platform and product words, is one of START_TITLES (or opens
// with "getting started") is a start page; it carries START_PAGE_KEYWORDS
// (src/search/keywords.ts), and a query asking only for a start page (its
// feature key, below, is one of START_QUERIES) ranks it like a page whose
// title it holds.
const START_TITLES = new Set([
  "integration",
  "setup",
  "set up",
  "quickstart",
  "quick start",
  "installation",
  "getting started",
  "get started",
]);
export const START_QUERIES: ReadonlySet<string> = new Set([
  "install",
  "installation",
  "installing",
  "integrate",
  "integration",
  "setup",
  "set up",
  "quickstart",
  "quick start",
  "getting started",
  "get started",
]);
// Words a start page's title or slug adds to say whose start page it is:
// "React Native CLI Integration", "Getting Started With Jetpack Compose UI
// Kit", /react-native-cli-integration. Unlike isProductWord, "calls" and
// "calling" are not among them: "Calling Integration" adds calling to a UI Kit
// and is not where the UI Kit starts. Nor is "builder": "Getting Started With
// UI Kit Builder" starts another product.
const START_TITLE_FILLER = new Set(["cometchat", "with", "native", "cli", "jetpack", "compose"]);

function isStartTitleFiller(w: string): boolean {
  return (
    START_TITLE_FILLER.has(w) ||
    PLATFORM_WORDS.has(w) ||
    LANGUAGE_WORDS.has(w) ||
    PRODUCT_WORDS.has(w) ||
    JS_FRAMEWORK_WORDS.has(w) ||
    /^v\d+$/.test(w)
  );
}

/** Whether text, without the words saying whose start page it is, is one of START_TITLES. */
function namesStart(text: string): boolean {
  return START_TITLES.has(
    titleKeyWords(text)
      .filter((w) => !isStartTitleFiller(w))
      .join(" "),
  );
}

/**
 * Whether a page is its doc set's getting-started page (see START_TITLES): its
 * title says so and, given its path, so does the path's last segment. The
 * docs title some feature pages "Integration" too (/ui-kit/vue/calls-integration,
 * /notifications/email-integration); their slugs name the feature.
 */
export function isStartPageTitle(title: string, path?: string): boolean {
  if (!namesStart(title)) return false;
  if (path === undefined) return true;
  const slug = path.split("/").filter(Boolean).pop() ?? "";
  return namesStart(slug.replace(/-/g, " "));
}

// The product words a docs.json trail writes ("UI Kits / iOS", "SDK /
// Flutter"); "chat" is left out, as the trail's family ("Chat & Messaging")
// that holds it is not part of the product the search compares.
const TRAIL_PRODUCT_WORDS = new Set(["sdk", "ui", "kit"]);

/**
 * Whether a MATCH term names the doc set rather than what is asked of it: a
 * platform term (isPlatformTerm) or a product word a trail writes. The
 * start-page bonus asks the page's product to hold every such term.
 */
export function isDocSetTerm(term: string): boolean {
  return isPlatformTerm(term) || TRAIL_PRODUCT_WORDS.has(term);
}

/**
 * The MATCH term groups that name the query's doc set (isDocSetTerm). A
 * language beside a platform the query names ("android java ui kit setup")
 * only says which tab of that platform's pages it reads, as it turns the
 * language aliases off (termGroups): neither the Android trail nor its start
 * page's title says Java. Beside a framework name it is part of the name
 * ("next js setup") and still counts.
 */
export function docSetGroupIndexes(groups: string[][], terms: string[]): number[] {
  const platformNamed = terms.some((t) => t.split("-").some((w) => PLATFORM_WORDS.has(w)));
  return groups.flatMap((g, i) => {
    if (!g.some(isDocSetTerm)) return [];
    if (platformNamed && g.every((t) => LANGUAGE_WORDS.has(t))) return [];
    if (g.every((t) => isStrayPlatformPart(t, terms))) return [];
    return [i];
  });
}

// Platforms and web frameworks a start page's title can name ("Astro
// Integration", "Next.js Integration", "React.js Integration"): the React UI
// Kit has one start page per framework, all on the React trail. A query that
// does not name a framework asks for none of them in particular, so the start
// page titled with one it does not name ("next" for "react ui kit install")
// is not the one it asks for; React.js Integration, whose "react" the query
// holds, is. Languages are not frameworks here: the "js" of "React.js" says
// nothing about which page.
// "native" counts too: "React Native CLI Integration" is not React's start
// page, and "react ui kit v5 install" (the React Native UI Kit is also v5)
// must not reach it.
const TITLE_PLATFORM_WORDS = new Set([...PLATFORM_WORDS, ...JS_FRAMEWORK_WORDS, "native"]);

/** The words a query names platforms by: its words, and the stem of a run-together name ("nextjs" -> "next"). */
function namedPlatformWords(terms: string[]): Set<string> {
  const named = new Set<string>();
  for (const word of terms.flatMap((t) => t.split(/[-\s]+/))) {
    if (isStrayPlatformPart(word, terms)) continue;
    named.add(word);
    const stem = jsFrameworkStem(word);
    if (stem !== null) named.add(stem);
  }
  return named;
}

/**
 * The platform and framework words a start page's title must not hold for
 * the query to ask for it: every one the query does not name.
 */
export function unnamedPlatformWords(terms: string[]): string[] {
  const named = namedPlatformWords(terms);
  return [...TITLE_PLATFORM_WORDS].filter((w) => !named.has(w));
}

/**
 * The words a page's title key may hold a doc-set term by ("nextjs" is
 * "next" in the title key of "Next.js Integration").
 */
export function titleWordsOf(term: string): string[] {
  return [...namedPlatformWords([term])];
}

/** Whether a query asks only for a doc set's getting-started page: its feature key is one of START_QUERIES. */
// Words a question wraps its request in: "how to install the react ui kit",
// "how do I set up the ios ui kit". MCP clients often send the question whole.
const QUESTION_WORDS = new Set([...STOPWORDS, "to", "for", "in", "into", "on", "of", "using", "our"]);

export function asksForStartPage(text: string): boolean {
  // The words a start page's title may add are not part of what is asked
  // either: "android jetpack compose ui kit setup" asks for a start page.
  const asked = featureKey(text)
    .split(" ")
    .filter((w) => w.length > 0 && !isStartTitleFiller(w) && !QUESTION_WORDS.has(w))
    .join(" ");
  return START_QUERIES.has(asked);
}
