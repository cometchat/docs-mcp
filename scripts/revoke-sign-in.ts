// Prints the complete new DASHBOARD_REVOKED_SIGN_INS value that also cuts off
// every current sign-in for one account (or everyone with "*"), validated the
// same way the server validates it at startup — a malformed value would stop
// the whole server, so roll out exactly what this prints.
//
//   DASHBOARD_REVOKED_SIGN_INS="<current value>" npm run revoke-sign-in -- someone@example.com
//   DASHBOARD_REVOKED_SIGN_INS="<current value>" npm run revoke-sign-in -- '*'
//
// Actor ids are keyed, so run it with the server's DASHBOARD_ACTOR_SALT (or,
// if that isn't set, its DASHBOARD_TOKEN_SECRET) in the environment.
import { configureActorKey, signInActor } from "../src/dashboard/actor.js";
import { parseRevocations } from "../src/dashboard/oauth.js";

const who = process.argv[2]?.trim();
if (!who) {
  console.error('usage: DASHBOARD_REVOKED_SIGN_INS="<current value>" npm run revoke-sign-in -- <account email | *>');
  process.exit(1);
}
const current = process.env.DASHBOARD_REVOKED_SIGN_INS ?? "";
try {
  parseRevocations(current);
} catch (err) {
  console.error(`The current value is already invalid, fix it first: ${(err as Error).message}`);
  process.exit(1);
}
const salt = process.env.DASHBOARD_ACTOR_SALT?.trim();
const secret = process.env.DASHBOARD_TOKEN_SECRET?.trim();
if (who !== "*" && !salt && !secret) {
  console.error("Set DASHBOARD_ACTOR_SALT (or DASHBOARD_TOKEN_SECRET) to the server's value: actor ids are keyed with it.");
  process.exit(1);
}
configureActorKey(salt || undefined, secret || undefined);
const actor = who === "*" ? "*" : signInActor(who, "");
const next = [current.trim(), `${actor}:${Math.floor(Date.now() / 1000)}`].filter(Boolean).join(",");
parseRevocations(next);
console.log(next);
