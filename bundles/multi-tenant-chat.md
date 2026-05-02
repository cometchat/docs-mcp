---
title: Multi-Tenant SaaS Chat
framework: any
prerequisites:
  - "Backend service capable of issuing Auth Tokens"
  - "CometChat App ID, REST API key, and Region"
  - "User identity model with a unique ID per user (e.g., DB user.id)"
last_verified: "2026-04-29"
---

# Multi-Tenant SaaS Chat

Recipe for SaaS apps where many tenants share one CometChat application but must not see each other's users, conversations, or messages.

Source: https://www.cometchat.com/docs/fundamentals/architecture-overview

## 1. Tenant isolation strategy

The pragmatic pattern is **prefix every CometChat UID and group ID with the tenant ID**:

```
UID         = `${tenantId}_${userId}`
GROUP_ID    = `${tenantId}_${groupId}`
```

This guarantees uniqueness across tenants and lets you scope server-side audits with a simple `LIKE 'tenant_42_%'` query.

CometChat does not natively partition tenants — isolation comes from disciplined ID prefixing plus server-side authorization on join/login.

## 2. Provision users via REST

```bash
curl -X POST "https://${APP_ID}.api-${REGION}.cometchat.io/v3.0/users" \
  -H "appID: $APP_ID" -H "apiKey: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "uid": "tenant_42_user_8911",
    "name": "Sam Rivera",
    "metadata": { "tenantId": "42" }
  }'
```

Storing `tenantId` in metadata lets you filter and audit users later.

Source: https://www.cometchat.com/docs/rest-api/users-apis/create-user

## 3. Issue scoped Auth Tokens

Mint Auth Tokens server-side, only after verifying the requesting user belongs to the tenant they claim:

```ts
// Express handler example
app.post("/chat-token", requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user;
  const cometchatUid = `${tenantId}_${userId}`;

  const r = await fetch(
    `https://${APP_ID}.api-${REGION}.cometchat.io/v3.0/users/${cometchatUid}/auth_tokens`,
    {
      method: "POST",
      headers: { appID: APP_ID, apiKey: API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    },
  );
  const { data } = await r.json();
  res.json({ authToken: data.authToken });
});
```

Source: https://www.cometchat.com/docs/rest-api/users-apis/create-auth-token

## 4. Login from the client

```ts
import { CometChat } from "@cometchat/chat-sdk-javascript";

const { authToken } = await fetch("/chat-token").then((r) => r.json());
await CometChat.init(APP_ID, settings);
await CometChat.loginWithAuthToken(authToken);
```

## 5. Group creation with tenant scoping

Always prefix group IDs and gate creation server-side:

```bash
curl -X POST "https://${APP_ID}.api-${REGION}.cometchat.io/v3.0/groups" \
  -H "appID: $APP_ID" -H "apiKey: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "guid": "tenant_42_project_777",
    "name": "Project 777",
    "type": "private",
    "owner": "tenant_42_user_8911",
    "metadata": { "tenantId": "42" }
  }'
```

## 6. Friend lists / search isolation

Don't expose the global users API to clients. Add a server endpoint that filters by `metadata.tenantId` and returns only users from the caller's tenant. Use that endpoint to populate "new chat" pickers — never `CometChat.getUsers()` raw on the client.

## 7. Audit checklist

- Every UID and GUID in your CometChat app starts with a known tenant prefix.
- Every Auth Token mint path checks tenant ownership before calling CometChat.
- Every "find users / find groups" UI hits *your* server, not CometChat's global list endpoint.
- Webhooks for new users/groups verify the prefix matches the expected tenant.

## Common pitfalls

- **Letting clients call `CometChat.getUsers()` directly** — returns all users across all tenants. Always proxy.
- **Using the same Auth Key in dev and prod** — leaked → cross-tenant impersonation. Rotate.
- **Forgetting to scope group invites server-side** — a tenant_42 admin invites tenant_99 users via guessable UIDs.
- **Storing tenantId only client-side** — server-side audit becomes impossible. Always also store in `metadata`.

## What to read next

- Authentication overview: https://www.cometchat.com/docs/fundamentals/authentication-overview
- Users APIs: https://www.cometchat.com/docs/rest-api/users-apis
- Groups APIs: https://www.cometchat.com/docs/rest-api/groups-apis
