# cometchat-mcp

First-party CometChat MCP server. Read-only tools that surface CometChat documentation and curated implementation bundles to AI agents over the Model Context Protocol.

Status: **v0.1.1 — ready for staging deployment and Anthropic connector-directory submission.**

## Tools

| Name | Purpose |
|---|---|
| `search_cometchat_docs` | Search CometChat docs (SDK guides, UI Kit, REST, OpenAPI). Returns ranked snippets with titles + URLs. Optional `version` filter. |
| `fetch_cometchat_doc_page` | Fetch a single doc page as markdown. Accepts full URL or relative path. |
| `get_cometchat_implementation_bundle` | Return a curated recipe (install, configure, code, pitfalls) for a named integration scenario. |

All three are `readOnlyHint: true`, named ≤ 64 chars, with descriptions that describe contracts (no behavioral instructions to the agent).

## Quickstart (local)

```bash
git clone https://github.com/cometchat/docs.git ../cometchat-docs-repo
npm install
DOCS_REPO=../cometchat-docs-repo npm run build:index
npm run dev
```

The server listens on `http://0.0.0.0:3000` with the MCP endpoint at `POST /mcp` and a health probe at `GET /health`.

## Inspect with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector
# add server: http://localhost:3000/mcp
```

You should see all three tools, each with `readOnlyHint: true` and a contract-only description.

## Test as a custom connector in Claude

In Claude → Settings → Connectors → Add custom connector → URL `http://localhost:3000/mcp` (or your staging URL).

Try:

- "How do I install the React UI Kit?"
- "Show me how to add presence indicators in JavaScript."
- "What's the OpenAPI shape for creating a group?"
- "Walk me through setting up CometChat in Flutter."

## Tests

```bash
npm test
```

CI runs type-check, tests, build, and search-index build against `cometchat/docs`.

## Layout

```
src/
  server.ts                 # MCP server entry, transport, tool dispatch
  tools/{search,fetch,bundle}.ts
  search/{sqlite,types}.ts  # SQLite FTS5 search client
  bundles/{loader,types}.ts # markdown bundle store
  lib/{errors,truncate,validation,logger}.ts
  config.ts                 # env-driven config (zod-validated)
bundles/                    # 10 curated markdown bundles
scripts/build-index.ts      # build SQLite FTS5 index from cometchat/docs clone
tests/                      # vitest suite
```

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind host |
| `DOCS_BASE_URL` | `https://www.cometchat.com/docs` | Used for URLs in responses + the `.md` fetch fallback |
| `INDEX_PATH` | `./data/index.sqlite` | SQLite FTS5 index location. Server still boots if missing; search returns `backend_unavailable` and `/health` is `503`. |
| `BUNDLES_DIR` | `./bundles` | Markdown bundles directory |
| `SKILLS_DIR` | `./skills` | Orientation skill (`overview.md`) directory |
| `FETCH_TIMEOUT_MS` | `5000` | Per-fetch HTTP timeout |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `NODE_ENV` | `development` | `production` makes bundle loading strict — a malformed bundle aborts boot instead of being skipped. |
| `ALLOWED_HOSTS` | `<HOST>:<PORT>,localhost:<PORT>,127.0.0.1:<PORT>` | Comma-separated `Host` header allowlist for DNS-rebinding protection. |
| `ALLOWED_ORIGINS` | _unset_ | Comma-separated CORS origin allowlist. |
| `DNS_REBINDING_PROTECTION` | `true` | Set `false` only if an upstream already validates `Host`. |
| `RATE_LIMIT_ENABLED` | `true` | Set `false` to disable per-IP rate limiting on `/mcp`. |
| `RATE_LIMIT_MAX` | `120` | Max requests per window per IP. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in ms. |

## Deployment

See [`DEPLOY.md`](./DEPLOY.md).

## Submission to the Anthropic connector directory

See [`SUBMISSION.md`](./SUBMISSION.md).

## License

Apache-2.0.
