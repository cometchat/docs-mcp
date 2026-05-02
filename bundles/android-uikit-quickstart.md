---
title: Android UI Kit Quickstart (Jetpack Compose)
framework: android
prerequisites:
  - "Android Studio Hedgehog or newer"
  - "minSdk 24, compileSdk 34+"
  - "Kotlin 1.9+"
  - "CometChat App ID, Auth Key, and Region from app.cometchat.com"
last_verified: "2026-04-29"
---

# Android UI Kit Quickstart (Jetpack Compose)

Install the CometChat Android UI Kit via Gradle, initialize, login, and host the conversations screen inside a Compose app.

Source: https://www.cometchat.com/docs/ui-kit/android/overview

## 1. Gradle dependencies

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
  repositories {
    google()
    mavenCentral()
    maven { url = uri("https://dl.cloudsmith.io/public/cometchat/cometchat/maven/") }
  }
}
```

```kotlin
// app/build.gradle.kts
android {
  compileSdk = 34
  defaultConfig { minSdk = 24 }
  buildFeatures { compose = true }
}

dependencies {
  implementation("com.cometchat:chat-uikit-android:5.0.0")
  // optional: voice/video
  implementation("com.cometchat:calls-uikit-android:5.0.0")
}
```

## 2. Manifest permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.CAMERA" />
```

## 3. Initialize and login

```kotlin
// CometChatBoot.kt
import com.cometchat.chatuikit.shared.cometchatuikit.CometChatUIKit
import com.cometchat.chatuikit.shared.cometchatuikit.UIKitSettingsBuilder

object CometChatBoot {
  fun start(application: Application, uid: String, onReady: (Throwable?) -> Unit) {
    val settings = UIKitSettingsBuilder()
      .setRegion(BuildConfig.COMETCHAT_REGION)
      .setAppId(BuildConfig.COMETCHAT_APP_ID)
      .setAuthKey(BuildConfig.COMETCHAT_AUTH_KEY)
      .subscribePresenceForAllUsers()
      .build()

    CometChatUIKit.init(application, settings, object : CometChat.CallbackListener<String>() {
      override fun onSuccess(s: String) {
        CometChatUIKit.login(uid, object : CometChat.CallbackListener<User>() {
          override fun onSuccess(user: User) = onReady(null)
          override fun onError(e: CometChatException) = onReady(e)
        })
      }
      override fun onError(e: CometChatException) = onReady(e)
    })
  }
}
```

## 4. Compose host

```kotlin
@Composable
fun ChatScreen(uid: String) {
  val context = LocalContext.current
  var ready by remember { mutableStateOf(false) }

  LaunchedEffect(uid) {
    CometChatBoot.start(context.applicationContext as Application, uid) { err ->
      if (err == null) ready = true else Log.e("CometChat", "init failed", err)
    }
  }

  if (!ready) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
    return
  }

  AndroidView(factory = { ctx ->
    val frame = FrameLayout(ctx)
    val conv = CometChatConversationsWithMessages(ctx)
    frame.addView(conv)
    frame
  })
}
```

## 5. Production auth

Switch from Auth Key to Auth Token via the REST API before shipping. See https://www.cometchat.com/docs/rest-api/users-apis/create-auth-token.

## Common pitfalls

- **`minSdk` below 24** — UI Kit will not build.
- **Missing CometChat Maven repository** — gradle resolves nothing.
- **R8/ProGuard stripping CometChat classes** — add the keep rules from the docs.
- **Calling `login()` from `onCreate` before `init` callback** — race causes blank screen.
- **Permissions denied at runtime** — handle with Activity Result API; UI Kit doesn't ask.

## What to read next

- Components: https://www.cometchat.com/docs/ui-kit/android/components-overview
- Theme: https://www.cometchat.com/docs/ui-kit/android/theme
- Methods: https://www.cometchat.com/docs/ui-kit/android/methods
