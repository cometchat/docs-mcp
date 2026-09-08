import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { refreshView, wantsDetail } from "../src/lib/health.js";
import type { RefresherState } from "../src/index/refresher.js";

const failing: RefresherState = {
  docsCommit: "6ca5892edbf3079ba1daa4523f344cdb0b551a07",
  builtAt: "2026-09-04T21:14:41.255Z",
  generations: 1,
  poisoned: 3,
  lastCheckedAt: "2026-09-04T21:24:41.255Z",
  lastError: "EACCES: permission denied, mkdtemp '/app/data/generations/clone-ZS0IAm'",
};

const healthy: RefresherState = { ...failing, poisoned: 0, lastError: null };

const req = (opts: { header?: string; query?: string } = {}): Request =>
  ({
    header: (name: string) =>
      name.toLowerCase() === "x-health-token" ? opts.header : undefined,
    query: opts.query === undefined ? {} : { detail: opts.query },
  }) as unknown as Request;

describe("refreshView — public payload", () => {
  const view = refreshView(failing, false) as Record<string, unknown>;

  it("exposes the freshness facts a monitor needs", () => {
    expect(view.docsCommit).toBe(failing.docsCommit);
    expect(view.builtAt).toBe(failing.builtAt);
    expect(view.lastCheckedAt).toBe(failing.lastCheckedAt);
    expect(view.generations).toBe(1);
  });

  it("NEVER leaks lastError to an unauthenticated caller", () => {
    expect(view).not.toHaveProperty("lastError");
    expect(JSON.stringify(view)).not.toContain("EACCES");
    expect(JSON.stringify(view)).not.toContain("/app/data");
  });

  it("does not expose the poisoned count publicly", () => {
    expect(view).not.toHaveProperty("poisoned");
  });

  it("still signals that refreshing is broken, without the detail", () => {
    expect(view.lastRefreshOk).toBe(false);
    expect((refreshView(healthy, false) as Record<string, unknown>).lastRefreshOk).toBe(true);
  });
});

describe("refreshView — detailed payload", () => {
  it("includes lastError and poisoned when authorised", () => {
    const v = refreshView(failing, true) as Record<string, unknown>;
    expect(v.lastError).toContain("EACCES");
    expect(v.poisoned).toBe(3);
    expect(v.lastRefreshOk).toBe(false);
  });
});

describe("wantsDetail — authorisation", () => {
  it("fails closed when no token is configured", () => {
    expect(wantsDetail(req({ header: "anything" }), undefined)).toBe(false);
    expect(wantsDetail(req({ query: "anything" }), undefined)).toBe(false);
    expect(wantsDetail(req({ header: "" }), "")).toBe(false);
  });

  it("rejects a request with no token supplied", () => {
    expect(wantsDetail(req(), "s3cret")).toBe(false);
  });

  it("accepts the header form", () => {
    expect(wantsDetail(req({ header: "s3cret" }), "s3cret")).toBe(true);
  });

  it("accepts the query-parameter form", () => {
    expect(wantsDetail(req({ query: "s3cret" }), "s3cret")).toBe(true);
  });

  it("prefers the header when both are present", () => {
    expect(wantsDetail(req({ header: "s3cret", query: "wrong" }), "s3cret")).toBe(true);
    expect(wantsDetail(req({ header: "wrong", query: "s3cret" }), "s3cret")).toBe(false);
  });

  it("rejects a wrong token", () => {
    expect(wantsDetail(req({ header: "nope" }), "s3cret")).toBe(false);
  });

  it("rejects a prefix or extended token (no partial match)", () => {
    expect(wantsDetail(req({ header: "s3cre" }), "s3cret")).toBe(false);
    expect(wantsDetail(req({ header: "s3crets" }), "s3cret")).toBe(false);
  });

  it("handles a non-string query value without throwing", () => {
    const weird = { header: () => undefined, query: { detail: ["a", "b"] } } as unknown as Request;
    expect(wantsDetail(weird, "s3cret")).toBe(false);
  });
});
