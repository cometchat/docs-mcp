// The HTTP app: CORS, health, rate limiting and the stateless MCP transport.
// No listening, index loading, analytics init or signal handling (src/server.ts
// owns those), so tests drive it in-process over a real socket.
import { randomUUID } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { sanitizeRef, sanitizeSessionId } from "./lib/attribution.js";
import { logger } from "./lib/logger.js";
import type { SqliteSearchClient } from "./search/sqlite.js";
import type { BundleStore } from "./bundles/loader.js";
import type { ResourceRegistry } from "./resources/registry.js";
import { rateLimit, clientIp } from "./lib/rateLimit.js";
import { ipKeyGenerator } from "express-rate-limit";
import { capture, fingerprint, ipHash, isAnthropicEgress } from "./lib/analytics.js";
import type { IndexRefresher } from "./index/refresher.js";
import { refreshView, wantsDetail } from "./lib/health.js";
import { buildMcpServer, SERVER_VERSION } from "./mcp.js";
import { createOAuthMetadata, mcpAuthMetadataRouter, mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { dashboardBearer } from "./dashboard/bearer.js";
import { CALLBACK_NONCE, CALLBACK_PATH, DashboardOAuthProvider, DISCONNECT_PATH, POLL_PATH, SIGNIN_BROWSER_COOKIE, disconnectPage, page, sendHtml, parseRevocations, signInCallbackPath } from "./dashboard/oauth.js";
import { actorId, configureActorKey, signInActor } from "./dashboard/actor.js";
import { APPROVE_PATH, ApprovalService } from "./dashboard/approval.js";
import { approvalPage } from "./dashboard/approval-page.js";
import { DashboardClient } from "./dashboard/client.js";
import { DASHBOARD_TOOL_NAMES, READ_SCOPE, WRITE_SCOPE, type DashboardSession } from "./tools/dashboard/index.js";

const SESSION_HEADER = "mcp-session-id";

/** clientInfo + protocol version captured from the initialize request
 *  (ENG-37102): a connector install that never calls a tool is exactly
 *  `initialize` + `tools/list`, so session open must record who connected. */
interface ClientMeta {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

export interface AppDeps {
  config: Config;
  searchClient: SqliteSearchClient;
  bundleStore: BundleStore;
  resources: ResourceRegistry;
  /** Null when INDEX_AUTO_REFRESH is off; /health then omits indexRefresh. */
  refresher: IndexRefresher | null;
  /** `Host` allowlist enforced by the SDK's DNS-rebinding guard. */
  allowedHosts: string[];
  /**
   * Browser `Origin` allowlist for /mcp. Empty allows no browser origin at all;
   * requests without an Origin (every non-browser client) are unaffected.
   */
  allowedOrigins: string[];
  dnsRebindingProtection: boolean;
}

/**
 * The HTTP app on its own: no listening, index loading, analytics init or
 * signal handlers (main() owns those), so tests can drive it over a socket.
 */
export function createApp(deps: AppDeps): Express {
  const {
    config,
    searchClient,
    bundleStore,
    resources,
    refresher,
    allowedHosts,
    allowedOrigins,
    dnsRebindingProtection,
  } = deps;

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Browsers attach `Origin` to cross-origin requests; native MCP clients (the
  // SDK, IDEs, CLIs, hosted connectors calling from their own backends) send
  // none. Only an allowlisted origin gets CORS headers.
  app.use((req, res, next) => {
    res.vary("Origin");
    const origin = req.header("origin");
    if (origin !== undefined && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        `Content-Type, Authorization, ${SESSION_HEADER}, mcp-protocol-version, last-event-id`,
      );
      res.setHeader("Access-Control-Expose-Headers", SESSION_HEADER);
    }
    next();
  });

  // Withholding CORS headers stops a page reading a reply, not a request the
  // browser sends without a preflight. The MCP transport spec requires servers
  // to validate Origin, so a /mcp request carrying one that is not allowlisted
  // is refused before any handler runs, its preflight included.
  app.use("/mcp", (req, res, next) => {
    const origin = req.header("origin");
    if (origin === undefined || allowedOrigins.includes(origin)) {
      next();
      return;
    }
    sendJsonRpcError(res, 403, "Origin not allowed.");
  });

  // The SDK's OAuth endpoints (token, registration, revocation, metadata) answer
  // their own CORS preflights with cors(); a bare 204 here would leave a
  // browser-based client without Access-Control-Allow-Origin.
  const sdkOAuthPreflight = (path: string) =>
    config.dashboardEnabled && (path === "/token" || path === "/register" || path === "/revoke" || path.startsWith("/.well-known/oauth-"));
  app.use((req, res, next) => {
    if (req.method === "OPTIONS" && !sdkOAuthPreflight(req.path)) {
      res.status(204).end();
      return;
    }
    next();
  });

  // Glama connector-ownership proof (https://glama.ai/mcp/schemas/connector.json):
  // Glama polls this path on the server's domain and matches the email against
  // a Glama account to grant listing ownership.
  app.get("/.well-known/glama.json", (_req, res) => {
    res.json({
      $schema: "https://glama.ai/mcp/schemas/connector.json",
      maintainers: [{ email: "ketan.yekale@cometchat.com" }],
    });
  });

  if (config.openaiAppsChallenge) {
    // OpenAI polls this exact path and expects the configured verification
    // token as the unadorned response body before accepting the Apps domain.
    app.get("/.well-known/openai-apps-challenge", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.type("text/plain").send(config.openaiAppsChallenge);
    });
  }

  app.get("/health", (req, res) => {
    const indexReady = searchClient.isReady();
    const indexAgeSeconds = searchClient.indexAgeSeconds();
    const bundleCount = bundleStore.list().length;
    // Bundles are read from the docs on demand, so only the index gates readiness.
    const ok = indexReady;
    res.status(ok ? 200 : 503).json({
      status: ok ? "ok" : "degraded",
      service: "cometchat-mcp",
      version: SERVER_VERSION,
      indexReady,
      indexAgeSeconds,
      bundles: bundleCount,
      // Bundles are built on first use: this counts those cached with every
      // listed page in them (0 after a restart until they are asked for).
      bundlesReady: bundleStore.readyCount(),
      ...(refresher
        ? {
            indexRefresh: refreshView(
              refresher.snapshot(),
              wantsDetail(req, config.healthDetailToken),
            ),
          }
        : {}),
    });
  });

  // DASHBOARD_ON_MCP only takes effect with the dashboard itself configured.
  const dashboardOnMcpActive = config.dashboardOnMcp && config.dashboardEnabled && !!config.dashboardTokenSecret;
  if (config.dashboardOnMcp && !dashboardOnMcpActive) {
    logger.warn("dashboard_on_mcp_ignored: DASHBOARD_ON_MCP needs DASHBOARD_ENABLED=true and DASHBOARD_TOKEN_SECRET; /mcp serves the docs tools only");
  }

  if (config.rateLimitEnabled) {
    const limiter = rateLimit({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs });
    // Signed-in /mcp/dashboard traffic is limited per user after sign-in is
    // checked (many users share one egress IP, e.g. claude.ai). Before that it
    // only gets a loose per-IP cap against unauthenticated floods.
    const dashboardIpLimiter = rateLimit({ max: config.rateLimitMax * 10, windowMs: config.rateLimitWindowMs });
    // With DASHBOARD_ON_MCP, signed-in /mcp traffic counts like /mcp/dashboard:
    // a request with a token goes through the bearer check (401 unless valid),
    // then the per-user limit. Without the dashboard, a token is never checked,
    // so it must not buy the looser cap.
    const signedIn = (req: Request) => req.path === "/dashboard" || (dashboardOnMcpActive && req.headers.authorization !== undefined);
    app.use("/mcp", (req, res, next) => (signedIn(req) ? dashboardIpLimiter(req, res, next) : limiter(req, res, next)));
    logger.info(
      { max: config.rateLimitMax, windowMs: config.rateLimitWindowMs },
      "rate_limit_enabled",
    );
  }

  /**
   * STATELESS transport: a fresh transport + server per request, no session
   * map, so ANY replica can serve ANY request.
   *
   * The `Mcp-Session-Id` header is still issued on initialize and echoed by
   * the client, but it is a CORRELATION LABEL only — no state hangs off it,
   * which is what removes the load-balancer affinity requirement. A request
   * arriving without one is served normally, just unattributed.
   */
  /** Serves one MCP request; `dashboard` is set only on the signed-in endpoint. */
  async function handleMcp(req: Request, res: Response, dashboard?: DashboardSession, offerDashboardSignIn = false) {
    const body = req.body as {
      method?: string;
      params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown } };
    };
    const isInit = isInitializeRequest(req.body);
    // The SERVER owns session identity. On initialize we always mint a fresh
    // id — honouring a client-supplied one there would let a client pin a
    // single id forever, collapsing unrelated working sessions into one row in
    // the analytics. On later requests we accept the echoed id, but only if it
    // is well-formed: it is reflected in a response header and recorded in log
    // lines and PostHog, so an unvalidated value is an injection sink.
    const sessionId = isInit ? randomUUID() : sanitizeSessionId(req.header(SESSION_HEADER));

    const ip = clientIp(req);
    // Lets each account-tool audit line join to this request's other log lines.
    if (dashboard) {
      if (sessionId) dashboard.sessionId = sessionId;
      const h = ipHash(ip);
      if (h) dashboard.ipHash = h;
    }
    // ENG-37100: links we control carry ?ref=<source>. Clients send their
    // configured URL on every request, so this is present throughout.
    const ref = sanitizeRef(req.query.ref);
    const distinctId = fingerprint(ip);

    if (isInit) {
      const client: ClientMeta = {
        name: asString(body.params?.clientInfo?.name),
        version: asString(body.params?.clientInfo?.version),
        protocolVersion: asString(body.params?.protocolVersion),
      };
      // Record the install only once the transport has ACCEPTED the handshake.
      // Emitting here unconditionally would count requests the SDK rejects
      // (406 on a bad Accept, 415 on wrong Content-Type, 403 from the
      // DNS-rebinding guard) as installs, inflating the headline metric.
      res.on("finish", () => {
        if (res.statusCode >= 400) return;
        logger.info(
          { sessionId, ref, client_name: client.name, client_version: client.version },
          "session_opened",
        );
        capture(distinctId, "mcp_session_started", {
          ref,
          client_name: client.name,
          client_version: client.version,
          protocol_version: client.protocolVersion,
          is_anthropic_egress: isAnthropicEgress(ip),
          ip_hash: ipHash(ip),
          session_id: sessionId,
        });
      });
    }

    if (sessionId) res.setHeader(SESSION_HEADER, sessionId);
    // NB: the SDK still sees the incoming header (it re-reads the raw request
    // via @hono/node-server), but in stateless mode validateSession() returns
    // early without checking it, so an id the SDK never issued is ignored
    // rather than rejected. Nothing to strip.

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: dnsRebindingProtection,
      allowedHosts,
      ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
    });
    const mcpServer = buildMcpServer({
      ...(dashboard ? { dashboard } : {}),
      ...(offerDashboardSignIn ? { offerDashboardSignIn } : {}),
      config,
      searchClient,
      bundleStore,
      resources,
      attribution: { ref, sessionId: () => sessionId },
      telemetry: {
        toolCall: (info) => {
          capture(
            distinctId,
            info.status === "success" ? "mcp_tool_called" : "mcp_tool_failed",
            { ref, session_id: sessionId, ...info },
          );
        },
      },
    });

    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      frameBodylessResponses(res);
      // express.json() under Express 5 (body-parser 2) leaves req.body
      // undefined when the Content-Type is not one it parses; Express 4 set {}.
      // The SDK reads an undefined parsedBody from the raw stream itself, with
      // no size limit, after only a substring check for "application/json" —
      // so `application/jsonx` would carry any size of body past the 4mb cap.
      // {} keeps the Express 4 contract: the SDK rejects it as invalid JSON-RPC.
      await transport.handleRequest(req, res, req.body ?? {});
    } catch (err) {
      logger.error({ err }, "mcp_request_failed");
      if (!res.headersSent) sendJsonRpcError(res, 500, "Internal error handling MCP request.");
    }
  }

  // Set below when DASHBOARD_ON_MCP serves the account tools on /mcp too.
  let dashboardOnMcp: ((req: Request, res: Response) => void) | undefined;
  app.post("/mcp", (req, res) => (dashboardOnMcp ? dashboardOnMcp(req, res) : handleMcp(req, res)));

  if (config.dashboardEnabled && config.dashboardTokenSecret) {
    configureActorKey(config.dashboardActorSalt, config.dashboardTokenSecret);
    const issuerUrl = new URL(config.publicUrl);
    const resourceServerUrl = new URL("/mcp/dashboard", issuerUrl);
    const mcpResourceUrl = new URL("/mcp", issuerUrl);
    const provider = new DashboardOAuthProvider({
      secret: config.dashboardTokenSecret,
      apiHost: config.dashboardApiHost,
      dashboardHost: config.dashboardHost,
      revocations: parseRevocations(config.dashboardRevokedSignIns),
      ...(config.dashboardTokenSecretPrevious ? { previousSecrets: [config.dashboardTokenSecretPrevious] } : {}),
      resource: resourceServerUrl,
      ...(config.dashboardOnMcp ? { alsoResources: [mcpResourceUrl] } : {}),
      issuer: issuerUrl.href,
      trustedRedirectUris: config.dashboardTrustedRedirectUris.split(","),
      allowUnverifiedWrite: config.dashboardAllowUnverifiedWrite,
      readOnly: config.dashboardReadOnly,
      signInFlow: config.dashboardSignInFlow,
      clientLogos: config.dashboardClientLogos,
    });
    if (config.dashboardSignInFlow === "poll") {
      logger.info(
        { flow: "poll" },
        "dashboard_signin_poll_flow: forwarded dashboard sign-in links aren't protected until mgmt-api#935 and customer-dashboard#2602 ship; then set DASHBOARD_SIGNIN_FLOW=confirm",
      );
    }
    const approvals = config.dashboardBrowserApproval
      ? new ApprovalService({
          sealer: provider.sealer,
          secret: config.dashboardTokenSecret,
          publicUrl: config.publicUrl,
        })
      : undefined;
    // /authorize, /token, /register and the RFC 8414 / RFC 9728 metadata (no
    // /revoke: the provider has no revokeToken, so the SDK doesn't mount one).
    // The SDK rate-limits these endpoints by req.ip, which behind the load
    // balancer is the balancer's own address: every user would share one
    // bucket. Key them by the real client IP instead, like /mcp.
    const authLimit = {
      windowMs: 60_000,
      max: config.dashboardAuthRequestsPerMinute,
      keyGenerator: (req: Request) => ipKeyGenerator(clientIp(req)),
      // We read X-Forwarded-For ourselves (clientIp), so the library's
      // trust-proxy checks don't apply.
      validate: { xForwardedForHeader: false, trustProxy: false },
    };
    // RFC 9207: every authorization response carries `iss`, so say so. ChatGPT
    // then uses its stable callback (https://chatgpt.com/connector_platform_oauth_redirect;
    // any chatgpt.com address is trusted, see KNOWN_AI_HOSTS). Once this
    // is advertised, ChatGPT and Codex reject an authorization response without
    // `iss`, so it is added to the SDK's own error redirects below. Mounted before
    // the SDK router, which serves the same path without the flag.
    const asMetadata = {
      ...createOAuthMetadata({ provider, issuerUrl, serviceDocumentationUrl: new URL("https://www.cometchat.com/docs/mcp-server"), scopesSupported: [READ_SCOPE, WRITE_SCOPE] }),
      authorization_response_iss_parameter_supported: true,
    };
    app.use("/.well-known/oauth-authorization-server", metadataHandler(asMetadata));
    app.use("/authorize", (_req, res, next) => {
      const redirect = res.redirect.bind(res) as (status: number, url: string) => void;
      res.redirect = ((a: number | string, b?: string | number) => {
        const [status, url] = typeof a === "number" ? [a, String(b)] : [typeof b === "number" ? b : 302, a];
        redirect(status, withIssuer(url, issuerUrl.href));
      }) as typeof res.redirect;
      next();
    });
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        resourceServerUrl,
        scopesSupported: [READ_SCOPE, WRITE_SCOPE],
        resourceName: "CometChat",
        serviceDocumentationUrl: new URL("https://www.cometchat.com/docs/mcp-server"),
        authorizationOptions: { rateLimit: authLimit },
        tokenOptions: { rateLimit: authLimit },
        // The client secret is sealed into the client id and can't be rotated,
        // so it must not expire (the SDK default of 30 days breaks sign-in).
        clientRegistrationOptions: { rateLimit: authLimit, clientSecretExpirySeconds: 0 },
      }),
    );
    // Help page linked from the sign-in page.
    app.get(DISCONNECT_PATH, (_req, res) => {
      sendHtml(res, 200, disconnectPage(), "public, max-age=3600");
    });
    // Polled by the sign-in page until the dashboard hands back a token.
    // The sign-in page polls every 3 s; each poll calls the dashboard API, so
    // cap it per client IP (room for a few people signing in behind one NAT).
    const pollLimit = rateLimit({ max: 120, windowMs: 60_000 });
    app.get(POLL_PATH, pollLimit, async (req, res) => {
      const handle = typeof req.query.handle === "string" ? req.query.handle : "";
      const result = await provider.pollSignIn(handle);
      res.set("Cache-Control", "no-store");
      if (result.status === "redirect") {
        // The browser that loaded the sign-in page can approve this user's
        // high-risk changes later. Anyone else polling the handle gets the
        // redirect but not that cookie.
        if (approvals && result.actor && provider.isSignInBrowser(handle, req.header("cookie"))) {
          res.append("Set-Cookie", approvals.approverCookie(result.actor, result.approverTtl));
        }
        res.json({ status: "redirect", location: result.location });
        return;
      }
      res.json(result);
    });

    // The dashboard returns the browser here after the user allowed a
    // browser-bound sign-in. Only the browser that started it (cookie) and
    // received the verifier gets the code.
    const HEX64 = /^[0-9a-f]{64}$/i;
    app.get(`${CALLBACK_PATH}/:nonce`, pollLimit, async (req, res) => {
      res.set("Cache-Control", "no-store");
      const nonce = String(req.params.nonce ?? "");
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
      const verifier = typeof req.query.verifier === "string" ? req.query.verifier : "";
      // Whatever happens, this sign-in's cookie is done with.
      if (CALLBACK_NONCE.test(nonce)) {
        res.append("Set-Cookie", `${SIGNIN_BROWSER_COOKIE}=; Path=${signInCallbackPath(nonce)}; Max-Age=0; HttpOnly; SameSite=Lax`);
      }
      const fail = (status: number, title: string, text: string) =>
        sendHtml(res, status, page(title, `<h1>${title}</h1><p>${text}</p>`));
      if (!CALLBACK_NONCE.test(nonce) || !HEX64.test(sessionId) || !HEX64.test(verifier)) {
        fail(400, "This sign-in link isn't valid", "Close this tab and connect again from your AI tool.");
        return;
      }
      const result = await provider.completeBrowserSignIn(nonce, sessionId, verifier, req.header("cookie"));
      if (result.status === "redirect") {
        // This browser started the sign-in and allowed it on the dashboard, so
        // it may approve this user's high-risk changes later.
        if (approvals && result.actor) res.append("Set-Cookie", approvals.approverCookie(result.actor, result.approverTtl));
        res.redirect(302, result.location);
        return;
      }
      if (result.status === "wrong_browser") {
        fail(
          403,
          "Finish signing in where you started",
          "This sign-in was started in a different browser, so nothing was shared. If you started it, open the sign-in link from your AI tool in this browser. If you didn't, someone may have sent you their link: you can ignore it.",
        );
        return;
      }
      if (result.status === "denied") {
        fail(403, "Sign-in cancelled", "Nothing was shared. Close this tab and connect again from your AI tool if you want to.");
        return;
      }
      if (result.status === "expired" || result.status === "invalid") {
        fail(410, "This sign-in has expired", "Close this tab and connect again from your AI tool.");
        return;
      }
      fail(502, "Sign-in didn't finish", "CometChat didn't confirm this sign-in. Close this tab and connect again from your AI tool.");
    });

    if (approvals) {
      // Only this server's own page may POST: a custom header (which a
      // cross-site form can't send without a CORS preflight we never grant),
      // plus the Origin when the browser sends one. The real gate is the
      // approver cookie, which only the browser that signed in has.
      const sameSite = (req: Request): boolean =>
        req.header("x-cometchat-approve") === "1" && (req.header("origin") === undefined || req.header("origin") === issuerUrl.origin);
      const approveBody = (req: Request): unknown => (req.body && typeof req.body === "object" ? (req.body as { r?: unknown }).r : undefined);
      app.get(APPROVE_PATH, (req, res) => {
        sendHtml(res, 200, approvalPage(approvals, req.query.r));
      });
      app.post(APPROVE_PATH, pollLimit, (req, res) => {
        res.set("Cache-Control", "no-store");
        if (!sameSite(req)) {
          res.status(403).json({ status: "error", message: "Approve from the CometChat approval page." });
          return;
        }
        res.json(approvals.approveWithCookie(approveBody(req), req.header("cookie")));
      });
    }
    // A token needs dashboard:read; the 401 asks for read + write, so clients
    // that follow the WWW-Authenticate scope get write access by default.
    const bearer = dashboardBearer({
      verifier: provider,
      requiredScopes: [READ_SCOPE],
      advertisedScopes: [READ_SCOPE, WRITE_SCOPE],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    });
    const actorOf = (req: Request) =>
      signInActor(typeof req.auth?.extra?.email === "string" ? req.auth.extra.email : undefined, req.auth?.clientId ?? "");
    const perUser = config.rateLimitEnabled
      ? rateLimit({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs, keyFor: actorOf })
      : (_req: Request, _res: Response, next: () => void) => next();
    const serveSignedIn = (req: Request, res: Response) => {
      const token = req.auth?.extra?.dashboardToken;
      if (typeof token !== "string") {
        sendJsonRpcError(res, 401, "Sign in to CometChat to use this endpoint.");
        return;
      }
      const email = typeof req.auth?.extra?.email === "string" ? req.auth.extra.email : "";
      return handleMcp(req, res, {
        client: new DashboardClient({ apiHost: config.dashboardApiHost, token, onUnauthorized: () => provider.rejectDashboardToken(token) }),
        scopes: new Set(req.auth?.scopes ?? []),
        readOnly: config.dashboardReadOnly,
        local: false,
        actor: actorOf(req),
        clientRef: actorId(`client:${req.auth?.clientId ?? ""}`).slice(0, 8),
        ...(typeof req.auth?.extra?.signedInAt === "number" ? { signedInAt: req.auth.extra.signedInAt } : {}),
        writesPerMinute: config.dashboardWritesPerMinute,
        ...(approvals ? { approvals } : {}),
      });
    };
    app.post("/mcp/dashboard", bearer, perUser, serveSignedIn);

    if (config.dashboardOnMcp) {
      // /mcp is its own protected resource (RFC 9728), so clients that connect
      // to /mcp find the sign-in there and get tokens for /mcp.
      app.use(
        mcpAuthMetadataRouter({
          oauthMetadata: asMetadata,
          resourceServerUrl: mcpResourceUrl,
          scopesSupported: [READ_SCOPE, WRITE_SCOPE],
          resourceName: "CometChat",
          serviceDocumentationUrl: new URL("https://www.cometchat.com/docs/mcp-server"),
        }),
      );
      const mcpBearer = dashboardBearer({
        verifier: provider,
        requiredScopes: [READ_SCOPE],
        advertisedScopes: [READ_SCOPE, WRITE_SCOPE],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl),
      });
      dashboardOnMcp = (req, res) => {
        // A token means a signed-in client: everything, as on /mcp/dashboard.
        // No token: the docs tools as always, and the account tools are listed;
        // calling one gets the bearer's 401, which makes the client sign in.
        if (req.headers.authorization || callsDashboardTool(req.body)) {
          void mcpBearer(req, res, () => perUser(req, res, () => serveSignedIn(req, res)));
          return;
        }
        void handleMcp(req, res, undefined, true);
      };
      logger.info({ resource: mcpResourceUrl.href }, "dashboard_on_mcp_enabled");
    }
    // Stateless like /mcp: clients (Codex, for one) announce the end of a
    // session with DELETE; answer it instead of a 404 they log as an error.
    app.delete("/mcp/dashboard", bearer, (req, res) => {
      const sessionId = req.header(SESSION_HEADER);
      if (sessionId) logger.info({ sessionId }, "session_closed");
      res.status(204).end();
    });
    app.get("/mcp/dashboard", (_req, res) => {
      res.status(405).set("Allow", "POST, DELETE").json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "This server does not offer an SSE stream." },
        id: null,
      });
    });
    logger.info({ resource: resourceServerUrl.href }, "dashboard_endpoint_enabled");
  }

  // No server->client stream exists (both capabilities declare
  // listChanged:false), so there is nothing to stream. 405 is the
  // spec-sanctioned response for a server that does not offer GET.
  app.get("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST, DELETE").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "This server does not offer an SSE stream." },
      id: null,
    });
  });

  // Nothing is held server-side, so termination is a no-op the client may
  // still politely announce.
  app.delete("/mcp", (req, res) => {
    const sessionId = req.header(SESSION_HEADER);
    if (sessionId) logger.info({ sessionId }, "session_closed");
    res.status(204).end();
  });

  return app;
}

// Cap client-supplied strings before they flow into every log line and
// analytics event — clientInfo is attacker-controlled and unbounded.
function asString(v: unknown, maxLen = 200): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, maxLen) : undefined;
}

export function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function sendJsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

/**
 * Frame a bodyless MCP response with `Content-Length: 0`, never as an empty
 * chunked body.
 *
 * The SDK answers notifications and client JSON-RPC responses with
 * `new Response(null, { status: 202 })`, and @hono/node-server's own
 * fallbacks are bodyless too (400 for a Host header `new URL()` rewrites,
 * 500/504 if the handler rejects). hono writes each as
 * `writeHead(status, headers)` then `end()`. The explicit writeHead makes
 * Node fix the framing before it knows no body follows, so it picks
 * `Transfer-Encoding: chunked` and sends a zero-length chunked body — which
 * the production gateway turns into a bare 500, breaking client connect.
 *
 * Applying hono's headers with setHeader instead (what Node's writeHead does
 * internally once any header is set) defers that choice to the first write
 * or end: an empty end() gets `Content-Length: 0`, a JSON reply keeps its
 * exact length, and a streamed SSE reply stays chunked. hono's placeholder
 * `Content-Type: text/plain` is dropped when no body is sent.
 */
function frameBodylessResponses(res: Response): void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, statusCode: number, ...rest: unknown[]) {
    const headers = typeof rest[0] === "string" ? rest[1] : rest[0];
    // Node's implicit-header path re-enters as writeHead(statusCode) with no
    // headers to commit the status line; that call must pass straight through.
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
      return Reflect.apply(writeHead, this, [statusCode, ...rest]);
    }
    res.writeHead = writeHead;
    res.statusCode = statusCode;
    if (typeof rest[0] === "string") res.statusMessage = rest[0];
    for (const [name, value] of Object.entries(headers as OutgoingHttpHeaders)) {
      if (value !== undefined) res.setHeader(name, value);
    }
    return this;
  } as Response["writeHead"];

  const end = res.end;
  res.end = function (this: Response, ...args: unknown[]) {
    // No header block stored yet and no chunk: nothing was ever written.
    if (!res.headersSent && (args[0] == null || typeof args[0] === "function")) {
      res.removeHeader("content-type");
    }
    return Reflect.apply(end, this, args);
  } as Response["end"];
}

/** Whether a JSON-RPC message (or batch) calls an account tool. */
function callsDashboardTool(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => {
    const msg = m as { method?: unknown; params?: { name?: unknown } } | null;
    return msg?.method === "tools/call" && typeof msg.params?.name === "string" && DASHBOARD_TOOL_NAMES.has(msg.params.name);
  });
}

/**
 * Sets `iss` (RFC 9207) on an authorization response redirect (one with a code
 * or an error). Always overwrites: a client can register a redirect_uri that
 * already carries its own `iss` in the query.
 */
export function withIssuer(url: string, issuer: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("code") || u.searchParams.has("error")) {
      if (u.searchParams.getAll("iss").length === 1 && u.searchParams.get("iss") === issuer) return url;
      u.searchParams.delete("iss");
      u.searchParams.set("iss", issuer);
      return u.href;
    }
  } catch {
    // not a URL: leave it alone
  }
  return url;
}
