---
title: React UI Kit Quickstart
framework: react
prerequisites:
  - "Node.js 18+"
  - "React 18+ project (Vite or CRA)"
  - "CometChat App ID, Auth Key, and Region from app.cometchat.com"
last_verified: "2026-04-29"
---

# React UI Kit Quickstart

End-to-end install of the CometChat React UI Kit. By the end you have init, login, and a chat UI rendering.

Source: https://www.cometchat.com/docs/ui-kit/react/react-js-integration

## 1. Install

```bash
npm install @cometchat/chat-uikit-react
```

This pulls in `@cometchat/chat-sdk-javascript` automatically. For voice/video calling, also install:

```bash
npm install @cometchat/calls-sdk-javascript
```

## 2. Configure

Add a constants file with your dashboard credentials.

```ts
// src/cometchat-config.ts
export const COMETCHAT = {
  APP_ID: import.meta.env.VITE_COMETCHAT_APP_ID,
  REGION: import.meta.env.VITE_COMETCHAT_REGION,
  AUTH_KEY: import.meta.env.VITE_COMETCHAT_AUTH_KEY,
};
```

Then import the UI Kit CSS in your root CSS file:

```css
/* src/index.css */
@import url("@cometchat/chat-uikit-react/css-variables.css");
```

> CRA projects use `REACT_APP_` instead of `VITE_`.

## 3. Initialize before render

`init()` must resolve before `login()`. `login()` must resolve before rendering any UI Kit component. Breaking this order yields a blank screen.

```tsx
// src/cometchat-init.ts
import {
  CometChatUIKit,
  UIKitSettingsBuilder,
} from "@cometchat/chat-uikit-react";
import { COMETCHAT } from "./cometchat-config";

const settings = new UIKitSettingsBuilder()
  .setAppId(COMETCHAT.APP_ID)
  .setRegion(COMETCHAT.REGION)
  .setAuthKey(COMETCHAT.AUTH_KEY)
  .subscribePresenceForAllUsers()
  .build();

export async function bootCometChat(uid: string) {
  await CometChatUIKit.init(settings);
  await CometChatUIKit.login(uid);
}
```

## 4. Render the conversations + message view

```tsx
// src/Chat.tsx
import { useEffect, useState } from "react";
import {
  CometChatConversationsWithMessages,
} from "@cometchat/chat-uikit-react";
import { bootCometChat } from "./cometchat-init";

export function Chat({ uid }: { uid: string }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    bootCometChat(uid).then(() => setReady(true));
  }, [uid]);

  if (!ready) return <div>Loading chat…</div>;
  return <CometChatConversationsWithMessages />;
}
```

## 5. Production auth

Auth Key is for development only. In production, mint Auth Tokens server-side via the REST API and use `CometChatUIKit.loginWithAuthToken(token)`. Never ship the Auth Key in client code.

REST: https://www.cometchat.com/docs/rest-api/users-apis/create-auth-token

## Common pitfalls

- **Calling `login()` before `init()` resolves.** Always `await` `init()` first.
- **Rendering UI Kit components before `login()` resolves.** Gate with a `ready` flag.
- **Missing CSS import.** Without `css-variables.css` the UI renders unstyled.
- **Wrong env prefix.** Vite needs `VITE_*`, CRA needs `REACT_APP_*`.
- **Shipping Auth Key to production.** Move to Auth Token before launch.

## What to read next

- Theming and customization: https://www.cometchat.com/docs/ui-kit/react/theme
- Methods reference (login/logout/auth tokens): https://www.cometchat.com/docs/ui-kit/react/methods
- Components: https://www.cometchat.com/docs/ui-kit/react/components-overview
