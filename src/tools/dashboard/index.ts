// The dashboard tool surface and the policy every call goes through: scopes,
// read-only mode, local-only tools, explicit confirmation, per-actor write
// rate limits and an audit record per call.
import { ApprovalRequiredError, ConfirmationRequiredError, ForbiddenError, RateLimitedError, ValidationError, asStructured } from "../../lib/errors.js";
import { cleanSummary, maskSecrets, type ApprovalService } from "../../dashboard/approval.js";
import { logger } from "../../lib/logger.js";
import type { DashboardClient } from "../../dashboard/client.js";
import { toolDefinition, type DashboardToolSpec } from "./registry.js";
import { ACCOUNT_TOOLS, AI_FEATURES } from "./account.js";
import { PROJECT_TOOLS } from "./project.js";
import { PEOPLE_TOOLS } from "./people.js";
import { OPS_TOOLS } from "./ops.js";
import { DELETE_TOOLS } from "./deletes.js";

export { AI_FEATURES };

export const READ_SCOPE = "dashboard:read";
export const WRITE_SCOPE = "dashboard:write";

export const ALL_DASHBOARD_TOOLS: readonly DashboardToolSpec[] = [...ACCOUNT_TOOLS, ...PROJECT_TOOLS, ...PEOPLE_TOOLS, ...OPS_TOOLS, ...DELETE_TOOLS];
const BY_NAME = new Map(ALL_DASHBOARD_TOOLS.map((t) => [t.name, t]));
export const DASHBOARD_TOOL_NAMES: ReadonlySet<string> = new Set(BY_NAME.keys());

export interface DashboardSession {
  client: DashboardClient;
  /** Granted OAuth scopes (stdio: from the environment). */
  scopes: ReadonlySet<string>;
  /** Server-wide read-only switch (DASHBOARD_READ_ONLY). */
  readOnly: boolean;
  /** Local stdio connection: local-only tools are allowed. */
  local: boolean;
  /** Pseudonymous id of the signed-in user, for the audit log and rate limits. */
  actor: string;
  /** Max account changes per actor per minute (0 = unlimited). */
  writesPerMinute: number;
  /** Short hash of the OAuth client, to tell one user's tools apart in the audit log. */
  clientRef?: string;
  /** When this sign-in happened (epoch seconds), for choosing revocation cut-offs. */
  signedInAt?: number;
  /**
   * Browser approval for high-risk changes (hosted endpoint). Absent on a
   * local stdio connection, where `confirm: true` from the user's own agent is enough.
   */
  approvals?: ApprovalService;
  /** MCP session id and a hash of the client IP, so audit lines join to the request logs. */
  sessionId?: string;
  ipHash?: string;
}

export { actorId } from "../../dashboard/actor.js";
import { actorId as keyedId } from "../../dashboard/actor.js";

/** Write scope granted and the server isn't read-only. */
function canWrite(s: DashboardSession): boolean {
  return !s.readOnly && s.scopes.has(WRITE_SCOPE);
}

function allowed(t: DashboardToolSpec, s: DashboardSession): boolean {
  if (t.localOnly && !s.local) return false;
  if (t.access === "write") return canWrite(s);
  return s.scopes.has(READ_SCOPE) || s.scopes.has(WRITE_SCOPE);
}

export function visibleDashboardTools(s: DashboardSession) {
  return ALL_DASHBOARD_TOOLS.filter((t) => allowed(t, s)).map(toolDefinition);
}

/** What a remote sign-in with the default (read + write) grant would see: offered on /mcp before sign-in. */
export function signInDashboardTools(readOnly: boolean) {
  return ALL_DASHBOARD_TOOLS.filter((t) => !t.localOnly && (t.access !== "write" || !readOnly)).map(toolDefinition);
}

// Sliding one-minute window per actor; process-local, so each replica enforces
// its own share (pair with a gateway limit for a global cap).
const writeLog = new Map<string, number[]>();
function takeWriteSlot(actor: string, perMinute: number): void {
  if (perMinute <= 0) return;
  const now = Date.now();
  const recent = (writeLog.get(actor) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) {
    writeLog.set(actor, recent);
    throw new RateLimitedError(Math.max(1, Math.ceil((60_000 - (now - recent[0]!)) / 1000)));
  }
  recent.push(now);
  writeLog.set(actor, recent);
  if (writeLog.size > 10_000) writeLog.delete(writeLog.keys().next().value!);
}

export function resetWriteLimits(): void {
  writeLog.clear();
}

export async function runDashboardTool(name: string, rawArgs: unknown, s: DashboardSession): Promise<Record<string, unknown>> {
  const tool = BY_NAME.get(name);
  const args = (rawArgs && typeof rawArgs === "object" ? { ...(rawArgs as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const started = Date.now();
  const appIdArg = typeof args.app_id === "string" ? args.app_id.slice(0, 64) : undefined;
  let outcome = "success";
  let errorCode: string | undefined;
  let target: Record<string, unknown> | undefined;
  let approved = false;
  let approvedCode: unknown;
  let writesBefore = 0;
  try {
    if (!tool) throw new ForbiddenError(`Unknown tool ${name}.`);
    if (!allowed(tool, s)) {
      throw new ForbiddenError(
        tool.localOnly && !s.local
          ? `${name} only works on a local connection, because it reads files from your machine.`
          : s.readOnly
            ? `${name} changes the account, and this server is read-only.`
            : `${name} changes the account, and this connection only has read access.`,
      );
    }
    if (tool.access === "write") {
      const confirmed = args.confirm === true;
      const approvalCode = args.approval_code;
      delete args.confirm;
      delete args.approval_code;
      target = auditTarget(args);
      if (tool.check) await tool.check(args, { client: s.client, local: s.local, canWrite: canWrite(s) });
      // Built from a masked copy: the summary is shown on the approval page and to the model.
      const summary = () => cleanSummary(tool.describe ? tool.describe(maskSecrets(args)) : `run ${name}.`);
      if (tool.approval && s.approvals) {
        // The browser approval is the user's confirmation; `confirm` alone can't stand in for it.
        if (approvalCode === undefined) {
          outcome = "approval_required";
          throw new ApprovalRequiredError(summary(), s.approvals.requestUrl(s.actor, name, tool.title, summary(), args));
        }
        // Rate-limit first, so a limited call doesn't use up the approved code.
        takeWriteSlot(s.actor, s.writesPerMinute);
        if (!s.approvals.check(s.actor, name, args, approvalCode)) {
          outcome = "approval_invalid";
          throw new ApprovalRequiredError(summary(), s.approvals.requestUrl(s.actor, name, tool.title, summary(), args), true, s.approvals.rejectReason(s.actor, name, args, approvalCode));
        }
        approved = true;
        approvedCode = approvalCode;
        writesBefore = s.client.writesSent;
      } else {
        if (tool.confirm && !confirmed) {
          outcome = "confirmation_required";
          throw new ConfirmationRequiredError(summary());
        }
        takeWriteSlot(s.actor, s.writesPerMinute);
      }
    }
    return await tool.run(args, { client: s.client, local: s.local, canWrite: canWrite(s) });
  } catch (err) {
    if (outcome === "success") outcome = "error";
    // Input the tool rejected before sending any change: the approval can be used again.
    if (approvedCode !== undefined && err instanceof ValidationError && s.client.writesSent === writesBefore) {
      s.approvals?.release(s.actor, name, args, approvedCode);
    }
    errorCode = asStructured(err).code;
    throw err;
  } finally {
    // One audit record per call: who (pseudonymous), what, which app, on what
    // (ids only, never values that can hold secrets or message text), outcome.
    logger.info(
      {
        audit: "dashboard_tool",
        actor: s.actor,
        ...(s.clientRef ? { client: s.clientRef } : {}),
        ...(s.signedInAt ? { signed_in_at: s.signedInAt } : {}),
        ...(s.sessionId ? { session_id: s.sessionId } : {}),
        ...(s.ipHash ? { ip_hash: s.ipHash } : {}),
        tool: name,
        access: tool?.access ?? "unknown",
        app_id: appIdArg,
        ...(target && Object.keys(target).length ? { target } : {}),
        ...(approved ? { approved_in_browser: true } : {}),
        outcome,
        ...(errorCode && outcome === "error" ? { error_code: errorCode } : {}),
        duration_ms: Date.now() - started,
      },
      "dashboard_audit",
    );
  }
}

// ── audit target ──────────────────────────────────────────────────────────

/** Ids a write acts on. Free text, names, keys and secrets are never included. */
const ID_FIELDS = ["uid", "guid", "feature_id", "rule_id", "provider_id", "role", "scope", "kind", "type", "conversation_id", "message_id", "webhook_id", "list_id"] as const;
const ID_LIST_FIELDS = ["uids", "participants", "moderators", "admins", "members", "triggers"] as const;
/** What an id, role or trigger looks like; anything else (free text) is never logged. */
const AUDIT_ID_RE = /^[A-Za-z0-9_.:@-]{1,100}$/;

export function auditTarget(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ID_FIELDS) {
    const v = args[f];
    if (typeof v === "string") out[f] = AUDIT_ID_RE.test(v) ? v : "(not an id)";
    else if (typeof v === "boolean") out[f] = v;
  }
  for (const f of ID_LIST_FIELDS) {
    const v = args[f];
    if (Array.isArray(v)) out[f] = { count: v.length, first: v.slice(0, 5).map((x) => (typeof x === "string" && AUDIT_ID_RE.test(x) ? x : "(not an id)")) };
  }
  if (typeof args.enabled === "boolean") out.enabled = args.enabled;
  if (typeof args.active === "boolean") out.active = args.active;
  if (typeof args.permanent === "boolean") out.permanent = args.permanent;
  // App settings: which keys changed, not their values.
  if (args.settings && typeof args.settings === "object") out.setting_keys = Object.keys(args.settings as object).slice(0, 20).map((k) => (AUDIT_ID_RE.test(k) ? k : "(not an id)"));
  // Webhook destination: the host is what an access review needs.
  if (typeof args.url === "string") {
    try {
      out.url_host = new URL(args.url).host;
    } catch {
      out.url_host = "invalid";
    }
  }
  // Invited person: hash (keyed like actor ids) plus domain, so a reviewer can match it to a known address without the log holding it.
  if (typeof args.email === "string") {
    const e = args.email.trim().toLowerCase();
    out.email_hash = keyedId(`invite:${e}`);
    out.email_domain = e.includes("@") ? e.split("@").pop() : undefined;
  }
  return out;
}
