# Security Policy

The CometChat MCP server has one endpoint, `/mcp`, with two kinds of tools:

- **Docs tools**: read-only. No account, API key or authentication; they serve only first-party
  CometChat documentation and curated implementation bundles.
- **Account tools** (off unless enabled): behind OAuth 2.1 sign-in with a CometChat account, on the
  same `/mcp` endpoint. The server stores nothing; sign-ins are sealed (AES-256-GCM) values held by the
  AI tool. Unverified apps get read-only access, API key values are masked on read-only connections,
  high-risk changes need approval in the user's browser, and every account action is audit-logged.
  See the README's *Account tools* section.

## Supported versions

Security fixes are provided for the latest released version. Run the most recent release.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest `0.2.x` | :white_check_mark: |
| Older          | :x:                |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or pull request.

- Preferred: **Security → Report a vulnerability** on this repository (GitHub private vulnerability reporting), **or**
- Email **support@cometchat.com** with the details.

Include the affected version, a description, reproduction steps, and the impact. We aim to
acknowledge within 3 business days and to share a remediation plan after triage.

## Scope

- **In scope:** the MCP server in this repository and its deployment at `mcp.cometchat.com`,
  including the account sign-in (`/authorize`, `/token`, `/register`, `/oauth/cometchat/*`) and the
  account tools on `/mcp`.
- **Out of scope:** the CometChat product and platform (report at https://www.cometchat.com), and
  vulnerabilities in third-party dependencies (tracked and patched via automated dependency updates).
