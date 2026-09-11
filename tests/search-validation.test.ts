import { describe, expect, it } from "vitest";
import { SearchInputSchema } from "../src/lib/validation.js";
import { normalizeVersionLabel, queryVersionLabel } from "../src/search/version.js";
import { SEARCH_TOOL_DEFINITION } from "../src/tools/search.js";

describe("search version input", () => {
  it.each([
    ["v7", "v7"],
    ["V7", "v7"],
    ["7", "v7"],
    ["v04", "v4"],
    ["v3.0", "v3"],
    ["v3.0.0", "v3"],
    ["v3.5", "v3.5"],
  ])("normalizes %s to the stored label %s", (input, expected) => {
    expect(SearchInputSchema.parse({ query: "x", version: input }).version).toBe(expected);
  });

  it.each(["four", "latest", "v", "v7-beta", "7.x", "v1.2.3.4"])("rejects %s", (input) => {
    expect(SearchInputSchema.safeParse({ query: "x", version: input }).success).toBe(false);
  });

  it("leaves the filter off when no version is given", () => {
    expect(SearchInputSchema.parse({ query: "x" }).version).toBeUndefined();
  });

  it("normalizeVersionLabel matches how the index builder labels N.0 folders", () => {
    expect(normalizeVersionLabel("2.0")).toBe("v2");
  });

  it.each([
    ["v4", "v4"],
    ["V5", "v5"],
    ["v3.0", "v3"],
    ["3.0", "v3"],
    ["v2.0.0", "v2"],
    ["(v4),", "v4"],
  ])("reads the query word %s as the version the filter calls %s", (word, label) => {
    expect(queryVersionLabel(word)).toBe(label);
    expect(SearchInputSchema.parse({ query: "x", version: word.replace(/[(),]/g, "") }).version).toBe(label);
  });

  it.each(["404", "4", "v", "v4-beta", "oauth", "1.x"])("does not read the query word %s as a version", (word) => {
    expect(queryVersionLabel(word)).toBeNull();
  });

  it("every example in the tool's version description is accepted as written", () => {
    const description = SEARCH_TOOL_DEFINITION.inputSchema.properties.version.description;
    const examples = [...description.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(SearchInputSchema.parse({ query: "x", version: example }).version).toBe(example);
    }
  });
});
