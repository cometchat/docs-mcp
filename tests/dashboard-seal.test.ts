import { describe, it, expect, vi, afterEach } from "vitest";
import { Sealer } from "../src/dashboard/seal.js";
import { testSecret } from "./secrets.js";

const SECRET = testSecret("x");

describe("Sealer", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips a payload of the same kind", () => {
    const s = new Sealer(SECRET);
    const v = s.seal("access", { dt: "tok", cid: "c1" }, 60);
    expect(s.open("access", v)?.data).toEqual({ dt: "tok", cid: "c1" });
  });

  it("never exposes the payload in the sealed string", () => {
    const v = new Sealer(SECRET).seal("access", { dt: "very-secret-dashboard-token" }, 60);
    expect(v).not.toContain("very-secret");
    expect(Buffer.from(v.split(".")[2]!, "base64url").toString("utf8")).not.toContain("very-secret");
  });

  it("rejects the wrong kind, a different secret, tampering and garbage", () => {
    const s = new Sealer(SECRET);
    const v = s.seal("refresh", { a: 1 }, 60);
    expect(s.open("access", v)).toBeNull();
    expect(new Sealer(testSecret("y")).open("refresh", v)).toBeNull();
    const parts = v.split(".");
    parts[2] = parts[2]!.slice(0, -2) + (parts[2]!.endsWith("A") ? "BB" : "AA");
    expect(s.open("refresh", parts.join("."))).toBeNull();
    expect(s.open("refresh", "not-a-token")).toBeNull();
  });

  it("expires values after their TTL; ttl 0 never expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const s = new Sealer(SECRET);
    const short = s.seal("code", { a: 1 }, 60);
    const forever = s.seal("client", { a: 1 }, 0);
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    expect(s.open("code", short)).toBeNull();
    expect(s.open("client", forever)?.data).toEqual({ a: 1 });
  });

  it("refuses a short secret", () => {
    expect(() => new Sealer("short")).toThrow(/32 characters/);
  });
});
