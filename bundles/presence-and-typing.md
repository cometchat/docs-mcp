---
title: Presence and Typing Indicators
framework: any
prerequisites:
  - "CometChat SDK or UI Kit installed and initialized (see other quickstart bundles)"
  - "App ID, Region, and authenticated user"
last_verified: "2026-04-29"
---

# Presence and Typing Indicators

Show online presence, typing indicators, and read receipts. Recipes use the JavaScript SDK; identical APIs exist on iOS, Android, Flutter, and React Native.

Source:
- https://www.cometchat.com/docs/sdk/javascript/user-presence
- https://www.cometchat.com/docs/sdk/javascript/typing-indicators
- https://www.cometchat.com/docs/sdk/javascript/delivery-read-receipts

## 1. Subscribe to presence

Presence is enabled at init time:

```ts
const settings = new CometChat.AppSettingsBuilder()
  .subscribePresenceForAllUsers()       // or .subscribePresenceForFriends()
  .setRegion(REGION)
  .build();
await CometChat.init(APP_ID, settings);
```

## 2. Listen for online/offline events

```ts
const userListenerId = "presence-listener";
CometChat.addUserListener(
  userListenerId,
  new CometChat.UserListener({
    onUserOnline: (user) => updateAvatar(user.getUid(), "online"),
    onUserOffline: (user) => updateAvatar(user.getUid(), "offline"),
  }),
);

// on screen unmount:
CometChat.removeUserListener(userListenerId);
```

## 3. Read a user's status on demand

```ts
const u = await CometChat.getUser("cometchat-uid-2");
console.log(u.getStatus()); // "online" | "offline"
console.log(u.getLastActiveAt()); // unix seconds
```

## 4. Send typing indicators

```ts
const start = new CometChat.TypingIndicator(
  "cometchat-uid-2",
  CometChat.RECEIVER_TYPE.USER,
);
CometChat.startTyping(start);

// when the user stops typing (debounce on the input):
CometChat.endTyping(start);
```

## 5. Receive typing indicators

```ts
CometChat.addMessageListener(
  "typing-listener",
  new CometChat.MessageListener({
    onTypingStarted: (i) => showTypingDots(i.getSender().getUid()),
    onTypingEnded: (i) => hideTypingDots(i.getSender().getUid()),
  }),
);
```

## 6. Delivery + read receipts

Mark a message read when the user actually sees it:

```ts
CometChat.markAsRead(message); // sends READ receipt to sender
```

Listen for receipt events on the sender side:

```ts
CometChat.addMessageListener(
  "receipts",
  new CometChat.MessageListener({
    onMessagesDelivered: (r) => markUiDelivered(r.getMessageId()),
    onMessagesRead: (r) => markUiRead(r.getMessageId()),
  }),
);
```

## Common pitfalls

- **`subscribePresenceForFriends`** without a friends list — events never arrive.
- **Calling `startTyping` on every keystroke** — flood. Debounce ~300 ms; call `endTyping` after 2 s of inactivity.
- **Marking *every* message in a conversation read on screen open** — looks fine in demos, fires N receipts in production. Mark only the latest visible message.
- **Forgetting to remove listeners** on screen unmount — duplicate handlers, memory leaks, double-renders.
- **Mixing `RECEIVER_TYPE.USER` and `RECEIVER_TYPE.GROUP`** — typing indicators sent to the wrong receiver type are silently dropped.

## What to read next

- All real-time listeners: https://www.cometchat.com/docs/sdk/javascript/all-real-time-listeners
- Connection status: https://www.cometchat.com/docs/sdk/javascript/connection-status
- Message filtering: https://www.cometchat.com/docs/sdk/javascript/message-filtering
