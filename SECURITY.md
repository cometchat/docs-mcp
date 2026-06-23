# Security Policy

The CometChat MCP server is a **read-only** documentation server: no account, API key, or
authentication is required, no user data is stored, and only first-party CometChat documentation
and curated implementation bundles are served.

## Supported versions

Security fixes are provided for the latest released version. Run the most recent release.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest `0.1.x` | :white_check_mark: |
| Older          | :x:                |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or pull request.

- Preferred: **Security → Report a vulnerability** on this repository (GitHub private vulnerability reporting), **or**
- Email **support@cometchat.com** with the details.

Include the affected version, a description, reproduction steps, and the impact. We aim to
acknowledge within 3 business days and to share a remediation plan after triage.

## Scope

- **In scope:** the MCP server in this repository and its deployment at `mcp.cometchat.com`.
- **Out of scope:** the CometChat product and platform (report at https://www.cometchat.com), and
  vulnerabilities in third-party dependencies (tracked and patched via automated dependency updates).
