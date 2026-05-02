---
title: React Native UI Kit Quickstart
framework: react-native
prerequisites:
  - "Node.js 18+"
  - "React Native 0.72+ project (CLI or Expo bare workflow)"
  - "CometChat App ID, Auth Key, and Region from app.cometchat.com"
  - "Xcode 15+ for iOS, Android Studio for Android"
last_verified: "2026-04-29"
---

# React Native UI Kit Quickstart

Install the CometChat React Native UI Kit, configure native deps, mount a chat screen.

Source: https://www.cometchat.com/docs/ui-kit/react-native/overview

## 1. Install

```bash
npm install @cometchat/chat-uikit-react-native @cometchat/chat-sdk-react-native
npm install react-native-reanimated react-native-gesture-handler react-native-svg \
  react-native-screens react-native-safe-area-context @react-native-async-storage/async-storage
```

For iOS:

```bash
cd ios && pod install && cd ..
```

For Android, ensure your `minSdkVersion` is 24 or higher in `android/build.gradle`.

## 2. Wrap your app

```tsx
// App.tsx
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Chat } from "./src/Chat";

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Chat uid="cometchat-uid-1" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

## 3. Initialize and login

```tsx
// src/cometchat-init.ts
import {
  CometChatUIKit,
  UIKitSettingsBuilder,
} from "@cometchat/chat-uikit-react-native";

const settings = new UIKitSettingsBuilder()
  .setAppId(process.env.COMETCHAT_APP_ID!)
  .setRegion(process.env.COMETCHAT_REGION!)
  .setAuthKey(process.env.COMETCHAT_AUTH_KEY!)
  .subscribePresenceForAllUsers()
  .build();

export async function bootCometChat(uid: string) {
  await CometChatUIKit.init(settings);
  await CometChatUIKit.login(uid);
}
```

## 4. Render the chat screen

```tsx
// src/Chat.tsx
import { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import {
  CometChatConversationsWithMessages,
} from "@cometchat/chat-uikit-react-native";
import { bootCometChat } from "./cometchat-init";

export function Chat({ uid }: { uid: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    bootCometChat(uid).then(() => setReady(true));
  }, [uid]);

  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }
  return <CometChatConversationsWithMessages />;
}
```

## 5. Add navigation (optional but typical)

If you use React Navigation, wrap your stack and push a chat screen on tap:

```tsx
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

const Stack = createNativeStackNavigator();

export function AppNav() {
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Chat" component={ChatScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
```

## Common pitfalls

- **Forgetting `pod install`** after adding native deps on iOS.
- **`minSdkVersion` below 24** on Android — UI Kit requires 24+.
- **Missing `GestureHandlerRootView`** at the app root — gestures fail silently.
- **Calling `login()` before `init()` resolves** — UI mounts to a blank screen.
- **Auth Key in client builds for production** — switch to Auth Token via REST.

## What to read next

- Components: https://www.cometchat.com/docs/ui-kit/react-native/components-overview
- Theme: https://www.cometchat.com/docs/ui-kit/react-native/theme
- Methods reference: https://www.cometchat.com/docs/ui-kit/react-native/methods
