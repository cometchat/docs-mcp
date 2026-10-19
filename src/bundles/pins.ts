/**
 * Package versions a bundle's pages tell people to install, checked against
 * what the package registries publish.
 *
 * Bundles read the live docs, so a bundle is as current as its pages. Public
 * issue 5 was bundles installing old kit majors and packages that don't
 * exist; with bundles built from the docs, the same drift shows up as a docs
 * page pinning an old or unpublished version. `npm run verify:bundles` uses
 * this to catch it.
 */

export type Registry = "npm" | "pub" | "maven" | "cocoapods" | "github";

export type Pin = {
  registry: Registry;
  /** npm/pub package, Maven artifact (group com.cometchat), pod, or cometchat GitHub repo. */
  name: string;
  /** As written: "5.4.0", "^6.2.0", "~6.0.6", "6.+", "2.x.x", "7", "7.0.0-beta.1". */
  version: string;
  /**
   * What the version holds still: "exact" (5.4.0), "minor" (~6.0.6, ~> 5.0.4:
   * patch releases only), or "major" (^6.2.0, 6.+, 7: any newer release of the major).
   */
  holds: "exact" | "minor" | "major";
};

export type Published = { versions: string[] };

export type PinCheck = { level: "ok" | "warn" | "fail"; reason: string };

// A prerelease suffix is dot-separated identifiers ("-beta.1"), so a full stop
// ending the sentence ("…@7.0.0-beta.1.") is not read as part of it.
const PRE = String.raw`(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?`;
const V = String.raw`\d+(?:\.(?:\d+|x|\*|\+))*${PRE}`;
const NPM_RE = new RegExp(String.raw`@cometchat\/([a-z0-9-]+)@([\^~]?${V})`, "g");
const NPM_JSON_RE = new RegExp(String.raw`"@cometchat\/([a-z0-9-]+)"\s*:\s*"([\^~]?${V})"`, "g");
const PUB_RE = new RegExp(String.raw`\b(cometchat_[a-z_]+):\s*(\^?${V})`, "g");
const MAVEN_RE = new RegExp(String.raw`com\.cometchat:([a-z0-9-]+):(${V})`, "g");
const CATALOG_MODULE_RE = /module\s*=\s*"com\.cometchat:([a-z0-9-]+)"\s*,\s*version\.ref\s*=\s*"([A-Za-z0-9_.-]+)"/g;
const CATALOG_VERSION_RE = new RegExp(String.raw`^\s*([A-Za-z0-9_.-]+)\s*=\s*"(${V})"\s*$`, "gm");
const POD_RE = new RegExp(String.raw`pod\s+['"](CometChat[A-Za-z]*)['"]\s*,\s*['"](~>\s*)?(${V})['"]`, "g");
// Only the Swift packages (repos named *-ios), so a link to a sample app or
// another repo followed by some version number isn't read as an install pin.
const SPM_URL_RE = /github\.com\/cometchat\/([a-z0-9][a-z0-9-]*-ios)\b/g;
// An SPM version is a line holding just the version (a code block), or a
// version in code (`5.0.4`, "5.0.4") on a line that says what kind of version
// it is ("Up to Next Major Version from `5.0.4`"). A bare number after such a
// word is not: "Set the minimum deployment target version to 15.1.0" is not
// chat-sdk-ios 15.1.0, nor is "Requires Xcode 16.0.1".
const SPM_VERSION_LINE_RE = new RegExp(String.raw`^\s*\`?(\d+\.\d+\.\d+${PRE})\`?\s*$`);
const SPM_VERSION_WORDS_RE = new RegExp(String.raw`\b(?:version|from|exact|next major|up to)\b[^\d\n]{0,40}?[\`"'](\d+\.\d+\.\d+${PRE})[\`"']`, "i");
// A version that belongs to the platform or toolchain, not to the package.
const PLATFORM_VERSION_RE = /\b(?:deployment target|i(?:pad)?os|macos|xcode|swift(?!\s+package))\b[^\n]{0,30}?\d+\.\d+/i;

/** Every package version the text tells people to install. */
export function findPins(text: string): Pin[] {
  const pins: Pin[] = [];
  const add = (registry: Registry, name: string, version: string, holds: Pin["holds"] = holdsOf(version)) => {
    if (!pins.some((q) => q.registry === registry && q.name === name && q.version === version)) pins.push({ registry, name, version, holds });
  };
  for (const m of text.matchAll(NPM_RE)) add("npm", `@cometchat/${m[1]}`, m[2]);
  for (const m of text.matchAll(NPM_JSON_RE)) add("npm", `@cometchat/${m[1]}`, m[2]);
  for (const m of text.matchAll(PUB_RE)) add("pub", m[1], m[2]);
  for (const m of text.matchAll(MAVEN_RE)) add("maven", m[1], m[2]);
  // Gradle version catalogs: `cometchat-ui-kit = "6.0.3"` plus a module line
  // referencing that key. A ref resolves to the nearest definition before it
  // (then after it): two tabs of one page may each define their own.
  const catalog = [...text.matchAll(CATALOG_VERSION_RE)].map((m) => ({ key: m[1], version: m[2], at: m.index ?? 0 }));
  for (const m of text.matchAll(CATALOG_MODULE_RE)) {
    const at = m.index ?? 0;
    const defs = catalog.filter((c) => c.key === m[2]);
    const def = defs.filter((c) => c.at < at).at(-1) ?? defs.find((c) => c.at > at);
    if (def) add("maven", m[1], def.version);
  }
  // `~> 5.0` allows any 5.x; `~> 5.0.4` only 5.0.x.
  for (const m of text.matchAll(POD_RE)) add("cocoapods", m[1], m[3], m[2] ? (m[3].split(".").length >= 3 ? "minor" : "major") : holdsOf(m[3]));
  // Swift Package Manager: the version given with a cometchat repo URL, on its
  // line or the next few (the docs write the URL and the version in separate
  // code blocks). Stops at the next URL.
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(SPM_URL_RE)) {
      const after = line.slice((m.index ?? 0) + m[0].length);
      const window = [after, ...lines.slice(i + 1, i + 9)];
      for (const [k, w] of window.entries()) {
        if (k > 0 && /https?:\/\//.test(w)) break;
        const v = PLATFORM_VERSION_RE.test(w)
          ? undefined
          : (SPM_VERSION_WORDS_RE.exec(w)?.[1] ?? (k > 0 ? SPM_VERSION_LINE_RE.exec(w)?.[1] : undefined));
        if (v) {
          const near = window.slice(0, k + 1).join("\n");
          add("github", m[1], v, /\bexact\b/i.test(near) || /-/.test(v) ? "exact" : "major");
          break;
        }
      }
    }
  });
  return pins;
}

/**
 * Checked against the highest release (never a prerelease, whatever a
 * registry's "latest" says):
 * fail: not published; on an older major; an exact or ~ pin a minor behind;
 *   a prerelease whose release is out;
 * warn: an exact pin a patch behind;
 * ok: otherwise (a ^ / 6.+ / 7 range takes newer releases of its major).
 */
export function checkPin(pin: Pin, pub: Published): PinCheck {
  const releases = pub.versions.filter(isRelease);
  const latest = highestRelease(releases);
  const want = parse(pin.version);
  if (isPrerelease(pin.version)) {
    const bare = pin.version.replace(/^[\^~]/, "");
    const released = latest !== "" && cmp(parse(latest), want) >= 0;
    // A range on a prerelease (^7.0.0-beta.1) takes the release once it is
    // out, so it is then checked like any range below.
    if (!(released && pin.holds !== "exact")) {
      if (!pub.versions.includes(bare)) return fail(`${pin.name} ${pin.version} is not published (latest ${latest})`);
      if (released) return fail(`${pin.name} ${pin.version} is a prerelease of a version that is out (latest ${latest})`);
      return OK;
    }
  }
  const parsed = releases.map(parse);
  const satisfying = parsed.filter((v) =>
    pin.holds === "exact" ? sameVersion(v, want)
    : pin.holds === "minor" ? v[0] === want[0] && v[1] === want[1] && cmp(v, want) >= 0
    : (want.length === 0 || v[0] === want[0]) && cmp(v, want) >= 0,
  );
  if (satisfying.length === 0) return fail(`${pin.name} ${pin.version} is not published (latest ${latest})`);
  const [maj = 0, min = 0, pat = 0] = want;
  const [lmaj = 0, lmin = 0, lpat = 0] = parse(latest);
  if (maj < lmaj) return fail(`${pin.name} ${pin.version} is on an older major (latest ${latest})`);
  if (pin.holds === "major" || maj > lmaj) return OK;
  if (min < lmin) return fail(`${pin.name} is pinned to ${pin.version}; latest is ${latest}`);
  if (pin.holds === "exact" && min === lmin && pat < lpat) return { level: "warn", reason: `${pin.name} is pinned to ${pin.version}; latest is ${latest}` };
  return OK;
}

/** The highest release version (no prerelease suffix). */
export function highestRelease(versions: string[]): string {
  return versions.filter(isRelease).sort((a, b) => cmp(parse(a), parse(b))).at(-1) ?? "";
}

const OK: PinCheck = { level: "ok", reason: "" };
const fail = (reason: string): PinCheck => ({ level: "fail", reason });

function holdsOf(v: string): Pin["holds"] {
  if (v.startsWith("~")) return "minor";
  if (v.startsWith("^")) return "major";
  // 6.0.+ / 6.0.x / 6.0.* only take patch releases of 6.0.
  if (/^\d+\.\d+\.(?:\+|x|\*)$/.test(v)) return "minor";
  return new RegExp(String.raw`^\d+\.\d+\.\d+${PRE}$`).test(v) ? "exact" : "major";
}

function isRelease(v: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(v);
}

function isPrerelease(v: string): boolean {
  return /^[\^~]?\d+(?:\.\d+)*-/.test(v);
}

function parse(v: string): number[] {
  const core = v.replace(/^[\^~]/, "").split(/[-+]/)[0];
  const nums: number[] = [];
  for (const part of core.split(".")) {
    if (!/^\d+$/.test(part)) break;
    nums.push(Number(part));
  }
  return nums;
}

function sameVersion(a: number[], b: number[]): boolean {
  return a.length >= 3 && b.length >= 3 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
