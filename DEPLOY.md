# Deploy

Target: `https://mcp.cometchat.com` (subdomain to confirm with DevOps).

## Container

```
docker build -t cometchat-mcp:0.1.6 .
docker run --rm -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e NODE_ENV=production \
  -e ALLOWED_HOSTS=mcp.cometchat.com \
  cometchat-mcp:0.1.6
```

The image bundles `bundles/`, `skills/`, and the compiled server. The SQLite
index is **not** bundled — mount it at `/app/data` or build it inside the
container before launch (see "Index build" below). The server still boots
without the index; `/health` will report `degraded` and the search tool will
return `backend_unavailable` per call until the index is in place.

## Index build (CI or pre-deploy)

The image ships without the SQLite index. Build the index against the latest `cometchat/docs` clone, then mount or `COPY` it into the container.

```
git clone --depth 1 https://github.com/cometchat/docs.git /tmp/cometchat-docs
DOCS_REPO=/tmp/cometchat-docs INDEX_PATH=./data/index.sqlite npm run build:index
```

The provided GitHub Actions workflow (`.github/workflows/ci.yml`) already does this and uploads the index as an artifact — wire that artifact to your deployment job.

## Refresh cadence

- Daily cron rebuild of the index against `cometchat/docs@main`.
- Optional: GitHub webhook on `push` to `cometchat/docs` triggers a rebuild + roll.

## Network

- Public HTTPS endpoint terminated at the load balancer or CDN.
- Anthropic outbound traffic originates from `160.79.104.0/21`. Allowlist explicitly if a WAF is in front.
- No inbound auth — docs are public. Per Anthropic's `none` auth-type spec, accept any incoming connection on `/mcp`.
- DNS rebinding protection is **on by default**. Set `ALLOWED_HOSTS` to the production hostname(s) the server is reachable at (comma-separated, including ports if non-standard, e.g. `mcp.cometchat.com,mcp.cometchat.com:443`). Set `DNS_REBINDING_PROTECTION=false` only if you have an upstream that already validates the `Host` header.
- Browser-based tooling (MCP Inspector, in-tab clients) needs CORS. Set `ALLOWED_ORIGINS` to the comma-separated origins you want to permit, e.g. `ALLOWED_ORIGINS=https://inspector.modelcontextprotocol.io`. With it unset, the server reflects the request's `Origin` only when DNS-rebinding protection allows it; for a tighter posture in production, always set this explicitly.

### Env vars added in 0.1.1

| Env var | Default | Notes |
|---|---|---|
| `ALLOWED_HOSTS` | `<HOST>:<PORT>,localhost:<PORT>,127.0.0.1:<PORT>` | Comma-separated `Host` allowlist. |
| `ALLOWED_ORIGINS` | _unset_ | Comma-separated CORS origin allowlist. |
| `DNS_REBINDING_PROTECTION` | `true` | Set `false` to disable. |
| `NODE_ENV` | `development` | `production` enables strict bundle loading (any malformed bundle aborts boot rather than being skipped). |
| `RATE_LIMIT_ENABLED` | `true` | Per-IP rate limit on `/mcp`. Set `false` for dev or behind an upstream limiter. |
| `RATE_LIMIT_MAX` | `120` | Max requests per window per IP. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window in ms. |

The limiter reads the client IP from `X-Forwarded-For` (first hop) when present, otherwise from the socket. In a multi-replica deploy each replica keeps its own counter — for global limits, terminate at the LB or front the replicas with a shared limiter.

## Health

- `GET /health` → `200 { status: "ok", indexReady: true, indexAgeSeconds: N, bundles: 10 }` when the SQLite index exists and at least one bundle loaded. (There is no `sessions` count: the server is stateless — see "Sessions".)
- `GET /health` → `503 { status: "degraded", indexReady: false, indexAgeSeconds: null, ... }` when the index is missing or the bundle store is empty. Use this for readiness gating: a container without an index should be marked not-ready so the load balancer doesn't route to it.
- `indexAgeSeconds` is the file mtime of the SQLite index. The daily-rebuild cadence above means a healthy production should always be under ~26 hours (~94000s). Alert above that.

## Sessions

The server is **stateless**. Each POST is handled by a fresh transport and MCP
`Server`; there is no session map and nothing is held between requests.

`Mcp-Session-Id` is still issued at `initialize` and echoed by the client, but
it is a **correlation label only** — no state hangs off it. That is what makes
the server horizontally scalable:

- **No load-balancer affinity is required.** Any replica serves any request.
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
When `HEAD` moves it sparse-clones only the `.mdx` blobs (~44 MB, ~2s), rebuilds
the index in a **child process** (~2s, ~245 MB peak, never blocking the event
loop), validates it, and hot-swaps it in.

**A bad index cannot reach traffic.** A candidate is rejected unless it clears
all of:

| Guard | Default | Catches |
|---|---|---|
| `INDEX_MIN_PAGES` | 2000 | empty or catastrophically broken build |
| `INDEX_MAX_DROP_RATIO` | 0.2 | a docs merge that silently deletes a chunk of pages |
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
`INDEX_WORK_DIR`, and ~1 GB task memory to cover the builder's peak. The work
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

`/health` reports `indexRefresh` with `docsCommit`, `builtAt`, `lastCheckedAt`,
retained `generations` and `lastRefreshOk`. The diagnostic fields — `lastError`
(sanitized, but still carrying filesystem paths and errno codes) and `poisoned`
— are withheld from the public payload and released only when a request carries
`HEALTH_DETAIL_TOKEN`, via the `x-health-token` header (preferred; query strings
end up in access logs) or `?detail=<token>`. Comparison is timing-safe and fails
closed: with no token configured the detail is unreachable. Log events:
`index_refresh_started`, `index_refresh_succeeded`, `index_refresh_rejected`,
`index_refresh_reverted`, `index_refresh_cycle_failed`.

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

- p95 tool latency > 1.5 s.
- `backend_unavailable` rate > 1% of calls.
- Sustained `unknown_bundle` calls — signal that we're missing a popular scenario.

## Rollback

The image is stateless. Roll back by pointing the load balancer at the previous tag. The index is a build artifact; an old image plus the current index works as long as schema didn't change.

## Retiring the Mintlify-generated MCP

Once `mcp.cometchat.com` is accepted into Anthropic's directory:

1. Update `mcp-server.mdx` in `cometchat/docs` to point users at the new connector.
2. Add an HTTP 301 from `cometchat.com/docs/mcp` → `mcp.cometchat.com/mcp` (or simply leave both up for one release; do not register two CometChat listings in the directory).
