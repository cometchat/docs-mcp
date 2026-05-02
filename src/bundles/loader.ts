import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { logger } from "../lib/logger.js";
import { BUNDLE_MAX_BYTES, byteLength } from "../lib/truncate.js";
import type { Bundle, BundleFrontmatter } from "./types.js";

export type BundleLoadOptions = {
  strict?: boolean;
};

export class BundleStore {
  private bundles = new Map<string, Bundle>();

  static async load(dir: string, opts: BundleLoadOptions = {}): Promise<BundleStore> {
    const store = new BundleStore();
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.replace(/\.md$/, "");
      const filePath = path.join(dir, entry.name);
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = matter(raw);
        const fm = parsed.data as Partial<BundleFrontmatter>;
        validateFrontmatter(name, fm);
        const content = parsed.content.trimStart();
        const size = byteLength(content);
        if (size > BUNDLE_MAX_BYTES) {
          const msg = `bundle ${name} exceeds ${BUNDLE_MAX_BYTES} bytes (${size})`;
          if (opts.strict) throw new Error(msg);
          logger.warn({ bundle: name, size }, "bundle_oversize_skipped");
          continue;
        }
        store.bundles.set(name, {
          name,
          title: fm.title!,
          framework: fm.framework!,
          prerequisites: fm.prerequisites!,
          last_verified: fm.last_verified!,
          content,
        });
      } catch (err) {
        if (opts.strict) {
          throw new Error(
            `bundle ${name} failed to load: ${(err as Error).message}`,
          );
        }
        logger.warn({ bundle: name, err: (err as Error).message }, "bundle_load_failed");
      }
    }
    logger.info({ count: store.bundles.size, strict: opts.strict === true }, "bundles_loaded");
    return store;
  }

  get(name: string): Bundle | undefined {
    return this.bundles.get(name);
  }

  list(): string[] {
    return Array.from(this.bundles.keys()).sort();
  }
}

function validateFrontmatter(name: string, fm: Partial<BundleFrontmatter>): asserts fm is BundleFrontmatter {
  for (const key of ["title", "framework", "last_verified"] as const) {
    if (typeof fm[key] !== "string" || fm[key]!.length === 0) {
      throw new Error(`bundle ${name} missing or invalid frontmatter field: ${key}`);
    }
  }
  if (!Array.isArray(fm.prerequisites) || fm.prerequisites.some((p) => typeof p !== "string")) {
    throw new Error(`bundle ${name} frontmatter 'prerequisites' must be a string array`);
  }
  const date = new Date(fm.last_verified!);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`bundle ${name} 'last_verified' is not a valid ISO date`);
  }
}
