# Deploy

Target: `https://mcp.cometchat.com` (subdomain to confirm with DevOps).

## Container

```
docker build --target runtime -t cometchat-mcp:0.2.1 .
docker run --rm -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e NODE_ENV=production \
  -e ALLOWED_HOSTS=mcp.cometchat.com \
  cometchat-mcp:0.2.1
```

The image bundles `skills/` and the compiled server. Implementation bundles
are compiled from live docs pages on request (src/bundles/manifest.ts). The SQLite
index is **not** bundled — mount it at `/app/data` or build it inside the
container before launch (see "Index build" below). The server still boots
without the index; `/health` will report `degraded` and the search tool will
return `backend_unavailable` per call until the index is in place.

Build a mounted index with the builder of the release you run. A newer server
serves an index from an older builder, but without the search text its ranking
relies on: 0.1.7 on a 0.1.6 index has no search keywords ("unsend", "blue
ticks"), title keys or code languages, and logs `sqlite_index_outdated` at warn,
naming the missing columns, when it opens one.

## Index build (CI or pre-deploy)

The image ships without the SQLite index. Build the index against the latest `cometchat/docs` clone, then mount or `COPY` it into the container.

```
git clone --depth 1 https://github.com/cometchat/docs.git /tmp/cometchat-docs
DOCS_REPO=/tmp/cometchat-docs INDEX_PATH=./data/index.sqlite npm run build:index
```

The provided GitHub Actions workflow (`.github/workflows/ci.yml`) already does this and uploads the index as an artifact — wire that artifact to your deployment job.

### Search ranking eval

`npm run eval:search` scores ranking against the golden queries in `scripts/eval-search.ts` (`INDEX_PATH` is the index; with `DOCS_REPO` set it first checks that every page a case names exists). It exits 1 when a check fails, 2 when a case names a missing page, and 3 when the index cannot be scored at all (missing, or built by an older release that lacks this release's columns).

CI runs it as the `search-eval` job in `ci.yml`, on the `cometchat/docs` commit pinned in `.github/eval-docs-commit`: a blobless, sparse checkout of the top-level files, `*.mdx` and `*.md`, as the Dockerfile clones it, then an index build and the eval. **A workflow job blocks a merge only once it is a required status check**, which lives in GitHub settings, not in this repository: add `search-eval` (with `test` and `index-refresh`) under Settings → Branches → the `main` protection rule, or the job goes red without stopping anything. A docs change therefore never fails a pull request. `search-eval-drift.yml` runs the same eval against docs `main` every day, gating nothing, and its job summary says whether main has drifted: exit 2 means a case names a page main moved or removed, exit 1 that a check fails on main's docs. Update the cases and bump the pin in the same change.

## Refresh cadence

- Daily cron rebuild of the index against `cometchat/docs@main`.
- Optional: GitHub webhook on `push` to `cometchat/docs` triggers a rebuild + roll.

## Network

- Public HTTPS endpoint terminated at the load balancer or CDN.
- Anthropic outbound traffic originates from `160.79.104.0/21`. Allowlist explicitly if a WAF is in front.
- No inbound auth for the docs tools — docs are public. Per Anthropic's `none` auth-type spec, accept any incoming connection on `/mcp`. With `DASHBOARD_ENABLED=true` (and `DASHBOARD_ON_MCP` not `false`), `/mcp` also lists the account tools and answers a call to one without a token with a 401 that starts sign-in.
- DNS rebinding protection is **on by default**. Set `ALLOWED_HOSTS` to the production hostname(s) the server is reachable at (comma-separated, including ports if non-standard, e.g. `mcp.cometchat.com,mcp.cometchat.com:443`). Set `DNS_REBINDING_PROTECTION=false` only if you have an upstream that already validates the `Host` header.
- Browser origins are refused by default. Browsers attach an `Origin` header; native MCP clients (IDEs, CLIs, the SDK, and hosted connectors that call from their own backends, such as Claude's from the range above) send none and are unaffected. A `/mcp` request whose `Origin` is not listed in `ALLOWED_ORIGINS` gets `403`, preflights included, and only listed origins get CORS headers. To use a client that connects straight from a browser page (MCP Inspector in direct mode, an in-tab client), set `ALLOWED_ORIGINS` to its exact origins, comma-separated, e.g. `ALLOWED_ORIGINS=http://localhost:6274`. Matching is exact on scheme, host and port, with no wildcard.

### Env vars added in 0.1.1

| Env var | Default | Notes |
|---|---|---|
| `ALLOWED_HOSTS` | `<HOST>:<PORT>,localhost:<PORT>,127.0.0.1:<PORT>` | Comma-separated `Host` allowlist. |
| `ALLOWED_ORIGINS` | _unset_ | Comma-separated browser `Origin` allowlist for `/mcp`. Unset allows no browser origin (`403`); requests without an `Origin` are unaffected. |
| `DNS_REBINDING_PROTECTION` | `true` | Set `false` to disable. |
| `NODE_ENV` | `development` | Standard Node.js setting (Express production mode); set `production` in containers. |
| `OPENAI_APPS_CHALLENGE` | _unset_ | OpenAI Apps domain-verification token. When set, `/.well-known/openai-apps-challenge` returns this exact value as plain text; when unset, the route is absent. |
| `RATE_LIMIT_ENABLED` | `true` | Per-IP rate limit on `/mcp`. Set `false` for dev or behind an upstream limiter. Exactly `true` or `false`; any other value fails startup. |
| `RATE_LIMIT_MAX` | `120` | Max requests per window per IP. A positive integer: `0` or a non-number fails startup rather than silently switching the limiter off (use `RATE_LIMIT_ENABLED=false`). |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window in ms. A positive integer. |

The limiter reads the client IP from the rightmost `X-Forwarded-For` hop when present, otherwise from the socket. That hop is the one our own proxy appends, so a client cannot forge it; this assumes exactly one trusted proxy in front (see the client-IP note under analytics below). In a multi-replica deploy each replica keeps its own counter — for global limits, terminate at the LB or front the replicas with a shared limiter.

## Dashboard tools (optional, off by default)

`/mcp` is the only endpoint clients use. With the dashboard on, it also serves account tools behind an OAuth sign-in with a CometChat account: the MCP client runs OAuth, the user signs in on app.cometchat.com, and every tool call uses that user's own dashboard token. (`/mcp/dashboard` still answers for older connections but is no longer documented or listed.)

| Env var | Default | Notes |
|---|---|---|
| `DASHBOARD_ENABLED` | `false` | `true` turns on the account tools on `/mcp` and mounts `/authorize`, `/token`, `/register`, the OAuth metadata and the sign-in help page `/oauth/cometchat/disconnect` (plus the legacy `/mcp/dashboard`). |
| `DASHBOARD_ON_MCP` | same as `DASHBOARD_ENABLED` | `true` also offers the account tools on `/mcp`: the docs tools stay open, and the first account tool call asks the client to sign in. **Leave it unset (on) in production**: `/mcp` is the only endpoint we use, so `false` would hide the account tools from every client. `false` is only for a deployment that must stay docs-only on `/mcp`. |
| `DASHBOARD_TOKEN_SECRET` | — | **Secret.** Required when enabled: 32+ random characters (`openssl rand -hex 32`), **the same on every replica**. Changing it invalidates every sign-in **and every connected tool's registration** (users must remove and re-add the server), so it's not the emergency lever; see Revocation. |
| `DASHBOARD_TOKEN_SECRET_PREVIOUS` | _unset_ | Planned rotation: set the new secret above and the old one here; both are accepted for 30 days, then remove this. |
| `PUBLIC_URL` | `https://mcp.cometchat.com` | The URL clients use; the OAuth issuer. Must match the public hostname exactly or clients reject the metadata. |
| `DASHBOARD_API_HOST` | `https://apimgmt.cc-cluster-2.io` | Dashboard management API. |
| `DASHBOARD_HOST` | `https://app.cometchat.com` | Sign-in page target. |
| `DASHBOARD_READ_ONLY` | `false` | `true` offers only read tools on every connection. |
| `DASHBOARD_WRITES_PER_MINUTE` | `30` | Account changes per signed-in user per minute, per replica (`0` = unlimited). |
| `DASHBOARD_AUTH_REQUESTS_PER_MINUTE` | `30` | Requests per client IP per minute to each of `/register`, `/authorize` and `/token`, per replica. Keyed by the real client IP (rightmost `X-Forwarded-For` hop), not the load balancer's. The sign-in status poll has its own fixed cap of 120/min per IP. |
| `DASHBOARD_REVOKED_SIGN_INS` | _empty_ | Server-side cut-off list, `actor:unixSeconds,…` (see Revocation below). A malformed entry fails startup. |
| `DASHBOARD_ACTOR_SALT` | _derived from the token secret_ | **Secret.** Keys the pseudonymous `actor` ids (audit lines, revocations) so they can't be matched to an account by hashing guessed emails. 32+ random characters, the same on every replica. Set it explicitly so actor ids survive a token-secret rotation; changing it changes every actor id. |
| `DASHBOARD_TRUSTED_REDIRECT_URIS` | `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback` | Exact https callback addresses (origin + path) whose sign-ins count as a known AI tool. Loopback and known app-scheme return addresses are always known. Any other https return address, including other pages on a trusted site, is shown as **unverified** and gets read-only access. |
| `DASHBOARD_ALLOW_UNVERIFIED_WRITE` | `false` | `true` lets unverified apps ask for write access too. Not recommended. |
| `DASHBOARD_BROWSER_APPROVAL` | `true` | High-risk changes need the user's approval in the browser they signed in with (see Security properties). `false` falls back to `confirm: true` from the model; testing only. |
| `DASHBOARD_SIGNIN_FLOW` | `poll` | `poll` (works with today's dashboard): the sign-in page polls until the dashboard hands back a token. A forwarded `app.cometchat.com/login?sessionId=…` link gives the token to whoever started the sign-in, the same as `cometchat auth login` today. `confirm`: the user allows the tool on the dashboard's confirmation screen, which sends the same browser back to `/oauth/cometchat/callback/<nonce>` with a one-time verifier, and the token is released only there. Needs mgmt-api#935 (and its migration, plus `CLI_AUTH_RETURN_ORIGINS` containing `PUBLIC_URL`'s origin) and customer-dashboard#2602 released first. Switch to `confirm` once they are. |
| `DASHBOARD_CLIENT_LOGOS` | `true` | The sign-in page shows the connecting app's icon. A known app (claude.ai's connector, or the Claude, Cursor, Windsurf or Zed app links) gets our bundled icon, matched by where the sign-in returns to, never by name. Any other app that isn't unverified gets the `logo_uri` it registered. This server fetches it: https, public addresses only, pinned to the checked address, no redirects, image types only, at most 64 KB and 2.5 s including DNS, at most 8 fetches at once, cached. The page shows it inline, so the browser never contacts the logo's host. Unverified apps, and failed fetches, show the first letter of the name. `false` turns the `logo_uri` fetch off. |

### Security properties

- **Stateless.** Clients, codes and tokens are AES-256-GCM sealed with `DASHBOARD_TOKEN_SECRET`; no database. Each process only keeps, in memory, the sign-in codes it already redeemed (until they expire) and the other per-process state in *Before enabling*, item 8.
- **Token lifetimes.** Sign-in codes last 60 seconds; access tokens 1 hour; refresh tokens 30 days, **capped at the expiry of the dashboard token inside** (a JWT, 7 days today). Each refresh re-checks the dashboard token with the dashboard (`GET /me`), so a sign-in the dashboard ended early (password change, logout) is refused with `invalid_grant` and the client starts a fresh sign-in by itself. A tool call that gets a 401 from the dashboard also makes that token's next call an HTTP 401 on the same replica.
- **Accepted stateless trade-offs.** A sign-in code works once on a given process; a restart, or the second pod during a rolling update, doesn't know it was used, so within its 60 seconds it could be exchanged once more there (PKCE and the client binding still apply). A used refresh token keeps working until it expires. Both end at the dashboard token's expiry, on revocation, or when the dashboard ends the sign-in.
- **Registration.** Return addresses must be https, loopback http (`localhost`, `127.0.0.1`, `[::1]`) or an app scheme. Schemes that hand the URL to a browser or web page (`intent:`, `x-safari-https:`, `googlechrome(s):`, `microsoft-edge:`, `javascript:`, `data:`…) are refused. Client secrets never expire (they're sealed into the client id). Removing `DASHBOARD_TOKEN_SECRET_PREVIOUS` after a rotation invalidates registrations sealed with the old secret: those tools must remove and re-add the server.
- **Known AI tools.** Besides loopback, app schemes (including the Grok app's `grokbot:`) and the exact `DASHBOARD_TRUSTED_REDIRECT_URIS` callbacks, any https page on these hosts or their subdomains counts as known: `chatgpt.com`, `grok.com`, `antigravity.google`, `chat.mistral.ai`, `perplexity.ai` (default port only; matched on the host name, so lookalikes such as `chatgpt.com.evil.example` don't count; set in code, `KNOWN_AI_HOSTS`, not in `DASHBOARD_TRUSTED_REDIRECT_URIS`). Trade-off: on those sites a sign-in can return to any page, not only a callback. The metadata also advertises `authorization_response_iss_parameter_supported`, so ChatGPT uses its stable callback.
- **Unverified apps.** Anyone can register a client named "Claude". A sign-in whose return address isn't loopback, an exact `DASHBOARD_TRUSTED_REDIRECT_URIS` callback, or the app scheme of a known MCP client (`cursor:`, `vscode:`, `vscode-insiders:`, `windsurf:`, `claude:`, `zed:`, `kiro:`) or a reverse-domain scheme (`com.example.app:`), or an https page on one of the known AI tools' hosts (above), or the Grok app's `grokbot:` is marked **unverified** on the sign-in page (with the full return address) and gets read-only access, so a lookalike can't collect write access.
- **Audience and issuer.** Tokens are issued and accepted only for this server's `/mcp` (and the legacy `/mcp/dashboard`) (RFC 8707: `/authorize` with any other `resource` returns `invalid_target`). The redirect back to the client carries `iss` (RFC 9207).
- **Browser approval for high-risk changes.** `cometchat_create_webhook`, `cometchat_create_api_key`, `cometchat_create_auth_token`, `cometchat_invite_team_member`, `cometchat_update_app_settings` and `cometchat_set_openai_key` can send the app's data elsewhere or hand out access, and every `cometchat_delete_*` tool removes data for good (users, a group, a message, an API key, a webhook, a role, a moderation list or rule, a push provider), and the model sets `confirm: true` itself. `cometchat_revoke_auth_tokens` only logs a user out, so it needs `confirm: true` alone. So on the hosted endpoint they return an approval link instead. The user opens it in the browser that connected the AI tool: sign-in leaves an HttpOnly, SameSite=Strict cookie there, scoped to the approval path and issued only to the browser that loaded the sign-in page (a sign-in-browser cookie is checked on the poll). They see every argument in full, nested settings one row per key, secrets masked; a value too long to show in full can't be approved. Approving gives an 8-character code: an HMAC over the user, the tool, the exact arguments and a 5-minute window (valid 5-10 minutes), so it can't approve anything else. Each code works once per server process (with several replicas, once per replica). A browser without the cookie can't approve; there is deliberately no "sign in here to approve" fallback, because the model could drive it. Local stdio connections keep `confirm: true`.
- **Approval page limits.** Values are shown in full, one row per nested field or array element, with invisible and direction-changing characters made visible (`[U+202E]`). Fields whose names end in key, secret, token, password, auth and similar are masked (last 4 characters), so for `cometchat_set_openai_key` the user sees only the end of the new key. A change too large, too deep or with too many fields to show this way is refused. Rate limits are checked before a code is used.
- **One sign-in per browser for approvals.** The approver cookie belongs to the last account that signed in in that browser. Signing in as a second account (or starting two sign-ins at once) moves approvals to it, and the page says to use the browser connected as the right account.
- **`PUBLIC_URL` must be the address users reach.** Approval POSTs are refused when the browser's Origin isn't `PUBLIC_URL`'s origin, so serving the endpoint under another host name breaks approvals.
- **Forwarded sign-in links (known, deferred).** A dashboard sign-in link (`app.cometchat.com/login?sessionId=…`) can be sent to someone else. Today the dashboard links it to whoever opens it while signed in, with no prompt, so with the default `DASHBOARD_SIGNIN_FLOW=poll` the person who started the sign-in gets that account's token. This is the same exposure `cometchat auth login` has today; an attacker doesn't need this server for it. The fix ships later: mgmt-api#935 (one-time verifier, deny, details) and customer-dashboard#2602 (confirmation screen), then `DASHBOARD_SIGNIN_FLOW=confirm`, which releases the code only to the browser that started the sign-in and pressed Allow. The approver cookie already goes only to the browser that loaded the sign-in page.
- **Untrusted content.** Tools that return end users' names and messages say so in their descriptions, so the model treats that text as data.
- **Secret strength.** Secrets shorter than 32 characters, or with fewer than 10 distinct characters, fail startup.
- **Rate limits.** Sign-in endpoints: per client IP. Signed-in `/mcp` traffic: per signed-in user (`RATE_LIMIT_MAX` per window), with a loose per-IP cap (10×) before sign-in is checked, because many users share one egress IP (claude.ai).
- **Read-only** hides every write tool, but credentials stay readable: `cometchat_get_app_credentials` returns the Auth Key, which can create and log in users. The consent page says so.
- **Revocation (the emergency lever).** Removing the connection in the AI tool stops that tool, but a copy of the sign-in made off the device keeps working until it expires (at most 7 days), unless the user changes their password (refused at the next refresh, within an hour) or it's revoked here. The script needs the server's `DASHBOARD_ACTOR_SALT` (or `DASHBOARD_TOKEN_SECRET`) in its environment, because actor ids are keyed. Actor ids changed to keyed ids in 0.2.0, so revocation entries made before it don't match: regenerate them. To cut off sign-ins server-side, roll out `DASHBOARD_REVOKED_SIGN_INS` (comma-separated `actor:unixSeconds`): `DASHBOARD_REVOKED_SIGN_INS="<current value>" npm run revoke-sign-in -- <account email>` prints the complete new value, already validated. Their access and refresh tokens from earlier sign-ins stop working; signing in again works. The `actor` is the same pseudonymous id as in the audit log, so an actor seen there can be revoked directly. Use `*` instead of an email to cut off **everyone** without breaking tool registrations. Entries can be removed once older than 30 days. **A malformed value fails startup for the whole server, docs included**, which is why the script prints the full value rather than an entry to hand-edit.
- **HTML pages** (`/authorize`, the help page) send `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a CSP with `frame-ancestors 'none'` and a per-response script nonce.

### Audit log and alarms

Every dashboard tool call logs one line with `"audit":"dashboard_tool"` (message `dashboard_audit`): a pseudonymous `actor` (keyed, see `DASHBOARD_ACTOR_SALT`), `client` (a short hash of the connected tool), `signed_in_at`, `session_id` (joins to the `tool_invocation` and `session_opened` lines), `ip_hash` (keyed with `ANALYTICS_SALT`, so set it), `tool`, `access` (read/write), `app_id`, `target` (for writes: the ids acted on — uid, guid, feature, rule, role, message, webhook, list and push provider ids, trigger ids, the `permanent` flag, changed setting **keys**, the webhook URL's **host**, and an invitee's keyed hash and email domain), `approved_in_browser` when a browser approval was used, `outcome` (`success`, `error`, `confirmation_required`, `approval_required`, `approval_invalid`), `error_code` on errors, and `duration_ms`. Message text, names, setting values, secrets and tokens are never logged.

- **Route** these lines to the audit store (they're on stdout with the rest of the JSON logs; filter on `audit = "dashboard_tool"`). Keep them at least as long as the dashboard's own audit retention.
- **Alarm** on, per 5 minutes:
  - `error_code = "backend_unavailable"` or `"dashboard_error"` above a few percent of calls — the dashboard API is failing.
  - `error_code = "unauthorized"` spiking — sign-ins are being rejected (dashboard token change, or an attack with stolen tokens).
  - `error_code = "rate_limited"` spiking — one user or tool hammering writes.
  - `outcome = "approval_invalid"` repeating for one actor — something is guessing or replaying approval codes.
  - HTTP 429s on `/register`, `/authorize`, `/token` from the access log — someone hammering sign-in.

CloudWatch Logs Insights (staging/ECS):

```
fields @timestamp, actor, tool, app_id, outcome, error_code
| filter audit = "dashboard_tool"
| stats count(*) as calls, sum(outcome = "error") as errors by tool, error_code
| sort errors desc
```

### Before enabling

Rolling out 0.2.0 with `DASHBOARD_ENABLED` unset is safe. Turn it on only when all of these are done:

1. **Backend sign-off** on the device-login changes listed in the internal design doc (not published), and on the API surface the tools use.
2. **Security review** of the endpoint.
3. **Ingress passes the real client IP** as the rightmost `X-Forwarded-For` hop (an HTTP-mode load balancer, or PROXY protocol / `externalTrafficPolicy: Local` on Kubernetes). Check: two clients on different networks hit `/register` and the server logs show two different IPs.
4. **Secrets** created (create-only): `DASHBOARD_TOKEN_SECRET` and `DASHBOARD_ACTOR_SALT`. Audit lines routed, retention and owner agreed, alarms set.
5. **Customer docs** published: what the account connection can access, approvals, how to disconnect (README → *Account tools* is the source).
6. **Registry listing**: `server.json` describes the account tools; its only remote is `/mcp`. Publishing a GitHub release on the public repo pushes it to the MCP Registry, so publish that release only after `DASHBOARD_ENABLED=true` is live in production; otherwise the registry advertises account tools that answer "not enabled".
7. **Staging check** below passes.
8. **One replica while the dashboard tools are on.** Production and staging both run one replica (confirmed by DevOps, 2026-11-12). Some sign-in safety state is held in each process, not shared:
   - single-use approval codes and OAuth authorization codes;
   - the per-user write limit and the sign-in rate limits;
   - the dashboard tokens already seen rejected.

   With N replicas, an approval code or an authorization code could be used once on each and the write limit becomes N × the setting. Add a shared store (e.g. Redis) before raising `replicas` with `DASHBOARD_ENABLED=true`. A restart, or the brief overlap of two pods in a rolling update (`maxSurge: 1`), has the same effect for codes still in their window (60 seconds for sign-in codes, up to 10 minutes for approval codes).

### Staging check before production

1. Deploy with `DASHBOARD_ENABLED=true`, `PUBLIC_URL=https://<staging host>` and a staging-only `DASHBOARD_TOKEN_SECRET`.
2. `curl -s https://<staging host>/.well-known/oauth-authorization-server | jq '.issuer, .authorization_response_iss_parameter_supported'` — the issuer must equal `PUBLIC_URL` with a trailing `/`, and the flag must be `true` (every sign-in response carries `iss`; ChatGPT then uses its stable, trusted callback).
3. In Claude Code: `claude mcp add --transport http cometchat-staging https://<staging host>/mcp`, then `/mcp` → Authenticate, sign in, and run "who am I on CometChat?" and "list my CometChat apps".
4. Ask it to create a webhook: it must return an approval link. Open it in the same browser, approve, give the code back, and check the webhook exists. Then open a new approval link in a private window: it must refuse and tell you to use the browser you connected with. Reusing an approved code must fail.
5. Check the audit lines arrived in the audit store (with `target` and `approved_in_browser`), then remove the connection.
6. Repeat the sign-in with an SSO-only account.

### Release order

1. Deploy the server with `DASHBOARD_ENABLED=true` and pass the staging check against production.
2. Only then release the skills version that uses the account tools on `/mcp` (skills 5.2.0). Releasing the skills first breaks their credentials step.
3. Rollback: set `DASHBOARD_ENABLED=false` and redeploy. `/mcp` (docs tools) keeps working, but note that with the dashboard tools **on**, a missing secret or a malformed `DASHBOARD_REVOKED_SIGN_INS` fails startup for the whole server.

## Health

- `GET /health` → `200 { status: "ok", indexReady: true, indexAgeSeconds: N, bundles: 11, bundlesReady: N }` when the SQLite index exists. `bundles` counts the manifest; `bundlesReady` counts bundles cached with every listed page in them; a bundle missing a deleted page is still served but not counted. Bundles are built on first use, so it starts at 0 after a restart. A docs outage doesn't change readiness: cached bundles keep being served. (There is no `sessions` count: the server is stateless — see "Sessions".)
- `GET /health` → `503 { status: "degraded", indexReady: false, indexAgeSeconds: null, ... }` when the index is missing. Use this for readiness gating: a container without an index should be marked not-ready so the load balancer doesn't route to it.
- `indexAgeSeconds` is the file mtime of the SQLite index. The daily-rebuild cadence above means a healthy production should always be under ~26 hours (~94000s). Alert above that.

## Sessions

The server is **stateless**. Each POST is handled by a fresh transport and MCP
`Server`; there is no session map and nothing is held between requests.

`Mcp-Session-Id` is still issued at `initialize` and echoed by the client, but
it is a **correlation label only** — no state hangs off it. That is what makes
the server horizontally scalable:

- **No load-balancer affinity is required.** Any replica serves any request.
  The dashboard tools are the exception: run one replica while they're on (see *Before enabling*, item 8).
  Do not configure sticky sessions; they are unnecessary (and cookie-based
  stickiness would not work anyway — MCP clients are `fetch`-based and do not
  persist cookies).
- **Rolling restarts no longer drop conversations**, because no conversation
  state lives in a pod. A client's next request simply lands somewhere else.
- The id is server-minted at `initialize` and validated as a UUID on echo; a
  client-supplied value of any other shape is ignored.
- `GET /mcp` returns **405** — the server declares `listChanged: false` on both
  capabilities and sends no server-initiated messages, so there is no stream to
  offer. `DELETE /mcp` returns **204** and is a no-op.

## Logging

Structured JSON via `pino`. Log per tool invocation:

- `tool` (name)
- `duration_ms`
- `status` (`success` / error code)
- `session_id` — correlates the calls of one working session
- `client_name`, `client_version` — **stdio only.** Over HTTP these appear on
  the `session_opened` line, not on per-call lines (the `Server` handling a
  tool call never saw `initialize`); correlate on `session_id`
- `ref` — install-source attribution, captured from `?ref=<source>` on the
  connect URL (only links we control carry it; marketplace installs attribute
  via `client_name`)
- `query_length` / `path_length` / `bundle` (for the relevant tool)

## In-container index refresh (self-healing)

With `INDEX_AUTO_REFRESH=true` the server keeps its own search index current
without a redeploy. Every `INDEX_POLL_INTERVAL_MS` (default 10 min) it runs a
`git ls-remote` against the public docs repo (~1s, anonymous, no credentials).
When `HEAD` moves it sparse-clones only the `.mdx` and `.md` blobs (~44 MB, ~2s), rebuilds
the index in a **child process** (~2s, ~245 MB peak, never blocking the event
loop), validates it, and hot-swaps it in.

**A bad index cannot reach traffic.** A candidate is rejected unless it clears
all of:

| Guard | Default | Catches |
|---|---|---|
| `INDEX_MIN_PAGES` | 2000 | empty or catastrophically broken build |
| `INDEX_MAX_DROP_RATIO` | 0.2 | a docs merge that silently deletes a chunk of pages |
| docs.json navigation coverage | `INDEX_MAX_DROP_RATIO` (0.2) | a docs.json the builder cannot use (missing, unparseable, reshaped, or no longer matching page paths): every page still builds, but versions silently fall back to paths. Applies only when the served index took versions from docs.json |
| `journal_mode != wal` | — | a file that would fail on a read-only mount |
| post-swap smoke queries | — | an index that validates but cannot answer |

If the smoke queries fail *after* the swap, the server reverts to the previous
generation immediately (an in-memory reference swap on a file already on disk —
sub-second) and marks that commit poisoned so the poller stops retrying it. A
later, healthy commit is accepted normally.

**Three fallback tiers:** current generation → previous generation
(`INDEX_KEEP_GENERATIONS`, on the work volume) → the index baked into the image, which is
immutable and always present. The server therefore never depends on GitHub
being reachable at boot.

**Requirements:** `git` in the runtime image (already added), a writable
`INDEX_WORK_DIR`, and ~1 GB task memory to cover the builder's peak. The image
ships production dependencies only (`npm prune --omit=dev` in the
Dockerfile build stage); `tsx` is a production dependency because the
refresh runs the index build under it, and `tests/image-layout.test.ts`
fails if it moves back to `devDependencies`. The work
dir is the **only** writable path the task needs: the clone, the candidate
index, and the build child's `TMPDIR`/`SQLITE_TMPDIR` all live under it, because
`/tmp` is unwritable when the root filesystem is read-only (the `tsx` runner
creates an IPC socket in the temp dir and fails otherwise). On Fargate
that writable path is an **empty task volume** backed by ephemeral storage
(`volumes: [{ name: index-work }]` + a `mountPoints` entry) — Fargate does not
support the `tmpfs` container parameter, which is EC2-launch-type only. The
volume is writable while `readonlyRootFilesystem: true` still applies to the
rest of the filesystem, and it does not consume task memory.

**Fargate mounts that volume root-owned**, and does *not* inherit the image
directory's ownership the way a local Docker named volume does — so a
container running as non-root (`node`) gets `EACCES` on first use, and the
refresh never runs while `/health` still reports `ok`. The task definition
therefore includes an `init-perms` container: the same image with `user: "0"`,
which chowns the work dir to 1000:1000 and exits, with the app container
gated on it via `dependsOn: SUCCESS`. Verified on staging 2026-09-04 —
without it: `EACCES: permission denied, mkdtemp`; with it: refresh succeeds.

**Incident escape hatch:** set `DOCS_COMMIT_PIN=<good-sha>` to freeze on a known
commit, or `INDEX_AUTO_REFRESH=false` to fall back to the baked index. Both
take effect on the next deploy.

A `navigation_regression` rejection keeps the last good index serving until a
later docs commit restores the navigation, or until the next deploy rebaselines:
the deploy bakes its index from docs `HEAD`, so an intentional large navigation
change (delisting a legacy version while keeping its pages, say) applies then.
`INDEX_MAX_DROP_RATIO=1` disables both relative rules, page count and
navigation coverage; it too takes effect on the next deploy.

`/health` reports `indexRefresh` with `docsCommit`, `builtAt`, `lastCheckedAt`,
retained `generations` and `lastRefreshOk`. The diagnostic fields — `lastError`
(sanitized, but still carrying filesystem paths and errno codes) and `poisoned`
— are withheld from the public payload and released only when a request carries
`HEALTH_DETAIL_TOKEN`, via the `x-health-token` header (preferred; query strings
end up in access logs) or `?detail=<token>`. Comparison is timing-safe and fails
closed: with no token configured the detail is unreachable.

Log events: `index_refresh_started`, `index_refresh_build_finished`,
`index_refresh_succeeded` (with `pages`, `bytes` and `navPages`),
`index_refresh_rejected`, `index_refresh_reverted`, `index_refresh_cycle_failed`,
`index_refresh_commit_abandoned` (a commit whose refresh kept failing is given
up on) and `index_refresh_ref_unresolved` (`DOCS_REF` matched nothing).
`index_refresh_build_finished` summarizes the builder's stderr once per build:
`docsCommit`, `duration_ms`, `ok`, `warnings` (the count of `WARNING:` lines),
`lines` (at most 20, each at most 300 characters, stack frames dropped, and
control characters, line and paragraph separators and format characters such as
bidi and zero-width marks replaced with spaces) and `linesOmitted`; a failed
build adds `exitCode`, `signal` and `timedOut`. The builder runs under `tsx`,
which exits 128+n when the builder dies of signal n, so `signal` is also read
from that exit code: an out-of-memory kill logs `exitCode` 137 and `signal`
`SIGKILL`. It logs at `info` when the build is clean, and at `warn` when the
builder printed a `WARNING:` line (a degraded index: docs.json unusable, pages skipped for executable frontmatter, version
labels the filter cannot match) or the build failed, which also logs
`index_refresh_cycle_failed`. `index_refresh_rejected` carries `code` (such as
`page_count_regression` or `navigation_regression`), `reason`, and `candidate`
and `served` as `{pages, navPages}`, with `served` null when no index was being
served. Alert on warn-level `index_refresh_build_finished`, on
`index_refresh_rejected`, `index_refresh_reverted` and
`index_refresh_ref_unresolved`, and on `index_refresh_commit_abandoned` or a
sustained run of `index_refresh_cycle_failed`: a refresh that fails before it
builds (the `EACCES` above, a clone or `ls-remote` error) logs no build or
rejection event, while `/health` still reports `status: ok` (only
`indexRefresh.lastRefreshOk` turns false). A failed build logs both
`index_refresh_build_finished` and `index_refresh_cycle_failed`, so count it
once.

## Usage analytics (PostHog, ENG-37102)

With `POSTHOG_KEY` + `ANALYTICS_SALT` set, the server emits four events tagged
`source: "docs-mcp"`: `mcp_session_started` (emitted once the transport has
accepted the handshake, so rejected requests are not counted as installs; includes `client_name`/`client_version` from
`clientInfo`, `protocol_version`, `ref`, `is_anthropic_egress`, `ip_hash`),
`mcp_tool_called` / `mcp_tool_failed` (per call, with `tool`, `status`,
`duration_ms`, `bundle_id`, `error_code`). `distinct_id` is a salted
`mcp:`-namespaced fingerprint of the **client IP alone** — `clientInfo` exists
only in the `initialize` body and cannot be reproduced per request, and hashing
`client_version` made every client auto-update look like a new install. Person
profiles are disabled; raw IPs and search-query text are never sent.

There is **no `mcp_session_ended`**: with a stateless, multi-replica server no
single process sees a session end. Session duration and per-session call counts
are derived at query time instead (the last event *is* the end) — see
`scripts/analytics/weekly-report.sql` §3b.

**Per-call client identity is only available on stdio.** Over HTTP the
`tool_invocation` log lines and `mcp_tool_called` events carry `session_id` and
`ref` but not `client_name`/`client_version`, because the `Server` handling a
tool call never saw `initialize`. Correlate on `session_id` with
`session_opened` / `mcp_session_started` to attribute calls to a client.

- **Client split:** `client_name` distinguishes agents (claude-ai / Claude
  Code / cursor / codex / …) — enumerate values from real traffic, don't
  hardcode a match list. `is_anthropic_egress` (160.79.104.0/21) marks
  claude.ai/Desktop/API traffic, whose shared egress IPs make per-client
  dedupe impossible — report those as sessions.
- **Client IP = rightmost X-Forwarded-For hop** (shared with the rate
  limiter). Proxies append to XFF, so the last hop is the address our own
  ALB/nginx saw — the only one a client can't forge. The first hop is
  attacker-chosen and would allow minting unlimited fingerprints and spoofing
  `is_anthropic_egress`. This assumes exactly ONE trusted proxy in front;
  inserting a CDN makes the last hop the CDN's address — every client then
  collapses into one fingerprint. Verify distinct fingerprints on real
  traffic after any LB/CDN change.
- Session end is not an event. `DELETE /mcp` is a no-op and a stateless server
  never observes an abandonment, so duration and per-session call counts are
  derived at query time — the last event for a `session_id` is its end.
- Absent `POSTHOG_KEY`, everything is a no-op (local dev, stdio, tests).
- Point at the dev PostHog project first; numbers only accrue once prod has
  the key. Nothing is retroactive.
- Weekly report: runnable HogQL in
  [`scripts/analytics/weekly-report.sql`](./scripts/analytics/weekly-report.sql)
  (headline table, client split, `ref` breakdown, top bundles).

Aggregate at the platform level (Datadog, CloudWatch, etc.) and watch for:

- p95 tool latency > 1.5 s. Search runs on the event loop, and a long query of common words costs about 20 ms at `limit` 25 (0.1.7's relaxed matching scans the candidates twice when the window is full), so sustained search bursts show up as latency on every other request too.
- `backend_unavailable` rate > 1% of calls.
- Sustained `unknown_bundle` calls — signal that we're missing a popular scenario.

## Rollback

The image is stateless. Roll back by pointing the load balancer at the previous tag. The index is a build artifact (the `full` target bakes its own). An old image plus the current index works as long as the schema didn't change, or changed compatibly: 0.1.6 and 0.1.7 each serve the other's index. 0.1.6 reads the columns 0.1.7 adds as plain search text, and 0.1.7 serves a 0.1.6 index without its search fixes (see "Container").

## Retiring the Mintlify-generated MCP

Once `mcp.cometchat.com` is accepted into Anthropic's directory:

1. Update `mcp-server.mdx` in `cometchat/docs` to point users at the new connector.
2. Add an HTTP 301 from `cometchat.com/docs/mcp` → `mcp.cometchat.com/mcp` (or simply leave both up for one release; do not register two CometChat listings in the directory).
