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
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  const problems = groundingProblems(CASES, (p) => existsSync(path.join(DOCS_REPO, `${p}.mdx`)));
  if (problems.length > 0) {
    console.error(`Golden expectations not grounded in ${DOCS_REPO}:\n  ${problems.join("\n  ")}`);
    process.exit(2);
  }
}

async function main() {
  verifyGrounding();
  const client = new SqliteSearchClient(INDEX_PATH);
  const json = process.argv.includes("--json");
  const report = [];
  let passed = 0;
  let total = 0;

  for (const c of CASES) {
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
