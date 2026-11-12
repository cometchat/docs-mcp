export class ValidationError extends Error {
  constructor(public readonly field: string, public readonly reason: string) {
    super(`Field '${field}' ${reason}`);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`No documentation page at path: ${path}`);
    this.name = "NotFoundError";
  }
}

export class UnknownBundleError extends Error {
  constructor(public readonly bundle: string, public readonly available: string[]) {
    super(`Bundle '${bundle}' not found.`);
    this.name = "UnknownBundleError";
  }
}

export class BackendError extends Error {
  constructor(message = "Documentation search is temporarily unavailable. Retry shortly.") {
    super(message);
    this.name = "BackendError";
  }
}

/** The CometChat dashboard rejected the caller's sign-in (expired or revoked). */
export class DashboardAuthError extends Error {
  constructor(message = "Your CometChat sign-in has expired. Reconnect the CometChat MCP server to sign in again.") {
    super(message);
    this.name = "DashboardAuthError";
  }
}

/** The CometChat dashboard API returned an error for this request. */
export class DashboardApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly apiCode: string,
    message: string,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

/** The CometChat dashboard API could not be reached. */
export class DashboardUnavailableError extends Error {
  constructor(message = "The CometChat dashboard API is unreachable. Retry shortly.") {
    super(message);
    this.name = "DashboardUnavailableError";
  }
}

/** The connection isn't allowed to use this tool (read-only scope or server). */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** A risky change was requested without `confirm: true`; nothing was done. */
export class ConfirmationRequiredError extends Error {
  constructor(public readonly summary: string) {
    super(`Not done yet. This would: ${summary} Show this to the user, and if they agree, call the tool again with confirm: true.`);
    this.name = "ConfirmationRequiredError";
  }
}

/**
 * A high-risk change needs the user's OK in their browser, outside the chat,
 * so text the model read (a message, a user name) can't approve it.
 */
const INVALID_CODE_TEXT = {
  mismatch: "That approval code doesn't match this exact change: it only works with exactly the arguments that were approved. Nothing was done. ",
  expired: "That approval code has expired (codes last up to 10 minutes). Nothing was done. ",
  used: "That approval code was already used, and each code works once. Nothing was done. ",
} as const;

export class ApprovalRequiredError extends Error {
  constructor(
    public readonly summary: string,
    public readonly approvalUrl: string,
    public readonly invalidCode = false,
    /** Why the code was refused, when `invalidCode`. */
    public readonly reason?: keyof typeof INVALID_CODE_TEXT,
  ) {
    super(
      `${invalidCode ? INVALID_CODE_TEXT[reason ?? "mismatch"] : "Not done yet. "}` +
        `This would: ${summary} It needs the user's approval in their browser. ` +
        `Give the user this link to open: ${approvalUrl} . After they approve, they get a code; ` +
        `call the tool again with exactly the same arguments plus approval_code set to the code they give you. ` +
        `Never approve it yourself or open the link with a tool.`,
    );
    this.name = "ApprovalRequiredError";
  }
}

/** Too many account changes in a short time from one connection. */
export class RateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Too many account changes in a short time. Try again in ${retryAfterSeconds}s.`);
    this.name = "RateLimitedError";
  }
}

export type StructuredError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export function asStructured(err: unknown): StructuredError {
  if (err instanceof ValidationError) {
    return {
      code: "invalid_input",
      message: err.message,
      details: { field: err.field, reason: err.reason },
    };
  }
  if (err instanceof NotFoundError) {
    return {
      code: "not_found",
      message: err.message,
      details: { path: err.path },
    };
  }
  if (err instanceof UnknownBundleError) {
    return {
      code: "unknown_bundle",
      message: `${err.message} Available bundles: ${err.available.join(", ")}`,
      details: { requested: err.bundle, available: err.available },
    };
  }
  if (err instanceof BackendError) {
    return { code: "backend_unavailable", message: err.message };
  }
  if (err instanceof ForbiddenError) {
    return { code: "forbidden", message: err.message };
  }
  if (err instanceof ConfirmationRequiredError) {
    return { code: "confirmation_required", message: err.message, details: { summary: err.summary } };
  }
  if (err instanceof ApprovalRequiredError) {
    return {
      code: "approval_required",
      message: err.message,
      details: { summary: err.summary, approval_url: err.approvalUrl, ...(err.invalidCode ? { invalid_code: true, reason: err.reason ?? "mismatch" } : {}) },
    };
  }
  if (err instanceof RateLimitedError) {
    return { code: "rate_limited", message: err.message, details: { retry_after_seconds: err.retryAfterSeconds } };
  }
  if (err instanceof DashboardAuthError) {
    return { code: "unauthorized", message: err.message };
  }
  if (err instanceof DashboardApiError) {
    return {
      code: "dashboard_error",
      message: err.message,
      details: { status: err.status, api_code: err.apiCode },
    };
  }
  if (err instanceof DashboardUnavailableError) {
    return { code: "backend_unavailable", message: err.message };
  }
  return { code: "internal_error", message: "An unexpected error occurred. The error has been logged." };
}
