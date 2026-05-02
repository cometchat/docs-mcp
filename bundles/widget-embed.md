---
title: Widget Embed (No-Code)
framework: widget
prerequisites:
  - "Access to the HTML <head> of your site"
  - "CometChat App ID, Region, and Widget ID from app.cometchat.com"
last_verified: "2026-04-29"
---

# Widget Embed (No-Code)

Drop the CometChat widget on an existing site without writing app code. Works on plain HTML, Squarespace, Webflow, Wix, WordPress, and Shopify.

Source: https://www.cometchat.com/docs/widget

## 1. Get widget credentials

In the dashboard:

1. Open your app → **Widgets** in the side nav.
2. Click **+ Create Widget** (or pick an existing one).
3. Copy the **Widget ID**, your **App ID**, and your **Region**.

## 2. Embed the script

Paste the snippet just before `</body>` on every page where chat should appear:

```html
<script defer src="https://widget-js.cometchat.io/v3/cometchatwidget.js"></script>
<script>
  (function () {
    window.addEventListener("DOMContentLoaded", function () {
      CometChatWidget.init({
        appID: "YOUR_APP_ID",
        appRegion: "YOUR_REGION",
        authKey: "YOUR_AUTH_KEY"
      }).then(function () {
        CometChatWidget.login({ uid: "cometchat-uid-1" }).then(function () {
          CometChatWidget.launch({
            widgetID: "YOUR_WIDGET_ID",
            target: "self",
            roundedCorners: "true",
            height: "600px",
            width: "400px",
            defaultID: "cometchat-uid-2",
            defaultType: "user"
          });
        });
      });
    });
  })();
</script>
```

## 3. CMS-specific install paths

- **Squarespace**: Settings → Advanced → Code Injection → Footer.
- **Webflow**: Project Settings → Custom Code → Footer Code.
- **Wix**: Settings → Custom Code → Add Custom Code → Body — End.
- **WordPress**: Use the *Insert Headers and Footers* plugin or theme `footer.php`.
- **Shopify**: Online Store → Themes → Edit Code → `theme.liquid` → just before `</body>`.

## 4. Production auth

Replace the inline `authKey` with a server-issued Auth Token. Generate it on the server using the REST API and inject the result into the widget call.

REST: https://www.cometchat.com/docs/rest-api/users-apis/create-auth-token

```html
<script>
  CometChatWidget.login({ authToken: serverIssuedToken }).then(/* ... */);
</script>
```

## Common pitfalls

- **Widget script in `<head>`** — race conditions; keep it before `</body>`.
- **Multiple `launch` calls** on a single page — duplicate iframes; call once.
- **Mixed-content errors** — embed must be served over HTTPS.
- **Auth Key visible in page source** — switch to Auth Token before going live.

## What to read next

- Widget customization: https://www.cometchat.com/docs/widget/html/customization
- Webflow guide: https://www.cometchat.com/docs/widget/webflow
- Squarespace guide: https://www.cometchat.com/docs/widget/squarespace
