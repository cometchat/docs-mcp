// Account tools: what @cometchat/skills-cli does (sign-in status, apps,
// credentials, features, OpenAI key).
import { DashboardApiError, ValidationError } from "../../lib/errors.js";
import { REGIONS, type Region } from "../../dashboard/client.js";
import { APP_ID, appOutput, bool, defineTool, listOf, objectSchema, appId, requiredString, str, num, compact } from "./registry.js";

/** Endpoint keys for POST/DELETE /apps/{appId}/features/{key}/enabled. They
 *  aren't in the region extension catalog, so the known set lives here. */
export const AI_FEATURES: ReadonlyArray<{ id: string; name: string }> = [
  { id: "smart-replies", name: "Smart Replies" },
  { id: "conversation-starter", name: "Conversation Starter" },
  { id: "conversation-summary", name: "Conversation Summary" },
];

const INDUSTRIES = ["edtech", "healthcare", "dating", "marketplace", "social", "community", "gaming", "fintech", "saas", "events", "media", "other"] as const;

const credentialsOutput = appOutput(
  {
    name: str("App name (create_app)"),
    region: str("Data region: us, eu or in"),
    auth_key: str("Auth Key. Development only: it ships to the browser. Don't print it back to the user."),
    env: objectSchema({ vite: str("VITE_COMETCHAT_* lines"), nextjs: str("NEXT_PUBLIC_COMETCHAT_* lines"), cra: str("REACT_APP_COMETCHAT_* lines") }, ["vite", "nextjs", "cra"]),
  },
  ["region", "auth_key", "env"],
);

function withEnv(app_id: string, region: string, auth_key: string) {
  const lines = (p: string) => `${p}COMETCHAT_APP_ID=${app_id}\n${p}COMETCHAT_REGION=${region}\n${p}COMETCHAT_AUTH_KEY=${auth_key}`;
  return { app_id, region, auth_key, env: { vite: lines("VITE_"), nextjs: lines("NEXT_PUBLIC_"), cra: lines("REACT_APP_") } };
}

function hasOpenAiKey(ai: Record<string, unknown> | null): boolean {
  return typeof ai?.openAIKey === "string" && ai.openAIKey.trim().length > 0;
}

export const ACCOUNT_TOOLS = [
  defineTool({
    name: "cometchat_whoami",
    title: "Show the signed-in CometChat account",
    description: "Returns the name and email of the signed-in CometChat account. Call it first to check the sign-in; an expired sign-in fails with 'unauthorized'.",
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({ signed_in: bool("Always true when the call succeeds"), name: str("Account name"), email: str("Account email") }, ["signed_in"]),
    access: "read",
    async run(_a, { client }) {
      const me = await client.getCurrentUser();
      return compact({ signed_in: true, name: me.name, email: me.email });
    },
  }),
  defineTool({
    name: "cometchat_list_apps",
    title: "List CometChat apps",
    description: "Lists the account's apps (App ID, name, region, plan, created), up to 100. Use it to get the app_id the other tools need. Don't create an app unless the user asks.",
    inputSchema: objectSchema({}),
    outputSchema: objectSchema(
      {
        apps: listOf({
          properties: { app_id: str("App ID"), name: str("App name"), region: str("Data region"), plan: str("Plan"), product: str("Product the app was created for"), created_at: num("Creation time as the dashboard reports it") },
          required: ["app_id", "name", "region"],
          additionalProperties: false,
        }),
        total: num("Number of apps"),
      },
      ["apps", "total"],
    ),
    access: "read",
    async run(_a, { client }) {
      const apps = await client.listApps();
      return {
        apps: apps.map((x) => compact({ app_id: x.appId, name: x.name, region: x.region, plan: x.plan, product: x.product, created_at: x.createdAt })),
        total: apps.length,
      };
    },
  }),
  defineTool({
    name: "cometchat_get_app_credentials",
    title: "Get a CometChat app's credentials",
    description: "Returns an app's App ID, region and Auth Key (client-side, development only) with env-var lines for Vite, Next.js and CRA. Write them to a gitignored env file; don't echo the key. For the REST key use cometchat_list_api_keys.",
    inputSchema: objectSchema({ app_id: APP_ID }, ["app_id"]),
    outputSchema: credentialsOutput,
    access: "read",
    async run(a, { client }) {
      const c = await client.getAppCredentials(appId(a));
      return withEnv(c.appId, c.region, c.authKey);
    },
  }),
  defineTool({
    name: "cometchat_create_app",
    title: "Create a CometChat app",
    description: "Creates a new app and returns its credentials. Only when the user asks, after confirming the name and region (the region can't change later). Can take over 15 seconds.",
    inputSchema: objectSchema(
      {
        name: str("App name, 1-100 characters"),
        region: { type: "string", enum: [...REGIONS], description: "Data region. Pick the one closest to the app's users; it can't be changed later." },
        industry: { type: "string", enum: [...INDUSTRIES], description: "Optional industry, for the dashboard's onboarding metadata." },
      },
      ["name", "region"],
    ),
    outputSchema: credentialsOutput,
    access: "write",
    async run(a, { client }) {
      const name = requiredString(a, "name", 100);
      const region = a.region;
      if (typeof region !== "string" || !REGIONS.includes(region as Region)) throw new ValidationError("region", `must be one of ${REGIONS.join(", ")}`);
      const industry = a.industry;
      if (industry !== undefined && (typeof industry !== "string" || !(INDUSTRIES as readonly string[]).includes(industry))) {
        throw new ValidationError("industry", `must be one of ${INDUSTRIES.join(", ")}`);
      }
      const c = await client.createApp({ name, region: region as Region, ...(typeof industry === "string" ? { industry } : {}) });
      return { name, ...withEnv(c.appId, c.region, c.authKey) };
    },
  }),
  defineTool({
    name: "cometchat_list_features",
    title: "List an app's features",
    description: "Lists an app's extensions with their on/off state, plus the three AI features and whether an OpenAI key is set. These ids are what cometchat_set_feature takes.",
    inputSchema: objectSchema({ app_id: APP_ID }, ["app_id"]),
    outputSchema: appOutput(
      {
        region: str("Data region"),
        openai_key_set: bool("Whether the app has an OpenAI key for AI features"),
        extensions: listOf({ properties: { id: str("Extension id for cometchat_set_feature"), name: str("Name"), enabled: bool("On for this app"), category: str("Category"), description: str("What it does") }, required: ["id", "name", "enabled"], additionalProperties: false }),
        ai_features: listOf({ properties: { id: str("AI feature id for cometchat_set_feature"), name: str("Name") }, required: ["id", "name"], additionalProperties: false }),
      },
      ["region", "openai_key_set", "extensions", "ai_features"],
    ),
    access: "read",
    async run(a, { client }) {
      const id = appId(a);
      const { region } = await client.getApp(id);
      const [extensions, ai] = await Promise.all([client.listExtensions(id, region), client.getAiSettings(id).catch(() => null)]);
      return { app_id: id, region, openai_key_set: hasOpenAiKey(ai), extensions: extensions.sort((x, y) => x.id.localeCompare(y.id)), ai_features: AI_FEATURES.map((f) => ({ ...f })) };
    },
  }),
  defineTool({
    name: "cometchat_set_feature",
    title: "Turn an app feature on or off",
    description: "Turns one extension or AI feature (id from cometchat_list_features) on or off for a live app. AI features need an OpenAI key first (cometchat_set_openai_key). For extensions, confirmed: false means check the dashboard's Extensions page.",
    inputSchema: objectSchema({ app_id: APP_ID, feature_id: str("Extension or AI feature id from cometchat_list_features"), enabled: bool("true to turn on, false to turn off") }, ["app_id", "feature_id", "enabled"]),
    outputSchema: appOutput(
      {
        feature_id: str("Feature id"),
        kind: { type: "string", enum: ["extension", "ai_feature"], description: "What kind of feature it is" },
        enabled: bool("Requested state"),
        confirmed: bool("Whether reading the app back shows the new state. false = CometChat accepted the change but it isn't visible yet; tell the user to check the dashboard."),
        message: str("CometChat's response"),
      },
      ["feature_id", "kind", "enabled", "confirmed"],
    ),
    access: "write",
    // Turning a feature off changes a live app for its users.
    confirm: true,
    describe: (a) => `Turn ${String(a.feature_id)} ${a.enabled === true ? "on" : "off"} for app ${String(a.app_id)}.`,
    async check(a, { client }) {
      const id = appId(a);
      const featureId = requiredString(a, "feature_id", 100);
      if (typeof a.enabled !== "boolean") throw new ValidationError("enabled", "must be true or false");
      if (AI_FEATURES.some((f) => f.id === featureId)) return;
      const { region } = await client.getApp(id);
      if (!(await client.listExtensions(id, region)).some((e) => e.id === featureId)) {
        throw new ValidationError("feature_id", "is not an extension or AI feature for this app. Call cometchat_list_features for valid ids.");
      }
    },
    async run(a, { client }) {
      const id = appId(a);
      const featureId = requiredString(a, "feature_id", 100);
      if (typeof a.enabled !== "boolean") throw new ValidationError("enabled", "must be true or false");
      const enabled = a.enabled;
      if (AI_FEATURES.some((f) => f.id === featureId)) {
        if (enabled && !hasOpenAiKey(await client.getAiSettings(id))) {
          throw new ValidationError("feature_id", `${featureId} needs an OpenAI key on the app first. Ask the user for one and call cometchat_set_openai_key.`);
        }
        await client.setAiFeature(id, featureId, enabled);
        return { app_id: id, feature_id: featureId, kind: "ai_feature", enabled, confirmed: true };
      }
      const { region } = await client.getApp(id);
      if (!(await client.listExtensions(id, region)).some((e) => e.id === featureId)) {
        throw new ValidationError("feature_id", "is not an extension or AI feature for this app. Call cometchat_list_features for valid ids.");
      }
      const result = await client.setExtension(id, featureId, enabled);
      if (!result.success) {
        throw new DashboardApiError(422, "EXTENSION_TOGGLE_FAILED", result.message ?? `CometChat couldn't ${enabled ? "enable" : "disable"} ${featureId}.`);
      }
      // The API reports success per extension; read the app back so the agent
      // never tells the user something changed when it didn't.
      const after = await client.listExtensions(id, region);
      const confirmed = after.find((e) => e.id === featureId)?.enabled === enabled;
      return compact({ app_id: id, feature_id: featureId, kind: "extension", enabled, confirmed, message: result.message });
    },
  }),
  defineTool({
    name: "cometchat_set_openai_key",
    title: "Set an app's OpenAI key",
    description: "Saves the OpenAI API key the app's AI features use, replacing any existing key. Only use a key the user gave you; it is never returned.",
    inputSchema: objectSchema({ app_id: APP_ID, openai_key: str("OpenAI API key, starting with sk-") }, ["app_id", "openai_key"]),
    outputSchema: appOutput({ openai_key_set: bool("Always true when the call succeeds") }, ["openai_key_set"]),
    access: "write",
    confirm: true,
    approval: true,
    describe: (a) => `Replace the OpenAI key on app ${String(a.app_id)}.`,
    async run(a, { client }) {
      const id = appId(a);
      const key = requiredString(a, "openai_key", 300);
      if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) throw new ValidationError("openai_key", "doesn't look like an OpenAI API key (sk-…)");
      const current = (await client.getAiSettings(id)) ?? {};
      await client.updateAiSettings(id, { ...current, openAIKey: key });
      return { app_id: id, openai_key_set: true };
    },
  }),
];
