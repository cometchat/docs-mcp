/**
 * Every docs page an implementation bundle points to still exists, and is the
 * current version of its docs.
 *
 * Bundles are lists of docs pages (src/bundles/manifest.ts) read live on each
 * call, so they break in two ways:
 * - a listed page moved or was deleted;
 * - a new kit major shipped and the listed page (say llms-flutter-v6) is now
 *   the legacy one, still published, so it still resolves. This is how the
 *   hand-written bundles drifted (public issue 5), so it is checked against
 *   the version picker in docs.json, the same navigation search ranks by.
 *
 * Each page is fetched once, the way the bundle tool reads it, and each bundle
 * is compiled from those results.
 *
 * Usage: npm run verify:bundles   (needs the network)
 *   DOCS_BASE_URL  docs site (default https://www.cometchat.com/docs)
 *   DOCS_JSON      docs.json path or URL (default: cometchat/docs main on GitHub)
 */
import { readFile } from "node:fs/promises";
import { BUNDLES } from "../src/bundles/manifest.js";
import { BundleStore, type DocsPage } from "../src/bundles/loader.js";
import { runFetch } from "../src/tools/fetch.js";
import { BUNDLE_MAX_BYTES, byteLength } from "../src/lib/truncate.js";
import { indexNavigation } from "../src/search/navigation.js";
import { staleBundlePages } from "../src/bundles/versions.js";

const docsBaseUrl = process.env.DOCS_BASE_URL ?? "https://www.cometchat.com/docs";
const docsJsonSource = process.env.DOCS_JSON ?? "https://raw.githubusercontent.com/cometchat/docs/main/docs.json";
const opts = { docsBaseUrl, timeoutMs: 20_000 };
const basePath = new URL(docsBaseUrl).pathname.replace(/\/+$/, "");
const problems: string[] = [];
const warnings: string[] = [];

// 1. Each page once, untruncated, as the bundle store reads it.
const paths = [...new Set(BUNDLES.flatMap((b) => [...b.pages, ...b.related]))];
const fetched = new Map<string, Promise<DocsPage>>();
for (const path of paths) {
  const p = runFetch({ path }, opts, { maxBytes: Infinity });
  p.catch(() => undefined); // reported below
  fetched.set(path, p);
}
for (const path of paths) {
  try {
    const page = await fetched.get(path)!;
    if ("redirectedFrom" in page && page.redirectedFrom) {
      const now = new URL(page.url).pathname;
      problems.push(`${path} moved to ${now.startsWith(basePath) ? now.slice(basePath.length) : now}: update the manifest`);
    }
  } catch (err) {
    problems.push(`${path}: ${(err as Error).message}`);
  }
}

// 2. Each bundle from those results (pages that failed above fail here too,
// and are reported once).
const store = new BundleStore(BUNDLES, (path) => fetched.get(path) ?? Promise.reject(new Error(`not fetched: ${path}`)));
for (const b of BUNDLES) {
  try {
    const r = (await store.build(b.name))!;
    const size = byteLength(r.bundle.content);
    console.log(`  ${b.name.padEnd(32)} ${String(size).padStart(6)} bytes`);
    // Every listed page is meant to be in the bundle in full; growth in the
    // docs can push one out (listed by path) or cut the first page.
    if (r.truncated) problems.push(`${b.name}: ${b.pages[0]} alone is over the ${BUNDLE_MAX_BYTES}-byte budget and is cut`);
    for (const p of r.deferred) problems.push(`${b.name}: ${p} no longer fits in the bundle; move it to related or split the bundle`);
    if (size > BUNDLE_MAX_BYTES * 0.9) warnings.push(`${b.name}: ${size} of ${BUNDLE_MAX_BYTES} bytes; close to pushing a page out`);
  } catch (err) {
    problems.push(`${b.name}: ${(err as Error).message}`);
  }
}

// 3. Every page is the current version of its docs.
const docsJson = JSON.parse(
  /^https?:/.test(docsJsonSource) ? await (await fetch(docsJsonSource)).text() : await readFile(docsJsonSource, "utf8"),
) as unknown;
const nav = indexNavigation(docsJson);
if (nav.pages.size === 0) {
  problems.push(`docs.json from ${docsJsonSource} has no navigation: can't check versions`);
} else {
  problems.push(...staleBundlePages(BUNDLES, nav));
}

for (const w of warnings) console.warn(`warning: ${w}`);
if (problems.length > 0) {
  console.error(`\nverify-bundles: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\nverify-bundles: ${BUNDLES.length} bundles, ${paths.length} pages, all resolve and are current`);
