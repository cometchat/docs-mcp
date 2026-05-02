---
title: JavaScript SDK — Messaging Basics
framework: javascript
prerequisites:
  - "Node.js 18+ or any modern browser"
  - "CometChat App ID, Auth Key, and Region from app.cometchat.com"
  - "A bundler (Vite, webpack) if using browser ESM"
last_verified: "2026-04-29"
---

# JavaScript SDK — Messaging Basics

Install the vanilla JS SDK, initialize, log a user in, and send + receive text and media messages without the UI Kit.

Source: https://www.cometchat.com/docs/sdk/javascript/overview

## 1. Install

```bash
npm install @cometchat/chat-sdk-javascript
```

## 2. Initialize and login

```ts
import { CometChat } from "@cometchat/chat-sdk-javascript";

const APP_ID = import.meta.env.VITE_COMETCHAT_APP_ID;
const REGION = import.meta.env.VITE_COMETCHAT_REGION;
const AUTH_KEY = import.meta.env.VITE_COMETCHAT_AUTH_KEY;

const settings = new CometChat.AppSettingsBuilder()
  .subscribePresenceForAllUsers()
  .setRegion(REGION)
  .build();

await CometChat.init(APP_ID, settings);
const user = await CometChat.login("cometchat-uid-1", AUTH_KEY);
```

## 3. Send a text message

```ts
const text = new CometChat.TextMessage(
  "cometchat-uid-2",            // receiver
  "Hello from the SDK!",
  CometChat.RECEIVER_TYPE.USER, // or GROUP
);
const sent = await CometChat.sendMessage(text);
```

## 4. Send a media message (image)

```ts
const file = (document.getElementById("upload") as HTMLInputElement).files![0];
const media = new CometChat.MediaMessage(
  "cometchat-uid-2",
  file,
  CometChat.MESSAGE_TYPE.IMAGE,
  CometChat.RECEIVER_TYPE.USER,
);
await CometChat.sendMediaMessage(media);
```

## 5. Listen for incoming messages

```ts
const listenerId = "app-listener";
CometChat.addMessageListener(
  listenerId,
  new CometChat.MessageListener({
    onTextMessageReceived: (msg) => console.log("text:", msg.getText()),
    onMediaMessageReceived: (msg) => console.log("media:", msg.getURL()),
  }),
);

// when leaving the screen:
CometChat.removeMessageListener(listenerId);
```

## 6. Fetch message history

```ts
const builder = new CometChat.MessagesRequestBuilder()
  .setUID("cometchat-uid-2")
  .setLimit(30);
const history = await builder.build().fetchPrevious();
```

## Common pitfalls

- **Not awaiting `CometChat.init`** before `login()` — silent failure.
- **Missing `region`** in settings — initialization succeeds but messages never deliver.
- **Using Auth Key in production** — generate Auth Tokens server-side instead.
- **Forgetting `removeMessageListener`** on screen unmount — leaks duplicate handlers.
- **Sending to a `GROUP` while passing `RECEIVER_TYPE.USER`** — message disappears.

## What to read next

- Users overview: https://www.cometchat.com/docs/sdk/javascript/users-overview
- Groups overview: https://www.cometchat.com/docs/sdk/javascript/groups-overview
- Real-time listeners: https://www.cometchat.com/docs/sdk/javascript/all-real-time-listeners
- Authentication overview: https://www.cometchat.com/docs/sdk/javascript/authentication-overview
