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
  return { code: "internal_error", message: "An unexpected error occurred. The error has been logged." };
}
