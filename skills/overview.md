---
name: CometChat
description: Use when building real-time chat, voice/video calling, or messaging features into web and mobile applications. Reach for this skill when integrating messaging APIs, configuring authentication, building UI components, managing users/groups, or implementing calling functionality.
last_verified: "2026-10-19"
---

# CometChat Skill

## Product Summary

CometChat is a real-time communications platform for adding chat, voice, and video calling to web and mobile apps. Agents use it through three integration paths:

- **UI Kits** — pre-built, themable components for React, React Native, iOS (UIKit, usable from SwiftUI), Android (Views or Jetpack Compose), Flutter, Angular. Fastest path to a complete chat surface.
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

**Key packages** (install the latest release; each implementation bundle carries the install steps from the current docs):
- JS SDK: `@cometchat/chat-sdk-javascript`
- React UI Kit: `@cometchat/chat-uikit-react` (peer deps: `react` 18–20, `@cometchat/chat-sdk-javascript`; `@cometchat/calls-sdk-javascript` only for calling)
- Angular UI Kit: `@cometchat/chat-uikit-angular` + `@cometchat/cards-angular` + `dompurify` (Angular 17–21; not 22 yet)
- React Native UI Kit: `@cometchat/chat-uikit-react-native` + `@cometchat/chat-sdk-react-native`
- Flutter UI Kit: `cometchat_chat_uikit` (pub.dev)
- iOS UI Kit: `CometChatUIKitSwift` (Swift Package Manager)
- Android UI Kit: `com.cometchat:chatuikit-compose-android` (Jetpack Compose) or `com.cometchat:chatuikit-kotlin-android` (Views), from Cloudsmith Maven
- Calls: `@cometchat/calls-sdk-javascript` (or platform-specific calls SDK)

**REST base URL pattern**: `https://{appId}.api-{region}.cometchat.io/v3.0`. Auth via `appID` + `apiKey` headers.

**Environment platforms supported by the chat widget**: HTML, Squarespace, Webflow, Wix, WordPress, Shopify.

## Decision Guidance

| User asks for | Use |
|---|---|
| "Add chat to my React app" | UI Kit (`@cometchat/chat-uikit-react`) — pull `react-uikit-quickstart` bundle |
| "I want full layout control over messages" | JS SDK directly — pull `js-sdk-messaging-basics` bundle |
| "Add chat to a Squarespace / Webflow / Shopify site" | Widget — pull `widget-embed` bundle |
| "I'm building a SaaS where each tenant should be isolated" | One CometChat app per tenant under a multi-tenant plan (Management API) — pull `multi-tenant-chat` bundle |
| "Add presence + typing indicators" | SDK — pull `presence-and-typing` bundle |
| "I need content moderation" | Dashboard moderation rules + REST + webhooks — pull `moderation-setup` bundle |
| "Add voice/video calling" | UI Kit + Calls SDK (`@cometchat/calls-sdk-javascript`) |
| "Add chat to my mobile app" | Platform UI Kit (Flutter / iOS / Android / React Native) |

## Workflow

1. **Orient.** Call `search_cometchat_docs` for any concept the user mentions you don't already know how to map.
2. **Match the recipe.** Call `get_cometchat_implementation_bundle` with the bundle name from the table above. Each bundle compiles the scenario's current docs pages (integration steps with code, then the platform's AI reference page), plus prerequisites and paths of related pages.
3. **Verify edge details.** For specific behaviors (rate limits, exact API field names, version differences), call `fetch_cometchat_doc_page` with a path returned from search.
4. **Apply.** Write the integration code in the user's project, using the bundle as the source of truth and the user's existing project structure as the constraint (existing router, env-var prefix, auth system).
5. **Tell the user about production auth.** Auth Key is for development only. Production must mint Auth Tokens server-side via REST and call `loginWithAuthToken()`. This is the most common production gotcha — surface it before the user ships.

## Common Gotchas

- **Init / login order.** `init()` must resolve before `login()`. `login()` must resolve before rendering UI Kit components. Use a `ready` flag.
- **Env-var prefix.** Vite needs `VITE_*`, Next.js client code needs `NEXT_PUBLIC_*`, RN needs no prefix. The docs examples default to Vite-style; rewrite for the user's bundler.
- **Missing CSS / theme imports** render unstyled where the kit needs one (check the platform's integration page; React v7 ships its styles).
- **Auth Key shipped to production.** Never. Use Auth Tokens minted server-side.
- **iOS deployment target below 15.1**, or **Android `minSdk` below 28** (24 for React Native) — the current UI Kits won't build.
- **Sharing one app between tenants.** Users in one app can see each other; isolate tenants with one app each (multi-tenancy), not with UID prefixes.
- **Forgetting to remove SDK listeners** on screen unmount leaks duplicate handlers.

## Verification Checklist

Before reporting an integration as done:

- [ ] `init()` is awaited before `login()`.
- [ ] `login()` is awaited before any UI Kit component mounts.
- [ ] Credentials are read from environment variables, not hardcoded.
- [ ] Auth Key is flagged as development-only with a TODO to switch to Auth Token.
- [ ] Styles are set up as the platform's integration page says (UI Kit projects only).
- [ ] Listeners are added with stable IDs and removed on unmount.
- [ ] If multi-tenant, each tenant has its own app and the client uses that app's App ID.
- [ ] Production-ready next steps are surfaced to the user (Auth Token migration, moderation rules, webhook signatures).

## Resources

- Quickstart bundles available via `get_cometchat_implementation_bundle`:
  - `react-uikit-quickstart`
  - `react-native-uikit-quickstart`
  - `angular-uikit-quickstart`
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
- This server's search index is built from the public `github.com/cometchat/docs` repository; bundles and page fetches read the live docs.
