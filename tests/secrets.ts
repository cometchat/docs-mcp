import { createHash } from "node:crypto";

/** A deterministic, realistic-looking secret for tests (passes the weak-secret check). */
export const testSecret = (tag: string): string => createHash("sha256").update(`test-secret:${tag}`).digest("base64url");
