// The dashboard's device-login handshake (the same one `cometchat auth login`
// uses): create a session, send the user to the dashboard to sign in, then poll
// until the dashboard hands back a token for that session.
type FetchLike = typeof fetch;

export type PollResult =
  | { status: "pending" }
  | { status: "authorized"; token: string; email?: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; message: string };

/** What the dashboard shows the user before they allow the sign-in, and where it returns the browser. */
export interface DeviceSessionMetadata {
  /** Browser-bound sign-in: after the user allows it, the dashboard sends the browser here with a one-time verifier. */
  returnUrl?: string;
  clientName?: string;
  returnTo?: string;
  verified?: boolean;
}

export async function createDeviceSession(apiHost: string, fetchImpl: FetchLike = fetch, metadata: DeviceSessionMetadata = {}): Promise<string> {
  const res = await fetchImpl(`${trim(apiHost)}/cli-auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ cli: "cometchat-mcp", metadata: { platform: "mcp", ...metadata } }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = body?.sessionId ?? (body?.data as Record<string, unknown> | undefined)?.sessionId;
  if (!res.ok || typeof sessionId !== "string" || !sessionId) {
    throw new Error(`Could not start a CometChat sign-in session (${res.status}).`);
  }
  return sessionId;
}

export function dashboardLoginUrl(dashboardHost: string, sessionId: string, kind: "login" | "signup" = "login"): string {
  return `${trim(dashboardHost)}/${kind}?${new URLSearchParams({ sessionId }).toString()}`;
}

/** One poll; the caller decides how often to retry. */
export async function pollDeviceSession(apiHost: string, sessionId: string, fetchImpl: FetchLike = fetch, verifier?: string): Promise<PollResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${trim(apiHost)}/cli-auth/session/authenticate`, {
      method: "GET",
      headers: { Accept: "application/json", sessionId, ...(verifier ? { verifier } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: "pending" }; // transient network error: keep polling
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) {
    const data = (body?.data ?? {}) as Record<string, unknown>;
    const token = body?.token ?? body?.access_token ?? data.token;
    if (typeof token === "string" && token) {
      const email = [body?.email, data.email, (data.user as Record<string, unknown> | undefined)?.email].find(
        (e): e is string => typeof e === "string" && e.length > 0,
      );
      return { status: "authorized", token, ...(email ? { email } : {}) };
    }
    return { status: "pending" };
  }
  const err = body?.error;
  const code = typeof err === "string" ? err : (err as { code?: string } | undefined)?.code;
  if ((res.status === 400 && code === "authorization_pending") || res.status === 429 || res.status >= 500) {
    return { status: "pending" };
  }
  if (code === "access_denied" || code === "ERR_ACCESS_DENIED" || code === "ERR_SESSION_DENIED") return { status: "denied" };
  if (res.status === 410 || code === "expired_token" || code === "ERR_SESSION_EXPIRED" || code === "ERR_SESSION_NOT_FOUND") {
    return { status: "expired" };
  }
  return { status: "error", message: `Sign-in failed (${res.status}${code ? ` ${code}` : ""}).` };
}

const trim = (h: string) => h.replace(/\/+$/, "");
