import { describe, it, expect } from "vitest";
import { rateLimit } from "../src/lib/rateLimit.js";
import type { Request, Response } from "express";

function makeReq(ip = "1.2.3.4"): Request {
  return {
    header: () => undefined,
    ip,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  const res = {
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  } as unknown as Response;
  return {
    res,
    headers,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

describe("rateLimit middleware", () => {
  it("passes through under the limit", () => {
    const limiter = rateLimit({ max: 3, windowMs: 1000 });
    const ctx = makeRes();
    let nextCalled = 0;
    for (let i = 0; i < 3; i++) {
      limiter(makeReq(), ctx.res, () => {
        nextCalled += 1;
      });
    }
    expect(nextCalled).toBe(3);
    expect(ctx.statusCode).toBe(200);
  });

  it("blocks with 429 once max is exceeded", () => {
    const limiter = rateLimit({ max: 2, windowMs: 1000 });
    const req = makeReq();
    const ctx = makeRes();
    let nextCalled = 0;
    for (let i = 0; i < 4; i++) {
      limiter(req, ctx.res, () => {
        nextCalled += 1;
      });
    }
    expect(nextCalled).toBe(2);
    expect(ctx.statusCode).toBe(429);
    expect(ctx.headers["Retry-After"]).toBeDefined();
  });

  it("isolates buckets per IP", () => {
    const limiter = rateLimit({ max: 1, windowMs: 1000 });
    const ctxA = makeRes();
    const ctxB = makeRes();
    let aOk = 0;
    let bOk = 0;
    limiter(makeReq("1.1.1.1"), ctxA.res, () => {
      aOk += 1;
    });
    limiter(makeReq("2.2.2.2"), ctxB.res, () => {
      bOk += 1;
    });
    expect(aOk).toBe(1);
    expect(bOk).toBe(1);
    expect(ctxA.statusCode).toBe(200);
    expect(ctxB.statusCode).toBe(200);
  });
});
