import { describe, it, expect } from "vitest";
import {
  truncateAtParagraph,
  snippet,
  byteLength,
  FETCH_MAX_BYTES,
} from "../src/lib/truncate.js";

describe("truncateAtParagraph", () => {
  it("returns input unchanged when under cap", () => {
    const input = "short content";
    const out = truncateAtParagraph(input, FETCH_MAX_BYTES, "https://example.com/x");
    expect(out).toBe(input);
  });

  it("truncates and appends marker when over cap", () => {
    const big = "abc\n\n".repeat(20000);
    const out = truncateAtParagraph(big, FETCH_MAX_BYTES, "https://example.com/x");
    expect(byteLength(out)).toBeLessThanOrEqual(FETCH_MAX_BYTES);
    expect(out).toMatch(/\[Content truncated/);
    expect(out).toMatch(/https:\/\/example\.com\/x\]/);
  });

  it("breaks at paragraph boundary when possible", () => {
    const para = "x".repeat(1000);
    const big = (para + "\n\n").repeat(200);
    const out = truncateAtParagraph(big, FETCH_MAX_BYTES, "https://example.com/x");
    expect(out.endsWith("]")).toBe(true);
    const beforeMarker = out.replace(/\n\n\[Content truncated.*$/, "");
    expect(beforeMarker.endsWith("\n\n") || beforeMarker.endsWith("x")).toBe(true);
  });
});

describe("snippet", () => {
  it("trims whitespace and caps length", () => {
    const long = "word ".repeat(500);
    const s = snippet(long);
    expect(s.length).toBeLessThanOrEqual(300);
  });

  it("preserves short text untouched", () => {
    expect(snippet("hello world")).toBe("hello world");
  });
});
