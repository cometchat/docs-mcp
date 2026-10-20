import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { logger } from "../src/lib/logger.js";
import { SqliteSearchClient, buildQueries, parseQuery, relaxedMatchQuery, titleKeyText } from "../src/search/sqlite.js";
import {
  STOPWORDS,
  contentTerms,
  featureKey,
  indexedTitleKey,
  isPlatformTerm,
  termGroups,
  titleKey,
  titleKeyWords,
} from "../src/search/phrasing.js";
import { FEATURE_KEYWORDS, normalizeKeyword, pageKeywords } from "../src/search/keywords.js";

// How query words become matches (0.1.7): stopwords, the "js" alias, title
// keys, search keywords, and relaxed matching of pages missing one word.
// Fixtures that would upset the rankings other tests pin get an index of
// their own (see the describe blocks at the end).

type Page = {
  path: string;
  title: string;
  section: string;
  /** docs.json trail below the product family; pages without one are outside the navigation. */
  trail?: string;
  version: string | null;
  isCurrent: boolean;
  body: string;
  /** Search keywords as a JSON array; defaults to what the title earns. */
  keywords?: string;
};

// Words no test queries for, to make a page long.
const FILLER = "Field Value Package Import Purpose Requirements Xcode Init Rendering Layout ".repeat(8);

const PAGES: Page[] = [
  // "delivery and read receipts enable disable": the SDK topic pages never say
  // "disable"; the UI Kit pages documenting a receipts prop say every word.
  {
    path: "/sdk/ios/delivery-read-receipts",
    title: "Delivery & Read Receipts",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `Mark messages as delivered and read, and listen for receipts. Receipts are enabled for every message you mark. ${FILLER}`,
  },
  {
    path: "/sdk/javascript/delivery-read-receipts",
    title: "Delivery & Read Receipts",
    section: "SDK / Javascript",
    trail: "SDKs / JavaScript",
    version: "v4",
    isCurrent: true,
    body: `Mark messages as delivered and read, and listen for receipts. Receipts are enabled for every message you mark. ${FILLER}`,
  },
  {
    path: "/sdk/ios/2.0/delivery-read-receipts",
    title: "Delivery & Read Receipts",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v2",
    isCurrent: false,
    body: "Mark messages as delivered and read.",
  },
  {
    path: "/ui-kit/react/message-list",
    title: "Message List",
    section: "UI Kit / React",
    trail: "UI Kits / React",
    version: "v7",
    isCurrent: true,
    body: `Set hideReceipts to disable delivery and read receipts, or enable them again. ${FILLER} ${FILLER}`,
  },
  {
    path: "/ui-kit/flutter/message-list",
    title: "Message List",
    section: "UI Kit / Flutter",
    trail: "UI Kits / Flutter",
    version: "v6",
    isCurrent: true,
    body: `Set disableReceipts to disable delivery and read receipts, or enable them again. ${FILLER} ${FILLER}`,
  },
  // "ios delete message for everyone": no delete page says "everyone"; one
  // unrelated iOS page happens to say every word, and the Android page lacks "ios".
  {
    path: "/sdk/ios/delete-message",
    title: "Delete Message",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `Delete a message you sent, for all participants, by its message ID. ${FILLER}`,
    keywords: "[]",
  },
  {
    path: "/sdk/android/delete-message",
    title: "Delete A Message",
    section: "SDK / Android",
    trail: "SDKs / Android",
    version: "v5",
    isCurrent: true,
    body: "Delete a message for everyone in the conversation by its message ID.",
    keywords: "[]",
  },
  {
    path: "/sdk/ios/delete-group",
    title: "Delete A Group",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: "Delete a group, and every message in it, for everyone.",
  },
  {
    path: "/sdk/ios/pin-message",
    title: "Pin Message",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `Pinned messages are visible to everyone in the conversation. Unpin a message before you delete it for good. ${FILLER} ${FILLER}`,
  },
  // A current page holding every word of "ios delivery and read receipts",
  // though not the page the title names: the older copy must stay below it.
  {
    path: "/sdk/ios/marking-delivered",
    title: "Marking Delivered With Push",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `Mark delivery and read receipts from a push notification. ${FILLER}`,
  },
  // "ios edit a sent message": the Edit page never says "sent".
  {
    path: "/sdk/ios/edit-message",
    title: "Edit Message",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `Edit a message by its message ID and listen for edits. ${FILLER}`,
  },
  {
    path: "/sdk/ios/message-composer",
    title: "Composer",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `The composer lets users edit a sent message or write a new one. ${FILLER} ${FILLER} ${FILLER}`,
  },
  // A renamed API: only the older pages name it.
  {
    path: "/calls/v4/android/ringing",
    title: "Ringing",
    section: "Calls / Android",
    trail: "Calling",
    version: "v4",
    isCurrent: false,
    body: "Handle onCallEndButtonPressed when the call end button is pressed on android.",
  },
  {
    path: "/calls/v4/android/call-session",
    title: "Call Session",
    section: "Calls / Android",
    trail: "Calling",
    version: "v4",
    isCurrent: false,
    body: "The onCallEndButtonPressed listener runs when the end button of a call is pressed on android.",
  },
  {
    path: "/calls/android/background-handling",
    title: "Background Handling",
    section: "Calls / Android",
    trail: "Calling",
    version: "v5",
    isCurrent: true,
    body: `When the call end button is pressed on android, leave the session. ${FILLER}`,
  },
  {
    path: "/calls/android/call-session",
    title: "Call Session",
    section: "Calls / Android",
    trail: "Calling",
    version: "v5",
    isCurrent: true,
    body: `End the session when the end button of a call is pressed on android. ${FILLER}`,
  },
  // Search keywords and stopwords.
  {
    path: "/sdk/javascript/typing-indicators",
    title: "Typing Indicators",
    section: "SDK / Javascript",
    trail: "SDKs / JavaScript",
    version: "v4",
    isCurrent: true,
    body: `Send startTyping and endTyping events so the receiver can show a typing indicator. ${FILLER}`,
  },
  {
    // Repeats "typing" and "bubble": plain bm25 saturates on both.
    path: "/ui-kit/react/message-bubble-styling",
    title: "Message Bubble Styling",
    section: "UI Kit / React",
    trail: "UI Kits / React",
    version: "v7",
    isCurrent: true,
    body: "Style the bubble. The typing bubble and the text bubble take colors. Typing shows in a bubble. Bubble typing bubble.",
  },
  {
    path: "/sdk/javascript/user-presence",
    title: "User Presence",
    section: "SDK / Javascript",
    trail: "SDKs / JavaScript",
    version: "v4",
    isCurrent: true,
    body: `Subscribe to presence to learn when a user goes online or offline, and read lastActiveAt. ${FILLER}`,
  },
  {
    path: "/sdk/ios/user-presence",
    title: "User Presence",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `Subscribe to presence to learn when a user goes online or offline. ${FILLER}`,
  },
  // Says "js" (Next.js), as a hundred-odd real pages do.
  {
    path: "/ui-kit/react/integration-nextjs",
    title: "Next.js Integration",
    section: "UI Kit / React",
    trail: "UI Kits / React",
    version: "v7",
    isCurrent: true,
    body: "Add the kit to a Next.js app.",
  },
  // Holds every word of a query made only of platform words.
  {
    path: "/ui-kit/react/overview",
    title: "React UI Kit",
    section: "UI Kit / React",
    trail: "UI Kits / React",
    version: "v7",
    isCurrent: true,
    body: `The React UI Kit builds on the JavaScript SDK, as the iOS, Android and Flutter kits build on theirs. ${FILLER}`,
  },
];

let tmp: string;
let indexPath: string;
let client: SqliteSearchClient;

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-matching-"));
  indexPath = path.join(tmp, "index.sqlite");
  buildIndex(indexPath, PAGES);
  client = new SqliteSearchClient(indexPath);
});

afterAll(() => {
  client.close();
  rmSync(tmp, { recursive: true, force: true });
});

const paths = (r: { results: { url: string }[] }) => r.results.map((x) => x.url.replace("https://www.cometchat.com/docs", ""));

/** Pages matching every word of an FTS query, as the 0.1.6 search required. */
function holdingEveryWord(match: string, at = indexPath): string[] {
  const db = new Database(at, { readonly: true });
  try {
    return (
      db
        .prepare("SELECT pages.path FROM pages_fts JOIN pages ON pages.rowid = pages_fts.rowid WHERE pages_fts MATCH ?")
        .all(match) as { path: string }[]
    ).map((r) => r.path);
  } finally {
    db.close();
  }
}

describe("stopwords", () => {
  it("are dropped from the terms that gate MATCH, unless nothing else is left", () => {
    expect(contentTerms(parseQuery("when was someone online").terms)).toEqual(["online"]);
    expect(contentTerms(parseQuery("how do I unsend a message").terms)).toEqual(["unsend", "a", "message"]);
    expect(contentTerms(["how", "is"])).toEqual(["how", "is"]);
    // A term with no letter or digit matches nothing.
    expect(contentTerms(parseQuery("ios - delete").terms)).toEqual(["ios", "delete"]);
  });

  // The request verbs earn their place on SHORT queries. At four words or more
  // relaxed matching drops one word anyway, so every other case here and in
  // the eval would pass without them.
  it("drop the request verb from a query too short for relaxed matching", () => {
    expect(contentTerms(parseQuery("show last seen").terms)).toEqual(["last", "seen"]);
    expect(contentTerms(parseQuery("check delivery receipts").terms)).toEqual(["delivery", "receipts"]);
    expect(contentTerms(parseQuery("see typing indicators").terms)).toEqual(["typing", "indicators"]);
  });

  it("leave articles, prepositions and product words in the query", () => {
    for (const word of ["a", "an", "the", "to", "of", "for", "from", "in", "on", "out", "up", "off", "all", "user", "get", "set"]) {
      expect(STOPWORDS.has(word), word).toBe(false);
    }
  });

  it("no longer hide a page that lacks one of them", async () => {
    expect(holdingEveryWord('"when" "was" "someone" "online"')).toEqual([]);
    expect(paths(await client.search("when was someone online")).sort()).toEqual([
      "/sdk/ios/user-presence",
      "/sdk/javascript/user-presence",
    ]);
  });
});

describe("the js alias", () => {
  it("widens js to javascript unless the query names a platform or web framework", () => {
    expect(termGroups(["js", "user", "presence"])).toEqual([["js", "javascript"], ["user"], ["presence"]]);
    const named = ["react js", "next js", "node js", "nest js", "express js", "react-native js", "node-js chat", "ios js"];
    for (const q of named) {
      expect(termGroups(q.split(" ")), q).toEqual(q.split(" ").map((t) => [t]));
    }
    // "next", "node" and "express" are ordinary words unless "js" follows.
    for (const q of ["js fetch next page", "js node list", "js express checkout"]) {
      expect(termGroups(q.split(" "))[0], q).toEqual(["js", "javascript"]);
    }
    // TypeScript mostly means the web UI Kits, not the JavaScript SDK.
    expect(termGroups(["ts", "typescript"])).toEqual([["ts"], ["typescript"]]);
    // "rn" is how people write React Native; the docs write it out.
    expect(termGroups(["rn", "setup"])).toEqual([["rn", "react native"], ["setup"]]);
  });

  it("looks words up as aliases only when they are aliases, not inherited object properties", async () => {
    expect(termGroups(["constructor"])).toEqual([["constructor"]]);
    expect(termGroups(["__proto__", "tostring", "hasownproperty"])).toEqual([
      ["__proto__"],
      ["tostring"],
      ["hasownproperty"],
    ]);
    for (const q of ["constructor", "class constructor", "__proto__", "valueOf toString"]) {
      await expect(client.search(q), q).resolves.toMatchObject({ totalAvailable: expect.any(Number) });
    }
  });

  it("ranks the JavaScript SDK page a js query means, and only it, without the pages that say Next.js", async () => {
    // Guard: some pages say "js"; the alternatives must stay grouped, or
    // (js OR javascript AND user AND presence) matches every one of them.
    expect(holdingEveryWord('"js"')).toEqual(["/ui-kit/react/integration-nextjs"]);
    expect(paths(await client.search("js user presence"))).toEqual(["/sdk/javascript/user-presence"]);
  });
});

describe("title keys", () => {
  it("drop punctuation, 'and' and articles on both sides", () => {
    expect(titleKey("Delivery & Read Receipts")).toBe("delivery read receipts");
    expect(titleKey("Delete A Message")).toBe("delete message");
    expect(titleKey("Building A One-to-One / Group Chat")).toBe("building one to one group chat");
    expect(titleKeyWords("pin and save messages")).toEqual(["pin", "save", "messages"]);
    // The query's words, then its words without stopwords.
    expect(titleKeyText(["delete", "my", "message"], ["delete", "message"])).toBe(" delete my message | delete message ");
  });

  it("let a query name a title it words differently", async () => {
    const db = new Database(indexPath, { readonly: true });
    const plain = db
      .prepare(
        `SELECT pages.path FROM pages_fts JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH '"ios" "delete" "a" "message"' AND pages.is_current = 1 ORDER BY bm25(pages_fts, 5, 1, 1, 2)`,
      )
      .all() as { path: string }[];
    db.close();
    // Guard: on weighted bm25 alone the shorter Delete A Group page wins.
    expect(plain[0].path).toBe("/sdk/ios/delete-group");
    expect(paths(await client.search("ios delete a message"))[0]).toBe("/sdk/ios/delete-message");
    expect(paths(await client.search("delete my message ios"))[0]).toBe("/sdk/ios/delete-message");
  });

  it("do not lift an older copy of the page above current pages", async () => {
    const r = paths(await client.search("ios delivery and read receipts", { limit: 10 }));
    expect(r[0]).toBe("/sdk/ios/delivery-read-receipts");
    // The v2 copy keeps 0.1.6's exact-title rule, which "and" never meets, so
    // it stays below a current page that merely holds the same words.
    expect(r.indexOf("/sdk/ios/marking-delivered")).toBeGreaterThan(0);
    expect(r.indexOf("/sdk/ios/2.0/delivery-read-receipts")).toBeGreaterThan(r.indexOf("/sdk/ios/marking-delivered"));
  });

  it("are stored empty for a title that only names its doc set", () => {
    const docSets = ["iOS SDK", "React Native SDK", "Chat SDK", "Calls SDK", "Android UI Kit", "React Native UI Kit"];
    for (const title of docSets) {
      expect(indexedTitleKey(title), title).toBe("");
    }
    expect(indexedTitleKey("Delivery & Read Receipts")).toBe("delivery read receipts");
    expect(indexedTitleKey("Next.js Integration")).toBe("next js integration");
    expect(indexedTitleKey("Block Users")).toBe("block users");
  });

  it("read what a query asks for once the doc set it names is taken away", () => {
    expect(featureKey("angular ui kit guides")).toBe("guides");
    expect(featureKey("ios calls sessionsettingsbuilder")).toBe("sessionsettingsbuilder");
    expect(featureKey("react native ui kit message list")).toBe("message list");
    // A query naming no doc set has no feature key: "moderation" must not name
    // the page titled "Moderation" over the one it usually wants.
    expect(featureKey("moderation")).toBe("");
    expect(featureKey("delete a message")).toBe("");
    // A query naming nothing else has none either ("ios sdk" is its doc set).
    expect(featureKey("ios sdk")).toBe("");
  });
});

describe("search keywords", () => {
  it("rank the page whose keyword the query holds whole above pages saturated with its words", async () => {
    const db = new Database(indexPath, { readonly: true });
    const plain = db
      .prepare(
        `SELECT pages.path FROM pages_fts JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH '"typing" "bubble"' ORDER BY bm25(pages_fts, 5, 1, 1, 2)`,
      )
      .all() as { path: string }[];
    db.close();
    // Guard: on weighted bm25 alone the styling page wins.
    expect(plain[0].path).toBe("/ui-kit/react/message-bubble-styling");
    expect(paths(await client.search("typing bubble"))[0]).toBe("/sdk/javascript/typing-indicators");
    // Only the whole keyword, in order, earns the bonus.
    expect(paths(await client.search("bubble typing"))[0]).toBe("/ui-kit/react/message-bubble-styling");
  });

  // A keyword the query holds whole hands its pages KEYWORD_BONUS, so a
  // one-word keyword hands it to them on every query holding that word,
  // whatever else the query asks: as "favourite", it gave the Save-a-Message
  // pages all five of "favourite reactions". Only these coinages, which the
  // docs use for nothing else, may stand alone.
  const COINAGES = new Set(["unsend", "unsent", "dm"]);

  it("are listed so that a query can hold them whole", () => {
    for (const { keywords } of FEATURE_KEYWORDS) {
      for (const k of keywords) {
        expect(normalizeKeyword(k), k).toBe(k);
        const words = k.split(" ");
        // parseQuery de-duplicates query words, so a repeated word could never match whole.
        expect(new Set(words).size, k).toBe(words.length);
        expect(words.every((w) => STOPWORDS.has(w)), k).toBe(false);
        if (words.length === 1) expect(COINAGES.has(k), `${k} stands alone but is an ordinary word`).toBe(true);
      }
    }
    // Hyphens split the way query terms do; no keyword needs it yet, and the
    // first one that does must not silently never match.
    expect(normalizeKeyword("Read-Receipt")).toBe("read receipt");
    const earned = (title: string) => JSON.parse(pageKeywords(title));
    expect(earned("Delete A Message")).toEqual([
      "unsend",
      "unsent",
      "recall message",
      "recall a message",
      "retract message",
      "retract a message",
      "delete for everyone",
    ]);
    expect(earned("User Presence")).toEqual(["last seen", "last online", "is online", "online status"]);
    expect(earned("Message Information")).toEqual(["who has seen", "who read this", "delivery details"]);
    expect(earned("Delivery & Read Receipts")).toEqual([
      "seen status",
      "message seen",
      "read status",
      "message was read",
      "blue ticks",
      "double ticks",
    ]);
    expect(earned("Typing Indicators")).toEqual([
      "is typing",
      "user is typing",
      "typing bubble",
      "typing status",
      "typing dots",
      "typing events",
      "typing indicator",
    ]);
    expect(earned("Send Messages")).toEqual(["dm", "direct message"]);
    expect(earned("Building A One-to-One / Group Chat")).toEqual(["dm", "direct message"]);
    expect(earned("Saved Messages")).toEqual([
      "star message",
      "star a message",
      "starred message",
      "starred messages",
      "bookmark message",
      "bookmark a message",
      "favorite message",
      "favourite message",
    ]);
    expect(JSON.parse(pageKeywords("Delete Message"))).toContain("unsend");
    expect(JSON.parse(pageKeywords("Delete A Group"))).toEqual([]);
    expect(JSON.parse(pageKeywords("Receipts", { listed: false }))).toEqual([]);
    // An OpenAPI reference page keeps the coinages, which the docs use for
    // nothing else, and not the keywords whose single words are ordinary.
    expect(JSON.parse(pageKeywords("Delete A Message", { openapi: true }))).toEqual(["unsend", "unsent"]);
    expect(JSON.parse(pageKeywords("Save Message", { openapi: true }))).toEqual([]);
  });
});

describe("relaxed matching", () => {
  it("adds the pages missing one word next to those holding every word", async () => {
    // Guard: every word is required in 0.1.6, and only the UI Kit pages hold them all.
    expect(holdingEveryWord('"delivery" "and" "read" "receipts" "enable" "disable"').sort()).toEqual([
      "/ui-kit/flutter/message-list",
      "/ui-kit/react/message-list",
    ]);
    const r = await client.search("delivery and read receipts enable disable", { limit: 10 });
    const p = paths(r);
    expect(p.slice(0, 3)).toContain("/sdk/ios/delivery-read-receipts");
    expect(p).toContain("/ui-kit/react/message-list");
    expect(p).toContain("/ui-kit/flutter/message-list");
    // One per title beside the full matches; the other copy comes after them.
    expect(p.indexOf("/sdk/javascript/delivery-read-receipts")).toBeGreaterThan(p.indexOf("/ui-kit/react/message-list"));
    expect(p.indexOf("/sdk/javascript/delivery-read-receipts")).toBeGreaterThan(p.indexOf("/ui-kit/flutter/message-list"));
    expect(r.totalAvailable).toBe(p.length);
  });

  it("starts at four words and stops at eight", async () => {
    const groups = (q: string) => q.split(" ").map((t) => [t]);
    expect(relaxedMatchQuery(groups("edit sent message"))).toBeNull();
    expect(relaxedMatchQuery(groups("ios edit sent message"))).toBe('"ios" AND ("edit" OR "sent" OR "message")');
    expect(relaxedMatchQuery(groups("one two three four five six seven eight"))).not.toBeNull();
    expect(relaxedMatchQuery(groups("one two three four five six seven eight nine"))).toBeNull();
    // Four words: the Edit page lacks only "sent", and joins at full weight.
    expect(paths(await client.search("ios edit sent message"))[0]).toBe("/sdk/ios/edit-message");
    // Three: every word is required, as in 0.1.6.
    const three = await client.search("edit sent message", { limit: 10 });
    expect(three.totalAvailable).toBe(holdingEveryWord('"edit" "sent" "message"').length);
  });

  it("drops any word but a platform, language or doc set word", () => {
    // "chat", "message", "on" and "customize" appear in docs.json trails
    // ("Chat & Messaging", "On-Premise Deployment", "Customization"), but a
    // page lacking one can still be the answer.
    for (const word of ["chat", "message", "on", "customize", "ui", "kit", "sdk", "push"]) {
      expect(isPlatformTerm(word), word).toBe(false);
    }
    for (const word of ["ios", "android", "react-native", "native", "swift", "objective-c", "js", "calls"]) {
      expect(isPlatformTerm(word), word).toBe(true);
    }
    expect(relaxedMatchQuery([["android"], ["chat"], ["ui"], ["kit"], ["mentions"], ["formatter"]])).toBe(
      '"android" AND ("chat" OR "ui" OR "kit" OR "mentions" OR "formatter")',
    );
    expect(relaxedMatchQuery([["js", "javascript"], ["on"], ["message"], ["customize"]])).toBe(
      '("js" OR "javascript") AND ("on" OR "message" OR "customize")',
    );
    // Every word names a platform: nothing may be dropped.
    expect(relaxedMatchQuery([["react"], ["ios"], ["android"], ["flutter"]])).toBeNull();
  });

  it("serves a query whose every word names a platform", async () => {
    expect(holdingEveryWord('"react" "ios" "android" "flutter"')).toEqual(["/ui-kit/react/overview"]);
    expect(paths(await client.search("react ios android flutter"))).toEqual(["/ui-kit/react/overview"]);
  });

  it("counts the pages missing one word the same at every limit", async () => {
    const q = "delivery and read receipts enable disable";
    const all = (await client.search(q, { limit: 10 })).totalAvailable;
    expect(all).toBeGreaterThan(2);
    expect((await client.search(q, { limit: 1 })).totalAvailable).toBe(all);
    expect((await client.search(q, { limit: 2 })).totalAvailable).toBe(all);
  });

  it("never drops a word naming a platform", async () => {
    expect(holdingEveryWord('"ios" "delete" "message" "for" "everyone"').sort()).toEqual([
      "/sdk/ios/delete-group",
      "/sdk/ios/pin-message",
    ]);
    const p = paths(await client.search("ios delete message for everyone", { limit: 10 }));
    expect(p).toContain("/sdk/ios/delete-message");
    // It lacks only "ios".
    expect(p).not.toContain("/sdk/android/delete-message");
  });

  it("does not demote a page whose title words the query holds in order", async () => {
    // Guard: the composer page holds every word; the Edit page lacks "sent".
    expect(holdingEveryWord('"ios" "edit" "a" "sent" "message"')).toEqual(["/sdk/ios/message-composer"]);
    const r = await client.search("ios edit a sent message");
    expect(paths(r)[0]).toBe("/sdk/ios/edit-message");
    // Its snippet comes from the MATCH that found it, not the one it misses.
    expect(r.results[0].snippet).toContain("Edit a message");
    // Out of order, the page missing a word ranks at half weight.
    expect(paths(await client.search("ios sent message edit"))[0]).toBe("/sdk/ios/message-composer");
  });

  it("puts current pages first, alternating with older ones, when only older pages hold every word", async () => {
    const q = "android call end button pressed onCallEndButtonPressed";
    expect(holdingEveryWord('"android" "call" "end" "button" "pressed" "oncallendbuttonpressed"').sort()).toEqual([
      "/calls/v4/android/call-session",
      "/calls/v4/android/ringing",
    ]);
    const r = await client.search(q, { limit: 5 });
    expect(r.results.slice(0, 4).map((x) => x.isCurrent)).toEqual([true, false, true, false]);
    // Asking for the older version keeps them first.
    expect(paths(await client.search(`${q} v4`, { limit: 5 })).slice(0, 2).sort()).toEqual([
      "/calls/v4/android/call-session",
      "/calls/v4/android/ringing",
    ]);
  });

  it("leaves the any-word fallback alone when no page holds every word", async () => {
    const r = await client.search("ios delete message zzzqqq", { limit: 25 });
    const any = new Set(
      ["ios", "delete", "message"].flatMap((w) => holdingEveryWord(`"${w}"`)),
    );
    expect(r.totalAvailable).toBe(any.size);
  });

  it("reads a title key that repeats a word from the query's word sequence", () => {
    // The LIKE pattern asks for the title key's words in turn, so a key like
    // "one to one group chat" needs "one" twice — and the subject was built
    // from the DE-DUPLICATED terms, which can never supply it. 14 indexed page
    // groups have such a key, every One-to-One / Group Chat page among them,
    // and for those the documented rule ("not demoted when the query holds
    // their title's words in order") could not fire at all.
    const db = new Database(indexPath, { readonly: true });
    const matches = (subject: string, titleKey: string) =>
      db
        .prepare("SELECT ? LIKE '% ' || replace(?, ' ', ' % ') || ' %' AS hit")
        .pluck()
        .get(subject, titleKey) as number;
    const { words, terms } = parseQuery("ios building a one to one group chat");
    const fromWords = `  ${titleKeyWords(words.join(" ")).join("  ")}  `;
    const fromTerms = `  ${titleKeyWords(terms.join(" ")).join("  ")}  `;
    try {
      expect(matches(fromWords, "one to one group chat")).toBe(1);
      // What the de-duplicated terms produced, and why the rule never fired.
      expect(matches(fromTerms, "one to one group chat")).toBe(0);
      // A key with no repeat reads the same either way.
      expect(matches(fromWords, "group chat")).toBe(1);
      expect(matches(fromTerms, "group chat")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("scans the FTS index once as the outer loop, not once per page", () => {
    const db = new Database(indexPath, { readonly: true });
    const { relaxed } = buildQueries({ versionMetadata: true, productTrails: true, keywords: true, titleKeys: true });
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${relaxed}`).all({
        match: '"ios" AND ("delete" OR "message" OR "everyone")',
        version: null,
        limit: 10,
        legacyFactor: 0.5,
        named: null,
        terms: 4,
        titleText: " ios delete message everyone ",
        titleKey: " ios delete message everyone | ios delete message everyone ",
        docSetQuery: 0,
        featureKey: "delete message everyone",
        titleWords: "  ios  delete  message  everyone  ",
        topicTerms: 3,
        areaTerms: "[]",
        startQuery: 0,
        startWidened: 0,
        docSetGroups: '[{"i":0,"words":["ios"]}]',
        unnamedPlatforms: '["android"]',
        phrases: '["\\"ios\\"","\\"delete\\"","\\"message\\"","\\"everyone\\""]',
        all: '["\\"ios\\"","\\"delete\\"","\\"message\\"","\\"everyone\\""]',
        relaxedFactor: 0.5,
      }) as { detail: string }[]
    ).map((r) => r.detail);
    db.close();
    // Only the FTS index is scanned, through its MATCH; pages is never the
    // outer loop (which evaluated the MATCH once per page). The plan's exact
    // wording varies across SQLite versions, so only its shape is checked.
    const fts = plan.filter((d) => /^SCAN pages_fts\b/.test(d));
    expect(fts.length).toBeGreaterThan(0);
    for (const d of fts) expect(d).toMatch(/VIRTUAL TABLE INDEX/);
    expect(plan.some((d) => /^SCAN pages\b(?!_fts)/.test(d))).toBe(false);
  });
});

describe("query words", () => {
  it("split a qualified API name into its parts, keeping version numbers whole", () => {
    expect(parseQuery("CometChat.markAsRead").terms).toEqual(["cometchat", "markasread"]);
    expect(parseQuery("CometChat.getUser().then(user)").terms).toEqual(["cometchat", "getuser", "thenuser"]);
    expect(parseQuery("Next.js app")).toEqual({
      terms: ["next", "js", "app"],
      words: ["next", "js", "app"],
      versions: [],
    });
    expect(parseQuery("ios v4.0 upgrade 3.0")).toEqual({
      terms: ["ios", "upgrade"],
      words: ["ios", "upgrade"],
      versions: [
        { word: "v4.0", label: "v4" },
        { word: "3.0", label: "v3" },
      ],
    });
  });

  it("are served from an index with the builder's current schema without the outdated warning", async () => {
    const spy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const c = new SqliteSearchClient(indexPath);
    try {
      await c.search("typing bubble");
      expect(spy.mock.calls.filter((call) => (call as unknown[])[1] === "sqlite_index_outdated")).toEqual([]);
    } finally {
      spy.mockRestore();
      c.close();
    }
  });

  it("with control characters or no word at all, find nothing rather than fail", async () => {
    const nul = String.fromCharCode(0);
    for (const q of [nul, `- ${nul}`, `_ ${nul}`, `-- ${nul} --`, "- -", `"${nul}"`]) {
      await expect(client.search(q), JSON.stringify(q)).resolves.toEqual({ results: [], totalAvailable: 0 });
    }
  });
});

// Relaxed matching when older pages lead the full matches.
const LEAD_PAGES: Page[] = [
  // Only older pages name the renamed API.
  {
    path: "/calls/v4/android/ringing",
    title: "Ringing",
    section: "Calls / Android",
    trail: "Calling",
    version: "v4",
    isCurrent: false,
    body: "Handle onCallEndButtonPressed when the call end button is pressed on android.",
  },
  // v4 is also the current iOS SDK's label: once a version is chosen, being
  // current says nothing, and this page lacks only the API name.
  {
    path: "/sdk/ios/calling",
    title: "Calling",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `When the call end button is pressed, end the call. ${FILLER}`,
  },
  // An older page and a current one both name this API; another current page
  // lacks it. The short older page ranks first.
  {
    path: "/calls/v4/android/audio",
    title: "Audio",
    section: "Calls / Android",
    trail: "Calling",
    version: "v4",
    isCurrent: false,
    body: "Handle onAudioModeChanged when the audio mode changes on android.",
  },
  {
    path: "/calls/android/audio-modes",
    title: "Audio Modes",
    section: "Calls / Android",
    trail: "Calling",
    version: "v5",
    isCurrent: true,
    body: `Listen for onAudioModeChanged: the audio mode changes on android when a headset connects. ${FILLER} ${FILLER}`,
  },
  {
    path: "/calls/android/audio-routing",
    title: "Audio Routing",
    section: "Calls / Android",
    trail: "Calling",
    version: "v5",
    isCurrent: true,
    body: `The audio mode changes on android as devices connect. ${FILLER}`,
  },
];

describe("relaxed matching, when older pages lead", () => {
  let dir: string;
  let lead: SqliteSearchClient;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-lead-"));
    buildIndex(path.join(dir, "index.sqlite"), LEAD_PAGES);
    lead = new SqliteSearchClient(path.join(dir, "index.sqlite"));
  });
  afterAll(() => {
    lead.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the ranked order when a current page holds every word too, at every limit", async () => {
    const q = "android audio mode changes onAudioModeChanged";
    const top10 = paths(await lead.search(q, { limit: 10 }));
    // The older page ranks first; the current one naming the API follows.
    expect(top10[0]).toBe("/calls/v4/android/audio");
    expect(top10).toContain("/calls/android/audio-modes");
    expect(top10).toContain("/calls/android/audio-routing");
    // With room for one result, the current full match is below the page
    // shown, and must still stop the alternation.
    expect(paths(await lead.search(q, { limit: 1 }))).toEqual([top10[0]]);
  });

  it("does not alternate once a version is chosen", async () => {
    const r = await lead.search("call end button pressed onCallEndButtonPressed", { version: "v4", limit: 5 });
    expect(paths(r)).toEqual(["/calls/v4/android/ringing", "/sdk/ios/calling"]);
  });
});

// The pages missing one word are their own ranked page of results, and the
// current page among them can rank below the older ones. Read at the caller's
// `limit`, that page would hold no current row for a small limit and one for a
// larger limit, so the merge below would alternate only sometimes and the same
// query would answer a different first result.
const WINDOW_PAGES: Page[] = [
  // The only page holding every word, and older: the alternation's precondition.
  {
    path: "/sdk/v4/webhooks/retries",
    title: "Retries",
    section: "SDK / Webhooks",
    trail: "Webhooks",
    version: "v4",
    isCurrent: false,
    body: "Webhook retry uses a backoff schedule; tuning it changes the delay.",
  },
  // Older pages missing "tuning". Short, so they lead the relaxed page and
  // push the current one below a small limit.
  {
    path: "/sdk/v4/webhooks/backoff",
    title: "Backoff",
    section: "SDK / Webhooks",
    trail: "Webhooks",
    version: "v4",
    isCurrent: false,
    body: "Webhook retry backoff schedule.",
  },
  {
    path: "/sdk/v4/webhooks/delivery",
    title: "Delivery",
    section: "SDK / Webhooks",
    trail: "Webhooks",
    version: "v4",
    isCurrent: false,
    body: "Webhook retry backoff schedule for delivery.",
  },
  {
    path: "/sdk/v4/webhooks/events",
    title: "Events",
    section: "SDK / Webhooks",
    trail: "Webhooks",
    version: "v4",
    isCurrent: false,
    body: "Webhook retry backoff schedule for events.",
  },
  // The current page missing "tuning", fourth of the relaxed page.
  {
    path: "/sdk/webhooks/schedule",
    title: "Schedules",
    section: "SDK / Webhooks",
    trail: "Webhooks",
    version: "v5",
    isCurrent: true,
    body: `Webhook retry follows a backoff schedule. ${FILLER} ${FILLER} ${FILLER}`,
  },
];

describe("relaxed matching reads a window, not the caller's limit", () => {
  let dir: string;
  let win: SqliteSearchClient;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-window-"));
    buildIndex(path.join(dir, "index.sqlite"), WINDOW_PAGES);
    win = new SqliteSearchClient(path.join(dir, "index.sqlite"));
  });
  afterAll(() => {
    win.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const QUERY = "webhook retry backoff schedule tuning";

  it("answers the same first result at every limit", async () => {
    const first = await Promise.all([1, 2, 3, 4, 5, 10].map(async (limit) => paths(await win.search(QUERY, { limit }))[0]));
    // The current page missing one word leads: nothing asked for v4.
    expect(first).toEqual(Array(6).fill("/sdk/webhooks/schedule"));
  });

  it("returns a prefix of the larger page at every limit", async () => {
    const full = paths(await win.search(QUERY, { limit: 10 }));
    expect(full).toEqual([
      "/sdk/webhooks/schedule",
      "/sdk/v4/webhooks/retries",
      "/sdk/v4/webhooks/backoff",
      "/sdk/v4/webhooks/delivery",
      "/sdk/v4/webhooks/events",
    ]);
    for (const limit of [1, 2, 3, 4, 5]) {
      const page = paths(await win.search(QUERY, { limit }));
      expect(page, `limit ${limit}`).toEqual(full.slice(0, limit));
    }
  });

  it("counts the same matches at every limit", async () => {
    for (const limit of [1, 2, 3, 4, 5, 10]) {
      expect((await win.search(QUERY, { limit })).totalAvailable, `limit ${limit}`).toBe(WINDOW_PAGES.length);
    }
  });
});

// Ranking guards with pages the main fixture's rankings must not see.
const GUARD_PAGES: Page[] = [
  // Overviews titled with their doc set's name, which most queries about the
  // platform hold whole; each lacks "block".
  {
    path: "/sdk/ios/overview",
    title: "iOS SDK",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: "The iOS SDK lets a user chat and see typing indicators. Look a user up by UID.",
  },
  {
    path: "/sdk/ios/typing-indicators",
    title: "Typing Indicators",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `Send typing indicators while a user writes, and show them as others type. ${FILLER}`,
  },
  {
    path: "/sdk/ios/block-users",
    title: "Block Users",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `Block a user by UID so that they cannot message you. ${FILLER}`,
  },
  {
    path: "/sdk/react-native/overview",
    title: "React Native SDK",
    section: "SDK / React-native",
    trail: "SDKs / React Native",
    version: "v4",
    isCurrent: true,
    body: "The React Native SDK lets a user chat. Look a user up by UID.",
  },
  // Names the doc set more often than its overview does.
  {
    path: "/sdk/react-native/setup",
    title: "React Native SDK Setup",
    section: "SDK / React-native",
    trail: "SDKs / React Native",
    version: "v4",
    isCurrent: true,
    body: "Install the React Native SDK package, then initialise the React Native SDK.",
  },
  {
    path: "/sdk/react-native/block-users",
    title: "Block Users",
    section: "SDK / React-native",
    trail: "SDKs / React Native",
    version: "v4",
    isCurrent: true,
    body: `Block a user by UID so that they cannot message you. ${FILLER}`,
  },
  // The current page was retitled, so only its older copy earns the presence keywords.
  {
    path: "/sdk/javascript/user-presence",
    title: "Online Presence",
    section: "SDK / Javascript",
    trail: "SDKs / JavaScript",
    version: "v4",
    isCurrent: true,
    body: "Show when a user was last seen online, and subscribe to presence events.",
  },
  {
    path: "/sdk/javascript/3.0/user-presence",
    title: "User Presence",
    section: "SDK / Javascript",
    trail: "SDKs / JavaScript",
    version: "v3",
    isCurrent: false,
    body: "Show when a user was last seen.",
  },
  // Its keywords ("dm") hide in ordinary words ("admin").
  {
    path: "/sdk/javascript/send-message",
    title: "Send A Message",
    section: "SDK / Javascript",
    trail: "SDKs / JavaScript",
    version: "v4",
    isCurrent: true,
    body: "Send a message to a user, or to a group whose admin roles allow it.",
  },
  {
    path: "/sdk/javascript/group-roles",
    title: "Group Roles",
    section: "SDK / Javascript",
    trail: "SDKs / JavaScript",
    version: "v4",
    isCurrent: true,
    body: "Each group member has one of three roles: admin, moderator or participant. An admin can change the roles of others.",
  },
];

describe("ranking guards", () => {
  let dir: string;
  let guard: SqliteSearchClient;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-guard-"));
    buildIndex(path.join(dir, "index.sqlite"), GUARD_PAGES);
    guard = new SqliteSearchClient(path.join(dir, "index.sqlite"));
  });
  afterAll(() => {
    guard.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("do not let an overview titled with the doc set's name outrank the feature page", async () => {
    expect(holdingEveryWord('"block"', path.join(dir, "index.sqlite")).sort()).toEqual([
      "/sdk/ios/block-users",
      "/sdk/react-native/block-users",
    ]);
    // Missing a word, the overview joins at half weight, without a title bonus.
    expect(paths(await guard.search("ios sdk block a user by uid"))[0]).toBe("/sdk/ios/block-users");
    expect(paths(await guard.search("react native sdk block a user by uid"))[0]).toBe("/sdk/react-native/block-users");
    // Holding every word, it still earns no bonus for a title the query holds
    // beside the feature it asks about.
    expect(holdingEveryWord('"ios" "sdk" "typing" "indicators"', path.join(dir, "index.sqlite")).sort()).toEqual([
      "/sdk/ios/overview",
      "/sdk/ios/typing-indicators",
    ]);
    expect(paths(await guard.search("ios sdk typing indicators"))[0]).toBe("/sdk/ios/typing-indicators");
    // The overview is the answer when the query names only the doc set.
    expect(paths(await guard.search("react native sdk"))[0]).toBe("/sdk/react-native/overview");
    expect(paths(await guard.search("the ios sdk"))[0]).toBe("/sdk/ios/overview");
  });

  it("count a keyword only as whole words of the query", async () => {
    // "dm" is in "admin", but the query does not say it.
    expect(paths(await guard.search("javascript admin roles"))[0]).toBe("/sdk/javascript/group-roles");
  });

  it("do not let a keyword lift an older copy above the current page", async () => {
    const r = await guard.search("last seen", { limit: 5 });
    expect(paths(r)).toEqual(["/sdk/javascript/user-presence", "/sdk/javascript/3.0/user-presence"]);
  });
});

// A plain-language question: its question words are not MATCH terms, so the
// words that are leave a page the question is not about matching too, and bm25
// prefers the shorter of the two. What still names the page asked for is its
// title, spread over the question's filler.
const QUESTION_PAGES: Page[] = [
  {
    path: "/sdk/flutter/send-message",
    title: "Send a Message",
    section: "SDK / Flutter",
    trail: "Chat SDK / Flutter",
    version: null,
    isCurrent: true,
    keywords: "[]",
    body: `Send a text, an image or a video message to a user or a group in Flutter. ${FILLER}`,
  },
  {
    path: "/ui-kit/flutter/campaigns",
    title: "Campaigns",
    section: "UI Kit / Flutter",
    trail: "UI Kit / Flutter",
    version: null,
    isCurrent: true,
    keywords: "[]",
    body: "Send an image message to every user in Flutter.",
  },
];

describe("a plain-language question", () => {
  let dir: string;
  let ask: SqliteSearchClient;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-question-"));
    buildIndex(path.join(dir, "index.sqlite"), QUESTION_PAGES);
    ask = new SqliteSearchClient(path.join(dir, "index.sqlite"));
  });
  afterAll(() => {
    ask.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ranks the page whose title it holds in order over the shorter page holding the same words", async () => {
    // Guard: both pages hold every MATCH term, so relaxed matching adds
    // nothing and the shorter page is the one bm25 alone answers with.
    const every = holdingEveryWord('"send" "an" "image" "message" "in" "flutter"', path.join(dir, "index.sqlite"));
    expect(every.sort()).toEqual(["/sdk/flutter/send-message", "/ui-kit/flutter/campaigns"]);
    expect(paths(await ask.search("how do i send an image message in flutter"))[0]).toBe("/sdk/flutter/send-message");
  });

  it("reads the title's words in the order the question writes them", async () => {
    expect(paths(await ask.search("how do i message an image send in flutter"))[0]).toBe("/ui-kit/flutter/campaigns");
  });
});

// A query that names a doc set and, once that is taken away, nothing but a
// page's whole title -- which is one word, so neither title rule above can
// reach it (see featureKey).
const FEATURE_PAGES: Page[] = [
  {
    path: "/ui-kit/angular/guides/guides-overview",
    title: "Guides",
    section: "UI Kit / Angular",
    trail: "UI Kit / Angular",
    version: null,
    isCurrent: true,
    keywords: "[]",
    body: `Every guide for the Angular UI Kit, one by one. ${FILLER}`,
  },
  {
    path: "/ui-kit/angular/styling",
    title: "Component Styling",
    section: "UI Kit / Angular",
    trail: "UI Kit / Angular",
    version: null,
    isCurrent: true,
    keywords: "[]",
    body: "Style an Angular UI Kit component; the guides cover the rest.",
  },
];

describe("a one-word title the query names once its doc set is taken away", () => {
  let dir: string;
  let feature: SqliteSearchClient;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-feature-"));
    buildIndex(path.join(dir, "index.sqlite"), FEATURE_PAGES);
    feature = new SqliteSearchClient(path.join(dir, "index.sqlite"));
  });
  afterAll(() => {
    feature.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ranks it over the shorter page that only mentions the word", async () => {
    const every = holdingEveryWord('"angular" "ui" "kit" "guides"', path.join(dir, "index.sqlite"));
    expect(every.sort()).toEqual(["/ui-kit/angular/guides/guides-overview", "/ui-kit/angular/styling"]);
    expect(paths(await feature.search("angular ui kit guides"))[0]).toBe("/ui-kit/angular/guides/guides-overview");
  });
});

// A keyword held whole inside a query that asks for something else
// (KEYWORD_BONUS_SPARE_TERMS). Both pages hold every query word, so the AND
// match cannot separate them and only the bonus decides.
const ASIDE_PAGES: Page[] = [
  {
    // Earns "dm" and "direct message" from its title.
    path: "/sdk/ios/send-message",
    title: "Send A Message",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `Send a direct message to one user on iOS. The receiver gets a push notification while offline. ${FILLER}`,
  },
  {
    path: "/notifications/ios-apns-push-notifications",
    title: "iOS APNs Push Notifications",
    section: "Notifications / Ios-Apns-Push-Notifications",
    trail: "Push",
    version: null,
    isCurrent: true,
    body: `Deliver a push notification on iOS through APNs. A direct message and a group message each raise one. ${FILLER}`,
  },
];

describe("keyword bonus scope", () => {
  let dir: string;
  let aside: SqliteSearchClient;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-aside-"));
    buildIndex(path.join(dir, "index.sqlite"), ASIDE_PAGES);
    aside = new SqliteSearchClient(path.join(dir, "index.sqlite"));
  });
  afterAll(() => {
    aside.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives the bonus to a keyword that is what the query asks", async () => {
    expect(JSON.parse(pageKeywords("Send A Message"))).toContain("direct message");
    expect(paths(await aside.search("direct message"))[0]).toBe("/sdk/ios/send-message");
    // A platform or doc set the query names is not a subject of its own.
    expect(paths(await aside.search("ios direct message"))[0]).toBe("/sdk/ios/send-message");
  });

  it("withholds it from a keyword the query only mentions in passing", async () => {
    expect(paths(await aside.search("direct message push notification ios"))[0]).toBe(
      "/notifications/ios-apns-push-notifications",
    );
  });
});

// Whether the current pages missing one word lead depends on there being no
// current page holding every word ANYWHERE, not just in the window of full
// matches that was read. Past the window the search can only learn that from
// the index, with anyCurrentStmt -- and nothing else in the suite or the eval
// fills the window, so the two fixtures below differ in one page's is_current
// alone and must answer different first results.
//
// SEARCH_MAX_RESULTS full matches keep `rows.length < window` false, so the
// statement is the only thing that decides. The deep page holds every word
// too, but its body is long enough to rank below all of them.
const WINDOW = 25;

function fullWindowPages(deepIsCurrent: boolean): Page[] {
  const pages: Page[] = [];
  // Older pages holding every word, short so they fill the window.
  for (let i = 0; i < WINDOW + 1; i++) {
    pages.push({
      path: `/sdk/v4/webhooks/retry-${i}`,
      title: `Retry Note ${i}`,
      section: "SDK / Webhooks",
      trail: "Webhooks",
      version: "v4",
      isCurrent: false,
      body: "Webhook retry backoff tuning notes.",
    });
  }
  // Holds every word as well, and ranks below the whole window: only a query
  // over the index, not the rows read, can find it.
  pages.push({
    path: "/sdk/webhooks/deep-reference",
    title: "Deep Reference",
    section: "SDK / Webhooks",
    trail: "Webhooks",
    version: deepIsCurrent ? "v5" : "v4",
    isCurrent: deepIsCurrent,
    body: `Webhook retry backoff tuning appears once here. ${FILLER.repeat(40)}`,
  });
  // Current, missing "tuning": the relaxed page, which leads only when no
  // current page holds every word.
  pages.push({
    path: "/sdk/webhooks/schedule",
    title: "Schedules",
    section: "SDK / Webhooks",
    trail: "Webhooks",
    version: "v5",
    isCurrent: true,
    body: "Webhook retry backoff schedule.",
  });
  return pages;
}

describe("relaxed matching, when the window of full matches is full", () => {
  let dir: string;
  let withCurrent: SqliteSearchClient;
  let withoutCurrent: SqliteSearchClient;
  const q = "webhook retry backoff tuning";
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-anycurrent-"));
    buildIndex(path.join(dir, "with.sqlite"), fullWindowPages(true));
    buildIndex(path.join(dir, "without.sqlite"), fullWindowPages(false));
    withCurrent = new SqliteSearchClient(path.join(dir, "with.sqlite"));
    withoutCurrent = new SqliteSearchClient(path.join(dir, "without.sqlite"));
  });
  afterAll(() => {
    withCurrent.close();
    withoutCurrent.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fills the window with older full matches, the current one below it", () => {
    for (const at of ["with.sqlite", "without.sqlite"]) {
      const held = holdingEveryWord('"webhook" "retry" "backoff" "tuning"', path.join(dir, at));
      // More full matches than the window, so `rows.length < window` is false.
      expect(held.length, at).toBeGreaterThan(WINDOW);
      expect(held, at).toContain("/sdk/webhooks/deep-reference");
    }
    // The deep page is past the window, so the rows the merge sees are all older.
    const db = new Database(path.join(dir, "with.sqlite"), { readonly: true });
    const window = db
      .prepare(
        `SELECT pages.path FROM pages_fts JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH ? ORDER BY bm25(pages_fts, 5, 1, 1, 2, 1) LIMIT ${WINDOW}`,
      )
      .pluck()
      .all('"webhook" "retry" "backoff" "tuning"') as string[];
    db.close();
    expect(window).not.toContain("/sdk/webhooks/deep-reference");
  });

  it("does not let the current relaxed page lead when a current full match is past the window", async () => {
    const top = paths(await withCurrent.search(q, { limit: 3 }));
    // Something current holds every word, so nothing is alternated: the full
    // matches keep the ranked order they were read in.
    expect(top[0]).not.toBe("/sdk/webhooks/schedule");
    for (const p of top) expect(p).toMatch(/^\/sdk\/v4\/webhooks\/retry-/);
  });

  it("lets the current relaxed page lead when every full match is older", async () => {
    const top = paths(await withoutCurrent.search(q, { limit: 3 }));
    // Nothing current holds every word, so the current page missing one leads,
    // alternating with the older full matches.
    expect(top[0]).toBe("/sdk/webhooks/schedule");
    expect(top[1]).toMatch(/^\/sdk\/v4\/webhooks\/retry-/);
  });
});

// A reference stub and the guides of the same feature. The stub's own words
// are its title and a line of boilerplate, so a query that spells the feature
// the way people say it reaches it only through its keywords: without them
// "retract a message rest api" missed both "retract" and the article, which is
// two of its five MATCH terms, so relaxed matching could not reach the stub
// either and no limit returned it. The guides do hold "retract", which kept
// the strict AND non-empty and suppressed the OR fallback that used to answer
// the query.
//
// The same keywords let one of their words reach the stub from a query about
// something else, where a document that short outscores every guide the word
// belongs to, so the stub keeps them only for a query naming the area its
// section states (STUB_OFF_AREA_FACTOR in src/search/sqlite.ts).
const STUB_PAGES: Page[] = [
  {
    path: "/rest-api/messages/delete-message",
    title: "Delete Message",
    section: "REST API / Messages",
    trail: "APIs",
    version: null,
    isCurrent: true,
    body: "For the complete error reference, see Error Guide.",
    keywords: pageKeywords("Delete Message", { openapi: true, stub: true }),
  },
  {
    // Holds every word of the query, the REST API included, so the strict AND
    // is not empty and the OR fallback never fires.
    path: "/sdk/ios/delete-message",
    title: "Delete A Message",
    section: "SDK / Ios",
    trail: "SDKs / iOS",
    version: "v4",
    isCurrent: true,
    body: `Delete a message on iOS, from the SDK or from the REST API. ${FILLER}`,
  },
  {
    path: "/sdk/javascript/delete-message",
    title: "Delete A Message",
    section: "SDK / Javascript",
    trail: "SDKs / JavaScript",
    version: "v4",
    isCurrent: true,
    body: `Delete a message on JavaScript, from the SDK or from the REST API. ${FILLER}`,
  },
];

describe("a reference stub's keywords", () => {
  let dir: string;
  let stubs: SqliteSearchClient;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-stub-"));
    buildIndex(path.join(dir, "index.sqlite"), STUB_PAGES);
    stubs = new SqliteSearchClient(path.join(dir, "index.sqlite"));
  });
  afterAll(() => {
    stubs.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("are the whole keywords, not the coinages a longer OpenAPI page keeps", () => {
    const stub = JSON.parse(pageKeywords("Delete Message", { openapi: true, stub: true }));
    expect(stub).toContain("retract a message");
    expect(stub).toContain("delete for everyone");
    // A longer OpenAPI page has text of its own to be found by, and one word
    // of a multi-word keyword would outscore the pages that word belongs to.
    expect(JSON.parse(pageKeywords("Delete Message", { openapi: true }))).toEqual(["unsend", "unsent"]);
    expect(JSON.parse(pageKeywords("Save Message", { openapi: true, stub: true }))).toContain("favourite message");
    expect(JSON.parse(pageKeywords("Save Message", { openapi: true }))).toEqual([]);
  });

  it("answer a query that names the REST API", async () => {
    // Guard: the guides hold every word, so the OR fallback cannot fire.
    expect(holdingEveryWord('"retract" "a" "message" "rest" "api"', path.join(dir, "index.sqlite"))).toContain(
      "/sdk/ios/delete-message",
    );
    expect(paths(await stubs.search("retract a message rest api"))[0]).toBe("/rest-api/messages/delete-message");
    expect(paths(await stubs.search("delete for everyone rest api"))[0]).toBe("/rest-api/messages/delete-message");
  });

  it("do not lift it over the guides on a query that names another area", async () => {
    // The same words, without the area: the guides explain the feature.
    expect(paths(await stubs.search("retract a message"))[0]).toBe("/sdk/ios/delete-message");
    expect(paths(await stubs.search("javascript retract a message"))[0]).toBe("/sdk/javascript/delete-message");
  });
});

// Getting-started pages (isStartPageTitle in src/search/phrasing.ts) and the
// React / React Native split. The current iOS start page is titled "iOS
// Integration" and never says "started", while its v4 copy is titled "Getting
// Started" and is shorter; the Flutter start page mentions iOS in passing.
// The React Native page is the shortest one holding "react ui kit install".
const START_PAGES: Page[] = [
  {
    path: "/ui-kit/ios/v4/getting-started",
    title: "Getting Started",
    section: "UI Kit / Ios",
    trail: "UI Kits / iOS",
    version: "v4",
    isCurrent: false,
    body: "Getting started with the iOS UI Kit: install it and log in.",
  },
  {
    path: "/ui-kit/ios/getting-started",
    title: "iOS Integration",
    section: "UI Kit / Ios",
    trail: "UI Kits / iOS",
    version: "v5",
    isCurrent: true,
    body: `Add the iOS UI Kit to your app: install it with Swift Package Manager, then get the app ID. ${FILLER}`,
  },
  {
    path: "/ui-kit/ios/overview",
    title: "CometChat UI Kit For iOS",
    section: "UI Kit / Ios",
    trail: "UI Kits / iOS",
    version: "v5",
    isCurrent: true,
    body: `The iOS UI Kit gets you started with ready-made chat screens. ${FILLER}`,
  },
  {
    path: "/ui-kit/flutter/getting-started",
    title: "Getting Started With CometChat Flutter UI Kit V6",
    section: "UI Kit / Flutter",
    trail: "UI Kits / Flutter",
    version: "v6",
    isCurrent: true,
    body: `Getting started with the Flutter UI Kit on iOS and Android. ${FILLER}`,
  },
  {
    path: "/ui-kit/react/integration-react",
    title: "React.js Integration",
    section: "UI Kit / React",
    trail: "UI Kits / React",
    version: "v7",
    isCurrent: true,
    body: `Install the React UI Kit with npm, then log in and render the provider. ${FILLER}`,
  },
  {
    path: "/ui-kit/react/integration-astro",
    title: "Astro Integration",
    section: "UI Kit / React",
    trail: "UI Kits / React",
    version: "v7",
    isCurrent: true,
    body: "Install the React UI Kit in an Astro site.",
  },
  {
    path: "/ui-kit/react/integration-nextjs",
    title: "Next.js Integration",
    section: "UI Kit / React",
    trail: "UI Kits / React",
    version: "v7",
    isCurrent: true,
    body: "Install the React UI Kit in a Next.js app.",
  },
  {
    path: "/ui-kit/react/react-tab-based-chat",
    title: "Tab-Based Chat",
    section: "UI Kit / React",
    trail: "UI Kits / React",
    version: "v7",
    isCurrent: true,
    body: "Build a tab based chat with the React UI Kit, one tab per conversation list, call log and user list.",
  },
  {
    path: "/ui-kit/android/getting-started-jetpack",
    title: "Getting Started With Jetpack Compose UI Kit",
    section: "UI Kit / Android",
    trail: "UI Kits / Android",
    version: "v6",
    isCurrent: true,
    body: `Add the Android UI Kit to a Jetpack Compose app. ${FILLER}`,
  },
  {
    path: "/ui-kit/android/users",
    title: "Users",
    section: "UI Kit / Android",
    trail: "UI Kits / Android",
    version: "v6",
    isCurrent: true,
    body: "The users list for Jetpack Compose: set up its style in the UI Kit.",
  },
  {
    path: "/ui-kit/angular/integration",
    title: "Integration",
    section: "UI Kit / Angular",
    trail: "UI Kits / Angular",
    version: "v5",
    isCurrent: true,
    body: "Install the Angular UI Kit with npm, then log in.",
  },
  {
    path: "/ui-kit/angular/overview",
    title: "Angular UI Kit",
    section: "UI Kit / Angular",
    trail: "UI Kits / Angular",
    version: "v5",
    isCurrent: true,
    body: `The Angular UI Kit: install it and render the chat. ${FILLER}`,
  },
  {
    path: "/ui-kit/vue/integration",
    title: "Integration",
    section: "UI Kit / Vue",
    trail: "UI Kits / Vue",
    version: "v4",
    isCurrent: true,
    body: `Set up the Vue UI Kit: install it, then log in. ${FILLER}`,
  },
  {
    path: "/ui-kit/vue/calls-integration",
    title: "Integration",
    section: "UI Kit / Vue",
    trail: "UI Kits / Vue",
    version: "v4",
    isCurrent: true,
    body: "Set up calls in the Vue UI Kit.",
  },
  {
    path: "/ui-kit/react-native/react-native-cli-integration",
    title: "React Native CLI Integration",
    section: "UI Kit / React-native",
    trail: "UI Kits / React Native",
    version: "v5",
    isCurrent: true,
    body: `Add the React Native UI Kit to a CLI app. ${FILLER}`,
  },
  {
    path: "/sdk/javascript/install-guide",
    title: "Package Guide",
    section: "SDK / Javascript",
    trail: "SDK / JavaScript",
    version: "v4",
    isCurrent: true,
    body: `How to install the JavaScript SDK package with npm or yarn. ${FILLER}`,
  },
  {
    path: "/ui-kit/react-native/react-native-tab-based-chat",
    title: "Tab-Based Chat",
    section: "UI Kit / React-native",
    trail: "UI Kits / React Native",
    version: "v5",
    isCurrent: true,
    body: "Install the React Native UI Kit and build a tab based chat.",
  },
];

describe("getting-started pages", () => {
  let dir: string;
  let start: SqliteSearchClient;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cometchat-mcp-start-"));
    buildIndex(path.join(dir, "index.sqlite"), START_PAGES);
    start = new SqliteSearchClient(path.join(dir, "index.sqlite"));
  });
  afterAll(() => {
    start.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("carry the getting-started keywords whatever their title says", () => {
    const earns = (title: string) => (JSON.parse(pageKeywords(title)) as string[]).includes("getting started");
    for (const title of [
      "iOS Integration",
      "React.js Integration",
      "Integration",
      "Setup",
      "Quickstart",
      "Getting Started",
      "Getting Started With CometChat Android UI Kit",
    ]) {
      expect(earns(title), title).toBe(true);
    }
    // Integrations of a feature, or of another product, are not where a doc set starts.
    for (const title of [
      "Calling Integration",
      "AI Agent Integration",
      "UI Kit Builder Integration",
      "Getting Started With UI Kit Builder",
      "Overview",
    ]) {
      expect(earns(title), title).toBe(false);
    }
    for (const title of ["React Native CLI Integration", "Getting Started With Jetpack Compose UI Kit"]) {
      expect(earns(title), title).toBe(true);
    }
    // A feature page the docs title just "Integration" is told apart by its slug.
    const earnsAt = (title: string, path: string) =>
      (JSON.parse(pageKeywords(title, { path })) as string[]).includes("getting started");
    expect(earnsAt("Integration", "/ui-kit/vue/integration")).toBe(true);
    expect(earnsAt("React.js Integration", "/ui-kit/react/integration-react")).toBe(true);
    expect(earnsAt("Integration", "/ui-kit/vue/calls-integration")).toBe(false);
    expect(earnsAt("Integration", "/notifications/email-integration")).toBe(false);
  });

  it("rank the current start page of the doc set the query names first, whatever it is titled", async () => {
    const top = paths(await start.search("ios ui kit getting started", { limit: 3 }));
    expect(top[0]).toBe("/ui-kit/ios/getting-started");
    // The v4 page's title is the query's words, but nothing asked for v4.
    expect(top.indexOf("/ui-kit/ios/v4/getting-started")).not.toBe(1);
    expect(paths(await start.search("react ui kit install"))[0]).toBe("/ui-kit/react/integration-react");
  });

  it("rank a framework's start page only for a query naming that framework", async () => {
    // Shorter pages on the same trail, titled after a framework the query does not name.
    expect(paths(await start.search("react ui kit install"))[0]).toBe("/ui-kit/react/integration-react");
    expect(paths(await start.search("react ui kit getting started"))[0]).toBe("/ui-kit/react/integration-react");
    for (const q of ["nextjs ui kit setup", "next.js ui kit setup", "next js ui kit install"]) {
      expect(paths(await start.search(q))[0], q).toBe("/ui-kit/react/integration-nextjs");
    }
    expect(paths(await start.search("astro ui kit install"))[0]).toBe("/ui-kit/react/integration-astro");
  });

  it("tell a start page from a feature page titled the same by its slug", async () => {
    expect(paths(await start.search("vue ui kit setup"))[0]).toBe("/ui-kit/vue/integration");
  });

  it("read native as React Native only beside react", async () => {
    expect(paths(await start.search("native ios ui kit getting started"))[0]).toBe("/ui-kit/ios/getting-started");
  });

  it("find React Native's CLI integration as its start page", async () => {
    expect(paths(await start.search("react native ui kit getting started"))[0]).toBe(
      "/ui-kit/react-native/react-native-cli-integration",
    );
  });

  it("do not pull a query that does not ask for a start page to the start pages", async () => {
    // "install" alone names no doc set: the start pages that never write the
    // word must not match it through the start-page keywords.
    const found = paths(await start.search("install", { limit: 25 }));
    expect(found).toContain("/sdk/javascript/install-guide");
    expect(found).not.toContain("/ui-kit/react-native/react-native-cli-integration");
    // A start query does reach that page through them.
    expect(paths(await start.search("react native ui kit install"))[0]).toBe(
      "/ui-kit/react-native/react-native-cli-integration",
    );
  });

  it("read a query holding a start title's own words as asking for a start page", async () => {
    expect(paths(await start.search("android jetpack compose ui kit setup"))[0]).toBe(
      "/ui-kit/android/getting-started-jetpack",
    );
  });

  it("read a language, rn, or a whole question the way the start-page rule needs", async () => {
    expect(paths(await start.search("swift ui kit getting started"))[0]).toBe("/ui-kit/ios/getting-started");
    expect(paths(await start.search("rn ui kit install"))[0]).toBe("/ui-kit/react-native/react-native-cli-integration");
    expect(paths(await start.search("how do i install the react ui kit"))[0]).toBe("/ui-kit/react/integration-react");
  });

  it("do not demote a short start page as a reference stub", async () => {
    expect(paths(await start.search("angular ui kit install"))[0]).toBe("/ui-kit/angular/integration");
  });

  it("still rank an older start page first when the query names its version", async () => {
    expect(paths(await start.search("ios ui kit v4 getting started"))[0]).toBe("/ui-kit/ios/v4/getting-started");
  });

  it("do not credit react to React Native pages unless the query says native", async () => {
    // The same page in both UI Kits; the React Native copy is the shorter.
    expect(paths(await start.search("react tab based chat"))[0]).toBe("/ui-kit/react/react-tab-based-chat");
    expect(paths(await start.search("react native tab based chat"))[0]).toBe(
      "/ui-kit/react-native/react-native-tab-based-chat",
    );
    expect(paths(await start.search("react-native tab based chat"))[0]).toBe(
      "/ui-kit/react-native/react-native-tab-based-chat",
    );
  });
});

/** The builder's schema (scripts/build-index.ts) for these pages. */
function buildIndex(at: string, pages: Page[]) {
  const db = new Database(at);
  db.exec(`
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT NOT NULL,
      title_key TEXT NOT NULL DEFAULT '', section TEXT NOT NULL, product TEXT, version TEXT,
      is_current INTEGER NOT NULL DEFAULT 1, trail_id INTEGER NOT NULL, label_id INTEGER NOT NULL,
      body TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '[]', languages TEXT NOT NULL DEFAULT ''
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
  const ids = new Map<string, number>();
  const trailId = (trail: string) => {
    if (!ids.has(trail)) {
      ids.set(trail, ids.size + 1);
      db.prepare("INSERT INTO trails_fts (rowid, trail) VALUES (?, ?)").run(ids.size, trail);
    }
    return ids.get(trail)!;
  };
  const insert = db.prepare(
    `INSERT INTO pages (path, url, title, title_key, section, product, version, is_current, trail_id, label_id, body, keywords)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of pages) {
    insert.run(
      p.path,
      `https://www.cometchat.com/docs${p.path}`,
      p.title,
      indexedTitleKey(p.title),
      p.section,
      p.trail ? `Chat & Messaging / ${p.trail}` : null,
      p.version,
      p.isCurrent ? 1 : 0,
      trailId(p.trail ?? p.section),
      trailId(p.section),
      p.body,
      p.keywords ?? pageKeywords(p.title, { path: p.path }),
    );
  }
  db.close();
}
