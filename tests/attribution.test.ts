import { describe, expect, it } from "vitest";
import { sanitizeRef, sanitizeSessionId } from "../src/lib/attribution.js";

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

describe("sanitizeSessionId", () => {
  const uuid = "3f2a1c9e-4b6d-4a2f-9c1e-7d5b8a0f2e41";

  it("accepts a well-formed UUID", () => {
    expect(sanitizeSessionId(uuid)).toBe(uuid);
  });

  it("normalises case so the same session is one grain", () => {
    expect(sanitizeSessionId(uuid.toUpperCase())).toBe(uuid);
  });

  // The value is reflected in a response header and written into logs and
  // PostHog properties, so anything not shaped like our own id is dropped.
  it("rejects injection shapes and free text", () => {
    for (const bad of [
      "not-a-uuid",
      "'; DROP TABLE events;--",
      '<script>alert(1)</script>',
      "3f2a1c9e-4b6d-4a2f-9c1e-7d5b8a0f2e41\r\nX-Injected: 1",
      "../../etc/passwd",
      "a".repeat(10_000),
      "",
    ]) {
      expect(sanitizeSessionId(bad)).toBeUndefined();
    }
  });

  it("rejects non-strings", () => {
    expect(sanitizeSessionId(undefined)).toBeUndefined();
    expect(sanitizeSessionId(["a", "b"])).toBeUndefined();
    expect(sanitizeSessionId(42)).toBeUndefined();
  });
});
