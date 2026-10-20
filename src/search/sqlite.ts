import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { logger } from "../lib/logger.js";
import { snippet, SEARCH_MAX_RESULTS } from "../lib/truncate.js";
import { BackendError } from "../lib/errors.js";
import { queryVersionLabel, queryVersionWord } from "./version.js";
import { REFERENCE_STUB_BODY, START_PAGE_KEYWORD, START_PAGE_KEYWORDS } from "./keywords.js";
import {
  areaTerms,
  START_QUERIES,
  asksForStartPage,
  contentTerms,
  excludedPlatformNames,
  featureKey,
  indexedTitleKey,
  docSetGroupIndexes,
  isPlatformTerm,
  isStrayPlatformPart,
  termGroups,
  titleWordsOf,
  unnamedPlatformWords,
  titleKey,
  titleKeyWords,
} from "./phrasing.js";
import type { SearchClient, SearchResponse, SearchResult } from "./types.js";

type RankedRow = {
  id: number;
  title: string;
  url: string;
  section: string;
  version: string | null;
  isCurrent: number;
  body: string;
  rank: number;
};

type SearchParams = {
  match: string;
  version: string | null;
  limit: number;
  legacyFactor: number;
  /** JSON array of the version labels the query names, or null. */
  named: string | null;
  terms: number;
  /** The query's terms as " term term ", to find whole page titles and keywords in it; null without terms. */
  titleText: string | null;
  /** The query's title keys (see titleKeyText); null without terms. */
  titleKey: string | null;
  /** 1 when the query only names a doc set ("ios sdk", "react native ui kit"; see indexedTitleKey), else 0. */
  docSetQuery: number;
  /** The query's feature key (see featureKey): its words minus the doc set it names. */
  featureKey: string;
  /** The query's words two spaces apart, in the order written, to find a title's words in order. */
  titleWords: string;
  /** MATCH terms that name neither a platform nor a doc set, at least 1; only indexes with keywords read it. */
  topicTerms?: number;
  /** JSON array of the docs areas the query names (see areaTerms); only indexes with keywords read it. */
  areaTerms?: string;
  /** JSON array of the MATCH terms as FTS expressions; only indexes with product trails read it. */
  phrases?: string;
  /** 1 when the query asks only for a doc set's getting-started page (asksForStartPage); only indexes with keywords read it. */
  startQuery?: number;
  /** 1 when startTermGroups widened a start word to the start-page keyword; only indexes with keywords read it. */
  startWidened?: number;
  /** JSON array of {i, words}: each term naming the doc set (docSetGroupIndexes), its index in $phrases and its title words; only indexes with product trails read it. */
  docSetGroups?: string;
  /** JSON array of the platform words the query does not name (unnamedPlatformWords); only indexes with product trails read it. */
  unnamedPlatforms?: string;
};
type CountParams = { match: string; version: string | null };
/**
 * Relaxed matching (see RELAX_MIN_TERMS): `all` is a JSON array of every MATCH
 * term, and a page qualifies holding all but one.
 */
type RelaxedParams = SearchParams & { all: string; relaxedFactor: number };
type RelaxedCountParams = CountParams & { all: string; terms: number };
type SnippetParams = { match: string; id: bigint };

// Ranking, tuned on the golden queries in scripts/eval-search.ts and checked on
// held-out queries; these values sit mid-plateau (title 3-8, section 0.5-1,
// boost 2-4 all pass). bm25 weights follow the FTS column order (title, body,
// section, keywords, languages). The constants from KEYWORD_WEIGHT on were
// tuned on the eval's ISSUE_CASES, so its pass rate on those cases is
// in-sample: check a change to them on queries they were not tuned on too.
//
// FTS5's bm25 adds up a term's weighted count across columns before saturating
// it, then normalizes by the length of the whole row. A heavily weighted
// section label ("UI Kit / Vue") saturates every page of the product a query
// names, so the shortest pages won whatever their body said. The section
// therefore counts in bm25 like one more occurrence of a term (so SDK pages
// that never repeat "android" still match it), and the product match is a
// bounded multiplier: up to 1 + SECTION_BOOST when the page's product matches
// every query term. The product is its docs.json navigation trail ("Chat &
// Messaging / UI Kit Builder / React"), not the folder label: /chat-builder/
// pages document the UI Kit Builder, so "ui kit builder" must not favour
// every /ui-kit/ page over them.
const TITLE_WEIGHT = 5;
const BODY_WEIGHT = 1;
const SECTION_WEIGHT = 1;
const SECTION_BOOST = 2;
// Search keywords (src/search/keywords.ts) make a consumer word ("unsend",
// "blue ticks") match the page it means; the whole-keyword bonus below does
// the ranking. Their weight mostly decides how far one word of a keyword
// reaches: at 3 or more, "direct" (from "direct message") lifts One-to-One
// Chat into "ios direct calling".
const KEYWORD_WEIGHT = 2;
// The languages of a page's code examples count like body text.
const LANGUAGE_WEIGHT = BODY_WEIGHT;
// A query holding one of a page's keywords whole ("typing bubble") asks for
// that page, but bm25 cannot say so when every query word is common: pages
// that repeat both words saturate as fully as the page the keyword names. The
// bonus must also beat the up-to-2x a page earns when its own folder label
// names half the query ("Web Elements / Text-Bubble" for "typing bubble").
// Like the title-key bonus, it applies only at full weight: older copies carry
// the same keywords, and the bonus would cancel their legacy factor.
const KEYWORD_BONUS = 3;
// The bonus says "the query asks for this keyword", so the keyword has to be
// most of what the query asks. Held whole inside a longer question it is an
// aside, and at 3x it outranked the product the rest of the query named:
// "direct message push notification ios" led with the iOS SDK's Send Messages
// (keyword "direct message") and put iOS APNs Push Notifications second. A
// keyword therefore earns the bonus only when it spans all but one of the
// query's topic terms -- its terms that name neither a platform nor a doc set,
// so "typing bubble react native" still qualifies. Counting the keyword's own
// words is the looser side of that test (the keyword may spend a word on a
// stopword the topic terms drop, as "user is typing" does), which is what
// keeps the short consumer phrasings the keywords exist for.
const KEYWORD_BONUS_SPARE_TERMS = 1;
// The bonus goes to pages that explain the feature, not to reference stubs
// (REFERENCE_STUB_BODY in src/search/keywords.ts). An OpenAPI endpoint page is
// a line or two of text, which bm25 already ranks far above a guide on the rare
// keyword term; handed the bonus as well, it took rank 1 on a bare "unsend a
// message" from every SDK's Delete A Message. Its keywords still sit in the FTS
// column, so a query that asks for the REST API ("unsend a message rest api")
// reaches it — that is the ranking the keywords exist to fix.
const KEYWORD_BONUS_MIN_BODY = REFERENCE_STUB_BODY;
// What a reference stub ranks at when the query does not name its area. The
// stub carries its feature's consumer words (keywords.ts) because they are the
// only words it can be found by: its own text is a line or two, so "retract a
// message rest api" otherwise missed two of the query's MATCH terms on the REST
// Delete Message page and could not reach it at any limit. But a document that
// short turns each of those words into a match no guide can outscore, and one
// word is enough: "favourite", from "favourite message", took rank 1 of
// "favourite notification" from the notification pages. So the stub keeps them
// only for a query that names the area its section states ("rest api", against
// "REST API / Messages"), which is the query the words were added for; every
// other query ranks it here, behind the pages the word belongs to. Demoting
// like a legacy page rather than dropping it: a stub the query really names by
// title ("delete a message rest api") still holds its area words and is not
// demoted at all.
//
// bm25 normalizes by row length, so how far the stub has to fall depends on
// how much shorter than its rivals it is, and the few-page fixtures of the
// tests are the harshest case: from 0.25 to 0.35 they and the docs both rank
// every query set the same way, at 0.5 the shortest fixture lets the stub lead
// a bare "unsend a message", and by 0.85 so do the real docs.
const STUB_OFF_AREA_FACTOR = 0.3;
// Older doc versions outnumber current ones and their pages are shorter, so
// plain bm25 ranked them first. bm25 is negative (lower = better): scaling a
// legacy page's score toward zero ranks it below a comparably relevant current
// page without hiding a legacy page that is clearly the better match. Anything
// from 0.3 to 0.7 ranks the golden set identically. When the query names a
// version, the same factor instead demotes pages of every other version.
const LEGACY_FACTOR = 0.5;
// A query holding a page's whole multi-word title ("angular ui kit message
// list" / "Message List") names that page, but such titles are made of words
// nearly every page of the product uses, so title weight alone cannot lift it
// above shorter pages. One-word titles ("Theme", "Overview") match too many
// queries to count. On the held-out queries: 10 better, 8 worse, the worse by
// one to two places.
//
// Titles are also compared by their title keys (src/search/phrasing.ts),
// without punctuation, "and" or articles: "delivery and read receipts" names
// "Delivery & Read Receipts", and "iOS delete a message" the iOS "Delete
// Message". Only a page ranked at full weight (current, or of the version the
// query names) gets this looser match. Older copies of a page keep the exact
// rule, or the bonus would cancel the legacy factor and lift them above other
// current pages. The query's key holds its words and then its words without
// stopwords, so "delete my message" names "Delete Message" too.
const TITLE_PHRASE_BONUS = 2;
// Which pages that rule can reach. A one-word title is normally an ordinary
// word ("Theme", "Overview") that half the queries about a product hold, so it
// earns nothing -- but a compound identifier is not a word. The API reference
// pages are titled after the API they document ("SessionSettingsBuilder",
// "MessageTemplate", "UIKitSettings"), and only a query naming that API holds
// the token. The page also needs it more than a prose-titled one: since the
// API names in inline code are indexed (see inlineCodeText in
// scripts/build-index.ts), every page of a doc set that calls the API holds
// its name, while the reference page that defines it is the longest page of
// the set -- and bm25 normalizes by row length, so the one occurrence in a
// 5x-weighted title lost to a few passing mentions in a shorter guide.
//
// The pattern is the COMPOUND_IDENTIFIER of scripts/build-index.ts as GLOB
// (case-sensitive, unlike LIKE): a lowercase-uppercase seam, or an acronym run
// into a word. Titles with a space qualify as before, whatever their shape.
const TITLED_PAGE =
  "(instr(trim(pages.title), ' ') > 0 OR pages.title GLOB '*[a-z0-9][A-Z]*' OR pages.title GLOB '*[A-Z][A-Z][a-z]*')";
// A plain-language question spreads a page's title over filler ("how do I send
// an image message in Flutter" / "Send a Message"): the title key's words are
// all there, in order, but not next to each other, so neither title rule above
// sees them. Such a query used to be answered by the OR fallback, because
// every one of its words was a required MATCH term and no page held them all;
// now that the question words are dropped, the remaining words do match pages
// -- tens of them -- and bm25 ranks the shortest, not the page the title
// names. Midway between no bonus and TITLE_PHRASE_BONUS: words in order with
// gaps is a weaker signal than the whole title, and the two must not tie. Any
// value from 1.2 to 1.75 ranks every query set the same way or better; at 2
// and above a title whose words the query merely spreads out ("Group Item"
// inside "angular ui kit group member item") starts to outrank the page whose
// whole title it holds ("Group Member Item"), which is the whole-title bonus
// being cancelled.
const TITLE_ORDER_BONUS = 1.5;
// The start-page rule's bonus (see startPage in buildQueries). Above the
// whole-title bonus because the start page carries the query's start words
// only in the keywords column, which a start query weighs at zero: against
// an overview that writes "getting started" in its body ("react ui kit
// getting started"), 2 left the start page second. 2.5 and 3 rank every
// query set the same way.
const START_PAGE_BONUS = 2.5;
// A query of RELAX_MIN_TERMS or more words adds words the page that best
// answers it need not contain ("disable" in "delivery and read receipts enable
// disable", "sent" in "iOS edit a sent message"); requiring every word then
// drops that page while pages that happen to repeat all of them stay. When
// some page holds every word, pages missing exactly one join the results,
// ranked RELAXED_FACTOR as high, provided the word they miss does not name a
// platform or doc set (isPlatformTerm in src/search/phrasing.ts: "ios" in "ios
// delete message", so no Android page answers it). They are not demoted when
// the query holds their title's words in order ("edit a sent message" / "Edit
// Message"), unless the title only names the doc set ("iOS SDK": its title
// key is empty). Beside the full matches they join once per title: six
// platform copies of one SDK page must not crowd them out. When every full
// match is an older version, the current pages among them lead, alternating
// with the older ones. Up to RELAX_MAX_TERMS words, each costing one more FTS
// lookup.
export const RELAX_MIN_TERMS = 4;
export const RELAX_MAX_TERMS = 8;
const RELAXED_FACTOR = 0.5;
// Distinct query tokens kept: MATCH and the product boost cost grow with each,
// and a 500-character query of repeated words must not multiply them.
export const MAX_QUERY_TOKENS = 32;
// Tokens of body text around the best-matching passage (FTS5 allows up to 64).
const SNIPPET_TOKENS = 40;
// FTS5's snippet() scores a window at every query-term instance in the page,
// so its cost grows with the square of the instance count: about 3 ms at 1,000
// instances and a second at 16,000. Real pages stay far below this (the most
// any one term occurs in a page is 464); a page above it gets the linear
// excerpt instead of stalling every search that returns it.
export const SNIPPET_MAX_MATCHES = 1000;
// Linear excerpt window around the first match, in characters.
const EXCERPT_BEFORE = 80;
const EXCERPT_AFTER = 210;

export type IndexSchema = {
  /** pages.is_current exists (indexes from builders with docs.json version metadata). */
  versionMetadata: boolean;
  /** trails_fts and pages.trail_id exist (product-trail boost). */
  productTrails: boolean;
  /** pages_fts has a fourth, `keywords` column (search keywords). Older indexes have none, or `version` there. */
  keywords?: boolean;
  /** pages.title_key exists (the looser title match and relaxed matching's title rule). */
  titleKeys?: boolean;
  /** pages_fts has a fifth, `languages` column (the languages of a page's code examples). */
  languages?: boolean;
};

/**
 * Indexes built before version metadata have no is_current column and still
 * index `version` as a fourth FTS column (bm25 weights it at the default 1.0).
 * There, an unversioned path is the best available signal for "current", and
 * the product boost falls back to the section label indexed in pages_fts.
 */
// The page's keywords as a JSON array. An index from another builder may hold
// '' there, and json_each() on it fails the whole query.
const KEYWORDS_JSON = "(CASE WHEN json_valid(pages.keywords) THEN pages.keywords ELSE '[]' END)";

export function buildQueries(schema: IndexSchema) {
  const current = schema.versionMetadata ? "pages.is_current = 1" : "pages.version IS NULL";
  const filter = "pages_fts MATCH $match AND ($version IS NULL OR pages.version = $version)";
  // Query terms the page's product matches. With trails: one FTS lookup per
  // term in the small trails index, counting distinct terms, for the page's
  // navigation trail and its folder section, keeping the better. Without:
  // highlight() inserts one marker per matched term instance in the section column.
  const productHits = schema.productTrails
    ? "max(COALESCE(trail_hits.n, 0), COALESCE(label_hits.n, 0))"
    : "length(highlight(pages_fts, 2, char(1), '')) - length(pages.section)";
  const hits = schema.productTrails
    ? `hits AS MATERIALIZED (
      SELECT trails_fts.rowid AS trail_id, COUNT(*) AS n,
        ',' || group_concat(q.key) || ',' AS keys
      FROM json_each($phrases) AS q
      CROSS JOIN trails_fts
      WHERE trails_fts MATCH q.value
      GROUP BY trails_fts.rowid
    ),`
    : "";
  const versionFactor = `CASE
          WHEN $named IS NULL THEN (CASE WHEN ${current} THEN 1.0 ELSE $legacyFactor END)
          WHEN pages.version IN (SELECT value FROM json_each($named)) THEN 1.0
          ELSE $legacyFactor
        END`;
  const exactTitle = "instr($titleText, ' ' || lower(pages.title) || ' ') > 0";
  // The query holds every word of the page's title key, in order, gaps allowed:
  // $titleWords is the query's words two spaces apart, so ' % ' spans the words
  // between two title words and the literal spaces keep each match whole.
  const inOrderTitle = "$titleWords LIKE '% ' || replace(pages.title_key, ' ', ' % ') || ' %'";
  // A title that only names its doc set (an empty title key: "iOS SDK") earns
  // the exact-title bonus only from a query that names nothing more: "ios sdk
  // typing indicators" holds "iOS SDK" whole, but asks about typing.
  const wholeTitle = schema.titleKeys
    ? `(${exactTitle} AND (pages.title_key <> '' OR $docSetQuery = 1))
              OR ((${versionFactor}) = 1.0 AND instr(pages.title_key, ' ') > 0
                  AND instr($titleKey, ' ' || pages.title_key || ' ') > 0)`
    : exactTitle;
  // The rule above reads a title out of a longer query, so it needs a titled
  // page (TITLED_PAGE). A query compared with the doc set it names taken away
  // needs no such guard, and is the one way a plain one-word title earns the
  // bonus: once "angular ui kit" is removed from "angular ui kit guides" the
  // query IS the title "Guides", so it asks for nothing else. featureKey is
  // empty for a query that names no doc set ("moderation"), which would
  // otherwise hand the bonus to any page titled with that one word over the
  // getting-started page the query usually wants.
  const featureTitle = `(${versionFactor}) = 1.0 AND pages.title_key <> '' AND pages.title_key = $featureKey`;
  // A query asking only for a doc set's getting-started page ("ios ui kit
  // getting started", "react ui kit install") names the start page as surely
  // as a query holding its title, but start pages are titled every which way
  // ("iOS Integration", "Setup"; see isStartPageTitle in
  // src/search/phrasing.ts), so the builder marks them with
  // START_PAGE_KEYWORDS and they earn the whole-title bonus here. At full
  // weight only, like the other title-key rules: the older copies are start
  // pages too, and the bonus must not cancel their legacy factor.
  //
  // Only the start page of a doc set the query names, though: every doc set
  // has one, and a page whose product is another ("Expo Integration", or the
  // iOS Calls SDK's "Setup", for "ios ui kit getting started") only matched
  // because its body mentions the platform. Its product, trail or folder
  // label, must hold every term naming the doc set (docSetGroupIndexes); a
  // query naming none asks for any start page.
  // A framework is named in the start page's title rather than its trail
  // ("Next.js Integration" on the React trail), so a term the title key holds
  // counts too ($docSetGroups: each doc-set term's index in $phrases and the
  // title words it may appear as) -- once the product holds one of the terms:
  // the title narrows a doc set the query names, it does not name one. "next
  // js setup" names no product's trail, and the start pages titled "Next.js
  // Integration" (React UI Kit, Calls SDK) do not answer it over the UI Kit
  // Builder's Next.js pages. And a start page whose title names a
  // platform or framework the query does not ($unnamedPlatforms; see
  // unnamedPlatformWords in src/search/phrasing.ts) is another framework's:
  // "Astro Integration" for "react ui kit install".
  //
  // On such a query a start page it passes over gets no other title rule,
  // unless it is current and its title holds every term naming the doc set:
  // "ionic integration" names "Ionic Integration" by its title though no
  // trail says Ionic, but "react ui kit getting started" does not name the
  // moderation "Getting Started". An older start page gets none: they are
  // mostly titled plain "Getting Started", which the query holds whole; the
  // exact-title rule then doubled them and cancelled their legacy factor,
  // while the current page, retitled "iOS Integration", earned nothing, so
  // /ui-kit/ios/v4/getting-started led "ios ui kit getting started". A query
  // naming a version still ranks its start page at full weight.
  const isStartPage = `EXISTS (SELECT 1 FROM json_each(${KEYWORDS_JSON}) AS s WHERE s.value = '${START_PAGE_KEYWORD}')`;
  const titleWords = "' ' || pages.title_key || ' '";
  const productHolds = (g: string) => `(instr(COALESCE(trail_hits.keys, ''), ',' || json_extract(${g}.value, '$.i') || ',') > 0
                       OR instr(COALESCE(label_hits.keys, ''), ',' || json_extract(${g}.value, '$.i') || ',') > 0)`;
  // The doc set a feature-key query names is the one whose page it asks for:
  // once "ionic" is taken from "ionic integration", the notifications pages
  // titled "Integration" are not what is left, their product says nothing of
  // Ionic. So the feature-title rule asks the page's product to hold every
  // doc-set term, as the start-page rule does but without the title.
  const titleHoldsDocSet = `json_array_length($docSetGroups) > 0 AND NOT EXISTS (
                     SELECT 1 FROM json_each($docSetGroups) AS t
                     WHERE NOT EXISTS (
                       SELECT 1 FROM json_each(json_extract(t.value, '$.words')) AS w
                       WHERE instr(' ' || pages.title_key || ' ', ' ' || w.value || ' ') > 0
                     )
                   )`;
  const productHoldsDocSet = `NOT EXISTS (
                     SELECT 1 FROM json_each($docSetGroups) AS f WHERE NOT ${productHolds("f")}
                   )`;
  const holdsDocSet = `(json_array_length($docSetGroups) = 0 OR EXISTS (
                     SELECT 1 FROM json_each($docSetGroups) AS p WHERE ${productHolds("p")}
                   ))
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each($docSetGroups) AS g
                     WHERE NOT ${productHolds("g")}
                       AND NOT EXISTS (
                         SELECT 1 FROM json_each(json_extract(g.value, '$.words')) AS w
                         WHERE instr(${titleWords}, ' ' || w.value || ' ') > 0
                       )
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each($unnamedPlatforms) AS u
                     WHERE instr(${titleWords}, ' ' || u.value || ' ') > 0
                   )`;
  const startPage = schema.keywords && schema.productTrails
    ? `
            WHEN $startQuery = 1 AND ${isStartPage}
                 AND (${versionFactor}) = 1.0 AND ${holdsDocSet} THEN ${START_PAGE_BONUS}
            WHEN $startQuery = 1 AND ${isStartPage}
                 AND NOT ((${versionFactor}) = 1.0 AND ${titleHoldsDocSet}) THEN 1.0`
    : "";
  const titleBonus = `(CASE${startPage}
            WHEN ${TITLED_PAGE} AND (${wholeTitle}) THEN ${TITLE_PHRASE_BONUS}${
              schema.titleKeys
                ? `
            WHEN ${featureTitle}${schema.productTrails ? ` AND ${productHoldsDocSet}` : ""} THEN ${TITLE_PHRASE_BONUS}
            WHEN (${versionFactor}) = 1.0 AND instr(pages.title_key, ' ') > 0
                 AND ${inOrderTitle} THEN ${TITLE_ORDER_BONUS}`
                : ""
            }
            ELSE 1.0 END)`;
  // A page missing one term ranks $relaxedFactor as high, unless the query
  // holds its title's words in order ("edit a sent message" and "Edit
  // Message"): then the missing word only qualifies the page asked for.
  const relaxedFactor = schema.titleKeys
    ? `(CASE WHEN (${versionFactor}) = 1.0 AND instr(pages.title_key, ' ') > 0
              AND ${inOrderTitle}
            THEN 1.0 ELSE $relaxedFactor END)`
    : "$relaxedFactor";
  // Words of a keyword: they are normalized to single spaces (normalizeKeyword
  // in src/search/keywords.ts), so the spaces count them.
  const keywordWords = "length(k.value) - length(replace(k.value, ' ', '')) + 1";
  // The page's section as whole words, for the area test below: "REST API /
  // Messages" -> " rest api messages ", so " api " matches it and " apis "
  // (folded to " api " in areaTerms) does too, while " ap " does not.
  const sectionWords = "' ' || replace(replace(lower(pages.section), '/', ' '), '-', ' ') || ' '";
  const namesArea = `EXISTS (
                  SELECT 1 FROM json_each($areaTerms) AS a
                  WHERE instr(${sectionWords}, ' ' || a.value || ' ') > 0
                     OR instr(${sectionWords}, ' ' || a.value || 's ') > 0
                )`;
  // The start-page keywords earn the start-page bonus above, which asks the
  // page's product to hold the query's platform; as plain keywords they would
  // hand every start page in the docs KEYWORD_BONUS on "flutter getting
  // started", the Email and SMS notification "Integration" pages included.
  const startKeywords = START_PAGE_KEYWORDS.map((k) => `'${k}'`).join(", ");
  const keywordBonus = schema.keywords
    ? `
          * (CASE WHEN (${versionFactor}) = 1.0 AND pages.keywords <> '[]'
                AND length(pages.body) >= ${KEYWORD_BONUS_MIN_BODY} AND EXISTS (
                SELECT 1 FROM json_each(pages.keywords) AS k
                WHERE instr($titleText, ' ' || k.value || ' ') > 0
                  AND ${keywordWords} >= $topicTerms - ${KEYWORD_BONUS_SPARE_TERMS}
                  AND k.value NOT IN (${startKeywords})
              ) THEN ${KEYWORD_BONUS} ELSE 1.0 END)
          * (CASE WHEN length(pages.body) < ${REFERENCE_STUB_BODY}
                -- A stub is short and carries feature keywords; the start-page
                -- keywords mark a start page, not a stub, however short.
                AND EXISTS (SELECT 1 FROM json_each(${KEYWORDS_JSON}) AS sk WHERE sk.value NOT IN (${startKeywords}))
                AND NOT ${namesArea} THEN ${STUB_OFF_AREA_FACTOR} ELSE 1.0 END)`
    : "";
  const weights = [
    TITLE_WEIGHT,
    BODY_WEIGHT,
    SECTION_WEIGHT,
    // When a start query's start word is widened to the start-page keyword
    // (startTermGroups), the keywords column only lets the start pages match:
    // every start page holds the keyword, the ones the query names and the
    // rest alike, and a phrase that rare weighs so much in bm25 that other doc
    // sets' start pages ("React Native CLI Integration" for "react ui kit
    // install") outranked ordinary matches. The start-page bonus does the
    // ranking instead. A query writing "getting started" itself keeps the
    // weight: there the keyword is the query's own words.
    ...(schema.keywords ? [`(CASE WHEN $startWidened = 1 THEN 0 ELSE ${KEYWORD_WEIGHT} END)`] : []),
    ...(schema.keywords && schema.languages ? [LANGUAGE_WEIGHT] : []),
  ].join(", ");
  // MATCH terms each page holds, for relaxed matching: one FTS lookup per term.
  // The queries using it CROSS JOIN it after pages_fts, keeping the ranked
  // MATCH the outer loop: joined the other way, FTS5 evaluated the MATCH (and
  // bm25's term statistics) once per page, 100 ms for common words.
  const cov = `cov AS MATERIALIZED (
      SELECT pages_fts.rowid AS id, COUNT(*) AS n
      FROM json_each($all) AS q
      CROSS JOIN pages_fts
      WHERE pages_fts MATCH q.value
      GROUP BY pages_fts.rowid
    ),`;
  // Rank ids first; the outer query then reads only the returned pages (a
  // body in the sorter would be copied for every matching row), and snippets
  // come from a per-page statement. The relaxed variant keeps pages holding
  // all MATCH terms but one ($terms - 1), ranked $relaxedFactor as high.
  const searchSql = (relaxed: boolean) => `
    WITH ${hits} ${relaxed ? cov : ""} ranked AS (
      SELECT
        pages.rowid AS id,
        bm25(pages_fts, ${weights})
          -- min() is what keeps the multiplier inside [1, 1 + SECTION_BOOST].
          -- With product trails productHits is a COUNT(*) grouped by trail
          -- rowid over json_each($phrases), so it cannot exceed $terms and the
          -- min() is belt and braces. Without them it counts highlight()
          -- markers in the section column, one per matched term INSTANCE:
          -- section 'Chat / Chat SDK / Chat Widget' scores 3 for the single
          -- term "chat", and unclamped that page's multiplier would be 7.
          * (1.0 + ${SECTION_BOOST} * CAST(min(${productHits}, $terms) AS REAL) / $terms)
          * (${versionFactor})
          * ${titleBonus}${keywordBonus}${relaxed ? `\n          * ${relaxedFactor}` : ""} AS rank
      FROM pages_fts
      JOIN pages ON pages.rowid = pages_fts.rowid
      ${
        schema.productTrails
          ? `LEFT JOIN hits AS trail_hits ON trail_hits.trail_id = pages.trail_id
      LEFT JOIN hits AS label_hits ON label_hits.trail_id = pages.label_id`
          : ""
      }
      ${relaxed ? "CROSS JOIN cov ON cov.id = pages.rowid" : ""}
      WHERE ${filter}${relaxed ? " AND cov.n = $terms - 1" : ""}
      -- pages.url breaks ties: without it equal-scoring rows come back in
      -- rowid order, which is the order the builder happened to walk the docs
      -- checkout in, so two index generations can answer the same query
      -- differently and a check on a tie boundary passes or fails by chance.
      ORDER BY rank, pages.url
      LIMIT $limit
    )
    SELECT
      ranked.id,
      pages.title,
      pages.url,
      pages.section,
      pages.version,
      (${current}) AS isCurrent,
      pages.body,
      ranked.rank
    FROM ranked
    CROSS JOIN pages ON pages.rowid = ranked.id
    ORDER BY ranked.rank, pages.url
  `;
  // rowid = $id lets FTS5 seek the one page instead of scanning every match.
  const snippetSql = `
    SELECT snippet(pages_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS snippet
    FROM pages_fts
    WHERE pages_fts MATCH $match AND pages_fts.rowid = $id
  `;
  const count = `
    SELECT COUNT(*) AS total
    FROM pages_fts
    JOIN pages ON pages.rowid = pages_fts.rowid
    WHERE ${filter}
  `;
  // Whether any match is current, beyond the ranked page of results.
  const anyCurrent = `
    SELECT 1 AS found
    FROM pages_fts
    JOIN pages ON pages.rowid = pages_fts.rowid
    WHERE ${filter} AND ${current}
    LIMIT 1
  `;
  const relaxedCount = `
    WITH ${cov.slice(0, -1)}
    SELECT COUNT(*) AS total
    FROM pages_fts
    JOIN pages ON pages.rowid = pages_fts.rowid
    CROSS JOIN cov ON cov.id = pages.rowid
    WHERE ${filter} AND cov.n = $terms - 1
  `;
  return { search: searchSql(false), relaxed: searchSql(true), snippet: snippetSql, count, anyCurrent, relaxedCount };
}

type Prepared = {
  db: Database.Database;
  schema: IndexSchema;
  /** Version labels some page carries; a version named in a query counts only if listed. */
  versionLabels: Set<string>;
  searchStmt: Database.Statement<[SearchParams], RankedRow>;
  snippetStmt: Database.Statement<[SnippetParams], { snippet: string | null }>;
  countStmt: Database.Statement<[CountParams], { total: number }>;
  anyCurrentStmt: Database.Statement<[CountParams], { found: number }>;
  /** Relaxed matching; null for indexes built before docs.json navigation (no product trails). */
  relaxedStmt: Database.Statement<[RelaxedParams], RankedRow> | null;
  relaxedCountStmt: Database.Statement<[RelaxedCountParams], { total: number }> | null;
};

export class SqliteSearchClient implements SearchClient {
  private prepared: Prepared | null = null;
  private warned = false;

  constructor(private indexPath: string) {}

  /** Path of the index currently being served. */
  currentPath(): string {
    return this.indexPath;
  }

  /**
   * Point the client at a different index file (in-container hot refresh).
   * Safe without draining: better-sqlite3 is synchronous, so a query either
   * has completed or has not started — it can never be suspended mid-flight
   * across the tick on which this runs.
   */
  swapTo(newPath: string): void {
    const previous = this.prepared;
    this.prepared = null;
    this.indexPath = newPath;
    this.warned = false;
    previous?.db.close();
  }

  /** Row count of the served index; used to validate refresh candidates. */
  pageCount(): number | null {
    try {
      const row = this.open().db.prepare("SELECT COUNT(*) AS n FROM pages").get() as
        | { n: number }
        | undefined;
      return row?.n ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Pages of the served index versioned by docs.json navigation; used to
   * validate refresh candidates. Null for an index without the product column,
   * or when there is no index to open.
   */
  navigationPageCount(): number | null {
    try {
      const row = this.open().db.prepare("SELECT COUNT(*) AS n FROM pages WHERE product IS NOT NULL").get() as
        | { n: number }
        | undefined;
      return row?.n ?? null;
    } catch {
      return null;
    }
  }

  isReady(): boolean {
    return this.prepared !== null || existsSync(this.indexPath);
  }

  indexAgeSeconds(): number | null {
    try {
      const s = statSync(this.indexPath);
      const ageMs = Date.now() - s.mtimeMs;
      return Math.max(0, Math.floor(ageMs / 1000));
    } catch {
      return null;
    }
  }

  private open(): Prepared {
    if (this.prepared) return this.prepared;
    if (!existsSync(this.indexPath)) {
      throw new BackendError(
        `Search index not found at ${this.indexPath}. Run \`npm run build:index\` against a clone of cometchat/docs first.`,
      );
    }
    // No journal-mode pragma here: changing journal modes writes to the
    // database, which fails on a read-only index mount (SQLITE_READONLY_DIRECTORY).
    const db = new Database(this.indexPath, { readonly: true, fileMustExist: true });
    try {
      const columns = new Set((db.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).map((c) => c.name));
      const trailsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trails_fts'").get();
      const ftsColumns = (db.prepare("PRAGMA table_info(pages_fts)").all() as { name: string }[]).map((c) => c.name);
      const schema: IndexSchema = {
        versionMetadata: columns.has("is_current"),
        productTrails: columns.has("trail_id") && columns.has("label_id") && trailsTable !== undefined,
        keywords: ftsColumns[3] === "keywords" && columns.has("keywords"),
        titleKeys: columns.has("title_key"),
        languages: ftsColumns[4] === "languages",
      };
      // An index from an older builder is served, without the search text
      // this code ranks by; say so once, or the fixes seem to do nothing.
      const missing = [
        ...(schema.keywords ? [] : ["keywords"]),
        ...(schema.titleKeys ? [] : ["title_key"]),
        ...(schema.languages ? [] : ["languages"]),
      ];
      if (missing.length > 0) logger.warn({ indexPath: this.indexPath, missing }, "sqlite_index_outdated");
      const relax = schema.productTrails && columns.has("product");
      const labels = db.prepare("SELECT DISTINCT version FROM pages WHERE version IS NOT NULL").pluck().all() as string[];
      const queries = buildQueries(schema);
      this.prepared = {
        db,
        schema,
        versionLabels: new Set(labels),
        searchStmt: db.prepare(queries.search),
        snippetStmt: db.prepare(queries.snippet),
        countStmt: db.prepare(queries.count),
        anyCurrentStmt: db.prepare(queries.anyCurrent),
        relaxedStmt: relax ? db.prepare(queries.relaxed) : null,
        relaxedCountStmt: relax ? db.prepare(queries.relaxedCount) : null,
      };
    } catch (err) {
      db.close();
      throw err;
    }
    return this.prepared;
  }

  async search(query: string, opts: { version?: string; limit?: number } = {}): Promise<SearchResponse> {
    // Clamped at both ends. SearchInputSchema already holds the MCP tool to 1
    // to 25, but the eval, the lab harnesses and the refresher's smoke test
    // call the client directly, and the page of rows is cut with
    // slice(0, limit), where a negative limit is an offset from the end and
    // returned nearly the whole window.
    const requested = Math.trunc(opts.limit ?? 10);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), SEARCH_MAX_RESULTS) : 10;
    const version = opts.version ?? null;
    const { terms, words, versions } = parseQuery(query);
    // Version labels are metadata, not indexed text, and a page rarely spells
    // out its own version, so a version named in the query ("ios ui kit v4
    // theme") is a ranking preference rather than a required word, unless it is
    // all the query says. Stopwords do not gate MATCH (src/search/phrasing.ts).
    const content = contentTerms(terms);
    const startQuery = terms.length > 0 && asksForStartPage(terms.join(" "));
    let phrases: string[][] = content.length > 0 ? termGroups(content) : versions.map((v) => [v.word]);

    let prepared: Prepared;
    try {
      prepared = this.open();
    } catch (err) {
      if (!this.warned) {
        logger.warn({ indexPath: this.indexPath }, "sqlite_index_unavailable");
        this.warned = true;
      }
      throw err;
    }

    // The start-page keyword lives in the keywords column, which older indexes lack.
    if (prepared.schema.keywords) phrases = startTermGroups(phrases, startQuery);

    // A version filter has already answered "which version": across the
    // products sharing that label, being current is not a relevance signal.
    // Otherwise a version the query names wins over "current" ("upgrade from
    // v4 to v5" asks about the older pages), provided some page carries it.
    const named = version === null ? versions.map((v) => v.label).filter((l) => prepared.versionLabels.has(l)) : [];
    // Relaxed matching merges two ranked pages into one order, so what the
    // merge sees must not be the caller's `limit`: a page cut at 1 and a page
    // cut at 5 disagree about which rows exist, and the merge would answer a
    // different #1 for the same query. Both pages are read at one fixed window
    // and the result is cut to `limit` once, at the end. Without relaxation
    // there is one ranked page and the window is `limit` itself.
    const relaxed = relaxedMatch(prepared, phrases, content);
    const window = relaxed === null ? limit : SEARCH_MAX_RESULTS;
    const base = {
      version,
      limit: window,
      legacyFactor: version === null ? LEGACY_FACTOR : 1,
      named: named.length > 0 ? JSON.stringify(named) : null,
      terms: Math.max(1, phrases.length),
      titleText: terms.length > 0 ? ` ${terms.join(" ").replace(/-/g, " ")} ` : null,
      titleKey: terms.length > 0 ? titleKeyText(terms, content) : null,
      docSetQuery: terms.length > 0 && indexedTitleKey(terms.join(" ")) === "" ? 1 : 0,
      featureKey: featureKey(terms.join(" ")),
      // The query's words in order, repeats included: the LIKE pattern asks for
      // each word of the title key in turn, so a title key that repeats a word
      // ("one to one group chat") needs it twice, which the de-duplicated terms
      // could never supply.
      titleWords: `  ${titleKeyWords(words.join(" ")).join("  ")}  `,
      ...(prepared.schema.keywords
        ? {
            topicTerms: Math.max(1, content.filter((t) => !isPlatformTerm(t)).length),
            areaTerms: JSON.stringify(areaTerms(terms)),
            startQuery: startQuery ? 1 : 0,
            startWidened: phrases.some((g) => g.includes(START_KEYWORD_ALTERNATIVE)) ? 1 : 0,
          }
        : {}),
      ...(prepared.schema.productTrails
        ? {
            phrases: JSON.stringify(phrases.map((g) => productAlternatives(g, content))),
            docSetGroups: JSON.stringify(
              docSetGroupIndexes(phrases, content).map((i) => ({
                i,
                words: phrases[i].filter((t) => !COLUMN_ALTERNATIVE.test(t)).flatMap(titleWordsOf),
              })),
            ),
            // The words as expanded ("swift" -> ios, "rn" -> react native):
            // "swift ui kit getting started" names iOS's start page.
            unnamedPlatforms: JSON.stringify(
              unnamedPlatformWords(phrases.flat().filter((t) => !COLUMN_ALTERNATIVE.test(t))),
            ),
          }
        : {}),
    };
    const runQuery = (match: string) => {
      const rows = prepared.searchStmt.all({ ...base, match });
      // A short page of results is every match; count only when it is full.
      const total = rows.length < window ? rows.length : (prepared.countStmt.get({ match, version })?.total ?? 0);
      return { rows, total };
    };

    try {
      const keys = snippetKeyPattern(phrases.flat().filter((t) => !COLUMN_ALTERNATIVE.test(t)));
      let match = buildFtsQuery(phrases, "AND", query);
      let { rows, total } = runQuery(match);
      // The MATCH each row was found by, for its snippet.
      const matchFor = new Map<number, string>();

      if (rows.length === 0 && phrases.length > 1) {
        match = buildFtsQuery(phrases, "OR", query);
        ({ rows, total } = runQuery(match));
      } else if (rows.length > 0) {
        // Pages missing one term (see RELAX_MIN_TERMS). Beside the full
        // matches they join once per title; the other copies go after them.
        if (relaxed) {
          const all = JSON.stringify(phrases.map(ftsAlternatives));
          const found = prepared.relaxedStmt!.all({
            ...base,
            match: relaxed,
            all,
            relaxedFactor: RELAXED_FACTOR,
          });
          if (found.length > 0) {
            const titles = new Set<string>();
            const joined: RankedRow[] = [];
            const deferred: RankedRow[] = [];
            for (const r of found) {
              matchFor.set(r.id, relaxed);
              const key = titleKey(r.title);
              (titles.has(key) ? deferred : joined).push(r);
              titles.add(key);
            }
            // Every page holding all the terms is an older version, usually
            // because older docs name an API the current ones renamed or write
            // only in code. Nothing asked for an older version, so the current
            // pages missing one term go first, alternating with the older ones.
            // `rows` is only the first window of full matches: a current one
            // may rank below it, so ask the index whether one exists at all.
            const onlyLegacy =
              version === null &&
              named.length === 0 &&
              rows.every((r) => r.isCurrent !== 1) &&
              (rows.length < window || prepared.anyCurrentStmt.get({ match, version }) === undefined);
            let merged = [...rows, ...joined].sort((a, b) => a.rank - b.rank);
            if (onlyLegacy && joined.some((r) => r.isCurrent === 1)) {
              merged = alternate(
                merged.filter((r) => r.isCurrent === 1),
                merged.filter((r) => r.isCurrent !== 1),
              );
            }
            rows = [...merged, ...deferred];
            total +=
              found.length < window
                ? found.length
                : (prepared.relaxedCountStmt!.get({ match: relaxed, version, all, terms: base.terms })?.total ?? 0);
          }
        }
      }

      const results: SearchResult[] = rows.slice(0, limit).map((r) => ({
        title: r.title,
        url: r.url,
        section: r.section,
        snippet: snippet(excerpt(prepared, r, matchFor.get(r.id) ?? match, keys)),
        ...(r.version ? { version: r.version } : {}),
        isCurrent: r.isCurrent === 1,
      }));
      return { results, totalAvailable: total };
    } catch (err) {
      // Never log the query itself: it is caller free text and can carry
      // personal data. Its shape is enough to spot pathological inputs.
      logger.error({ err, queryLength: query.length, tokenCount: phrases.length }, "sqlite_search_failed");
      throw new BackendError();
    }
  }

  close() {
    this.prepared?.db.close();
    this.prepared = null;
  }

}

/** FTS5's best passage, unless the page holds too many term instances for snippet() to stay cheap. */
function excerpt(prepared: Prepared, row: RankedRow, match: string, keys: RegExp | null): string {
  if (keys && countKeyMatches(row.body, keys, SNIPPET_MAX_MATCHES) > SNIPPET_MAX_MATCHES) {
    return linearExcerpt(row.body, keys);
  }
  // BigInt, not number: better-sqlite3 binds a JS number as REAL, and FTS5
  // then silently ignores the rowid constraint and returns every match.
  return prepared.snippetStmt.get({ match, id: BigInt(row.id) })?.snippet ?? "";
}

// A dot between a name and the next one separates the parts of a qualified
// API name ("CometChat.markAsRead", "CometChat.getUser().then", "Next.js");
// the dots of version numbers ("v4.0", "3.0") stay.
const QUALIFIED_NAME_DOT = /(?<=[A-Za-z_)])\.(?=[A-Za-z_])/g;

/**
 * Query words, lowercased and de-duplicated, capped at MAX_QUERY_TOKENS.
 * Version words ('v4', '3.0') come back separately with their canonical label.
 */
export function parseQuery(raw: string): {
  terms: string[];
  /** The same words in the order written, repeats kept: relaxed matching's in-order title rule. */
  words: string[];
  versions: { word: string; label: string }[];
} {
  const terms: string[] = [];
  const words: string[] = [];
  const versions: { word: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const word of raw.replace(/"/g, "").replace(QUALIFIED_NAME_DOT, " ").split(/\s+/)) {
    if (seen.size >= MAX_QUERY_TOKENS) break;
    const label = queryVersionLabel(word);
    const key = label === null ? word.replace(/[^\w-]/g, "").toLowerCase() : `version:${label}`;
    if (key.length === 0) continue;
    if (label === null) words.push(key);
    if (seen.has(key)) continue;
    seen.add(key);
    if (label === null) terms.push(key);
    else versions.push({ word: queryVersionWord(word).toLowerCase(), label });
  }
  return { terms, words, versions };
}

/** A term's alternatives as an FTS5 expression: "js" OR "javascript". */
function ftsAlternatives(group: string[]): string {
  return group
    .map((t) => {
      const column = COLUMN_ALTERNATIVE.exec(t);
      return column ? `${column[1]} : "${column[2]}"` : `"${t}"`;
    })
    .join(" OR ");
}

/**
 * A term's alternatives as the product boost looks them up in the trails: as
 * ftsAlternatives, minus the trails of a longer platform name the query does
 * not write ("react" is not credited to "UI Kits / React Native"; see
 * excludedPlatformNames in src/search/phrasing.ts).
 */
export function productAlternatives(group: string[], terms: string[]): string {
  // The trails index has no keywords column.
  const words = group.filter((t) => !COLUMN_ALTERNATIVE.test(t));
  const excluded = [...new Set(words.flatMap((t) => excludedPlatformNames(t, terms)))];
  if (excluded.length === 0) return ftsAlternatives(words);
  return `(${ftsAlternatives(words)}) NOT (${excluded.map((n) => `"${n}"`).join(" OR ")})`;
}

/**
 * A start query's groups, its one-word start term ("setup", "install") widened
 * to the start-page keyword: the start page asked for need not write the word
 * ("Next.js Integration" never says "setup"), and START_PAGE_KEYWORDS
 * (src/search/keywords.ts) keeps such ordinary words out of the keywords
 * column, so only a start query reaches the start pages through them.
 */
export function startTermGroups(groups: string[][], startQuery: boolean): string[][] {
  if (!startQuery) return groups;
  return groups.map((g) =>
    g.length === 1 && START_QUERIES.has(g[0]) && !g[0].includes(" ") ? [g[0], START_KEYWORD_ALTERNATIVE] : g,
  );
}

// The start-page keyword as a MATCH alternative, in the keywords column only:
// a page whose text says "getting started" is no more a start page than one
// that does not.
const START_KEYWORD_ALTERNATIVE = `keywords:${START_PAGE_KEYWORD}`;
const COLUMN_ALTERNATIVE = /^(keywords):(.*)$/;

function buildFtsQuery(phrases: string[][], op: "AND" | "OR", raw: string): string {
  if (phrases.length === 0) {
    const safe = raw.replace(/[\u0000-\u001f"]/g, " ").trim();
    return safe.length > 0 ? `"${safe}"` : `""`;
  }
  if (op === "OR") return phrases.map(ftsAlternatives).join(" OR ");
  // FTS5 accepts implicit AND only between phrases, not after a parenthesis.
  return phrases.map((g) => (g.length > 1 ? `(${ftsAlternatives(g)})` : ftsAlternatives(g))).join(" AND ");
}

function relaxedMatch(prepared: Prepared, phrases: string[][], terms: string[]): string | null {
  return prepared.relaxedStmt ? relaxedMatchQuery(phrases, terms) : null;
}

/**
 * MATCH for pages missing one term: every platform term (isPlatformTerm, but
 * not a stray part of a longer platform name among `terms`) and at least one
 * other. Null when the query is too short or too long for
 * relaxed matching, or every term names a platform.
 */
export function relaxedMatchQuery(phrases: string[][], terms: string[] = []): string | null {
  if (phrases.length < RELAX_MIN_TERMS || phrases.length > RELAX_MAX_TERMS) return null;
  // "native" without "react" ("native ios ui kit getting started") qualifies
  // the app, not the docs: a page may lack it (isStrayPlatformPart).
  const platform = phrases.filter((g) => g.some((t) => isPlatformTerm(t) && !isStrayPlatformPart(t, terms)));
  const other = phrases.filter((g) => !platform.includes(g));
  if (other.length === 0) return null;
  const required = platform.map((g) => (g.length > 1 ? `(${ftsAlternatives(g)})` : ftsAlternatives(g)));
  return [...required, `(${other.map(ftsAlternatives).join(" OR ")})`].join(" AND ");
}

/** a[0], b[0], a[1], b[1], …, then the rest of the longer list. */
function alternate<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/**
 * The query as title keys are compared with it: the key of its words, then
 * the key of its words without stopwords, " | " between them so a title never
 * spans both.
 */
export function titleKeyText(terms: string[], content: string[]): string {
  return ` ${titleKeyWords(terms.join(" ")).join(" ")} | ${titleKeyWords(content.join(" ")).join(" ")} `;
}

// Suffixes the porter stemmer can remove (steps 1-5), longest first.
const STEM_SUFFIXES = [
  "ational", "ization", "iveness", "fulness", "ousness", "biliti", "tional", "ation", "alism", "aliti", "iviti",
  "icate", "ative", "alize", "iciti", "ement", "entli", "ousli", "ator", "ical", "izer", "ment", "ness", "ance",
  "ence", "able", "ible", "enci", "anci", "abli", "alli", "logi", "ies", "ied", "ing", "ism", "ate", "iti", "ous",
  "ive", "ize", "ion", "ful", "ant", "ent", "eli", "bli", "al", "er", "ic", "ou", "ed", "es", "li", "s", "e", "y",
];

/** A prefix every word sharing `word`'s porter stem is expected to start with. */
function stemKey(word: string): string {
  let key = word;
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const suffix of STEM_SUFFIXES) {
      const rest = key.slice(0, -suffix.length);
      // The stemmer only strips once the rest has a vowel-consonant pair (its "measure").
      if (key.endsWith(suffix) && rest.length >= 2 && /[aeiouy][^aeiouy]/.test(rest)) {
        key = rest;
        stripped = true;
        break;
      }
    }
  }
  return key;
}

/**
 * Matches, at word starts, every body word the MATCH phrases can hit through
 * stemming ("messages" -> message, messaging), erring toward counting more:
 * it only decides whether snippet() is affordable. Null when nothing to match.
 */
export function snippetKeyPattern(phrases: string[]): RegExp | null {
  const alternatives = new Set<string>();
  for (const phrase of phrases) {
    for (const word of phrase.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length === 0) continue;
      // The stemmer leaves words under three letters alone.
      const key = word.length < 3 ? word : stemKey(word);
      if (key.length >= 3) {
        alternatives.add(key);
        continue;
      }
      // A one- or two-letter stem ("us" from "using") is matched by short words only.
      alternatives.add(`${key}(?:s|e|es|ed|ing)?(?![a-z0-9])`);
      if (word.length >= 3) alternatives.add(word.replace(/(?<=^[a-z0-9]{3,})(?:ing|es|ed|s)$/, ""));
    }
  }
  if (alternatives.size === 0) return null;
  return new RegExp(`(?<![a-z0-9])(?:${[...alternatives].join("|")})`, "gi");
}

// unicode61 folds Latin diacritics ("café" matches "cafe"); fold them before counting.
const LATIN_DIACRITIC_RE = /[À-ɏḀ-ỿ]/;
const COMBINING_MARK_RE = /[̀-ͯ]/g;

/** Word-start matches of `keys` in `body`, counting no further than max + 1. */
export function countKeyMatches(body: string, keys: RegExp, max: number): number {
  const text = LATIN_DIACRITIC_RE.test(body) ? body.normalize("NFD").replace(COMBINING_MARK_RE, "") : body;
  keys.lastIndex = 0;
  let n = 0;
  while (n <= max && keys.exec(text) !== null) n++;
  return n;
}

/** Fixed window around the first match (the pre-FTS5 extractor): linear in the body. */
function linearExcerpt(body: string, keys: RegExp): string {
  keys.lastIndex = 0;
  const at = keys.exec(body)?.index ?? 0;
  let start = Math.max(0, at - EXCERPT_BEFORE);
  let end = Math.min(body.length, at + EXCERPT_AFTER);
  // Never split a surrogate pair.
  if (start > 0 && isLowSurrogate(body.charCodeAt(start))) start += 1;
  if (end < body.length && isLowSurrogate(body.charCodeAt(end))) end -= 1;
  return `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
