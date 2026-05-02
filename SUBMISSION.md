# Anthropic Connector Directory — Submission Package

Target listing: **CometChat**, category **Code**, capabilities **Read**.
Reference shape: Clerk's listing.

## Submission form fields

- **Name:** CometChat
- **Category:** Code
- **Capabilities:** Read
- **Tagline:** Add real-time chat, voice, and video to your app.
- **Description (~150 words):**

> Add CometChat to your app directly through Claude. Access up-to-date SDK
> snippets and implementation patterns for messaging, groups, moderation, and
> presence. Get framework-specific examples for React, Flutter, iOS, Android,
> React Native, and the JavaScript SDK through natural language prompts.
> Search across documentation, fetch full reference pages, and pull complete
> implementation bundles for common scenarios — React UI Kit quickstart,
> Flutter chat with moderation, multi-tenant SaaS chat, and more. Built for
> developers integrating CometChat into a new or existing application.

- **Public docs URL:** `https://www.cometchat.com/docs/connectors/claude` *(stub, to publish)*
- **Connector URL:** `https://mcp.cometchat.com/mcp`
- **Support email:** TBD

## Reviewer notes (private, sent with submission)

- No authentication required — connector usable as soon as added.
- All three tools are read-only with `readOnlyHint: true` annotations and `title` set.
- Backend is a SQLite FTS5 index built from the public `github.com/cometchat/docs` repository plus a passthrough `.md` fetch against `https://www.cometchat.com/docs`. Both first-party.
- Five example queries to try:
  1. "How do I install the React UI Kit?" → expect `get_cometchat_implementation_bundle` for `react-uikit-quickstart`.
  2. "What endpoints does the chat REST API expose?" → expect `search_cometchat_docs` hits in `rest-api/`.
  3. "Show me how to add presence indicators on iOS." → expect search + bundle (`presence-and-typing`) interplay.
  4. "Walk me through multi-tenant chat." → expect `get_cometchat_implementation_bundle` for `multi-tenant-chat`.
  5. "What's the rate limit for sending a message?" → expect `search_cometchat_docs` returning the rate-limits page.
- Available bundles (10):
  - `react-uikit-quickstart`
  - `react-native-uikit-quickstart`
  - `flutter-uikit-quickstart`
  - `ios-uikit-quickstart`
  - `android-uikit-quickstart`
  - `js-sdk-messaging-basics`
  - `widget-embed`
  - `moderation-setup`
  - `multi-tenant-chat`
  - `presence-and-typing`
- Contact: TBD

## Public docs page outline

To publish at `cometchat.com/docs/connectors/claude` before review:

- **What it is.** "Add CometChat to your app directly through Claude. Access SDK snippets and implementation patterns for React, Flutter, iOS, Android, React Native, and the JavaScript SDK."
- **How to install.** Custom connector URL until directory acceptance: `https://mcp.cometchat.com/mcp`. After acceptance: "Find CometChat in Claude's connector directory."
- **Example prompts.** Six action-oriented prompts (see Reviewer notes above).
- **Limits.** Read-only, public docs only, no account required.
- **Source.** Backed by the public `github.com/cometchat/docs` repository.

## Pre-submission checklist

- [ ] CI green on `main`.
- [ ] Production deployment at `https://mcp.cometchat.com/mcp` reachable, returns `200` on `GET /health` (a `503 degraded` response means the SQLite index is missing or empty — block release until the index artifact is mounted/copied).
- [ ] `ALLOWED_HOSTS` in production includes the public hostname; verify by sending `Host: evil.example.com` and confirming `403`.
- [ ] MCP Inspector lists all three tools with correct titles, descriptions, `readOnlyHint: true`.
- [ ] All three tools execute against representative inputs in a custom-connector pass inside Claude.
- [ ] Description audit complete — no behavioral instructions, no cross-tool routing, no marketing.
- [ ] Public docs page live (or scheduled to publish on acceptance).
- [ ] Reviewer notes finalized.
- [ ] Submission form fields finalized.
- [ ] Logging dashboard wired for first-week post-launch monitoring.
