# Contributing

Thanks for helping improve the CometChat MCP server.

1. Set the repo up by following [Local development](README.md#local-development) in the README — it covers the docs clone, the search index, and the dev server.
2. For anything beyond a small fix, open an issue or a draft PR first so we can agree on scope. [Contributing](README.md#contributing) lists what is in and out of scope today.
3. Run `npm run check` (lint + tests + index-refresh verification) before you push. CI runs the same gate plus the search-quality eval, so a local pass saves a round trip.
4. Keep PRs focused, and say what you changed and how you verified it.

Found a security issue? Please do **not** open a public issue or PR — follow [SECURITY.md](SECURITY.md) instead.
