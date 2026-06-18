# Operator setup

Step-by-step wiring to run `arc-mcp-hub` in front of your ARC-1 instances. Do this once per landscape,
plus one short step per backend system. Everything here is BTP configuration — no code changes.

> **Prerequisite:** the hub and all backend ARC-1 instances must be in the **same BTP subaccount**.
> The per-user token exchange only maps the issuer within one subaccount (cross-subaccount fails with
> `Unable to map issuer`). Cross-subaccount is on the roadmap, not in v1.

---

## 1. Deploy the hub

```bash
npm ci && npm run build
cf push                      # manifest.yml
# or, for MTA:  mbt build && cf deploy mta_archives/arc-mcp-hub_0.1.0.mtar
```

This creates the app plus two service instances: `arc-mcp-hub-xsuaa` (its OAuth identity) and
`arc-mcp-hub-destination` (how it reaches backends). Set a stable DCR secret so logins survive
redeploys:

```bash
cf set-env arc-mcp-hub ARC_HUB_DCR_SIGNING_SECRET "$(openssl rand -base64 48)"
cf restart arc-mcp-hub
```

---

## 2. Per backend system — repeat for dev / qa / prod

### 2a. Create a destination (`OAuth2JWTBearer`)

In the subaccount → **Connectivity → Destinations → New Destination**:

| Field | Value |
|---|---|
| Name | `arc1-dev` (matches `HUB_BACKENDS[].destination`) |
| Type | `HTTP` |
| URL | `https://<arc1-dev-host>/mcp` *(the backend's `/mcp` endpoint)* |
| Proxy Type | `Internet` |
| Authentication | `OAuth2JWTBearer` |
| Token Service URL Type | `Dedicated` |
| Token Service URL | `https://<subaccount>.authentication.<region>.hana.ondemand.com/oauth/token` |
| Client ID / Secret | the **hub's** xsuaa `clientid` / `clientsecret` (from `cf env arc-mcp-hub` → `VCAP_SERVICES.xsuaa`) |
| `scope` (additional property) | `<backend-xsappname>!<instance>.<scope>` — e.g. `arc1-mcp!t627062.admin` |

The `scope` is what forces the **backend's** xsappname into the exchanged token's audience. Note it is
the **instance-suffixed** form (`arc1-mcp!t627062.admin`, not `arc1-mcp.admin`). Find it in the
backend's `cf env` → `VCAP_SERVICES.xsuaa.xsappname`, plus the scope name (`.read`/`.write`/`.admin`).

### 2b. Grant the hub a scope on the backend

On the **backend** ARC-1's `xs-security.json`, add `granted-apps` to the scope you reference above, then
update the backend's xsuaa instance:

```jsonc
"scopes": [
  { "name": "$XSAPPNAME.admin", "description": "...",
    "granted-apps": ["$XSAPPNAME(application,arc-mcp-hub)"] }   // <- add this
]
```

```bash
cf update-service <backend-xsuaa> -c xs-security.json
```

The hub's own `xs-security.json` declares `"foreign-scope-references": ["$ACCEPT_GRANTED_SCOPES"]` —
the wildcard that accepts whatever any backend grants it, so you don't edit the hub per backend. (The
per-app form `$XSAPPNAME(application,arc1-mcp)` is rejected by XSUAA as an invalid scope name; use the
wildcard.)

### 2c. Assign developers the backend role collection — under the right IdP

Developers need the backend's role collection (e.g. `ARC-1 Admin`) **assigned under the IdP they
actually log in with**. For business users on a custom IAS that is `sap.custom`, not `sap.default`:

```bash
btp assign security/role-collection "ARC-1 Admin" --to-user dev@example.com --of-idp sap.custom
```

> Wrong IdP here is the #1 setup failure: XSUAA returns `invalid_scope` at login if the user doesn't
> hold the requested scope **under that IdP**. Check a user's token `origin` claim if unsure.

Also assign them the hub's own collection so they can reach the hub:
`btp assign security/role-collection "arc-mcp-hub User" --to-user dev@example.com --of-idp sap.custom`.

### 2d. Harden PROD (defense in depth)

On the **PROD** ARC-1 instance set `SAP_ALLOW_WRITES=false` **and** point it at a read-only SAP user.
Routing already prevents cross-environment mistakes; this makes a mistake harmless even if it happens
(read-only flags can fail open, so the read-only SAP user is the real backstop).

---

## 3. Tell the hub about the backends

```bash
cf set-env arc-mcp-hub HUB_BACKENDS '[{"name":"dev","destination":"arc1-dev"},{"name":"prod","destination":"arc1-prod"}]'
cf restart arc-mcp-hub
```

`name` becomes the URL path (`/dev/mcp`); `destination` is the BTP destination from step 2a.

---

## 4. Verify

```bash
curl https://<hub>/healthz        # -> {"status":"ok","backends":["dev","prod"]}
```

Then connect an MCP client to `https://<hub>/dev/mcp` (one browser login) and confirm the backend's
tools list and a read call works **as you** (check the backend's audit shows your user). Repeat for
each env.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Login → `invalid_scope` | User lacks the backend role collection under the login IdP. Assign it `--of-idp sap.custom` (2c). |
| Backend 401 `invalid_token` | The hub's xsuaa is missing the `jwt-bearer` grant (it's in `xs-security.json` — redeploy), or the destination `scope` doesn't put the backend xsappname in the audience (2a). |
| `Unable to map issuer` | Hub and backend are in **different subaccounts**. v1 needs same subaccount. |
| Destination "did not yield a per-user bearer" | The destination isn't `OAuth2JWTBearer` (2a). |
| Tools list is empty (0) | The user's token has no backend scope — assign a role collection that grants one (2c). Not a transport bug. |
| `No BTP destination service binding` at startup | The hub isn't bound to a destination service — check `cf services`. |
