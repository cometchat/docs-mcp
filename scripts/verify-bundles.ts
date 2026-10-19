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
 * - a page tells people to install a package version that is old (an older
 *   major, or an exact pin a minor behind) or not published at all. That is
 *   the drift issue 5 reported, now coming from the docs pages; it is checked
 *   against npm, pub.dev, CometChat's Maven repo, CocoaPods trunk and GitHub.
 *
 * Each page is fetched once, the way the bundle tool reads it, and each bundle
 * is compiled from those results.
 *
 * Usage: npm run verify:bundles   (needs the network)
 *   DOCS_BASE_URL  docs site (default https://www.cometchat.com/docs)
 *   DOCS_JSON      docs.json path or URL (default: cometchat/docs main on GitHub)
 *   GITHUB_TOKEN   optional; raises the GitHub API rate limit for the iOS checks
 *   PINS=warn      report package-version problems as warnings (CI does this on
 *                  pull requests: the docs, not this repo, have to change)
 */
import { readFile } from "node:fs/promises";
import { BUNDLES } from "../src/bundles/manifest.js";
import { BundleStore, type DocsPage } from "../src/bundles/loader.js";
import { runFetch } from "../src/tools/fetch.js";
import { BUNDLE_MAX_BYTES, byteLength } from "../src/lib/truncate.js";
import { indexNavigation } from "../src/search/navigation.js";
import { staleBundlePages } from "../src/bundles/versions.js";
import { checkPin, findPins, type Pin, type Published } from "../src/bundles/pins.js";

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

// 4. Every package version a bundle's pages install is published and current.
const pinProblems = process.env.PINS === "warn" ? warnings : problems;
const lookups = new Map<string, Promise<Published | undefined>>();
const published = (pin: Pin) => {
  const key = `${pin.registry}:${pin.name}`;
  if (!lookups.has(key)) {
    // One retry; a registry that is still failing is a warning, not a docs problem.
    const once = () => lookup(pin);
    lookups.set(key, once().catch(() => new Promise<void>((r) => setTimeout(r, 3000)).then(once)).catch((err: Error) => {
      warnings.push(`can't look up ${pin.registry} ${pin.name}: ${err.message}`);
      return undefined;
    }));
  }
  return lookups.get(key)!;
};
const pagePaths = [...new Set(BUNDLES.flatMap((b) => b.pages))];
for (const path of pagePaths) {
  const page = await fetched.get(path)!.catch(() => undefined);
  if (!page) continue; // reported in step 1
  for (const pin of findPins(page.content)) {
    const pub = await published(pin);
    if (!pub) continue;
    if (pub.versions.length === 0) {
      pinProblems.push(`${path}: ${pin.registry} package ${pin.name} doesn't exist`);
      continue;
    }
    const r = checkPin(pin, pub);
    if (r.level === "fail") pinProblems.push(`${path}: ${r.reason}`);
    else if (r.level === "warn") warnings.push(`${path}: ${r.reason}`);
  }
}

for (const w of warnings) console.warn(`warning: ${w}`);
if (problems.length > 0) {
  console.error(`\nverify-bundles: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\nverify-bundles: ${BUNDLES.length} bundles, ${paths.length} pages, ${lookups.size} packages; all resolve and are current`);

async function lookup(pin: Pin): Promise<Published> {
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res;
  };
  const none: Published = { versions: [] };
  switch (pin.registry) {
    case "npm": {
      const res = await get(`https://registry.npmjs.org/${pin.name.replace("/", "%2F")}`);
      if (!res) return none;
      const d = (await res.json()) as { versions?: Record<string, unknown> };
      return { versions: Object.keys(d.versions ?? {}) };
    }
    case "pub": {
      const res = await get(`https://pub.dev/api/packages/${pin.name}`);
      if (!res) return none;
      const d = (await res.json()) as { versions: Array<{ version: string }> };
      return { versions: d.versions.map((v) => v.version) };
    }
    case "maven": {
      const res = await get(`https://dl.cloudsmith.io/public/cometchat/cometchat/maven/com/cometchat/${pin.name}/maven-metadata.xml`);
      if (!res) return none;
      const xml = await res.text();
      const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
      return { versions };
    }
    case "cocoapods": {
      const res = await get(`https://trunk.cocoapods.org/api/v1/pods/${pin.name}`);
      if (!res) return none;
      const d = (await res.json()) as { versions: Array<{ name: string }> };
      return { versions: d.versions.map((v) => v.name) };
    }
    case "github": {
      const auth: Record<string, string> = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
      // Tags come back sorted by name, not version: read every page.
      const versions: string[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await get(`https://api.github.com/repos/cometchat/${pin.name}/tags?per_page=100&page=${page}`, auth);
        if (!res) return page === 1 ? none : { versions };
        const tags = (await res.json()) as Array<{ name: string }>;
        versions.push(...tags.map((t) => t.name.replace(/^v/, "")));
        if (tags.length < 100) break;
      }
      return { versions };
    }
  }
}
