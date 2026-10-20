import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_SPARSE_PATTERNS } from "../src/search/mdx-imports.js";

// Four places clone github.com/cometchat/docs to build the index, and only one
// of them can import DOCS_SPARSE_PATTERNS: src/index/refresher.ts, the one the
// running container uses. The other three spell the patterns in their own
// syntax, so they are pinned here. They drifted once already — the refresher
// kept asking for `**/*.mdx` alone after the rest had learned that a page may
// import a `.md` snippet, which would have let the first in-container refresh
// quietly replace a baked index that held snippet text with one that did not,
// at an unchanged page count the refresher's validation cannot see.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** The patterns of a workflow's `sparse-checkout: |` block, in order. */
function workflowPatterns(yaml: string): string[][] {
  return [...yaml.matchAll(/sparse-checkout: \|\n((?:[ \t]+\S+\n)+)/g)].map((m) =>
    m[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/** The patterns of a `git ... sparse-checkout set --no-cone '...' '...'` line, in order. */
function shellPatterns(text: string): string[][] {
  return [...text.matchAll(/sparse-checkout set --no-cone((?: '[^']+')+)/g)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]),
  );
}

describe("docs sparse checkout", () => {
  it("is spelled the same wherever the docs are cloned", () => {
    const blocks = [
      ...shellPatterns(read("Dockerfile")),
      ...workflowPatterns(read(".github/workflows/ci.yml")),
      ...workflowPatterns(read(".github/workflows/search-eval-drift.yml")),
    ];
    // One in the Dockerfile's indexer stage, one in ci.yml's search-eval job,
    // one in the drift job: a missing block would silently assert nothing.
    expect(blocks.length).toBe(3);
    for (const patterns of blocks) expect(patterns).toEqual(DOCS_SPARSE_PATTERNS);
  });

  it("covers the snippet extensions the builder inlines", () => {
    // src/search/mdx-imports.ts takes .md as well as .mdx.
    expect(DOCS_SPARSE_PATTERNS).toContain("**/*.md");
    expect(DOCS_SPARSE_PATTERNS).toContain("**/*.mdx");
  });
});
