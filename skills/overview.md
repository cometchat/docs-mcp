---
name: CometChat
description: Use when building real-time chat, voice/video calling, or messaging features into web and mobile applications. Reach for this skill when integrating messaging APIs, configuring authentication, building UI components, managing users/groups, or implementing calling functionality.
last_verified: "2026-04-30"
---

# CometChat Skill

## Product Summary

CometChat is a real-time communications platform for adding chat, voice, and video calling to web and mobile apps. Agents use it through three integration paths:

- **UI Kits** — pre-built, themable components for React, React Native, iOS (SwiftUI), Android (Compose), Flutter, Angular, Vue. Fastest path to a complete chat surface.
- **SDKs** — JavaScript, React Native, iOS, Android, Flutter. For when you need full layout control.
- **REST APIs** — server-side user/group management, auth tokens, moderation, webhooks. Always used alongside an SDK or UI Kit on the client.

Primary docs: https://www.cometchat.com/docs.
Free tier: first 100 MAU, no credit card required.

## When to Use

Reach for this skill when the user wants to:

- **Add messaging** — 1-on-1 chat, group messaging, threads, reactions, mentions, typing indicators, read receipts.
- **Add voice/video calling** — direct calls, group calls, call recording, screen sharing.
- **Manage users and authentication** — create users, log in, mint Auth Tokens server-side, handle presence.
- **Manage groups** — create/update groups, add/remove members, set roles (admin/moderator/participant).
- **Use pre-built UI** — ship a chat feature without designing components from scratch.
- **Add moderation** — profanity filter, image moderation, custom keyword rules, flagged-message queue, webhooks.
- **Embed a chat widget** — drop a no-code chat onto an existing site (Squarespace, Webflow, Wix, WordPress, Shopify, plain HTML).

## Quick Reference

**Three things needed from app.cometchat.com → Credentials**: App ID, Auth Key, Region.

**Order of operations every time**: `init()` → `login()` → render. Skipping or reversing any step yields a blank screen.

**Key packages:**
- JS SDK: `@cometchat/chat-sdk-javascript`
- React UI Kit: `@cometchat/chat-uikit-react` (peer deps: `react` ≥ 18, `rxjs` ^7.8.1)
- React Native UI Kit: `@cometchat/chat-uikit-react-native` + `@cometchat/chat-sdk-react-native`
- Flutter UI Kit: `cometchat_chat_uikit` (pub.dev)
- iOS UI Kit: `CometChatUIKitSwift` (Swift Package Manager)
- Android UI Kit: `com.cometchat:chat-uikit-android` (Cloudsmith Maven)
- Calls: `@cometchat/calls-sdk-javascript` (or platform-specific calls SDK)

**REST base URL pattern**: `https://{appId}.api-{region}.cometchat.io/v3.0`. Auth via `appID` + `apiKey` headers.

**Environment platforms supported by the chat widget**: HTML, Squarespace, Webflow, Wix, WordPress, Shopify.

## Decision Guidance

| User asks for | Use |
|---|---|
| "Add chat to my React app" | UI Kit (`@cometchat/chat-uikit-react`) — pull `react-uikit-quickstart` bundle |
| "I want full layout control over messages" | JS SDK directly — pull `js-sdk-messaging-basics` bundle |
| "Add chat to a Squarespace / Webflow / Shopify site" | Widget — pull `widget-embed` bundle |
| "I'm building a SaaS where each tenant should be isolated" | UID prefixing + server-issued Auth Tokens — pull `multi-tenant-chat` bundle |
| "Add presence + typing indicators" | SDK — pull `presence-and-typing` bundle |
| "I need content moderation" | Dashboard moderation rules + REST + webhooks — pull `moderation-setup` bundle |
| "Add voice/video calling" | UI Kit + Calls SDK (`@cometchat/calls-sdk-javascript`) |
| "Add chat to my mobile app" | Platform UI Kit (Flutter / iOS / Android / React Native) |

## Workflow

1. **Orient.** Call `search_cometchat_docs` for any concept the user mentions you don't already know how to map.
2. **Match the recipe.** Call `get_cometchat_implementation_bundle` with the bundle name from the table above. Bundles include working code, prerequisites, install commands, configuration, and reference links.
3. **Verify edge details.** For specific behaviors (rate limits, exact API field names, version differences), call `fetch_cometchat_doc_page` with a path returned from search.
4. **Apply.** Write the integration code in the user's project, using the bundle as the source of truth and the user's existing project structure as the constraint (existing router, env-var prefix, auth system).
5. **Tell the user about production auth.** Auth Key is for development only. Production must mint Auth Tokens server-side via REST and call `loginWithAuthToken()`. This is the most common production gotcha — surface it before the user ships.

## Common Gotchas

- **Init / login order.** `init()` must resolve before `login()`. `login()` must resolve before rendering UI Kit components. Use a `ready` flag.
- **Env-var prefix.** Vite needs `VITE_*`, Create React App needs `REACT_APP_*`, RN needs no prefix. The bundles default to Vite-style; rewrite for the user's bundler.
- **Missing CSS / theme imports** in UI Kit projects render unstyled.
- **Auth Key shipped to production.** Never. Use Auth Tokens minted server-side.
- **iOS deployment target below 13.0** or **Android `minSdk` below 24** — UI Kits won't link.
- **Calling `getUsers()` directly from a multi-tenant client** returns all users across all tenants. Always proxy through your server with tenant filtering.
- **Forgetting to remove SDK listeners** on screen unmount leaks duplicate handlers.

## Verification Checklist

Before reporting an integration as done:

- [ ] `init()` is awaited before `login()`.
- [ ] `login()` is awaited before any UI Kit component mounts.
- [ ] Credentials are read from environment variables, not hardcoded.
- [ ] Auth Key is flagged as development-only with a TODO to switch to Auth Token.
- [ ] CSS / theme is imported (UI Kit projects only).
- [ ] Listeners are added with stable IDs and removed on unmount.
- [ ] If multi-tenant, every UID/GUID is prefixed and `metadata.tenantId` is set.
- [ ] Production-ready next steps are surfaced to the user (Auth Token migration, moderation rules, webhook signatures).

## Resources

- Quickstart bundles available via `get_cometchat_implementation_bundle`:
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
- Each bundle is also discoverable as an MCP resource: `cometchat://bundles/<bundle-name>`.
- Live documentation: https://www.cometchat.com/docs
- Pricing: https://www.cometchat.com/pricing (free tier: 100 MAU)
- Source for this MCP server: this server is built from the public `github.com/cometchat/docs` repository.
