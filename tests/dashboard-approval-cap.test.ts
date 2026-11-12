// Approval codes are single-use: the service remembers used codes until their
// window ends. Its memory bound must never forget them all at once, because a
// forgotten code works again until it expires (review of PR #35).
import { describe, it, expect } from "vitest";
import { Sealer } from "../src/dashboard/seal.js";
import { ApprovalService, MAX_USED_CODES } from "../src/dashboard/approval.js";

const SECRET = "approval-cap-test-secret-0123456789-abcdefghijklmnop";
const ACTOR = "actor-1";
const TOOL = "cometchat_delete_role";

function setup() {
  const approvals = new ApprovalService({ sealer: new Sealer(SECRET), secret: SECRET, publicUrl: "https://mcp.example.com" });
  const cookie = approvals.approverCookie(ACTOR).split(";")[0];
  /** A real code for these exact arguments, as the user's browser would get it. */
  const codeFor = (args: Record<string, unknown>) => {
    const r = new URL(approvals.requestUrl(ACTOR, TOOL, "Delete a role", "Delete it", args)).searchParams.get("r");
    const res = approvals.approveWithCookie(r, cookie);
    if (res.status !== "approved") throw new Error(`not approved: ${res.status}`);
    return res.code;
  };
  const used = (approvals as unknown as { used: Map<string, number> }).used;
  return { approvals, codeFor, used };
}

describe("approval codes stay single-use when the used-code list is full", () => {
  it("forgets only the oldest entries, so a recently used code is still refused", () => {
    const { approvals, codeFor, used } = setup();
    // Fill the list with unexpired entries, as a burst of real approvals would.
    const until = Math.floor(Date.now() / 1000) + 3600;
    for (let i = 0; i < MAX_USED_CODES - 1; i++) used.set(`filler|${i}`, until);

    const a = { app_id: "app123", role: "a" };
    const codeA = codeFor(a);
    expect(approvals.check(ACTOR, TOOL, a, codeA)).toBe(true); // used once: the list is now full

    const b = { app_id: "app123", role: "b" };
    const codeB = codeFor(b);
    expect(approvals.check(ACTOR, TOOL, b, codeB)).toBe(true); // over the cap: the oldest filler goes

    // The previous behaviour cleared the whole list here, so code A worked a second time.
    expect(approvals.check(ACTOR, TOOL, a, codeA)).toBe(false);
    expect(approvals.check(ACTOR, TOOL, b, codeB)).toBe(false);
    expect(approvals.rejectReason(ACTOR, TOOL, a, codeA)).toBe("used");

    expect(used.size).toBeLessThanOrEqual(MAX_USED_CODES);
    expect(used.has("filler|0")).toBe(false); // the oldest entry was the one dropped
    expect(used.has(`filler|${MAX_USED_CODES - 2}`)).toBe(true);
  });

  it("still drops expired entries first", () => {
    const { approvals, codeFor, used } = setup();
    used.set("expired|1", 1); // long past
    const args = { app_id: "app123", role: "c" };
    expect(approvals.check(ACTOR, TOOL, args, codeFor(args))).toBe(true);
    expect(used.has("expired|1")).toBe(false);
  });
});
