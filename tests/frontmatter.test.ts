import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../src/lib/frontmatter.js";

const BODY = "Body long enough to clear the forty character minimum check.";

// gray-matter 4.0.3 ships `engines.javascript.parse = eval`, selected by the
// language tag written in the file. Every payload here executed before the
// fix; the global flag proves none of them execute now.
declare global {
  // eslint-disable-next-line no-var
  var __FM_PWNED: number | undefined;
}

const payload = (tag: string) =>
  `---${tag}\n{ title: (function(){ globalThis.__FM_PWNED = (globalThis.__FM_PWNED || 0) + 1; return "Innocent"; })() }\n---\n\n${BODY}\n`;

describe("parseFrontmatter — executable frontmatter cannot run", () => {
  // Aliases gray-matter resolves to an eval-backed engine, plus spacing and
  // case variants, since the tag is matched after a trim/lowercase.
  const tags = ["js", "javascript", "JS", "  js", "js  ", "Javascript", "coffee", "cson"];

  for (const tag of tags) {
    it(`does not evaluate '---${tag}' frontmatter`, () => {
      globalThis.__FM_PWNED = 0;
      const parsed = parseFrontmatter(payload(tag));
      expect(globalThis.__FM_PWNED).toBe(0);
      expect(parsed.unsafeLanguage).toBeDefined();
      // The attacker's fields must not reach the caller either — a page that
      // cannot execute could still forge a title/url if `data` survived.
      expect(parsed.data).toEqual({});
    });
  }

  it("still returns the body so the page is not silently truncated", () => {
    const parsed = parseFrontmatter(payload("js"));
    expect(parsed.content).toContain("forty character minimum");
  });

  it("does not execute even when the payload spans many lines", () => {
    globalThis.__FM_PWNED = 0;
    const multi = `---js\n{\n  title: (() => {\n    globalThis.__FM_PWNED = 1;\n    return "x";\n  })()\n}\n---\n\n${BODY}\n`;
    parseFrontmatter(multi);
    expect(globalThis.__FM_PWNED).toBe(0);
  });

  it("does not execute with a BOM before the delimiter", () => {
    globalThis.__FM_PWNED = 0;
    const parsed = parseFrontmatter("﻿" + payload("js"));
    expect(globalThis.__FM_PWNED).toBe(0);
    expect(parsed.unsafeLanguage).toBe("js");
  });
});

describe("parseFrontmatter — normal pages keep working", () => {
  it("parses plain YAML frontmatter", () => {
    const parsed = parseFrontmatter(`---\ntitle: Real Page\nversion: v6\n---\n\n${BODY}\n`);
    expect(parsed.data).toEqual({ title: "Real Page", version: "v6" });
    expect(parsed.content.trim()).toBe(BODY);
    expect(parsed.unsafeLanguage).toBeUndefined();
  });

  it("accepts an explicit yaml tag", () => {
    const parsed = parseFrontmatter(`---yaml\ntitle: Tagged\n---\n\n${BODY}\n`);
    expect(parsed.data).toEqual({ title: "Tagged" });
    expect(parsed.unsafeLanguage).toBeUndefined();
  });

  it("handles a page with no frontmatter at all", () => {
    const parsed = parseFrontmatter(`# Heading\n\n${BODY}\n`);
    expect(parsed.data).toEqual({});
    expect(parsed.content).toContain("Heading");
    expect(parsed.unsafeLanguage).toBeUndefined();
  });

  it("survives malformed YAML without aborting the build", () => {
    // One bad page must not fail a 3k-page index build.
    expect(() => parseFrontmatter(`---\ntitle: "unterminated\n  bad: [\n---\n\n${BODY}\n`)).not.toThrow();
  });

  it("keeps types from YAML (numbers/booleans stay themselves)", () => {
    const parsed = parseFrontmatter(`---\ncount: 3\ndraft: false\n---\n\n${BODY}\n`);
    expect(parsed.data).toEqual({ count: 3, draft: false });
  });
});
