import { describe, expect, it } from "vitest";
import { CASES, groundingProblems, type GoldenCase } from "../scripts/eval-search.js";

// The golden set is only as good as its grounding: a check whose pattern no
// real page matches can never pass, and one naming a deleted page proves nothing.
describe("eval-search grounding", () => {
  it("grounds every check in pages its pattern matches", () => {
    expect(groundingProblems(CASES, () => true)).toEqual([]);
  });

  it("flags missing pages, grounding outside the pattern, and ungrounded checks", () => {
    const cases: GoldenCase[] = [
      {
        id: "x",
        query: "q",
        checks: [
          { kind: "inTop", k: 1, pattern: /^\/a\//, grounding: ["/a/one", "/b/two", "/a/gone"], label: "in" },
          { kind: "notInTop", k: 1, pattern: /^\/c\//, grounding: [], label: "not" },
          { kind: "above", current: "/a/one", legacy: "/a/old", label: "above" },
        ],
      },
    ];
    const existing = new Set(["/a/one", "/b/two"]);
    expect(groundingProblems(cases, (p) => existing.has(p))).toEqual([
      "x: /b/two does not match /^\\/a\\//",
      "x: /a/gone does not exist",
      'x: "not" names no grounding page',
      "x: /a/old does not exist",
    ]);
  });
});
