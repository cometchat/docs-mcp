// Project setup through the REST API (via the dashboard's chat-api proxy, so no
// REST API key is needed): API keys, webhooks, app settings.
import { DashboardApiError, DashboardAuthError, ValidationError, asStructured } from "../../lib/errors.js";
import type { DashboardClient } from "../../dashboard/client.js";
import { APP_ID, appOutput, bool, defineTool, identifier, listOf, num, objectSchema, appId, oneOf, requiredString, str, compact, truncate } from "./registry.js";

export const PROJECT_TOOLS = [
  defineTool({
    name: "cometchat_list_api_keys",
    title: "List an app's API keys",
    description: "Lists an app's API keys (name, scope, value); values are masked on a read-only connection. fullAccess is the REST key (server-side only), authOnly the client Auth Key. Write keys to env files; don't echo them.",
    inputSchema: objectSchema({ app_id: APP_ID }, ["app_id"]),
    outputSchema: appOutput(
      {
        keys: listOf({ properties: { name: str("Key name"), scope: str("fullAccess or authOnly"), api_key: str("The key (masked on a read-only connection). Store it in an env file; don't print it back."), created_at: num("Created (epoch seconds)") }, required: ["name", "scope", "api_key"], additionalProperties: false }),
        masked: bool("True when key values are hidden because this connection is read-only"),
      },
      ["keys", "masked"],
    ),
    access: "read",
    async run(a, { client, canWrite }) {
      const id = appId(a);
      const keys = await client.chatApi<unknown>(id, "GET", "/apikeys?per_page=100&page=1");
      return {
        app_id: id,
        keys: (Array.isArray(keys) ? keys : []).map((raw) => {
          const k = raw as Record<string, unknown>;
          const value = String(k.apiKey ?? k.key ?? "");
          // A full-access REST key can do anything through the REST API, so a
          // read-only connection must not get usable key values.
          return compact({ name: String(k.name ?? ""), scope: String(k.scope ?? ""), api_key: canWrite ? value : maskKey(value), created_at: typeof k.createdAt === "number" ? k.createdAt : undefined });
        }),
        masked: !canWrite,
      };
    },
  }),
  defineTool({
    name: "cometchat_create_api_key",
    title: "Create an API key",
    description: "Creates an API key and returns its value: fullAccess (REST, server-side env only) or authOnly (client Auth Key). Write it to an env file; don't echo it. Check cometchat_list_api_keys first.",
    inputSchema: objectSchema({ app_id: APP_ID, name: str("Key name, e.g. 'data-import' or 'backend'"), scope: { type: "string", enum: ["fullAccess", "authOnly"], description: "fullAccess = REST API key; authOnly = Auth Key" } }, ["app_id", "name", "scope"]),
    outputSchema: appOutput({ name: str("Key name"), scope: str("Scope"), api_key: str("The key. Store it server-side; don't print it back.") }, ["name", "scope", "api_key"]),
    access: "write",
    confirm: true,
    approval: true,
    describe: (a) => `Create ${a.scope === "fullAccess" ? "a REST API key (full access)" : "an Auth Key"} named "${String(a.name)}" on app ${String(a.app_id)}.`,
    async run(a, { client }) {
      const id = appId(a);
      const name = requiredString(a, "name", 100);
      const scope = oneOf(a, "scope", ["fullAccess", "authOnly"] as const);
      const d = await client.chatApi<Record<string, unknown>>(id, "POST", "/apikeys", { name, scope });
      const key = d?.apiKey ?? d?.key;
      if (typeof key !== "string") throw new ValidationError("scope", "the key was created but CometChat returned no value; check the dashboard");
      return { app_id: id, name, scope, api_key: key };
    },
  }),
  defineTool({
    name: "cometchat_list_webhook_triggers",
    title: "List webhook triggers",
    description: "Lists the event ids a webhook can subscribe to (for example message_sent), for cometchat_create_webhook.",
    inputSchema: objectSchema({ app_id: APP_ID }, ["app_id"]),
    outputSchema: appOutput({ triggers: listOf({ properties: { id: str("Trigger id"), name: str("Name"), description: str("What fires it") }, required: ["id"], additionalProperties: false }) }, ["triggers"]),
    access: "read",
    async run(a, { client }) {
      const id = appId(a);
      const triggers = await client.chatApi<unknown>(id, "GET", "/triggers?per_page=100&page=1");
      return {
        app_id: id,
        triggers: (Array.isArray(triggers) ? triggers : []).map((raw) => {
          const t = raw as Record<string, unknown>;
          return compact({ id: String(t.trigger ?? t.id ?? t.triggerId ?? ""), name: typeof t.name === "string" ? t.name : undefined, description: truncate(t.description) });
        }),
      };
    },
  }),
  defineTool({
    name: "cometchat_list_webhooks",
    title: "List an app's webhooks",
    description: "Lists an app's webhooks (up to 100): id, name, URL, enabled, and subscribed trigger ids.",
    inputSchema: objectSchema({ app_id: APP_ID }, ["app_id"]),
    outputSchema: appOutput(
      {
        webhooks: listOf({
          properties: {
            id: str("Webhook id"),
            name: str("Name"),
            url: str("Endpoint URL"),
            enabled: bool("Enabled"),
            triggers: { type: "array", items: { type: "string" }, description: "Trigger ids it's subscribed to (missing if they couldn't be read)" },
          },
          required: ["id", "url", "enabled"],
          additionalProperties: false,
        }),
      },
      ["webhooks"],
    ),
    access: "read",
    async run(a, { client }) {
      const id = appId(a);
      const hooks = await listWebhooks(client, id);
      const triggers = await mapLimit(hooks, 5, (h) => webhookTriggers(client, id, String(h.id ?? "")).catch((err) => {
        if (err instanceof DashboardAuthError) throw err;
        return undefined; // one unreadable webhook doesn't hide the rest
      }));
      return {
        app_id: id,
        webhooks: hooks.map((h, i) =>
          compact({ id: String(h.id ?? ""), name: typeof h.name === "string" ? h.name : undefined, url: String(h.webhookURL ?? h.url ?? ""), enabled: h.enabled === true || h.enabled === 1, triggers: triggers[i] }),
        ),
      };
    },
  }),
  defineTool({
    name: "cometchat_create_webhook",
    title: "Create a webhook",
    description: "Creates a webhook that POSTs events, including message content, to an HTTPS URL, for trigger ids from cometchat_list_webhook_triggers. Prefer Basic Auth. Returns the triggers actually attached.",
    inputSchema: objectSchema(
      {
        app_id: APP_ID,
        id: str("Unique webhook id, e.g. 'backend-sync' (letters, numbers, - and _)"),
        name: str("Display name"),
        url: str("HTTPS endpoint that receives the events"),
        triggers: { type: "array", items: { type: "string" }, minItems: 1, description: "Trigger ids from cometchat_list_webhook_triggers, e.g. message_sent" },
        username: str("Basic Auth username (optional)"),
        password: str("Basic Auth password (optional)"),
        retry_on_failure: bool("Retry failed deliveries (default true)"),
      },
      ["app_id", "id", "name", "url", "triggers"],
    ),
    outputSchema: appOutput(
      {
        id: str("Webhook id"),
        url: str("Endpoint URL"),
        triggers: { type: "array", items: { type: "string" }, description: "Triggers attached, as read back from CometChat" },
        failed_triggers: listOf({ properties: { id: str("Trigger id"), error: str("Why it wasn't attached") }, required: ["id", "error"], additionalProperties: false }),
        basic_auth: bool("Basic Auth on"),
      },
      ["id", "url", "triggers", "basic_auth"],
    ),
    access: "write",
    confirm: true,
    approval: true,
    describe: (a) => `Create webhook ${String(a.id)}: send events (${Array.isArray(a.triggers) ? a.triggers.join(", ") : "?"}) from app ${String(a.app_id)} to ${String(a.url)}.`,
    async check(a, { client }) {
      const { id, hookId, triggers } = webhookInput(a);
      const [hooks, known] = await Promise.all([listWebhooks(client, id), triggerIds(client, id)]);
      if (hooks.some((h) => String(h.id ?? "") === hookId)) {
        throw new ValidationError("id", `is already used by another webhook on this app (${hookId}); pick a new id`);
      }
      const unknown = triggers.filter((t) => !known.has(t));
      if (unknown.length > 0) {
        throw new ValidationError("triggers", `has unknown trigger id${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; use ids from cometchat_list_webhook_triggers (for example message_sent)`);
      }
    },
    async run(a, { client }) {
      const { id, hookId, name, url, triggers, username, password } = webhookInput(a);
      await client.chatApi(id, "POST", "/webhooks", {
        id: hookId,
        name,
        webhookURL: url,
        enabled: true,
        retryOnFailure: a.retry_on_failure !== false,
        useBasicAuth: !!username,
        ...(username ? { username, password } : {}),
      });
      const failed: Array<{ id: string; error: string }> = [];
      const confirmed: string[] = [];
      try {
        // Per-trigger results: { message_sent: { success: true }, nope: { success: false, message } }.
        const res = await client.chatApi<Record<string, unknown> | null>(id, "POST", `/webhooks/${encodeURIComponent(hookId)}/triggers`, { triggerIds: triggers });
        for (const t of triggers) {
          const r = res?.[t] as { success?: unknown; message?: unknown } | undefined;
          if (r?.success === true) confirmed.push(t);
          else if (r && r.success === false) failed.push({ id: t, error: typeof r.message === "string" ? r.message : "not attached" });
        }
      } catch (err) {
        if (err instanceof DashboardAuthError) throw err;
        throw triggersFailed(hookId, asStructured(err).message);
      }
      // What CometChat actually stored, not what was asked for. If that read
      // fails, fall back to the per-trigger results of the request above.
      let attached: string[];
      try {
        attached = await webhookTriggers(client, id, hookId);
      } catch (err) {
        if (err instanceof DashboardAuthError) throw err;
        attached = confirmed; // only what CometChat said it attached
      }
      for (const t of triggers) {
        if (!attached.includes(t) && !failed.some((f) => f.id === t)) failed.push({ id: t, error: "not attached" });
      }
      if (attached.length === 0) throw triggersFailed(hookId, failed.map((f) => `${f.id}: ${f.error}`).join("; ") || "none were attached");
      return compact({ app_id: id, id: hookId, url, triggers: attached, failed_triggers: failed.length > 0 ? failed : undefined, basic_auth: !!username });
    },
  }),
  defineTool({
    name: "cometchat_get_app_settings",
    title: "Get an app's settings",
    description: "Returns an app's settings as key/value pairs (for example core.notifications.push.enabled). Read it before cometchat_update_app_settings. Extensions and AI features are in cometchat_list_features.",
    inputSchema: objectSchema({ app_id: APP_ID }, ["app_id"]),
    outputSchema: appOutput({ settings: { type: "object", description: "Setting key → value" } }, ["settings"]),
    access: "read",
    async run(a, { client }) {
      const id = appId(a);
      return { app_id: id, settings: await client.getAppSettings(id) };
    },
  }),
  defineTool({
    name: "cometchat_update_app_settings",
    title: "Update app settings",
    description: "Overwrites the given app settings (up to 50 keys); the rest keep their values. Keep each value's type: CometChat doesn't check it. Returns the keys sent, not a read-back.",
    inputSchema: objectSchema({ app_id: APP_ID, settings: { type: "object", description: "Setting key → new value (string, number or boolean)", additionalProperties: { type: ["string", "number", "boolean"] } } }, ["app_id", "settings"]),
    outputSchema: appOutput({ updated: { type: "array", items: { type: "string" }, description: "Keys that were set" } }, ["updated"]),
    access: "write",
    confirm: true,
    approval: true,
    describe: (a) => `Change ${Object.entries((a.settings as Record<string, unknown>) ?? {}).map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join(", ")} on app ${String(a.app_id)}.`,
    async run(a, { client }) {
      const id = appId(a);
      const s = a.settings;
      if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).length === 0 || Object.keys(s).length > 50) {
        throw new ValidationError("settings", "must be an object of 1-50 setting → value pairs");
      }
      for (const [k, v] of Object.entries(s)) {
        if (!/^[A-Za-z0-9_.-]{1,200}$/.test(k)) throw new ValidationError("settings", `has an invalid key: ${k.slice(0, 50)}`);
        if (!["string", "number", "boolean"].includes(typeof v)) throw new ValidationError("settings", `${k} must be a string, number or boolean`);
      }
      await client.updateAppSettings(id, s as Record<string, unknown>);
      return { app_id: id, updated: Object.keys(s) };
    },
  }),
];

/** create_webhook's arguments, checked; shared by its pre-approval check and its run. */
function webhookInput(a: Record<string, unknown>) {
  const id = appId(a);
  const hookId = identifier(a, "id");
  const name = requiredString(a, "name", 100);
  const url = requiredString(a, "url", 2000);
  if (!/^https:\/\/[^\s]+$/.test(url)) throw new ValidationError("url", "must be an https:// URL");
  const triggers = a.triggers;
  if (!Array.isArray(triggers) || triggers.length === 0 || triggers.length > 100 || !triggers.every((x) => typeof x === "string" && /^[a-z0-9_]{1,100}$/.test(x))) {
    throw new ValidationError("triggers", "must be a non-empty list of trigger ids");
  }
  const username = typeof a.username === "string" && a.username ? a.username : undefined;
  const password = typeof a.password === "string" && a.password ? a.password : undefined;
  if (!!username !== !!password) throw new ValidationError("password", "username and password go together");
  return { id, hookId, name, url, triggers: triggers as string[], username, password };
}

// ── webhook helpers ────────────────────────────────────────────────────────

/**
 * An app's webhooks. The webhooks endpoint pages with `perPage` and ignores
 * `per_page` (it then returns 10), so send both.
 */
async function listWebhooks(client: DashboardClient, app: string): Promise<Record<string, unknown>[]> {
  const hooks = await client.chatApi<unknown>(app, "GET", "/webhooks?perPage=100&per_page=100&page=1");
  return (Array.isArray(hooks) ? hooks : []) as Record<string, unknown>[];
}

/** Ids of the triggers a webhook can subscribe to. */
async function triggerIds(client: DashboardClient, app: string): Promise<Set<string>> {
  const triggers = await client.chatApi<unknown>(app, "GET", "/triggers?perPage=100&per_page=100&page=1");
  return new Set((Array.isArray(triggers) ? triggers : []).map((t) => String((t as Record<string, unknown>).trigger ?? (t as Record<string, unknown>).id ?? (t as Record<string, unknown>).triggerId ?? "")));
}

/** The trigger ids one webhook is subscribed to. */
async function webhookTriggers(client: DashboardClient, app: string, hookId: string): Promise<string[]> {
  const t = await client.chatApi<unknown>(app, "GET", `/webhooks/${encodeURIComponent(hookId)}/triggers?perPage=100&per_page=100&page=1`);
  return (Array.isArray(t) ? t : []).map((x) => String((x as Record<string, unknown>).id ?? (x as Record<string, unknown>).trigger ?? (x as Record<string, unknown>).triggerId ?? "")).filter(Boolean);
}

/** The webhook exists but listens to nothing: say so instead of a bare error. */
function triggersFailed(hookId: string, why: string) {
  return new DashboardApiError(
    400,
    "webhook_triggers_failed",
    `Webhook ${hookId} was created but its triggers couldn't be added (${why}). It sends nothing until triggers are added; tell the user to add them in the dashboard (Webhooks → ${hookId}) or delete it with cometchat_delete_webhook and create it again.`,
  );
}

/** Runs fn over items, at most `limit` at a time, keeping order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/** A key with all but its last 4 characters hidden. */
function maskKey(v: string): string {
  return v.length > 8 ? `${"•".repeat(8)}${v.slice(-4)}` : "•".repeat(8);
}
