#!/usr/bin/env tsx
/**
 * Golden-query evaluation for search ranking.
 *
 * Usage:
 *   INDEX_PATH=./data/index.sqlite [DOCS_REPO=/path/to/cometchat-docs] tsx scripts/eval-search.ts [--json]
 *
 * Expectations are grounded in the real cometchat/docs layout: each SDK and
 * UI Kit keeps its CURRENT version at the unversioned path and moves older
 * versions under /vN/ or N.0/ — except where docs.json says otherwise (the
 * Android Chat SDK lists v5, under /sdk/android/v5/, ahead of the unversioned
 * v4). Checks read result URLs only, so the same script scores an index built
 * by an older builder and served by older code.
 *
 * With DOCS_REPO set, every path a check names is verified against the clone
 * first — the `above` pairs, and each pattern check's `grounding` pages, which
 * must also match the check's pattern — so an expectation cannot silently
 * refer to a deleted page or be impossible to meet. Exits 1 when any check
 * fails, 2 when grounding does.
 *
 * CI runs it on the docs commit pinned in .github/eval-docs-commit, and daily
 * on docs main to report drift (see DEPLOY.md, "Search ranking eval").
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { SqliteSearchClient } from "../src/search/sqlite.js";

const INDEX_PATH = process.env.INDEX_PATH ?? "./data/index.sqlite";
const DOCS_REPO = process.env.DOCS_REPO;
const DOCS_BASE_URL = process.env.DOCS_BASE_URL ?? "https://www.cometchat.com/docs";
const LIMIT = 25;

/** `grounding`: real pages the pattern matches (for notInTop, pages it guards against). */
type PatternCheck = { k: number; pattern: RegExp; grounding: string[]; label: string };

export type Check =
  | ({ kind: "inTop" } & PatternCheck)
  | ({ kind: "notInTop" } & PatternCheck)
  | ({ kind: "allInTop" } & PatternCheck)
  | { kind: "above"; current: string; legacy: string; label: string };

export type GoldenCase = { id: string; query: string; version?: string; checks: Check[] };

/** A page at or below `prefix` with no /vN/ or N.0/ segment after it. */
const unversioned = (prefix: string) => new RegExp(`^${prefix}/(?!(v\\d+|\\d+\\.\\d+)/)`);
const LEGACY_V2_TO_V4 = /\/(v[234]|[234]\.0)\//;

export const CASES: GoldenCase[] = [
  {
    id: "install-react-ui-kit",
    query: "install react ui kit",
    checks: [
      {
        kind: "inTop",
        k: 5,
        pattern: unversioned("/ui-kit/react"),
        grounding: ["/ui-kit/react/overview", "/ui-kit/react/integration-react"],
        label: "current React UI Kit page in top 5",
      },
      {
        kind: "notInTop",
        k: 3,
        pattern: LEGACY_V2_TO_V4,
        grounding: ["/ui-kit/react/v2/integration-with-nextjs", "/ui-kit/react/v4/getting-started"],
        label: "no v2/v3/v4 page in top 3",
      },
    ],
  },
  {
    id: "ios-ui-kit-getting-started",
    query: "ios ui kit getting started",
    checks: [
      {
        kind: "inTop",
        k: 2,
        pattern: /^\/ui-kit\/ios\/(overview|getting-started)$/,
        grounding: ["/ui-kit/ios/overview", "/ui-kit/ios/getting-started"],
        label: "current iOS UI Kit overview/getting-started in top 2",
      },
    ],
  },
  {
    id: "calls-sdk-setup",
    query: "calls sdk setup",
    checks: [
      {
        kind: "inTop",
        k: 5,
        pattern: /^\/calls\/(javascript|react-native|ios|android|flutter)\/setup$/,
        grounding: ["/calls/javascript/setup", "/calls/android/setup"],
        label: "current /calls/<framework>/setup in top 5",
      },
      {
        kind: "notInTop",
        k: 3,
        pattern: /^\/calls\/v4\//,
        grounding: ["/calls/v4/javascript/setup"],
        label: "no /calls/v4/ page in top 3",
      },
    ],
  },
  {
    id: "flutter-chat-ui-kit",
    query: "flutter chat ui kit",
    checks: [
      {
        kind: "inTop",
        k: 1,
        pattern: unversioned("/ui-kit/flutter"),
        grounding: ["/ui-kit/flutter/overview"],
        label: "current Flutter UI Kit page first",
      },
    ],
  },
  {
    id: "send-message-android",
    query: "send a message android",
    checks: [
      {
        kind: "above",
        current: "/ui-kit/android/message-composer",
        legacy: "/ui-kit/android/v5/message-composer",
        label: "Android UI Kit v6 composer above its /v5/ duplicate",
      },
      {
        kind: "above",
        current: "/sdk/android/v5/send-message",
        legacy: "/sdk/android/send-message",
        label: "Android SDK v5 (current, listed first) above unversioned v4",
      },
    ],
  },
  {
    id: "version-react-v7",
    query: "react message list",
    version: "v7",
    checks: [
      {
        kind: "allInTop",
        k: 5,
        pattern: /^\/ui-kit\/react\//,
        grounding: ["/ui-kit/react/overview"],
        label: "v7 filter returns React UI Kit pages",
      },
    ],
  },
  {
    id: "version-android-v6",
    query: "android message list",
    version: "v6",
    checks: [
      {
        kind: "allInTop",
        k: 5,
        pattern: /^\/ui-kit\/android\//,
        grounding: ["/ui-kit/android/message-list"],
        label: "v6 filter returns Android UI Kit pages",
      },
    ],
  },
  {
    // Current-first ranking must not bury older docs someone asks for by version.
    id: "version-react-v4-legacy",
    query: "react ui kit getting started",
    version: "v4",
    checks: [
      {
        kind: "inTop",
        k: 1,
        pattern: /^\/ui-kit\/react\/v4\/getting-started$/,
        grounding: ["/ui-kit/react/v4/getting-started"],
        label: "v4 filter still reaches the legacy React UI Kit getting-started page",
      },
    ],
  },
  {
    // A product-name query must not be won by the product's shortest pages.
    id: "vue-ui-kit",
    query: "vue ui kit",
    checks: [
      {
        kind: "inTop",
        k: 5,
        pattern: /^\/ui-kit\/vue\/overview$/,
        grounding: ["/ui-kit/vue/overview"],
        label: "Vue UI Kit overview in top 5",
      },
    ],
  },
  {
    id: "ai-agents",
    query: "ai agents",
    checks: [
      { kind: "inTop", k: 5, pattern: /^\/ai-agents$/, grounding: ["/ai-agents"], label: "AI Agents overview in top 5" },
      {
        // Per-framework pages that render one shared snippet must not outrank the overview.
        kind: "notInTop",
        k: 1,
        pattern: /^\/ai-agents\/[a-z0-9-]+-(actions|tools|card-messages)$/,
        grounding: ["/ai-agents/crew-ai-actions", "/ai-agents/ag2-tools"],
        label: "no per-framework snippet page first",
      },
    ],
  },
  {
    // Version labels are not indexed text and these pages never write their
    // version, so the version in the query must steer ranking, not filter text.
    id: "version-in-query-ios-v4",
    query: "ios ui kit v4 theme",
    checks: [
      {
        kind: "inTop",
        k: 3,
        pattern: /^\/ui-kit\/ios\/v4\/theme$/,
        grounding: ["/ui-kit/ios/v4/theme"],
        label: "iOS UI Kit v4 theme page in top 3",
      },
    ],
  },
  {
    id: "version-in-query-flutter-v5",
    query: "flutter ui kit v5 theme",
    checks: [
      {
        kind: "inTop",
        k: 3,
        pattern: /^\/ui-kit\/flutter\/v5\/theme-introduction$/,
        grounding: ["/ui-kit/flutter/v5/theme-introduction"],
        label: "Flutter UI Kit v5 theme page in top 3",
      },
    ],
  },
  {
    // The UI Kit Builder lives under /chat-builder/; generic "ui kit" words
    // must not hand the query to every /ui-kit/ page.
    id: "ui-kit-builder",
    query: "ui kit builder",
    checks: [
      {
        kind: "inTop",
        k: 1,
        pattern: /^\/chat-builder\//,
        grounding: ["/chat-builder/react/overview"],
        label: "a UI Kit Builder page first",
      },
    ],
  },
  {
    id: "react-ui-kit-builder",
    query: "react ui kit builder",
    checks: [
      {
        kind: "inTop",
        k: 1,
        pattern: /^\/chat-builder\/react\//,
        grounding: ["/chat-builder/react/overview"],
        label: "React UI Kit Builder page first",
      },
    ],
  },
  {
    id: "chat-builder",
    query: "chat builder",
    checks: [
      {
        kind: "inTop",
        k: 1,
        pattern: /^\/chat-builder\//,
        grounding: ["/chat-builder/react/overview"],
        label: "a UI Kit Builder (/chat-builder/) page first",
      },
    ],
  },
  {
    // A query naming versions asks for the older pages the legacy penalty demotes.
    id: "upgrade-react-ui-kit-v4-v5",
    query: "upgrade from v4 to v5 react ui kit",
    checks: [
      {
        kind: "inTop",
        k: 5,
        pattern: /^\/ui-kit\/react\/(v4|v5)\/upgrad/,
        grounding: ["/ui-kit/react/v5/upgrading-from-v4", "/ui-kit/react/v4/upgrade-to-v5"],
        label: "React UI Kit v4-to-v5 upgrade guide in top 5",
      },
    ],
  },
];

/**
 * Search issues fixed in 0.1.7, each case a query from the report and the page
 * it should reach: receipts toggles, language aliases, delete/edit wording,
 * APIs only older docs spell out and plain-language phrasings, plus guards
 * that the fixes must not break, and guards for what the 0.1.7 review found.
 */
// A current, navigable page: no older-version folder, except /sdk/android/v5/,
// which docs.json lists as current ahead of the unversioned (older) Android
// SDK, and no REST reference stub. The phrasing cases ask for the guide a
// consumer word means; an older copy or a stub must not pass for it.
const CURRENT_PAGE = String.raw`^/(?!rest-api/|sdk/android/(?!v5/))(?:sdk/android/v5/|(?!v\d+/|\d+\.\d+/)[^/]+/)*`;
const feature = (slugs: string) => new RegExp(`${CURRENT_PAGE}(?:${slugs})$`);
/** Any copy of a feature page, older versions included: what a notInTop guard keeps out. */
const anyCopy = (slugs: string) => new RegExp(`/(?:${slugs})$`);
const page = (p: string) => new RegExp(`^${p.replace(/[.]/g, "\\.")}$`);
const DELETE = feature("delete-message|delete-a-message|messaging-delete-message");
const PRESENCE = feature("user-presence");
const RECEIPTS = feature("delivery-read-receipts|messaging-receipts");
const TYPING = feature("typing-indicators|messaging-typing-indicators");
const ONE_TO_ONE = feature("send-message|messaging-send-message|[a-z-]*one-to-one-chat");
const PINNED = feature(
  "pin-message|pinned-messages|cometchat-pinned-messages|pin-save-message|guide-pin-save-message|guide-pin-and-save-messages",
);
const SAVED = feature(
  "save-message|saved-messages|cometchat-saved-messages|pin-save-message|guide-pin-save-message|guide-pin-and-save-messages",
);
const CURRENT_SDK_RECEIPTS = /^\/sdk\/(ios|javascript|react-native|flutter|android\/v5|unreal)\/delivery-read-receipts$/;
const RECEIPTS_PROP = /^\/ui-kit\/(react\/components|flutter|react-native|ios)\/message-list$/;

/** One inTop check: `pattern` among the first k results. */
function top(id: string, query: string, k: number, pattern: RegExp, grounding: string[], opts: { version?: string } = {}) {
  // The label names the page only when the pattern accepts nothing else.
  const label = `${grounding[0]}${pattern.source === page(grounding[0]).source ? "" : " or alike"} in top ${k}`;
  return { id, query, ...opts, checks: [{ kind: "inTop" as const, k, pattern, grounding, label }] };
}

/** One notInTop check: nothing `pattern` matches among the first k results. */
function none(id: string, query: string, k: number, pattern: RegExp, grounding: string[], what: string): GoldenCase {
  return { id, query, checks: [{ kind: "notInTop", k, pattern, grounding, label: `no ${what} in top ${k}` }] };
}

/** One inTop check naming its page exactly. */
function exact(id: string, query: string, k: number, path: string, opts: { version?: string } = {}) {
  return top(id, query, k, page(path), [path], opts);
}

export const ISSUE_CASES: GoldenCase[] = [
  {
    id: "receipts-toggle",
    query: "delivery and read receipts enable disable",
    checks: [
      {
        kind: "inTop",
        k: 3,
        pattern: CURRENT_SDK_RECEIPTS,
        grounding: ["/sdk/ios/delivery-read-receipts"],
        label: "a current SDK Delivery & Read Receipts page in top 3",
      },
      {
        kind: "inTop",
        k: 3,
        pattern: RECEIPTS_PROP,
        grounding: ["/ui-kit/react/components/message-list", "/ui-kit/flutter/message-list"],
        label: "a UI Kit page with a receipts prop in top 3",
      },
      {
        kind: "notInTop",
        k: 5,
        pattern: /^\/ui-kit\/kotlin\/[^/]+$/,
        grounding: ["/ui-kit/kotlin/customize-ui-kit"],
        label: "no retired Kotlin UI Kit page in top 5",
      },
      {
        kind: "notInTop",
        k: 3,
        pattern: /^\/rest-api\//,
        grounding: ["/rest-api/groups/create"],
        label: "no REST page in top 3",
      },
    ],
  },
  {
    id: "receipts-ios",
    query: "iOS delivery and read receipts",
    checks: [
      {
        kind: "inTop",
        k: 1,
        pattern: page("/sdk/ios/delivery-read-receipts"),
        grounding: ["/sdk/ios/delivery-read-receipts"],
        label: "iOS Delivery & Read Receipts first",
      },
      {
        kind: "notInTop",
        k: 3,
        pattern: /^\/sdk\/ios\/[23]\.0\/delivery-read-receipts$/,
        grounding: ["/sdk/ios/2.0/delivery-read-receipts"],
        label: "no older iOS copy in top 3",
      },
    ],
  },
  {
    id: "receipts-sdk",
    query: "delivery read receipts",
    checks: [
      {
        kind: "allInTop",
        k: 3,
        pattern: CURRENT_SDK_RECEIPTS,
        grounding: ["/sdk/ios/delivery-read-receipts"],
        label: "top 3 are current SDK receipts pages",
      },
    ],
  },
  top("pin-and-save", "pin and save messages", 3, /\/(guide-pin-and-save-messages|pin-save-message|guide-pin-save-message)$/, [
    "/ui-kit/react/guide-pin-and-save-messages",
  ]),
  exact("alias-swift-presence", "Swift user presence online offline last active", 3, "/sdk/ios/user-presence"),
  exact("alias-swift-presence-short", "swift user presence", 3, "/sdk/ios/user-presence"),
  // Longhand, for the second check: a language alias must not merely put the
  // page somewhere in the top 3. The page's code languages are a bm25 column
  // of their own (LANGUAGE_WEIGHT), and at weight 0 this page still led while
  // the SDK's LLM index and an upgrade guide took the places below it.
  {
    id: "alias-kotlin-presence",
    query: "kotlin user presence",
    checks: [
      {
        kind: "inTop",
        k: 3,
        pattern: page("/sdk/android/v5/user-presence"),
        grounding: ["/sdk/android/v5/user-presence"],
        label: "/sdk/android/v5/user-presence in top 3",
      },
      {
        kind: "allInTop",
        k: 3,
        pattern: /\/user-presence$/,
        grounding: ["/sdk/android/v5/user-presence"],
        label: "top 3 are User Presence pages",
      },
    ],
  },
  exact("alias-dart-presence", "dart user presence", 3, "/sdk/flutter/user-presence"),
  exact("alias-js-presence", "js user presence", 3, "/sdk/javascript/user-presence"),
  exact("alias-swift-v3", "swift user presence", 3, "/sdk/ios/3.0/user-presence", { version: "v3" }),
  top(
    "alias-swift-push",
    "swift push notifications",
    3,
    /^\/notifications\/(ios-apns-push-notifications|ios-fcm-push-notifications|ios-push-notifications-sdk)$/,
    ["/notifications/ios-apns-push-notifications"],
  ),
  {
    id: "alias-guard-react-js",
    query: "react js message list",
    checks: [
      {
        kind: "allInTop",
        k: 3,
        pattern: /^\/ui-kit\/react\//,
        grounding: ["/ui-kit/react/overview"],
        label: "top 3 are React UI Kit pages",
      },
    ],
  },
  exact("delete-for-everyone", "iOS delete message for everyone", 3, "/sdk/ios/delete-message"),
  {
    id: "edit-sent-message",
    query: "iOS edit a sent message",
    checks: [
      {
        kind: "inTop",
        k: 3,
        pattern: page("/sdk/ios/edit-message"),
        grounding: ["/sdk/ios/edit-message"],
        label: "iOS Edit Message in top 3",
      },
      {
        kind: "notInTop",
        k: 1,
        pattern: page("/sdk/ios/delete-message"),
        grounding: ["/sdk/ios/delete-message"],
        label: "Delete Message not first",
      },
    ],
  },
  exact("delete-article", "iOS delete a message", 3, "/sdk/ios/delete-message"),
  exact("delete-js-guard", "javascript delete a message deleteMessage", 1, "/sdk/javascript/delete-message"),
  exact("edit-js-guard", "javascript edit a message updateMessage", 1, "/sdk/javascript/edit-message"),
  exact("block-user-guard", "block user android", 1, "/ui-kit/android/guide-block-unblock-user"),
  exact("api-mark-as-read", "iOS mark message as read markAsRead", 3, "/sdk/ios/delivery-read-receipts"),
  {
    id: "api-bare-identifier",
    query: "markAsRead",
    checks: [
      {
        kind: "allInTop",
        k: 3,
        pattern: CURRENT_SDK_RECEIPTS,
        grounding: ["/sdk/ios/delivery-read-receipts"],
        label: "top 3 are current SDK receipts pages",
      },
    ],
  },
  {
    id: "api-renamed",
    query: "ios calls app settings callsAppSettings",
    checks: [
      {
        kind: "inTop",
        k: 3,
        pattern: page("/calls/ios/setup"),
        grounding: ["/calls/ios/setup"],
        label: "current iOS calls setup in top 3",
      },
      {
        kind: "inTop",
        k: 5,
        pattern: page("/calls/v4/ios/setup"),
        grounding: ["/calls/v4/ios/setup"],
        label: "the older page naming the API still in top 5",
      },
    ],
  },
  {
    id: "api-renamed-android",
    query: "android on call end button pressed onCallEndButtonPressed",
    checks: [
      {
        kind: "inTop",
        k: 3,
        pattern: /^\/calls\/android\//,
        grounding: ["/calls/android/setup"],
        label: "a current Android calls page in top 3",
      },
      {
        kind: "inTop",
        k: 5,
        pattern: /^\/calls\/v4\/android\//,
        grounding: ["/calls/v4/android/ringing"],
        label: "an older Android calls page in top 5",
      },
      {
        kind: "notInTop",
        k: 5,
        pattern: /^\/calls\/v4\/(flutter|javascript)\//,
        grounding: ["/calls/v4/flutter/presenter-mode"],
        label: "no other platform's older page in top 5",
      },
    ],
  },
  top("api-renamed-flutter", "flutter on user muted onUserMuted", 3, /^\/calls\/flutter\/(participant-management|events)$/, [
    "/calls/flutter/participant-management",
  ]),
  exact("api-version-guard", "iOS v3 mark message as read markAsRead", 3, "/sdk/ios/3.0/delivery-read-receipts"),
  top("phrasing-unsend", "unsend a message", 3, DELETE, ["/sdk/javascript/delete-message"]),
  exact("phrasing-unsend-flutter", "flutter unsend a message", 3, "/sdk/flutter/delete-message"),
  top("phrasing-recall", "recall a message", 3, DELETE, ["/sdk/javascript/delete-message"]),
  top("phrasing-last-seen", "last seen", 3, PRESENCE, ["/sdk/javascript/user-presence"]),
  top("phrasing-when-online", "when was someone online", 3, PRESENCE, ["/sdk/javascript/user-presence"]),
  exact("phrasing-when-online-flutter", "flutter when was someone online", 3, "/sdk/flutter/user-presence"),
  top("phrasing-is-online", "check if a user is online", 3, PRESENCE, ["/sdk/javascript/user-presence"]),
  // The request verbs ("show", "check", ...) are stopwords so that the rest of
  // a plain-language query decides the page. Every other case that exercises
  // them is 4 words or more, where relaxed matching drops the extra word
  // anyway; these two are short, so only the stopword list can carry them.
  {
    id: "phrasing-show-last-seen",
    query: "show last seen",
    checks: [
      {
        kind: "allInTop",
        k: 3,
        pattern: PRESENCE,
        grounding: ["/sdk/javascript/user-presence"],
        label: "top 3 are current User Presence pages",
      },
    ],
  },
  // The other side of "check" being a stopword: dropped from MATCH, it widens
  // the candidate set of a query that names a page by it. The two Check Box
  // Element pages lead in v0.1.6 and sit at #2 and #3 here, which is the price
  // paid for phrasing-is-online and phrasing-check-receipts.
  top("check-box-element", "check box element", 3, /\/interactive-check-box-element$/, [
    "/ui-kit/ios/v4/interactive-check-box-element",
    "/ui-kit/flutter/v4/interactive-check-box-element",
  ]),
  {
    id: "phrasing-check-receipts",
    query: "check delivery receipts",
    checks: [
      {
        kind: "allInTop",
        k: 3,
        pattern: RECEIPTS,
        grounding: ["/sdk/ios/delivery-read-receipts"],
        label: "top 3 are current Delivery & Read Receipts pages",
      },
    ],
  },
  top("phrasing-blue-ticks", "blue ticks", 3, RECEIPTS, ["/sdk/javascript/delivery-read-receipts"]),
  exact("phrasing-blue-ticks-android", "android blue ticks", 3, "/sdk/android/v5/delivery-read-receipts"),
  top("phrasing-seen-status", "seen status", 3, RECEIPTS, ["/sdk/javascript/delivery-read-receipts"]),
  top("phrasing-read-status", "read status", 3, RECEIPTS, ["/sdk/javascript/delivery-read-receipts"]),
  top("phrasing-typing-bubble", "typing bubble", 3, TYPING, ["/sdk/javascript/typing-indicators"]),
  exact("phrasing-typing-bubble-ios", "ios typing bubble", 3, "/sdk/ios/typing-indicators"),
  top("phrasing-is-typing", "user is typing", 3, TYPING, ["/sdk/javascript/typing-indicators"]),
  top("phrasing-dm", "DM", 3, ONE_TO_ONE, ["/sdk/javascript/send-message", "/ui-kit/react/react-one-to-one-chat"]),
  top("phrasing-direct-message", "direct message", 3, ONE_TO_ONE, ["/sdk/javascript/send-message"]),
  top(
    "phrasing-direct-message-android",
    "android direct message",
    3,
    /^\/(sdk\/android\/v5\/send-message|ui-kit\/android\/one-to-one-chat)$/,
    ["/sdk/android/v5/send-message", "/ui-kit/android/one-to-one-chat"],
  ),
  top("phrasing-pinned", "pinned messages", 3, PINNED, ["/sdk/javascript/pin-message"]),
  top("phrasing-starred", "starred messages", 3, SAVED, ["/sdk/javascript/save-message"]),
  top(
    "phrasing-starred-ios",
    "ios starred messages",
    3,
    /^\/(sdk|ui-kit)\/ios\/(saved-messages|pin-save-message|guide-pin-save-message)$/,
    ["/ui-kit/ios/saved-messages", "/sdk/ios/pin-save-message"],
  ),
  {
    // Keywords must not pull their page into queries sharing one word:
    // "direct" (from "direct message") is not "direct calling".
    id: "phrasing-guard-direct-calling",
    query: "ios direct calling",
    checks: [
      {
        kind: "notInTop",
        k: 3,
        pattern: /one-to-one-chat$/,
        grounding: ["/ui-kit/ios/ios-one-to-one-chat"],
        label: "no One-to-One Chat page in top 3",
      },
    ],
  },
  top("phrasing-delete-for-everyone", "delete for everyone", 3, DELETE, ["/sdk/javascript/delete-message"]),
  top("phrasing-online-status", "online status", 3, PRESENCE, ["/sdk/javascript/user-presence"]),
  // Keywords that are ordinary words elsewhere must not win those queries.
  // k = 1 is the truth, not caution: the keywords FTS column is tokenized, so
  // one word of "star message" makes "star" a searchable word of the page at
  // KEYWORD_WEIGHT, and the Save Message pages sit at #3-#5 of "star rating"
  // where v0.1.6 returned Rate Limits pages throughout. The 3x bonus is what
  // this guards; separating the two roles of the column would need a second
  // builder column.
  none(
    "keyword-guard-star",
    "star rating",
    1,
    anyCopy("save-message|saved-messages"),
    ["/fundamentals/save-message"],
    "Save Message page",
  ),
  // Only two pages match this query at all, and the guarded one is the second,
  // so this says "not first", not "not in the top 3". Widening k would fail
  // today; it is here to catch a keyword bonus lifting it over the AI Agents
  // page that actually explains an API key.
  none(
    "keyword-guard-recall",
    "recall api key",
    1,
    anyCopy("delete-message"),
    ["/sdk/flutter/v4/delete-message"],
    "Delete Message page",
  ),
  // "favourite reactions" is docs vocabulary (the UI Kits' quick-reaction
  // row). A one-word "favourite" keyword gave the Save-a-Message pages the
  // whole top of it; the guard is wide because the collision was total.
  none(
    "keyword-guard-favourite",
    "favourite reactions",
    5,
    anyCopy("save-message|saved-messages|pin-save-message|guide-pin-save-message"),
    ["/fundamentals/save-message", "/ui-kit/react-native/saved-messages"],
    "Save Message page",
  ),
  none(
    "keyword-guard-offline",
    "online offline mode sdk",
    1,
    anyCopy("user-presence"),
    ["/sdk/android/v5/user-presence"],
    "User Presence page",
  ),
  none(
    "keyword-guard-private-group",
    "ios create private group",
    3,
    /one-to-one-chat$/,
    ["/ui-kit/ios/ios-one-to-one-chat"],
    "One-to-One Chat page",
  ),
  // A qualified API name is its parts.
  {
    id: "api-qualified-name",
    query: "CometChat.markAsRead",
    checks: [
      {
        kind: "allInTop",
        k: 3,
        pattern: CURRENT_SDK_RECEIPTS,
        grounding: ["/sdk/ios/delivery-read-receipts"],
        label: "top 3 are current SDK receipts pages",
      },
    ],
  },
  // Relaxed matching must not let an overview titled with the doc set's name
  // ("iOS SDK") win a longer query about a feature.
  exact("relaxed-overview-guard-ios", "ios sdk block a user by uid", 1, "/sdk/ios/block-users"),
  exact("relaxed-overview-guard-rn", "react native sdk block a user by uid", 1, "/sdk/react-native/block-users"),
  // A word that only appears in some docs.json trail ("chat") is not a
  // platform: the page lacking it still joins.
  exact(
    "relaxed-drops-trail-word",
    "android chat ui kit mentions formatter",
    1,
    "/ui-kit/android/mentions-formatter-guide",
  ),
  // The retired Kotlin UI Kit must not lead "kotlin" queries.
  none(
    "retired-kotlin-ui-kit",
    "kotlin groups",
    3,
    /^\/ui-kit\/kotlin\//,
    ["/ui-kit/kotlin/overview"],
    "retired Kotlin UI Kit page",
  ),
  // A framework name that is also a word names a platform right before "js".
  exact("alias-guard-next-js", "next js setup", 1, "/chat-builder/nextjs/builder-settings"),
  exact("alias-guard-vue-js", "vue js install", 2, "/ui-kit/vue/integration"),
  // A doc set's getting-started page, whatever its title says ("iOS
  // Integration", "React.js Integration"), leads a query asking only for it;
  // an older copy titled "Getting Started" does not, unless the query names
  // its version.
  merge(
    exact("start-ios-ui-kit", "ios ui kit getting started", 1, "/ui-kit/ios/getting-started"),
    none("", "", 3, /^\/ui-kit\/ios\/v\d+\//, ["/ui-kit/ios/v4/getting-started"], "older iOS UI Kit page"),
  ),
  exact("start-ios-ui-kit-v4", "ios ui kit v4 getting started", 1, "/ui-kit/ios/v4/getting-started"),
  merge(
    exact("start-android-ui-kit", "android ui kit getting started", 1, "/ui-kit/android/getting-started"),
    none("", "", 3, /^\/ui-kit\/android\/v\d+\//, ["/ui-kit/android/v4/getting-started", "/ui-kit/android/v5/getting-started"], "older Android UI Kit page"),
  ),
  merge(
    exact("start-flutter", "flutter getting started", 1, "/ui-kit/flutter/getting-started"),
    none("", "", 3, /^\/ui-kit\/flutter\/v\d+\//, ["/ui-kit/flutter/v4/getting-started", "/ui-kit/flutter/v5/getting-started"], "older Flutter UI Kit page"),
  ),
  exact("start-flutter-ui-kit-install", "flutter ui kit install", 1, "/ui-kit/flutter/getting-started"),
  // "react" names React, not React Native, unless the query says native.
  merge(
    exact("start-react-ui-kit-install", "react ui kit install", 1, "/ui-kit/react/integration-react"),
    none("", "", 5, /^\/ui-kit\/react-native\//, ["/ui-kit/react-native/react-native-cli-integration"], "React Native UI Kit page"),
  ),
  // The React UI Kit has a start page per framework; a query naming none, or
  // naming React, asks for React.js, and one naming Next.js or Astro for its own.
  exact("start-react-ui-kit-getting-started", "react ui kit getting started", 1, "/ui-kit/react/integration-react"),
  exact("start-nextjs-ui-kit-setup", "nextjs ui kit setup", 1, "/ui-kit/react/integration-nextjs"),
  exact("start-next-js-ui-kit-setup", "next.js ui kit setup", 1, "/ui-kit/react/integration-nextjs"),
  exact("start-astro-integration", "astro integration", 1, "/ui-kit/react/integration-astro"),
  // A page titled "Integration" whose slug names a feature (calls-, ai-) is
  // not where its doc set starts.
  exact("start-vue-ui-kit-setup", "vue ui kit setup", 1, "/ui-kit/vue/integration"),
  // React Native starts at its CLI integration, or at Expo when asked.
  exact("start-react-native-getting-started", "react native ui kit getting started", 1, "/ui-kit/react-native/react-native-cli-integration"),
  exact("start-react-native-expo-setup", "react native expo setup", 1, "/ui-kit/react-native/expo-integration"),
  // "Getting Started With UI Kit Builder" starts another product.
  exact("start-react-v6", "react v6 getting started", 1, "/ui-kit/react/v6/react-js-integration"),
  // A query that does not ask for a start page is not pulled to them by the
  // words they are asked for by.
  none("start-words-not-keywords", "install", 2, /^\/calls\/javascript\/[a-z]+-integration$/, ["/calls/javascript/angular-integration"], "Calls SDK framework integration page"),
  none("start-words-widget-install", "widget install", 5, /\/setup$/, ["/sdk/unreal/setup"], "SDK or Calls setup page"),
  // "native" names React Native only beside "react".
  exact("start-native-ios", "native ios ui kit getting started", 1, "/ui-kit/ios/getting-started"),
  merge(
    top("start-native-android", "native android ui kit setup", 1, /^\/ui-kit\/android\/getting-started(-[a-z]+)?$/, ["/ui-kit/android/getting-started", "/ui-kit/android/getting-started-jetpack"]),
    none("", "", 3, /^\/ui-kit\/react-native\/[a-z-]*integration$/, ["/ui-kit/react-native/react-native-cli-integration", "/ui-kit/react-native/expo-integration"], "React Native UI Kit start page"),
  ),
  // The words a start page's title adds ("Jetpack Compose") do not stop a
  // query holding them from asking for a start page.
  exact("start-android-jetpack-compose", "android jetpack compose ui kit setup", 1, "/ui-kit/android/getting-started-jetpack"),
  // A language names its platform here too ("swift" -> iOS), "rn" is React
  // Native, and a whole question asks for the start page as its keywords do.
  exact("start-swift-alias", "swift ui kit getting started", 1, "/ui-kit/ios/getting-started"),
  exact("start-rn-alias", "rn ui kit setup", 1, "/ui-kit/react-native/react-native-cli-integration"),
  exact("start-question", "how to install react ui kit", 1, "/ui-kit/react/integration-react"),
  // The iOS UI Kit installs with Swift Package Manager in a tab of that name.
  exact("ios-swift-package-manager", "ios swift package manager", 5, "/ui-kit/ios/getting-started"),
];

/** One case holding the checks of both: the first's id and query, the second's checks too. */
function merge(a: GoldenCase, b: GoldenCase): GoldenCase {
  return { ...a, checks: [...a.checks, ...b.checks] };
}

/** Every case the eval runs: the golden set, then the 0.1.7 issue cases. */
export const ALL_CASES: GoldenCase[] = [...CASES, ...ISSUE_CASES];

export type CheckResult = { label: string; pass: boolean; detail: string };

/** Scores one check against result paths in rank order. */
export function evaluate(check: Check, paths: string[]): CheckResult {
  const rank = (i: number) => (i >= 0 ? `#${i + 1}` : "absent");
  switch (check.kind) {
    case "inTop": {
      const i = paths.findIndex((p) => check.pattern.test(p));
      return { label: check.label, pass: i >= 0 && i < check.k, detail: `first match ${rank(i)}` };
    }
    case "notInTop": {
      const offenders = paths.slice(0, check.k).filter((p) => check.pattern.test(p));
      return { label: check.label, pass: offenders.length === 0, detail: offenders.join(", ") || "none" };
    }
    case "allInTop": {
      const top = paths.slice(0, check.k);
      const hits = top.filter((p) => check.pattern.test(p)).length;
      return { label: check.label, pass: top.length > 0 && hits === top.length, detail: `${hits}/${top.length} match` };
    }
    case "above": {
      const c = paths.indexOf(check.current);
      const l = paths.indexOf(check.legacy);
      return {
        label: check.label,
        pass: c >= 0 && (l < 0 || c < l),
        detail: `current ${rank(c)}, legacy ${rank(l)}`,
      };
    }
  }
}

/** Grounding problems: named paths missing from the docs, or grounding pages outside their check's pattern. */
export function groundingProblems(cases: GoldenCase[], exists: (pagePath: string) => boolean): string[] {
  const problems: string[] = [];
  for (const c of cases) {
    for (const check of c.checks) {
      const paths = check.kind === "above" ? [check.current, check.legacy] : check.grounding;
      if (paths.length === 0) problems.push(`${c.id}: "${check.label}" names no grounding page`);
      for (const p of paths) {
        if (!exists(p)) problems.push(`${c.id}: ${p} does not exist`);
        else if (check.kind !== "above" && !check.pattern.test(p)) {
          problems.push(`${c.id}: ${p} does not match ${check.pattern}`);
        }
      }
    }
  }
  return problems;
}

function toPath(url: string): string {
  return url.startsWith(DOCS_BASE_URL) ? url.slice(DOCS_BASE_URL.length) : new URL(url).pathname;
}

function verifyGrounding(): void {
  if (!DOCS_REPO) return;
  const problems = groundingProblems(ALL_CASES, (p) => existsSync(path.join(DOCS_REPO, `${p}.mdx`)));
  if (problems.length > 0) {
    console.error(`Golden expectations not grounded in ${DOCS_REPO}:\n  ${problems.join("\n  ")}`);
    process.exit(2);
  }
}

/**
 * An index built before this release has none of the search text these cases
 * score — every keyword, title-key and language check fails at once, which
 * reads like a ranking regression rather than a stale file. Exit 3, a code of
 * its own (1 is a failed check, 2 a case the docs no longer ground), and say
 * how to rebuild. A missing index exits 3 for the same reason.
 */
function verifyIndexSchema(): void {
  if (!existsSync(INDEX_PATH)) {
    console.error(
      `No index at ${INDEX_PATH}. Build one from a docs checkout, then run the eval again:\n` +
        `  DOCS_REPO=<docs checkout> INDEX_PATH=${INDEX_PATH} npx tsx scripts/build-index.ts`,
    );
    process.exit(3);
  }
  const db = new Database(INDEX_PATH, { readonly: true, fileMustExist: true });
  try {
    const columns = new Set((db.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).map((c) => c.name));
    const ftsColumns = (db.prepare("PRAGMA table_info(pages_fts)").all() as { name: string }[]).map((c) => c.name);
    const missing = [
      ...(ftsColumns[3] === "keywords" && columns.has("keywords") ? [] : ["keywords"]),
      ...(columns.has("title_key") ? [] : ["title_key"]),
      ...(ftsColumns[4] === "languages" ? [] : ["languages"]),
    ];
    if (missing.length === 0) return;
    console.error(
      `The index at ${INDEX_PATH} was built by an older release and is missing ${missing.join(", ")}.\n` +
        "Rebuild it with the builder in this checkout, then run the eval again:\n" +
        `  DOCS_REPO=<docs checkout> INDEX_PATH=${INDEX_PATH} npx tsx scripts/build-index.ts\n` +
        "The docs commit CI scores against is pinned in .github/eval-docs-commit.",
    );
    process.exit(3);
  } finally {
    db.close();
  }
}

async function main() {
  verifyIndexSchema();
  verifyGrounding();
  const client = new SqliteSearchClient(INDEX_PATH);
  const json = process.argv.includes("--json");
  const report = [];
  let passed = 0;
  let total = 0;

  for (const c of ALL_CASES) {
    const res = await client.search(c.query, { version: c.version, limit: LIMIT });
    const paths = res.results.map((r) => toPath(r.url));
    const checks = c.checks.map((check) => evaluate(check, paths));
    passed += checks.filter((r) => r.pass).length;
    total += checks.length;
    // version/isCurrent exist only on newer servers; printed when present.
    const top = res.results.slice(0, 5).map((r, i) => {
      const extra = r as { version?: string; isCurrent?: boolean };
      const tag = extra.isCurrent === undefined ? "" : ` [${extra.version ?? "-"}${extra.isCurrent ? "" : ", legacy"}]`;
      return `${i + 1}. ${paths[i]}${tag}`;
    });
    report.push({ id: c.id, query: c.query, version: c.version ?? null, totalAvailable: res.totalAvailable, top, checks });

    if (!json) {
      console.log(`\n## ${c.id}: "${c.query}"${c.version ? ` (version ${c.version})` : ""}`);
      for (const line of top) console.log(`   ${line}`);
      for (const r of checks) console.log(`   ${r.pass ? "PASS" : "FAIL"}  ${r.label} — ${r.detail}`);
    }
  }
  client.close();

  if (json) console.log(JSON.stringify({ index: INDEX_PATH, passed, total, cases: report }, null, 2));
  else console.log(`\n${passed}/${total} checks passed (${INDEX_PATH})`);
  if (passed < total) process.exit(1);
}

// Importable (CASES/evaluate) without running against an index.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
