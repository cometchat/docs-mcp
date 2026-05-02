---
title: iOS UI Kit Quickstart (SwiftUI)
framework: ios
prerequisites:
  - "Xcode 15+"
  - "iOS 13.0+ deployment target"
  - "CocoaPods or Swift Package Manager"
  - "CometChat App ID, Auth Key, and Region from app.cometchat.com"
last_verified: "2026-04-29"
---

# iOS UI Kit Quickstart (SwiftUI)

Install the CometChat iOS UI Kit via SPM, initialize, log in, and embed a SwiftUI chat view.

Source: https://www.cometchat.com/docs/ui-kit/ios/overview

## 1. Install via Swift Package Manager

In Xcode: File → Add Packages → enter:

```
https://github.com/cometchat/chat-uikit-ios
```

Select the latest 5.x release, add `CometChatUIKitSwift` to your app target.

## 2. Configure your Info.plist

Add the following keys (required for messaging + media):

```xml
<key>NSCameraUsageDescription</key>
<string>This app uses the camera to send photos in chat.</string>
<key>NSMicrophoneUsageDescription</key>
<string>This app uses the microphone to send voice messages.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>This app accesses photos to send images in chat.</string>
```

## 3. Initialize at launch

```swift
// CometChatBoot.swift
import CometChatUIKitSwift

enum CometChatBoot {
  static func start(uid: String) async throws {
    let settings = UIKitSettings()
      .set(appID: AppSecrets.appId)
      .set(region: AppSecrets.region)
      .set(authKey: AppSecrets.authKey)
      .subscribePresenceForAllUsers()
      .build()

    try await withCheckedThrowingContinuation { cont in
      CometChatUIKit.init(uiKitSettings: settings) { result in
        switch result {
        case .success: cont.resume()
        case .onError(let e): cont.resume(throwing: e)
        }
      }
    }
    try await withCheckedThrowingContinuation { cont in
      CometChatUIKit.login(uid: uid) { result in
        switch result {
        case .success: cont.resume()
        case .onError(let e): cont.resume(throwing: e)
        }
      }
    }
  }
}
```

## 4. Embed the conversations view

```swift
// ChatView.swift
import SwiftUI
import CometChatUIKitSwift

struct ChatView: View {
  @State private var ready = false

  var body: some View {
    Group {
      if ready {
        CometChatConversationsWithMessagesBridge()
      } else {
        ProgressView()
      }
    }
    .task {
      do { try await CometChatBoot.start(uid: "cometchat-uid-1"); ready = true }
      catch { print("CometChat init failed: \(error)") }
    }
  }
}

struct CometChatConversationsWithMessagesBridge: UIViewControllerRepresentable {
  func makeUIViewController(context: Context) -> CometChatConversationsWithMessages {
    return CometChatConversationsWithMessages()
  }
  func updateUIViewController(_ vc: CometChatConversationsWithMessages, context: Context) {}
}
```

## 5. Production auth

Move from Auth Key to Auth Token before shipping:

```swift
CometChatUIKit.loginWithAuthToken(authToken: serverIssuedToken) { ... }
```

REST: https://www.cometchat.com/docs/rest-api/users-apis/create-auth-token

## Common pitfalls

- **Deployment target below iOS 13** — UI Kit refuses to link.
- **Missing Info.plist usage descriptions** — App Store rejects + crashes on first media use.
- **Calling `login` before `init` completes** — both calls are async; chain them.
- **Embedding the UIKit view in SwiftUI without `UIViewControllerRepresentable`** — view fails to lay out.
- **Auth Key in TestFlight build** — treat as production; switch to Auth Token.

## What to read next

- Components: https://www.cometchat.com/docs/ui-kit/ios/components-overview
- Theme: https://www.cometchat.com/docs/ui-kit/ios/theme
- Methods: https://www.cometchat.com/docs/ui-kit/ios/methods
