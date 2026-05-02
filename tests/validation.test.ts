import { describe, it, expect } from "vitest";
import {
  SearchInputSchema,
  FetchInputSchema,
  BundleInputSchema,
  fieldErrorFromZod,
} from "../src/lib/validation.js";

describe("SearchInputSchema", () => {
  it("accepts a minimal valid query", () => {
    const r = SearchInputSchema.parse({ query: "react quickstart" });
    expect(r.limit).toBe(10);
    expect(r.version).toBeUndefined();
  });

  it("rejects empty query", () => {
    const r = SearchInputSchema.safeParse({ query: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const f = fieldErrorFromZod(r.error);
      expect(f.field).toBe("query");
    }
  });

  it("rejects bad version format", () => {
    const r = SearchInputSchema.safeParse({ query: "x", version: "four" });
    expect(r.success).toBe(false);
  });

  it("caps limit at 25", () => {
    const r = SearchInputSchema.safeParse({ query: "x", limit: 100 });
    expect(r.success).toBe(false);
  });
});

describe("FetchInputSchema", () => {
  it("accepts a relative path", () => {
    const r = FetchInputSchema.parse({ path: "/sdk/javascript/overview" });
    expect(r.path).toContain("javascript");
  });

  it("rejects empty path", () => {
    const r = FetchInputSchema.safeParse({ path: "" });
    expect(r.success).toBe(false);
  });
});

describe("BundleInputSchema", () => {
  it("accepts kebab-case names", () => {
    const r = BundleInputSchema.parse({ bundle: "react-uikit-quickstart" });
    expect(r.bundle).toBe("react-uikit-quickstart");
  });

  it("rejects camelCase", () => {
    const r = BundleInputSchema.safeParse({ bundle: "reactQuickstart" });
    expect(r.success).toBe(false);
  });

  it("rejects spaces", () => {
    const r = BundleInputSchema.safeParse({ bundle: "react quickstart" });
    expect(r.success).toBe(false);
  });
});
