import { describe, expect, it } from "vitest";
import { sanitizeRef } from "../src/lib/attribution.js";

describe("sanitizeRef", () => {
  it("accepts simple minted sources", () => {
    expect(sanitizeRef("producthunt")).toBe("producthunt");
    expect(sanitizeRef("cometchat-skills")).toBe("cometchat-skills");
    expect(sanitizeRef("docs_cta.v2")).toBe("docs_cta.v2");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeRef("  launch ")).toBe("launch");
  });

  it("rejects non-strings, empties, and junk", () => {
    expect(sanitizeRef(undefined)).toBeUndefined();
    expect(sanitizeRef(42 as unknown)).toBeUndefined();
    expect(sanitizeRef("")).toBeUndefined();
    expect(sanitizeRef("   ")).toBeUndefined();
    expect(sanitizeRef(["a", "b"] as unknown)).toBeUndefined();
  });

  it("rejects injection-shaped values", () => {
    expect(sanitizeRef("a b")).toBeUndefined();
    expect(sanitizeRef("<script>")).toBeUndefined();
    expect(sanitizeRef("a\nb")).toBeUndefined();
    expect(sanitizeRef(".hidden")).toBeUndefined(); // must start alphanumeric
    expect(sanitizeRef("x".repeat(65))).toBeUndefined(); // 64-char cap
    expect(sanitizeRef("x".repeat(64))).toBe("x".repeat(64));
  });
});
