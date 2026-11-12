# Anthropic Connector Directory — Submission Package

Target listing: **CometChat**, category **Code**, capabilities **Read** and **Write**.
Reference shape: Clerk's listing.

## Submission form fields

- **Name:** CometChat
- **Category:** Code
- **Capabilities:** Read, Write (writes only after the user signs in)
- **Tagline:** Add real-time chat, voice, and video to your app.
- **Description (~150 words):**

> Add CometChat to your app directly through Claude. Access up-to-date SDK
> snippets and implementation patterns for messaging, groups, moderation, and
> presence. Get framework-specific examples for React, Flutter, iOS, Android,
> React Native, and the JavaScript SDK through natural language prompts.
> Search across documentation, fetch full reference pages, and pull complete
> implementation bundles for common scenarios — React UI Kit quickstart,
> Flutter chat with moderation, multi-tenant SaaS chat, and more. Sign in with
> your CometChat account to also manage your apps, users, groups, settings,
> API keys, webhooks, moderation and push setup; edits and deletes ask for your
> confirmation first. Built for developers integrating CometChat into a new or
> existing application.

- **Public docs URL:** `https://www.cometchat.com/docs/connectors/claude` *(stub, to publish)*
- **Connector URL:** `https://mcp.cometchat.com/mcp`
- **Support email:** support@cometchat.com

## Reviewer notes (private, sent with submission)

- Docs tools (4) need no authentication and work as soon as the connector is added.
- Account tools (51) use OAuth 2.0 sign-in with a CometChat account (dynamic client registration, PKCE), asked on the first account tool call. Edits and deletes need `confirm: true`; deletes and changes that grant access or send data out (API keys, auth tokens, the OpenAI key, webhooks, team invites, app settings) also need approval in the user's browser.
- Every tool has a `title` and either `readOnlyHint: true` or a `destructiveHint`.
- Known, deferred: a dashboard sign-in link (`app.cometchat.com/login?sessionId=…`) forwarded to someone else signs the sender in to that person's account, as with `cometchat auth login` today. The fix is `DASHBOARD_SIGNIN_FLOW=confirm` once mgmt-api#935 and customer-dashboard#2602 ship; DEPLOY.md (`DASHBOARD_SIGNIN_FLOW` row and "Forwarded sign-in links") lists every prerequisite.
- Reviewer test account: a CometChat account with a populated app (users, groups, messages, webhooks). *(credentials TBD — entered in the portal only)*
- Backend is a SQLite FTS5 index built from the public `github.com/cometchat/docs` repository plus a passthrough `.md` fetch against `https://www.cometchat.com/docs`. Both first-party.
- Five example queries to try:
  1. "How do I install the React UI Kit?" → expect `get_cometchat_implementation_bundle` for `react-uikit-quickstart`.
  2. "What endpoints does the chat REST API expose?" → expect `search_cometchat_docs` hits in `rest-api/`.
  3. "Show me how to add presence indicators on iOS." → expect search + bundle (`presence-and-typing`) interplay.
  4. "Walk me through multi-tenant chat." → expect `get_cometchat_implementation_bundle` for `multi-tenant-chat`.
  5. "What's the rate limit for sending a message?" → expect `search_cometchat_docs` returning the rate-limits page.
- Available bundles (11; each compiled from the current docs pages):
  - `react-uikit-quickstart`
  - `react-native-uikit-quickstart`
  - `flutter-uikit-quickstart`
  - `ios-uikit-quickstart`
  - `android-uikit-quickstart`
  - `angular-uikit-quickstart`
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
- **Limits.** Docs tools: public docs only, no account required. Account tools: need sign-in; they can't delete apps, change billing, transfer ownership or ban users.
- **Source.** Backed by the public `github.com/cometchat/docs` repository.

## Pre-submission checklist

- [ ] CI green on `main`.
- [ ] Production deployment at `https://mcp.cometchat.com/mcp` reachable, returns `200` on `GET /health` (a `503 degraded` response means the SQLite index is missing or empty — block release until the index artifact is mounted/copied).
- [ ] `ALLOWED_HOSTS` in production includes the public hostname; verify by sending `Host: evil.example.com` and confirming `403`.
- [ ] MCP Inspector lists the four docs tools before sign-in and all 55 tools after, each with a title and a `readOnlyHint` or `destructiveHint`.
- [ ] Every tool executes against representative inputs in a custom-connector pass inside Claude, signed in to the reviewer test account.
- [ ] Reviewer test account created and populated; credentials ready for the portal.
- [ ] Description audit complete — factual only: no directives to the agent, sibling tools named only where one serves a specific need, no other servers or products, no marketing. Read the four descriptions yourself; `tests/tools.test.ts` only rejects a list of known phrasings, across the tool, parameter and output-field descriptions and the `initialize` instructions.
- [ ] Public docs page live (or scheduled to publish on acceptance).
- [ ] Reviewer notes finalized.
- [ ] Submission form fields finalized.
- [ ] Logging dashboard wired for first-week post-launch monitoring.
