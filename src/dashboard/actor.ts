import { createHash, createHmac } from "node:crypto";

// Keyed on the hosted server, so an actor id in an audit line or revocation
// entry can't be matched to an account by hashing guessed emails. A local
// stdio session has no key and stays a plain hash; it never leaves the machine.
let actorKey: Buffer | undefined;

/**
 * Sets the key for actor ids: DASHBOARD_ACTOR_SALT, else one derived from
 * DASHBOARD_TOKEN_SECRET. Undefined turns keying off (stdio, tests).
 */
export function configureActorKey(salt: string | undefined, tokenSecret?: string): void {
  if (salt) actorKey = createHash("sha256").update(`actor-salt:${salt}`).digest();
  else if (tokenSecret) actorKey = createHash("sha256").update(`actor-from-token-secret:${tokenSecret}`).digest();
  else actorKey = undefined;
}

/** Pseudonymous id for a signed-in user: the `actor` in audit lines, rate limits and revocations. */
export function actorId(seed: string): string {
  const h = actorKey ? createHmac("sha256", actorKey).update(seed) : createHash("sha256").update(seed);
  return h.digest("hex").slice(0, 16);
}

/** The actor for a hosted sign-in: from the account email, else the OAuth client. */
export function signInActor(email: string | undefined, clientId: string): string {
  return actorId(email ? `user:${email.trim().toLowerCase()}` : `client:${clientId}`);
}
