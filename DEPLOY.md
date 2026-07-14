# Deploy

Target: `https://mcp.cometchat.com` (subdomain to confirm with DevOps).

## Container

```
docker build -t cometchat-mcp:0.1.5 .
docker run --rm -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e NODE_ENV=production \
  -e ALLOWED_HOSTS=mcp.cometchat.com \
  cometchat-mcp:0.1.5
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

- `GET /health` → `200 { status: "ok", indexReady: true, indexAgeSeconds: N, bundles: 10, sessions: N }` when the SQLite index exists and at least one bundle loaded.
- `GET /health` → `503 { status: "degraded", indexReady: false, indexAgeSeconds: null, ... }` when the index is missing or the bundle store is empty. Use this for readiness gating: a container without an index should be marked not-ready so the load balancer doesn't route to it.
- `indexAgeSeconds` is the file mtime of the SQLite index. The daily-rebuild cadence above means a healthy production should always be under ~26 hours (~94000s). Alert above that.

## Sessions

The server is stateful per the MCP Streamable HTTP spec. Each client gets its own `mcp-session-id` allocated on `initialize`, kept alive across subsequent POST/GET/DELETE on `/mcp`. Sessions are in-memory and process-local, so:

- For multi-replica deploys, configure the load balancer with **session affinity on the `mcp-session-id` header** (or sticky cookies seeded from it). Otherwise round-robin will break sessions mid-handshake.
- Rolling restarts terminate active sessions; the client (Claude) reconnects with a fresh `initialize`.

## Logging

Structured JSON via `pino`. Log per tool invocation:

- `tool` (name)
- `duration_ms`
- `status` (`success` / error code)
- `query_length` / `path_length` / `bundle` (for the relevant tool)

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
