// Stateless sealed values (AES-256-GCM). OAuth client IDs, authorization codes
// and access/refresh tokens are all sealed payloads, so any replica can verify
// them without shared storage. The dashboard token inside is never readable by
// the MCP client or the model, only by this server.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

export type SealKind = "client" | "pending" | "code" | "access" | "refresh" | "approval" | "approver" | "signin-browser";

interface Envelope<T> {
  k: SealKind;
  exp: number; // epoch seconds; 0 = never expires
  d: T;
}

export class Sealer {
  private readonly key: Buffer;
  /** Current key first, then previous keys still accepted for opening (rotation). */
  private readonly openKeys: Buffer[];

  constructor(secret: string, previousSecrets: string[] = []) {
    for (const s of [secret, ...previousSecrets]) {
      if (!s || s.length < 32) throw new Error("DASHBOARD_TOKEN_SECRET (and any previous secret) must be at least 32 characters.");
      // Length alone lets "aaaa…" or "abcdefghij" repeated through. Real
      // random secrets (`openssl rand -hex 32`, `-base64 48`) clear both easily.
      if (looksWeak(s)) throw new Error("DASHBOARD_TOKEN_SECRET (and any previous secret) looks weak: generate one with `openssl rand -base64 48`.");
    }
    const derive = (s: string) => createHash("sha256").update(s).digest();
    this.key = derive(secret);
    this.openKeys = [this.key, ...previousSecrets.map(derive)];
  }

  seal<T>(kind: SealKind, data: T, ttlSeconds: number): string {
    const env: Envelope<T> = { k: kind, exp: ttlSeconds > 0 ? nowSeconds() + ttlSeconds : 0, d: data };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(env), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}.${b64(iv)}.${b64(body)}.${b64(tag)}`;
  }

  /** Returns the payload, or null when tampered, expired, malformed or the wrong kind. */
  open<T>(kind: SealKind, value: string): { data: T; exp: number } | null {
    // Strict format first: Node's base64url decoder stops at the first bad
    // character, so "<valid value>=<anything>" would otherwise still open, and
    // the trailing text could reach a page that echoes the value.
    if (typeof value !== "string" || value.length > 16_384 || !SEALED_RE.test(value)) return null;
    const parts = value.split(".");
    for (const key of this.openKeys) {
      let json: string;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, unb64(parts[1]!));
        decipher.setAuthTag(unb64(parts[3]!));
        json = Buffer.concat([decipher.update(unb64(parts[2]!)), decipher.final()]).toString("utf8");
      } catch {
        continue; // not sealed with this key
      }
      try {
        const env = JSON.parse(json) as Envelope<T>;
        if (env.k !== kind) return null;
        if (env.exp !== 0 && env.exp < nowSeconds()) return null;
        return { data: env.d, exp: env.exp };
      } catch {
        return null;
      }
    }
    return null;
  }
}

const SEALED_RE = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/;

/** Too few distinct characters, or mostly repeated 4-character runs. */
export function looksWeak(s: string): boolean {
  if (new Set(s).size < 10) return true;
  const grams = new Set<string>();
  for (let i = 0; i + 4 <= s.length; i++) grams.add(s.slice(i, i + 4));
  return grams.size < (s.length - 3) * 0.7;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");
