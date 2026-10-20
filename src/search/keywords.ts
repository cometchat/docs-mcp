// Search keywords: the words people use for a feature that its docs page never
// writes ("unsend" for Delete A Message, "blue ticks" for Delivery & Read
// Receipts). The index builder stores them in a `keywords` FTS column, so a
// consumer word matches the page it means, and a query holding one of a
// page's keywords whole ranks that page higher (KEYWORD_BONUS in
// src/search/sqlite.ts). Nothing is rewritten at query time.
//
// The rules match page titles: every SDK version and platform titles a
// feature page the same way, so one rule covers all of its copies. A keyword
// belongs here only when the docs do not already use it for something else:
// "one on one" (203 pages say "one-on-one"), "availability" (stems to
// "avail", 947 pages) or a lone "seen" (every presence page says "last seen")
// would pull these pages into unrelated queries. So would a keyword that is
// an ordinary word or phrase elsewhere: "recall" ("recall api key"), "star"
// ("star rating"), "private chat" (its "private" matches "private group") and
// "online offline" ("offline mode") are qualified or left out. A keyword never
// repeats a word: query words are de-duplicated, so it could never be found
// whole.
//
// Qualifying means adding a word. A ONE-WORD keyword is found whole by any
// query holding that word, whatever else the query asks, so it hands its
// pages the full bonus on queries about something else entirely: "favourite"
// gave the Save-a-Message pages the whole top of "favourite reactions", a
// phrase three UI Kit pages use for their quick-reaction row. Only a coinage
// the docs use for nothing else ("unsend", "unsent", "dm") may stand alone;
// every ordinary word carries the noun it qualifies ("starred messages",
// "retract a message"). One word of a multi-word keyword still matches the
// page through the FTS column, at KEYWORD_WEIGHT rather than the bonus.
//
// Pages docs.json does not list get none (web-shared/, web-elements/, the
// retired Kotlin UI Kit): the words should lead to the pages the docs site
// navigates to.
//
// An OpenAPI reference page gets the coinages only, unless it is a reference
// stub. It had none at all, and then "unsend a message rest api" could not
// reach /rest-api/messages/delete-message at any limit: the SDK pages that do
// carry "unsend" made the strict AND non-empty and suppressed the OR fallback
// that used to answer it. The coinages fixed that query and no other: a
// multi-word keyword names the same endpoint ("retract a message rest api"),
// but no word of it reached the stub, which then missed two of the query's
// MATCH terms and fell out of relaxed matching as well.
//
// A longer OpenAPI page still gets the coinages only: it has text of its own
// to be found by, and one word of a multi-word keyword lands in a short
// document and outscores every page that word belongs to — "favourite", from
// "favourite message", put the REST Save Message endpoint third on "favourite
// reactions". A stub has no text of its own at all, so the keywords are the
// only way to it and the same leak is far worse; what holds it back is a
// ranking rule rather than an empty keywords column (the stub factor in
// src/search/sqlite.ts), which keeps its keywords for the queries that name
// the REST API and takes them away from the rest.
//
// Kept free of package dependencies (phrasing.ts is too): the builder runs as a
// child process in the container.

import { isStartPageTitle } from "./phrasing.js";

/** `title` tests a page title: a RegExp, or a named test (its `toString` is what the builder reports). */
export type FeatureKeywords = {
  /** Tests the page title; a named test may also read the page path (`toString` is what the builder reports). */
  title: { test(title: string, path?: string): boolean; toString(): string };
  keywords: string[];
};

/**
 * What a doc set's getting-started page is asked for by, whatever its title
 * says (isStartPageTitle in src/search/phrasing.ts): without them the iOS UI
 * Kit's "iOS Integration" could not match "ios ui kit getting started" at all.
 * The first is also how the search tells a start page (see the start-page
 * bonus in src/search/sqlite.ts), and a start query's one-word start term
 * ("setup", "install") also matches it there (startTermGroups), so the
 * ordinary single words never sit in the keywords column, where every query
 * holding them ("install", "widget install") would match the start pages.
 */
export const START_PAGE_KEYWORDS = ["getting started", "get started", "quick start", "set up"];
export const START_PAGE_KEYWORD = START_PAGE_KEYWORDS[0];

/**
 * Indexed text below which a page is a reference stub: an OpenAPI endpoint
 * page of a line or two, whose own words cannot answer anything. The floor is
 * well clear of the shortest page that earns keywords honestly (846 characters
 * at the pinned docs commit) and well above the stubs (50 and 172).
 */
export const REFERENCE_STUB_BODY = 400;

export const FEATURE_KEYWORDS: FeatureKeywords[] = [
  {
    title: { test: isStartPageTitle, toString: () => "isStartPageTitle" },
    keywords: START_PAGE_KEYWORDS,
  },
  {
    title: /^delete (a )?messages?$/i,
    keywords: [
      "unsend",
      "unsent",
      "recall message",
      "recall a message",
      "retract message",
      "retract a message",
      "delete for everyone",
    ],
  },
  {
    title: /^(user )?presence$/i,
    keywords: ["last seen", "last online", "is online", "online status"],
  },
  {
    title: /^(delivery (&|and) read receipts|receipts?)$/i,
    keywords: ["seen status", "message seen", "read status", "message was read", "blue ticks", "double ticks"],
  },
  {
    // "typing events" and "typing indicator" are not consumer words for a
    // feature the docs write differently -- they are how people write this
    // page's own name. They are needed because the index is tokenized with the
    // porter stemmer, which folds "typing" into "type": the query word that
    // should pick this page out reaches every page that says "type", "types"
    // or "typed" instead, and those outrank it on a query that spells no
    // keyword out ("react native sdk listen for typing events" put
    // /sdk/react-native/reactions first, a page that never says "typing"). The
    // keyword bonus is the one signal the stemmer cannot blunt: it is a
    // literal test on the query text, not an FTS lookup. "typing indicator"
    // also closes the plural gap the exact title match leaves, the title being
    // "Typing Indicators".
    title: /^typing indicators?$/i,
    keywords: [
      "is typing",
      "user is typing",
      "typing bubble",
      "typing status",
      "typing dots",
      "typing events",
      "typing indicator",
    ],
  },
  {
    title: /^(building a )?one-to-one \/ group chat$|^send (a )?messages?$/i,
    keywords: ["dm", "direct message"],
  },
  {
    // The UI Kit component that shows who a message reached. The Receipts rule
    // above covers the SDK API; nothing covered the component people see, so
    // none of the consumer words for it led anywhere.
    title: /^message information$/i,
    keywords: ["who has seen", "who read this", "delivery details"],
  },
  {
    title: /^(save (a )?message|saved messages|pin (&|and) save messages)$/i,
    keywords: [
      "star message",
      "star a message",
      "starred message",
      "starred messages",
      "bookmark message",
      "bookmark a message",
      "favorite message",
      "favourite message",
    ],
  },
];

/**
 * A keyword as the search compares it with query text: lowercase words split
 * the way query terms are ("one-to-one" -> "one to one").
 */
export function normalizeKeyword(k: string): string {
  return k.toLowerCase().replace(/-/g, " ").replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The rules a page's title earns. None, when there is usable navigation, for a
 * page docs.json does not list (`listed` false). `path`: the page's URL path,
 * which the start-page rule also reads.
 */
export function keywordRules(title: string, opts: { listed?: boolean; path?: string } = {}): FeatureKeywords[] {
  if (opts.listed === false) return [];
  return FEATURE_KEYWORDS.filter((rule) => rule.title.test(title.trim(), opts.path));
}

/**
 * The keywords stored for a page, as a JSON array: those its title earns. The
 * FTS column tokenizes the JSON text as words. `listed`: whether docs.json
 * navigation lists the page (true when there is no usable navigation).
 * `openapi`: an OpenAPI reference page, which keeps the coinages only unless
 * `stub` says its indexed text is shorter than REFERENCE_STUB_BODY, in which
 * case the keywords are the only words it can be found by.
 */
export function pageKeywords(
  title: string,
  opts: { openapi?: boolean; stub?: boolean; listed?: boolean; path?: string } = {},
): string {
  const words = new Set<string>();
  for (const rule of keywordRules(title, opts)) {
    for (const k of rule.keywords) {
      const keyword = normalizeKeyword(k);
      if (!opts.openapi || opts.stub || !keyword.includes(" ")) words.add(keyword);
    }
  }
  words.delete("");
  return JSON.stringify([...words]);
}
