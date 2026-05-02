---
title: Moderation Setup
framework: any
prerequisites:
  - "CometChat plan that includes Moderation (Enterprise/Plus)"
  - "App ID and Region"
  - "REST API key for management endpoints"
last_verified: "2026-04-29"
---

# Moderation Setup

Configure CometChat moderation: profanity filter, image moderation, custom rules, flagged messages, and webhooks.

Source: https://www.cometchat.com/docs/moderation/overview

## 1. Enable moderation in the dashboard

Dashboard → your app → **Moderation** → toggle **Enable Moderation**.

You will see four built-in rule categories:

- Profanity filter (text)
- Sentiment analysis (text)
- Image moderation (NSFW, violence)
- Custom rules (regex / keyword lists)

## 2. Configure the profanity filter

Moderation → **Rules** → **Profanity** → choose action:

- **Block** — reject the message before delivery.
- **Mask** — deliver but replace banned terms with `***`.
- **Flag** — deliver and add to the flagged-messages queue for review.

## 3. Add custom keyword rules

REST:

```bash
curl -X POST "https://${APP_ID}.api-${REGION}.cometchat.io/v3.0/moderation/rules" \
  -H "appID: $APP_ID" -H "apiKey: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "no-competitor-links",
    "type": "keyword",
    "keywords": ["competitor1.com", "competitor2.io"],
    "action": "block",
    "scope": ["text", "custom"]
  }'
```

Source: https://www.cometchat.com/docs/moderation/rules-management

## 4. Image moderation

Moderation → **Rules** → **Image** → enable categories:

- NSFW (`adult`)
- Violence
- Weapons
- Drugs

Action options match text rules: block / flag.

## 5. Webhook for moderation events

Configure a webhook so flagged messages reach your review tool:

```bash
curl -X POST "https://${APP_ID}.api-${REGION}.cometchat.io/v3.0/webhooks" \
  -H "appID: $APP_ID" -H "apiKey: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "moderation-events",
    "url": "https://your-app.example.com/webhooks/cometchat-moderation",
    "events": ["message_flagged", "message_blocked", "user_banned"]
  }'
```

Validate the `X-Cometchat-Signature` header on every incoming webhook.

## 6. Review queue

Flagged messages live at:

- Dashboard → Moderation → **Flagged Messages**
- REST: `GET /v3.0/moderation/flagged-messages` — paginated, filterable by date/user.

Source: https://www.cometchat.com/docs/moderation/flagged-messages

## Common pitfalls

- **Profanity rule set to *Flag* on a high-volume app** without staffing the queue — backlog grows fast.
- **Webhook signature unchecked** — opens you to spoofed events.
- **Image moderation enabled but media uploads use a CDN bypass** — moderation runs only on uploads through CometChat.
- **Custom-rule keyword overlap** — rules apply in priority order; conflicting `block` + `mask` resolves to `block`.

## What to read next

- Rules management: https://www.cometchat.com/docs/moderation/rules-management
- Lists management: https://www.cometchat.com/docs/moderation/lists-management
- Custom moderation provider: https://www.cometchat.com/docs/moderation/custom
- OpenAI moderation: https://www.cometchat.com/docs/moderation/open-ai
