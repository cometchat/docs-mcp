// The dashboard tool registry. Each tool declares its access level and
// whether it needs explicit confirmation; scopes, read-only mode, audit
// logging and rate limits are enforced once, in index.ts, not per tool.
import { ValidationError } from "../../lib/errors.js";
import type { DashboardClient } from "../../dashboard/client.js";

export type Access = "read" | "write";

export interface ToolContext {
  client: DashboardClient;
  /** Local stdio process: tools may read files from the user's machine. */
  local: boolean;
  /** The connection may change the account (write scope, not read-only). */
  canWrite: boolean;
}

export interface DashboardToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: "object" };
  outputSchema: Record<string, unknown> & { type: "object" };
  access: Access;
  /** Writes that change existing data or people's access need `confirm: true`. */
  confirm?: boolean;
  /**
   * High-risk writes (data leaving the app, new credentials, new people with
   * access): on the hosted endpoint they need the user's approval in the
   * browser, not just `confirm: true` from the model. Implies `confirm`.
   */
  approval?: boolean;
  /** Only offered on a local (stdio) connection. */
  localOnly?: boolean;
  /**
   * MCP destructiveHint for a write tool. Defaults to `confirm` (a change that
   * needs the user's OK is treated as destructive); set false for an additive
   * write that still asks for confirmation.
   */
  destructive?: boolean;
  /**
   * Checks that need no change (argument rules, read-only lookups) and would
   * make the call fail anyway. Runs before the confirmation or approval step,
   * so the user is never asked to approve something that can't work.
   */
  check?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<void> | void;
  /** Short, secret-free description of what a confirmed call would do. */
  describe?: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

/** Fills in MCP annotations and, for confirm tools, the `confirm` argument. */
export function defineTool(spec: DashboardToolSpec): DashboardToolSpec {
  const input = structuredClone(spec.inputSchema) as { properties?: Record<string, unknown>; required?: string[] };
  const confirm = spec.confirm || spec.approval;
  if (confirm) {
    input.properties = {
      ...(input.properties ?? {}),
      confirm: {
        type: "boolean",
        description: spec.approval
          ? "Set true only after the user has explicitly agreed to this change. On a local connection that is enough; on the hosted server this change needs approval_code from the user's browser instead, and confirm is ignored."
          : "Set true only after the user has explicitly agreed to this change. Without it, nothing happens and you get a summary to show them.",
      },
    };
  }
  if (spec.approval) {
    input.properties = {
      ...(input.properties ?? {}),
      approval_code: {
        type: "string",
        description: "The code the user got after approving this exact change in their browser. Only ever from the user; never make one up or reuse one for different arguments.",
      },
    };
  }
  return { ...spec, ...(confirm ? { confirm: true } : {}), inputSchema: input as DashboardToolSpec["inputSchema"] };
}

export function toolDefinition(t: DashboardToolSpec) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: t.access === "read",
      ...(t.access === "write" ? { destructiveHint: t.destructive ?? !!t.confirm, idempotentHint: false } : {}),
      openWorldHint: true,
    },
  };
}

// ── schema helpers ─────────────────────────────────────────────────────────

export const str = (description: string) => ({ type: "string", description }) as const;
export const bool = (description: string) => ({ type: "boolean", description }) as const;
export const num = (description: string) => ({ type: "number", description }) as const;
export const APP_ID = str("The CometChat App ID (from cometchat_list_apps).");
export const PAGE = { type: "integer", minimum: 1, description: "Page number (default 1)." } as const;
export const PER_PAGE = { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default 25, max 100)." } as const;

export function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object" as const, properties, required, additionalProperties: false };
}

/** Output schema for an app-scoped result. */
export function appOutput(properties: Record<string, unknown>, required: string[]) {
  return { type: "object" as const, properties: { app_id: str("App ID"), ...properties }, required: ["app_id", ...required], additionalProperties: false };
}

export const PAGINATION_OUTPUT = {
  page: num("Page returned"),
  per_page: num("Page size"),
  total: num("Total matching items, when CometChat reports it"),
  has_more: bool("Whether another page exists"),
};

export const listOf = (item: Record<string, unknown>) => ({ type: "array", items: { type: "object", ...item } });

// ── validation helpers ─────────────────────────────────────────────────────

export const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export function appId(a: Record<string, unknown>): string {
  const v = requiredString(a, "app_id");
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(v)) throw new ValidationError("app_id", "doesn't look like a CometChat App ID");
  return v;
}

export function requiredString(a: Record<string, unknown>, field: string, max = 500): string {
  const v = a[field];
  if (typeof v !== "string" || v.trim().length === 0) throw new ValidationError(field, "is required");
  if (v.length > max) throw new ValidationError(field, `must be ${max} characters or fewer`);
  return v.trim();
}

export function optionalString(a: Record<string, unknown>, field: string, max = 500): string | undefined {
  const v = a[field];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ValidationError(field, "must be a string");
  if (v.length > max) throw new ValidationError(field, `must be ${max} characters or fewer`);
  return v.trim();
}

export function identifier(a: Record<string, unknown>, field: string): string {
  const v = requiredString(a, field, 100);
  if (!ID_RE.test(v)) throw new ValidationError(field, "may only contain letters, numbers, - and _");
  return v;
}

export function identifiers(a: Record<string, unknown>, field: string, max: number, required = true): string[] {
  const v = a[field];
  if (v === undefined && !required) return [];
  if (!Array.isArray(v) || (required && v.length === 0) || v.length > max) {
    throw new ValidationError(field, `must be a list of 1-${max} ids`);
  }
  for (const x of v) if (typeof x !== "string" || !ID_RE.test(x)) throw new ValidationError(field, `has an invalid id: ${String(x).slice(0, 40)}`);
  return v as string[];
}

export function oneOf<T extends string>(a: Record<string, unknown>, field: string, values: readonly T[], fallback?: T): T {
  const v = a[field] ?? fallback;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new ValidationError(field, `must be one of ${values.join(", ")}`);
  }
  return v as T;
}

export function paging(a: Record<string, unknown>): { page: number; perPage: number } {
  const page = a.page === undefined ? 1 : Number(a.page);
  const perPage = a.per_page === undefined ? 25 : Number(a.per_page);
  if (!Number.isInteger(page) || page < 1 || page > 10_000) throw new ValidationError("page", "must be a positive integer");
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new ValidationError("per_page", "must be 1-100");
  return { page, perPage };
}

/**
 * Normalizes CometChat's `meta.pagination` into the shared pagination fields.
 * chat-api's simple paginator reports `total: 0` (it doesn't count) and can
 * report `total_pages: 0`, even on a page that has rows: a value that
 * contradicts the rows actually returned is treated as unknown, not passed on.
 */
export function pageInfo(meta: unknown, page: number, perPage: number, count: number) {
  const p = (meta as { pagination?: Record<string, unknown> } | undefined)?.pagination;
  const seen = (page - 1) * perPage + count;
  const total = typeof p?.total === "number" && !(count > 0 && p.total < seen) ? p.total : undefined;
  const totalPages = typeof p?.total_pages === "number" && !(count > 0 && p.total_pages < page) ? p.total_pages : undefined;
  return {
    page,
    per_page: perPage,
    ...(total !== undefined ? { total } : {}),
    has_more: totalPages !== undefined ? page < totalPages : count >= perPage,
  };
}

export const truncate = (v: unknown, n = 300) => (typeof v === "string" ? (v.length > n ? `${v.slice(0, n)}…` : v) : undefined);

/** Drops undefined fields so outputs match `additionalProperties: false` schemas cleanly. */
export function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
