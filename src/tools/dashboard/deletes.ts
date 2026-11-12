// Deleting things in an app: users, groups, messages, sign-in tokens, API keys,
// webhooks, roles, moderation lists and rules, push providers. Never apps.
//
// Every delete here can't be undone, so each one needs the user's approval in
// the browser on the hosted server (`confirm: true` on a local connection).
// Revoking sign-in tokens only logs a user out, so it needs `confirm` alone.
// Where the API would report success for something that doesn't exist (push
// providers) or would delete something built in, `check` refuses first, so the
// user is never asked to approve a delete that can't do what it says.
import { DashboardApiError, DashboardAuthError, ValidationError, asStructured } from "../../lib/errors.js";
import type { DashboardClient } from "../../dashboard/client.js";
import { APP_ID, appOutput, bool, defineTool, identifier, identifiers, objectSchema, appId, oneOf, str } from "./registry.js";

const FAILED = {
  type: "array",
  items: { type: "object", properties: { id: str("What wasn't deleted"), error: str("Why") }, required: ["id", "error"], additionalProperties: false },
  description: "What wasn't deleted; tell the user",
} as const;

/**
 * Auth tokens look like `<uid>_<digits><hex>`. A value made only of dots is a
 * path segment (`.`, `..`) that fetch would resolve, moving the request off
 * /auth_tokens/{token} (`..` lands on DELETE /users/{uid}), so it never passes.
 */
const TOKEN_RE = /^(?!\.+$)[A-Za-z0-9_.-]{1,255}$/;
const MESSAGE_ID_RE = /^\d{1,20}$/;

function token(a: Record<string, unknown>, field: string): string {
  const v = a[field];
  if (typeof v !== "string" || !TOKEN_RE.test(v)) throw new ValidationError(field, "must be an auth token (letters, numbers, _ . -)");
  return v;
}

async function moderationEntry(client: DashboardClient, app: string, kind: "keywords" | "rules", id: string): Promise<Record<string, unknown>> {
  const { data } = await client.listFull(`/apps/${encodeURIComponent(app)}/moderation/${kind}?limit=50`);
  const hit = (Array.isArray(data) ? data : []).find((x) => String((x as Record<string, unknown>).id ?? "") === id) as Record<string, unknown> | undefined;
  const what = kind === "keywords" ? "moderation list" : "moderation rule";
  const field = kind === "keywords" ? "list_id" : "rule_id";
  if (!hit) throw new ValidationError(field, `no ${what} ${id} on app ${app} (see cometchat_list_moderation_${kind === "keywords" ? "lists" : "rules"})`);
  if (hit.default === true) throw new ValidationError(field, `${id} is a built-in ${what}; built-in ones can't be deleted (turn a rule off with cometchat_set_moderation_rule instead)`);
  return hit;
}

/**
 * After a moderation delete: refuses to report success while the list or rule
 * is still listed. A failed read never turns a completed delete into an error.
 */
async function moderationGone(client: DashboardClient, app: string, kind: "keywords" | "rules", id: string): Promise<void> {
  let listed: boolean;
  try {
    const { data } = await client.listFull(`/apps/${encodeURIComponent(app)}/moderation/${kind}?limit=50`);
    listed = (Array.isArray(data) ? data : []).some((x) => String((x as Record<string, unknown>).id ?? "") === id);
  } catch {
    return;
  }
  if (listed) {
    throw new DashboardApiError(502, "delete_not_applied", `CometChat reported moderation ${kind === "keywords" ? "list" : "rule"} ${id} deleted, but it's still listed on app ${app}. Nothing else was changed; check it in the dashboard (Moderation).`);
  }
}

export const DELETE_TOOLS = [
  defineTool({
    name: "cometchat_delete_users",
    title: "Delete users permanently",
    description:
      "Permanently deletes users with their messages and conversations. To only stop them logging in use cometchat_set_users_active.",
    inputSchema: objectSchema({ app_id: APP_ID, uids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25, description: "User IDs" } }, ["app_id", "uids"]),
    outputSchema: appOutput({ deleted: { type: "array", items: { type: "string" }, description: "Users deleted" }, failed: FAILED }, ["deleted"]),
    access: "write",
    approval: true,
    describe: (a) => `Permanently delete user${Array.isArray(a.uids) && a.uids.length === 1 ? "" : "s"} ${Array.isArray(a.uids) ? a.uids.join(", ") : "?"} and all their messages on app ${String(a.app_id)}. This can't be undone.`,
    check(a) {
      appId(a);
      identifiers(a, "uids", 25);
    },
    async run(a, { client }) {
      const id = appId(a);
      const uids = identifiers(a, "uids", 25);
      // One call per user, so a failure part-way still reports who was deleted.
      const deleted: string[] = [];
      const failed: { id: string; error: string }[] = [];
      for (const uid of uids) {
        try {
          await client.chatApi(id, "DELETE", `/users/${encodeURIComponent(uid)}`, { permanent: true });
          deleted.push(uid);
        } catch (err) {
          if (err instanceof DashboardAuthError) {
            if (deleted.length === 0) throw err;
            throw new DashboardApiError(401, "signed_out_part_way", `Deleted ${deleted.join(", ")}, then the CometChat sign-in ended before ${uid}; nothing after that was deleted. Sign in again to finish.`);
          }
          failed.push({ id: uid, error: asStructured(err).message });
          continue;
        }
        // Permanent means gone: if the user can still be read, the delete only deactivated them.
        if (await stillThere(client, id, `/users/${encodeURIComponent(uid)}`)) {
          deleted.pop();
          failed.push({ id: uid, error: "CometChat accepted the delete but the user still exists (possibly only deactivated); check and delete them in the dashboard" });
        }
      }
      if (deleted.length === 0) throw new DashboardApiError(400, "delete_failed", `No users were deleted: ${failed.map((f) => `${f.id} (${f.error})`).join("; ")}`);
      return { app_id: id, deleted, ...(failed.length ? { failed } : {}) };
    },
  }),
  defineTool({
    name: "cometchat_delete_group",
    title: "Delete a group",
    description: "Permanently deletes a group, its members list and its messages. To remove one person use cometchat_remove_group_member.",
    inputSchema: objectSchema({ app_id: APP_ID, guid: str("Group ID") }, ["app_id", "guid"]),
    outputSchema: appOutput({ guid: str("Group ID"), deleted: bool("Always true when the call succeeds") }, ["guid", "deleted"]),
    access: "write",
    approval: true,
    describe: (a) => `Delete group ${String(a.guid)} and its messages on app ${String(a.app_id)}. This can't be undone.`,
    check(a) {
      appId(a);
      identifier(a, "guid");
    },
    async run(a, { client }) {
      const id = appId(a);
      const guid = identifier(a, "guid");
      await client.chatApi(id, "DELETE", `/groups/${encodeURIComponent(guid)}`);
      return { app_id: id, guid, deleted: true };
    },
  }),
  defineTool({
    name: "cometchat_delete_message",
    title: "Delete a message",
    description:
      "Deletes one message; a 'message deleted' placeholder stays unless permanent: true. The content can't be restored.",
    inputSchema: objectSchema({ app_id: APP_ID, message_id: str("Message ID (digits)"), permanent: bool("true = remove it completely; false (default) = leave a 'message deleted' placeholder") }, ["app_id", "message_id"]),
    outputSchema: appOutput({ message_id: str("Message ID"), permanent: bool("Removed completely"), deleted: bool("Always true when the call succeeds") }, ["message_id", "permanent", "deleted"]),
    access: "write",
    approval: true,
    describe: (a) => `${a.permanent === true ? "Permanently remove" : "Delete"} message ${String(a.message_id)} on app ${String(a.app_id)}. This can't be undone.`,
    check(a) {
      appId(a);
      if (typeof a.message_id !== "string" || !MESSAGE_ID_RE.test(a.message_id)) throw new ValidationError("message_id", "must be a message ID (digits)");
      if (a.permanent !== undefined && typeof a.permanent !== "boolean") throw new ValidationError("permanent", "must be true or false");
    },
    async run(a, { client }) {
      const id = appId(a);
      const messageId = String(a.message_id);
      if (!MESSAGE_ID_RE.test(messageId)) throw new ValidationError("message_id", "must be a message ID (digits)");
      const permanent = a.permanent === true;
      await client.chatApi(id, "DELETE", `/messages/${messageId}`, { permanent });
      if (permanent && (await stillThere(client, id, `/messages/${messageId}`))) {
        throw new DashboardApiError(502, "not_permanent", `Message ${messageId} was deleted but is still stored (only marked deleted); remove it in the dashboard to delete it permanently.`);
      }
      return { app_id: id, message_id: messageId, permanent, deleted: true };
    },
  }),
  defineTool({
    name: "cometchat_revoke_auth_tokens",
    title: "Revoke a user's auth tokens",
    description:
      "Revokes a user's auth tokens (all, or the one auth_token given), so they must sign in with a new token. The user and their data are kept.",
    inputSchema: objectSchema({ app_id: APP_ID, uid: str("User ID"), auth_token: str("Only this token (optional; default: all of the user's tokens)") }, ["app_id", "uid"]),
    outputSchema: appOutput({ uid: str("User ID"), revoked: str("all, one, or none (the user had no tokens)") }, ["uid", "revoked"]),
    access: "write",
    confirm: true,
    describe: (a) => `Revoke ${a.auth_token ? "one auth token" : "all auth tokens"} of ${String(a.uid)} on app ${String(a.app_id)} (they'll have to sign in again).`,
    check(a) {
      appId(a);
      identifier(a, "uid");
      if (a.auth_token !== undefined) token(a, "auth_token");
    },
    async run(a, { client }) {
      const id = appId(a);
      const uid = identifier(a, "uid");
      if (a.auth_token !== undefined) {
        await client.chatApi(id, "DELETE", `/users/${encodeURIComponent(uid)}/auth_tokens/${encodeURIComponent(token(a, "auth_token"))}`);
        return { app_id: id, uid, revoked: "one" };
      }
      try {
        await client.chatApi(id, "DELETE", `/users/${encodeURIComponent(uid)}/auth_tokens`);
      } catch (err) {
        // The API answers "no tokens" with a 404: nothing to revoke is not a failure.
        if (err instanceof DashboardApiError && err.apiCode === "ERR_AUTH_TOKENS_NOT_FOUND") return { app_id: id, uid, revoked: "none" };
        throw err;
      }
      return { app_id: id, uid, revoked: "all" };
    },
  }),
  defineTool({
    name: "cometchat_delete_api_key",
    title: "Delete an API key",
    description:
      "Permanently deletes an API key, given its value; anything using it stops working at once. To rotate, create the new key first.",
    inputSchema: objectSchema({ app_id: APP_ID, api_key: str("The key to delete (its value from cometchat_list_api_keys)") }, ["app_id", "api_key"]),
    outputSchema: appOutput({ name: str("Name of the deleted key"), scope: str("fullAccess or authOnly"), deleted: bool("Always true when the call succeeds") }, ["name", "scope", "deleted"]),
    access: "write",
    approval: true,
    describe: (a) => `Delete API key ${String(a.api_key)} on app ${String(a.app_id)}; anything using it stops working. This can't be undone.`,
    async check(a, { client }) {
      await existingKey(a, client);
    },
    async run(a, { client }) {
      const id = appId(a);
      const key = await existingKey(a, client);
      await client.chatApi(id, "DELETE", `/apikeys/${encodeURIComponent(String(a.api_key))}`);
      return { app_id: id, name: String(key.name ?? ""), scope: String(key.scope ?? ""), deleted: true };
    },
  }),
  defineTool({
    name: "cometchat_delete_webhook",
    title: "Delete a webhook",
    description: "Permanently deletes a webhook, so CometChat stops sending its events. Not read back: confirm with cometchat_list_webhooks.",
    inputSchema: objectSchema({ app_id: APP_ID, webhook_id: str("Webhook id") }, ["app_id", "webhook_id"]),
    outputSchema: appOutput({ webhook_id: str("Webhook id"), deleted: bool("Always true when the call succeeds") }, ["webhook_id", "deleted"]),
    access: "write",
    approval: true,
    describe: (a) => `Delete webhook ${String(a.webhook_id)} on app ${String(a.app_id)}; its URL stops getting events.`,
    check(a) {
      appId(a);
      identifier(a, "webhook_id");
    },
    async run(a, { client }) {
      const id = appId(a);
      const hookId = identifier(a, "webhook_id");
      await client.chatApi(id, "DELETE", `/webhooks/${encodeURIComponent(hookId)}`);
      return { app_id: id, webhook_id: hookId, deleted: true };
    },
  }),
  defineTool({
    name: "cometchat_delete_role",
    title: "Delete a role",
    description: "Permanently deletes a custom role ('default' is refused). Users holding it aren't reassigned: move them first with cometchat_update_user.",
    inputSchema: objectSchema({ app_id: APP_ID, role: str("Role id") }, ["app_id", "role"]),
    outputSchema: appOutput({ role: str("Role id"), deleted: bool("Always true when the call succeeds") }, ["role", "deleted"]),
    access: "write",
    approval: true,
    describe: (a) => `Delete role ${String(a.role)} on app ${String(a.app_id)}.`,
    check(a) {
      appId(a);
      if (identifier(a, "role") === "default") throw new ValidationError("role", "the built-in default role can't be deleted");
    },
    async run(a, { client }) {
      const id = appId(a);
      const role = identifier(a, "role");
      await client.chatApi(id, "DELETE", `/roles/${encodeURIComponent(role)}`);
      return { app_id: id, role, deleted: true };
    },
  }),
  defineTool({
    name: "cometchat_delete_moderation_list",
    title: "Delete a moderation keyword list",
    description: "Permanently deletes a custom keyword list; rules using it stop matching its words. Built-in lists are refused.",
    inputSchema: objectSchema({ app_id: APP_ID, list_id: str("List id") }, ["app_id", "list_id"]),
    outputSchema: appOutput({ list_id: str("List id"), deleted: bool("Always true when the call succeeds") }, ["list_id", "deleted"]),
    access: "write",
    approval: true,
    describe: (a) => `Delete moderation list ${String(a.list_id)} on app ${String(a.app_id)}; rules using it stop matching its words.`,
    async check(a, { client }) {
      await moderationEntry(client, appId(a), "keywords", identifier(a, "list_id"));
    },
    async run(a, { client }) {
      const id = appId(a);
      const listId = identifier(a, "list_id");
      // The management API, like list and create. The chat-api proxy's
      // /moderation/keywords route is plan-gated and refuses free apps.
      await client.request("DELETE", `/apps/${encodeURIComponent(id)}/moderation/keywords/${encodeURIComponent(listId)}`);
      await moderationGone(client, id, "keywords", listId);
      return { app_id: id, list_id: listId, deleted: true };
    },
  }),
  defineTool({
    name: "cometchat_delete_moderation_rule",
    title: "Delete a moderation rule",
    description: "Permanently deletes a custom moderation rule. Built-in rules can only be turned off (cometchat_set_moderation_rule).",
    inputSchema: objectSchema({ app_id: APP_ID, rule_id: str("Rule id") }, ["app_id", "rule_id"]),
    outputSchema: appOutput({ rule_id: str("Rule id"), deleted: bool("Always true when the call succeeds") }, ["rule_id", "deleted"]),
    access: "write",
    approval: true,
    describe: (a) => `Delete moderation rule ${String(a.rule_id)} on app ${String(a.app_id)}; messages stop being checked against it.`,
    async check(a, { client }) {
      await moderationEntry(client, appId(a), "rules", identifier(a, "rule_id"));
    },
    async run(a, { client }) {
      const id = appId(a);
      const ruleId = identifier(a, "rule_id");
      await client.request("DELETE", `/apps/${encodeURIComponent(id)}/moderation/rules/${encodeURIComponent(ruleId)}`);
      await moderationGone(client, id, "rules", ruleId);
      return { app_id: id, rule_id: ruleId, deleted: true };
    },
  }),
  defineTool({
    name: "cometchat_delete_push_provider",
    title: "Delete a push notification provider",
    description: "Permanently deletes an FCM or APNs provider (id from cometchat_get_push_setup); devices relying on it stop getting push. To replace an FCM one, add the new provider first (cometchat_add_fcm_provider, local connection only).",
    inputSchema: objectSchema({ app_id: APP_ID, kind: { type: "string", enum: ["fcm", "apns"], description: "fcm (Android/web) or apns (iOS)" }, provider_id: str("Provider id") }, ["app_id", "kind", "provider_id"]),
    outputSchema: appOutput({ kind: str("fcm or apns"), provider_id: str("Provider id"), deleted: bool("Always true when the call succeeds") }, ["kind", "provider_id", "deleted"]),
    access: "write",
    approval: true,
    describe: (a) => `Delete ${String(a.kind).toUpperCase()} push provider ${String(a.provider_id)} on app ${String(a.app_id)}; its devices stop getting push notifications.`,
    async check(a, { client }) {
      await existingProvider(a, client);
    },
    async run(a, { client }) {
      const id = appId(a);
      const { kind, providerId } = await existingProvider(a, client);
      await client.chatApi(id, "DELETE", `/notifications/push/v1/providers/${kind}/${encodeURIComponent(providerId)}`);
      // A failed read-back never turns the completed delete into an error.
      const after = await providerIds(client, id, kind).catch(() => [] as string[]);
      if (after.includes(providerId)) {
        throw new DashboardApiError(502, "not_deleted", `CometChat answered OK, but ${kind.toUpperCase()} provider ${providerId} is still set up; delete it in the dashboard (Notifications → Push).`);
      }
      return { app_id: id, kind, provider_id: providerId, deleted: true };
    },
  }),
];

async function existingKey(a: Record<string, unknown>, client: DashboardClient): Promise<Record<string, unknown>> {
  const id = appId(a);
  const value = a.api_key;
  if (typeof value !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(value)) throw new ValidationError("api_key", "must be an API key value from cometchat_list_api_keys");
  const keys = await client.chatApi<unknown>(id, "GET", "/apikeys?per_page=100&page=1");
  const key = (Array.isArray(keys) ? keys : []).find((k) => (k as Record<string, unknown>).apiKey === value) as Record<string, unknown> | undefined;
  if (!key) throw new ValidationError("api_key", `isn't a key on app ${id} (see cometchat_list_api_keys)`);
  return key;
}

// The API reports success for a provider id that doesn't exist, so look first.
async function existingProvider(a: Record<string, unknown>, client: DashboardClient): Promise<{ kind: "fcm" | "apns"; providerId: string }> {
  const id = appId(a);
  const kind = oneOf(a, "kind", ["fcm", "apns"] as const);
  const providerId = identifier(a, "provider_id");
  if (!(await providerIds(client, id, kind)).includes(providerId)) {
    throw new ValidationError("provider_id", `no ${kind.toUpperCase()} provider ${providerId} on app ${id} (see cometchat_get_push_setup)`);
  }
  return { kind, providerId };
}

async function providerIds(client: DashboardClient, app: string, kind: "fcm" | "apns"): Promise<string[]> {
  const d = await client.chatApi<Record<string, unknown> | null>(app, "GET", `/notifications/push/v1/providers/dashboard/${kind}`);
  const providers = Array.isArray(d?.pushProviders) ? (d!.pushProviders as Record<string, unknown>[]) : [];
  return providers.map((p) => String(p.providerId ?? p.id ?? ""));
}

/**
 * After a permanent delete: true only when the thing can still be read. The
 * delete itself succeeded, so a failed read (404, or anything else) never
 * turns it into an error.
 */
async function stillThere(client: DashboardClient, app: string, path: string): Promise<boolean> {
  try {
    await client.chatApi(app, "GET", path);
    return true;
  } catch {
    return false;
  }
}
