// Typed client for the CometChat dashboard management API (the same API the
// web dashboard and @cometchat/skills-cli use). Every call is made with the
// signed-in user's dashboard token; nothing here is cached across users.
import { DashboardApiError, DashboardAuthError, DashboardUnavailableError } from "../lib/errors.js";

export type Region = "us" | "eu" | "in";
/** Creating an app took over 15 s in live testing. */
const CREATE_APP_TIMEOUT_MS = 90_000;
/** A new app's Auth Key can lag its creation; how often and how long to look for it. */
const CREATE_APP_KEY_RETRIES = 3;
const CREATE_APP_KEY_RETRY_MS = 1500;

export const REGIONS: readonly Region[] = ["us", "eu", "in"];

export interface DashboardApp {
  appId: string;
  name: string;
  region: string;
  plan?: string;
  product?: string;
  createdAt?: number;
}

export interface AppCredentials {
  appId: string;
  region: string;
  authKey: string;
}

export interface DashboardUser {
  name?: string;
  email?: string;
}

export interface Extension {
  id: string;
  name: string;
  enabled: boolean;
  category?: string;
  description?: string;
}

type FetchLike = typeof fetch;

export interface DashboardClientOptions {
  apiHost: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Called when the dashboard rejects the token (401), before the error is thrown. */
  onUnauthorized?: () => void;
}

const API_VERSIONS = new Map<string, { version: string; until: number }>();

export class DashboardClient {
  private readonly apiHost: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly onUnauthorized: (() => void) | undefined;

  constructor(opts: DashboardClientOptions) {
    this.apiHost = opts.apiHost.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onUnauthorized = opts.onUnauthorized;
  }

  async getCurrentUser(): Promise<DashboardUser> {
    const data = await this.request<Record<string, unknown>>("GET", "/me");
    return {
      name: typeof data?.name === "string" ? data.name : undefined,
      email: typeof data?.email === "string" ? data.email : undefined,
    };
  }

  async listApps(): Promise<DashboardApp[]> {
    const data = await this.request<unknown>("GET", "/apps?per_page=100&page=1");
    if (!Array.isArray(data)) return [];
    return data.map((raw) => toApp(raw as Record<string, unknown>));
  }

  /** An app's id and region (no keys). */
  async getApp(appId: string): Promise<{ appId: string; region: string }> {
    const d = await this.request<Record<string, unknown>>("GET", `/apps/${encodeURIComponent(appId)}?includeParentApp=1`);
    const id = d?.appId ?? d?.id ?? appId;
    const region = d?.region ?? "us";
    if (typeof id !== "string" || typeof region !== "string") {
      throw new DashboardApiError(502, "UNEXPECTED_SHAPE", "The dashboard returned no region for this app.");
    }
    return { appId: id, region };
  }

  /**
   * The app's Auth Key: its oldest authOnly API key, as on the dashboard's
   * API & Auth Keys page. Never the app record's `accessKey`: that is the key
   * the dashboard itself calls the REST API with, and it has full access, so
   * writing it to a VITE_/NEXT_PUBLIC_ variable would publish a server key.
   */
  async getAuthKey(appId: string): Promise<string> {
    const keys = await this.chatApi<unknown>(appId, "GET", "/apikeys?per_page=100&page=1");
    const authOnly = (Array.isArray(keys) ? keys : [])
      .map((raw) => raw as Record<string, unknown>)
      .filter((k) => k.scope === "authOnly" && typeof (k.apiKey ?? k.key) === "string" && String(k.apiKey ?? k.key) !== "")
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    const first = authOnly[0];
    if (!first) {
      throw new DashboardApiError(404, "NO_AUTH_KEY", "This app has no Auth Key. Create one with cometchat_create_api_key (scope authOnly).");
    }
    return String(first.apiKey ?? first.key);
  }

  async getAppCredentials(appId: string): Promise<AppCredentials> {
    const app = await this.getApp(appId);
    return { ...app, authKey: await this.getAuthKey(app.appId) };
  }

  async createApp(params: { name: string; region: Region; industry?: string }): Promise<AppCredentials> {
    // Mirrors the dashboard's onboarding form; the API rejects non-empty
    // otherTechnology values containing "@" or "/", so it stays empty.
    // Creating an app provisions it in its region and takes longer than the
    // default timeout (over 15 s in live testing), so it gets its own.
    const d = (
      await this.send(
        "POST",
        "/apps",
        {
          name: params.name,
          region: params.region,
          version: "3",
          metadata: { technology: "mcp", industry: params.industry ?? "other", otherTechnology: "" },
          source: "onboarding",
        },
        CREATE_APP_TIMEOUT_MS,
      )
    )?.data as Record<string, unknown> | undefined;
    const appId = d?.appId ?? d?.id;
    const region = d?.region ?? params.region;
    if (typeof appId !== "string" || typeof region !== "string") {
      throw new DashboardApiError(502, "UNEXPECTED_SHAPE", "The dashboard created the app but returned no app id.");
    }
    // The Auth Key comes from the new app's API keys (see getAuthKey), which
    // can take a moment to appear. The app exists either way, so never invite
    // a retry of create_app.
    for (let attempt = 0; ; attempt++) {
      try {
        return { appId, region, authKey: await this.getAuthKey(appId) };
      } catch (err) {
        // Only a key that hasn't appeared yet or a transient failure is worth
        // waiting for; anything else (e.g. 401/403) won't clear up by itself.
        const transient =
          !(err instanceof DashboardApiError) || err.apiCode === "NO_AUTH_KEY" || err.status === 404 || err.status >= 500;
        if (!transient || attempt >= CREATE_APP_KEY_RETRIES) {
          throw new DashboardApiError(
            502,
            "APP_CREATED_NO_KEY_YET",
            `The app was created (app_id ${appId}, region ${region}), but its Auth Key isn't available yet. Don't create it again: call cometchat_get_app_credentials for ${appId} in a moment.`,
          );
        }
        await new Promise((r) => setTimeout(r, CREATE_APP_KEY_RETRY_MS));
      }
    }
  }

  /** Every extension available in a region, with whether it's on for the app. */
  async listExtensions(appId: string, region: string): Promise<Extension[]> {
    const [catalog, installed] = await Promise.all([
      this.request<unknown>("GET", `/regions/${encodeURIComponent(region)}/extensions?per_page=50`),
      this.request<unknown>("GET", `/apps/${encodeURIComponent(appId)}/extensions?per_page=50`),
    ]);
    const on = new Set(
      (Array.isArray(installed) ? installed : [])
        .filter((e) => isEnabled(e as Record<string, unknown>))
        .map((e) => String((e as Record<string, unknown>).id)),
    );
    return (Array.isArray(catalog) ? catalog : []).map((raw) => {
      const e = raw as Record<string, unknown>;
      const id = String(e.id ?? "");
      return {
        id,
        name: String(e.name ?? id).trim() || id,
        enabled: on.has(id),
        ...(typeof e.category === "string" ? { category: e.category } : {}),
        ...(typeof e.description === "string" ? { description: e.description.trim().slice(0, 300) } : {}),
      };
    });
  }

  /** The API answers 200 with a per-extension result map, so failures are only in the body. */
  async setExtension(appId: string, extensionId: string, enabled: boolean): Promise<{ success: boolean; message?: string }> {
    const d = await this.request<Record<string, unknown>>(
      "POST",
      `/apps/${encodeURIComponent(appId)}/extensions`,
      enabled ? { enabled: [extensionId] } : { disabled: [extensionId] },
    );
    const bucket = (enabled ? d?.enabled : d?.disabled) as Record<string, { success?: unknown; message?: unknown }> | undefined;
    const entry = bucket?.[extensionId];
    return {
      success: entry ? entry.success === true : true,
      ...(typeof entry?.message === "string" ? { message: entry.message } : {}),
    };
  }

  async setAiFeature(appId: string, featureKey: string, enabled: boolean): Promise<void> {
    const path = `/apps/${encodeURIComponent(appId)}/features/${encodeURIComponent(featureKey)}/enabled`;
    await this.request(enabled ? "POST" : "DELETE", path, enabled ? {} : undefined);
  }

  async getAiSettings(appId: string): Promise<Record<string, unknown> | null> {
    try {
      const d = await this.request<Record<string, unknown>>("GET", `/apps/${encodeURIComponent(appId)}/ai/settings`);
      return d && typeof d === "object" ? d : null;
    } catch (err) {
      if (err instanceof DashboardApiError && err.status === 404) return null;
      throw err;
    }
  }

  async updateAiSettings(appId: string, settings: Record<string, unknown>): Promise<void> {
    await this.request("PUT", `/apps/${encodeURIComponent(appId)}/ai/settings`, settings);
  }

  // ── REST API v3 through the dashboard's chat-api proxy ──────────────────
  // apimgmt validates the dashboard token and injects the app's region host
  // and API key server-side, so no REST API key is needed.

  /** The REST API version the app runs on (v3.0 for every current app). */
  async apiVersion(appId: string): Promise<string> {
    // Shared across clients (one is built per request): the version isn't
    // secret, and every proxied call still goes out with this user's token.
    const key = `${this.apiHost}|${appId}`;
    const cached = API_VERSIONS.get(key);
    if (cached && cached.until > Date.now()) return cached.version;
    const d = await this.request<Record<string, unknown>>("GET", `/apps/${encodeURIComponent(appId)}?includeParentApp=1`);
    const v = String(d?.version ?? "3");
    const version = v === "1" ? "v1.8" : v === "2" ? "v2.0" : "v3.0";
    if (API_VERSIONS.size >= 5_000) API_VERSIONS.clear();
    API_VERSIONS.set(key, { version, until: Date.now() + 10 * 60_000 });
    return version;
  }

  async chatApi<T>(appId: string, method: string, path: string, body?: unknown): Promise<T> {
    const version = await this.apiVersion(appId);
    return this.request<T>(method, `/apps/${encodeURIComponent(appId)}/chat-api/${version}${path}`, body);
  }

  async getAppSettings(appId: string): Promise<Record<string, unknown>> {
    const d = await this.request<unknown>("GET", `/apps/${encodeURIComponent(appId)}/settings`);
    const s = (d as { settings?: unknown } | null)?.settings ?? d;
    return s && typeof s === "object" ? (s as Record<string, unknown>) : {};
  }

  async updateAppSettings(appId: string, settings: Record<string, unknown>): Promise<void> {
    await this.request("POST", `/apps/${encodeURIComponent(appId)}/settings`, { settings });
  }

  /** Like chatApi, but also returns the response's `meta` (pagination/cursors). */
  async chatApiList(appId: string, path: string): Promise<{ data: unknown[]; meta: unknown }> {
    const version = await this.apiVersion(appId);
    const full = await this.requestFull("GET", `/apps/${encodeURIComponent(appId)}/chat-api/${version}${path}`);
    return { data: Array.isArray(full?.data) ? (full.data as unknown[]) : [], meta: full?.meta };
  }

  /** A management-API list (no chat-api proxy), with `meta`. */
  async listFull(path: string): Promise<{ data: unknown; meta: unknown }> {
    const full = await this.requestFull("GET", path);
    return { data: full?.data, meta: full?.meta };
  }

  /** Low-level call; returns the response's `data` field. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.requestFull(method, path, body))?.data as T;
  }

  /** Low-level call returning the whole body. GETs are retried once on a transient failure. */
  async requestFull(method: string, path: string, body?: unknown): Promise<{ data?: unknown; meta?: unknown } | null> {
    try {
      return await this.send(method, path, body);
    } catch (err) {
      if (method === "GET" && err instanceof DashboardUnavailableError) {
        await new Promise((r) => setTimeout(r, 400));
        return this.send(method, path, body);
      }
      throw err;
    }
  }

  /** Changing requests (anything but GET) sent so far, so callers can tell whether a change may have reached CometChat. */
  writesSent = 0;

  private async send(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<{ data?: unknown; meta?: unknown } | null> {
    if (method !== "GET") this.writesSent++;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiHost}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // A change that timed out may still have been made: retrying blindly
      // creates duplicates (apps, keys, webhooks), so say so.
      throw new DashboardUnavailableError(
        method === "GET"
          ? undefined
          : "The CometChat dashboard API didn't answer in time. The change may still have been made: check (for example with the matching list tool) before trying again.",
      );
    }
    const parsed = await readJson(res);
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new DashboardAuthError();
    }
    if (!res.ok) {
      const { code, message } = errorOf(parsed);
      if (res.status >= 500) throw new DashboardUnavailableError(`The CometChat dashboard API failed (${res.status} ${code}). Retry shortly.`);
      throw new DashboardApiError(res.status, code, message);
    }
    return parsed && typeof parsed === "object" ? (parsed as { data?: unknown; meta?: unknown }) : null;
  }
}

function toApp(e: Record<string, unknown>): DashboardApp {
  const appId = String(e.appId ?? e.id ?? "");
  const meta = e.metadata && typeof e.metadata === "object" ? (e.metadata as Record<string, unknown>) : {};
  const features = typeof meta.features === "string" ? meta.features : undefined;
  const product =
    typeof meta.product === "string"
      ? meta.product
      : features === "chat"
        ? "chat-messaging"
        : features === "calling"
          ? "voice-video"
          : features === "aiAgent"
            ? "ai-agent"
            : features;
  const created = e.createdAt ?? e.created_at;
  const createdAt = typeof created === "number" ? created : typeof created === "string" ? Number(new Date(created)) || undefined : undefined;
  return {
    appId,
    name: String(e.name ?? appId),
    region: String(e.region ?? "us"),
    ...(typeof e.plan === "string" ? { plan: e.plan } : {}),
    ...(product ? { product } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

// A row of the app's installed extensions. `enabled` (0/1) is this app's
// state; `isActive` is the extension's global availability flag and comes on
// every row, so it must not count as "on" (it made every disable read back as
// still on). Disabled rows stay in the list with enabled: 0.
function isEnabled(e: Record<string, unknown>): boolean {
  if (e.enabled !== undefined && e.enabled !== null) return e.enabled === 1 || e.enabled === true || e.enabled === "1";
  return e.status === "enabled";
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorOf(body: unknown): { code: string; message: string } {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string") return { code: err, message: err };
    const e = err as { code?: string; message?: string; details?: unknown } | undefined;
    // Validation errors carry per-field reasons in `details`; include them so the agent can fix the call.
    const details =
      e?.details && typeof e.details === "object"
        ? Object.entries(e.details as Record<string, unknown>)
            .map(([field, reasons]) => `${field}: ${Array.isArray(reasons) ? reasons.join("; ") : String(reasons)}`)
            .join(" | ")
            .slice(0, 400)
        : "";
    const message = e?.message ?? "The dashboard rejected the request.";
    return { code: e?.code ?? "UNKNOWN", message: details ? `${message} (${details})` : message };
  }
  return { code: "UNKNOWN", message: typeof body === "string" && body ? body.slice(0, 200) : "The dashboard rejected the request." };
}
