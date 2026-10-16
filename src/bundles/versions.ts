import type { NavigationIndex } from "../search/navigation.js";
import { resolvePageVersion } from "../search/navigation.js";
import type { BundleSpec } from "./manifest.js";

/**
 * Pages in the manifest that aren't the current version of their docs, per
 * the version picker in docs.json. A bundle built from such a page serves an
 * old kit major while every page still resolves: the drift behind public
 * issue 5. Used by `npm run verify:bundles`.
 */
export function staleBundlePages(specs: readonly BundleSpec[], nav: NavigationIndex): string[] {
  const problems: string[] = [];
  for (const b of specs) {
    for (const path of [...b.pages, ...b.related]) {
      const meta = resolvePageVersion(path, nav);
      if (!meta.isCurrent) {
        problems.push(`${b.name}: ${path} documents ${meta.version ?? "an older version"}, not the current one in docs.json`);
        continue;
      }
      // llms-<platform>-vN pages are unlisted and sit beside the current
      // pages, so their folder looks current even after a new major ships:
      // the major in the name must be the folder's current version.
      const named = /-v(\d+)$/.exec(path)?.[1];
      if (named && meta.version && meta.version !== `v${named}`) {
        problems.push(`${b.name}: ${path} is for v${named}, but the current ${meta.product ?? "docs"} version is ${meta.version}`);
      }
    }
  }
  return problems;
}
