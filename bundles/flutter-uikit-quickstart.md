---
title: Flutter UI Kit Quickstart
framework: flutter
prerequisites:
  - "Flutter 3.13+"
  - "Dart 3.0+"
  - "CometChat App ID, Auth Key, and Region from app.cometchat.com"
last_verified: "2026-04-29"
---

# Flutter UI Kit Quickstart

Install the CometChat Flutter UI Kit, initialize, log a user in, and mount a conversations screen.

Source: https://www.cometchat.com/docs/ui-kit/flutter/overview

## 1. Add dependencies

```yaml
# pubspec.yaml
dependencies:
  flutter_chat_ui_kit: ^5.0.0
  cometchat_chat_uikit: ^5.0.0
  cometchat_calls_uikit: ^5.0.0   # optional, for calls
```

```bash
flutter pub get
```

For iOS, set the platform to 13.0+ in `ios/Podfile`:

```ruby
platform :ios, '13.0'
```

For Android, set `minSdkVersion 24` in `android/app/build.gradle`.

## 2. Initialize

```dart
// lib/cometchat_init.dart
import 'package:cometchat_chat_uikit/cometchat_chat_uikit.dart';

Future<void> bootCometChat(String uid) async {
  final settings = (UIKitSettingsBuilder()
        ..subscriptionType = CometChatSubscriptionType.allUsers
        ..autoEstablishSocketConnection = true
        ..region = const String.fromEnvironment('COMETCHAT_REGION')
        ..appId = const String.fromEnvironment('COMETCHAT_APP_ID')
        ..authKey = const String.fromEnvironment('COMETCHAT_AUTH_KEY'))
      .build();

  await CometChatUIKit.init(uiKitSettings: settings);
  await CometChatUIKit.login(uid);
}
```

## 3. Mount the conversations screen

```dart
// lib/main.dart
import 'package:flutter/material.dart';
import 'package:cometchat_chat_uikit/cometchat_chat_uikit.dart';
import 'cometchat_init.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(home: ChatHome());
  }
}

class ChatHome extends StatefulWidget {
  @override
  State<ChatHome> createState() => _ChatHomeState();
}

class _ChatHomeState extends State<ChatHome> {
  bool ready = false;

  @override
  void initState() {
    super.initState();
    bootCometChat('cometchat-uid-1').then((_) => setState(() => ready = true));
  }

  @override
  Widget build(BuildContext context) {
    if (!ready) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    return Scaffold(body: CometChatConversationsWithMessages());
  }
}
```

Run:

```bash
flutter run --dart-define=COMETCHAT_APP_ID=... \
            --dart-define=COMETCHAT_REGION=us \
            --dart-define=COMETCHAT_AUTH_KEY=...
```

## Common pitfalls

- **iOS platform too low** — bump `platform :ios, '13.0'` in Podfile and run `pod install`.
- **Android `minSdkVersion` < 24** — UI Kit refuses to compile.
- **Calling `init()` and `login()` outside `initState`** before any UI renders → race conditions.
- **Auth Key in production binary** — use Auth Token via REST instead.

## What to read next

- Components: https://www.cometchat.com/docs/ui-kit/flutter/components-overview
- Theme: https://www.cometchat.com/docs/ui-kit/flutter/theme
- Methods: https://www.cometchat.com/docs/ui-kit/flutter/methods
