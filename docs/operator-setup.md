# Operator setup

Step-by-step wiring to run `arc-mcp-hub` in front of your ARC-1 instances. Do this once per landscape,
plus one short step per backend system. Everything here is BTP configuration — no code changes.

For the *requirements* behind these steps — and how to onboard a **non-ARC-1** MCP server — see
[integrating-an-mcp-server.md](integrating-an-mcp-server.md).

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

### 2b-2. Reference the backend scope in a HUB role-template (the part that's easy to miss)

A backend's scope only reaches a user's token **if it is referenced by a role-template of the app the
token is issued for** — i.e. the **hub**, not the backend. So the hub's `xs-security.json` must:
- accept the foreign scope: `"foreign-scope-references": ["$XSAPPNAME(application,arc1-mcp).admin"]`, and
- reference it inside a role-template (the shipped `DevAdmin`):
  ```jsonc
  { "name": "DevAdmin",
    "scope-references": ["$XSAPPNAME.use", "$XSAPPNAME(application,arc1-mcp).admin"] }
  ```
  plus the `arc-mcp-hub Dev Admin` role-collection built from it.

**For each additional backend, add a `foreign-scope-reference` + a role-template (+ collection) that
references *that* backend's scope, then `cf update-service <arc-mcp-hub xsuaa> -c xs-security.json`.**
The `$XSAPPNAME(application,...)` form is a deploy-time placeholder valid only inside `xs-security.json`
— never send it in a token request (the live scope is the instance-suffixed `arc1-mcp!t627062.admin`).

### 2c. Assign developers the HUB role collection — under the right IdP

**Assign the *hub's* `arc-mcp-hub Dev Admin` collection, not the backend's `ARC-1 Admin`.** A backend
role collection is invisible to the hub-issued token; the hub's collection is what carries the backend
scope through (per SAP's "tightly-coupled principal propagation" pattern). Assign it under the IdP the
developer actually logs in with — for business users on a custom IAS that's `sap.custom`, not
`sap.default`:

```bash
btp assign security/role-collection "arc-mcp-hub Dev Admin" --to-user dev@example.com --of-idp sap.custom
```

> Two #1-setup-failure traps: (1) assigning the **backend** collection instead of the **hub** one →
> `invalid_scope: "user is not allowed any of the requested scopes"` at the hub→backend exchange;
> (2) the wrong **IdP** (`sap.default` vs `sap.custom`) → `invalid_scope` at login. Check a token's
> `origin` claim if unsure. **After assignment the developer must log in again** — a cached token won't
> carry the new scope.

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
| **(MCP client login)** `invalid_scope: "<hub-app>!<inst>.admin is invalid. Please use a valid scope name"` | The hub advertised arc-1's scope names (`read…admin`) in `scopes_supported`, so the client requested a scope the **hub** xsuaa doesn't define (it only defines `.use`). The hub must advertise **only `openid`** (`HUB_SCOPES = ['openid']` in `src/auth.ts`); the backend scope still reaches the user via the role collection at jwt-bearer exchange, not via the authorize request. Redeploy the hub. |
| **(MCP client)** `invalid_token: "not a valid XSUAA, OIDC, or API key token"` | The client obtained a token whose `aud` lacks the hub app (or carries only a foreign app) → `@sap/xssec` rejects it. Same fix: advertise `openid` so the issued token is `{scope:[openid], aud:[openid, <hub-client>]}` — the shape xssec validates. **After deploying the fix, clear the client's cached OAuth/DCR registration** (e.g. a fresh incognito window; clients cache it per server URL) so it re-authorizes against the new metadata. |
| `invalid_scope: "user is not allowed any of the requested scopes"` (hub→backend exchange) | **The #1 issue.** The user was assigned the **backend's** role collection, not the **hub's** `arc-mcp-hub Dev Admin`. A backend collection is invisible to the hub-issued token. Assign the hub collection (2c) **and re-login**. Also confirm the hub's `DevAdmin` role-template references the foreign scope (2b-2). |
| Login → `invalid_scope` | Wrong IdP for the assignment (`sap.default` vs `sap.custom`). Re-assign `--of-idp sap.custom`; check the token `origin` claim. |
| `Destination Service auth token error: Bad credentials` | The destination's `clientId`/`clientSecret` are invalid — use the hub xsuaa's **stable** creds (from `cf env`, or a *persistent* service key), not an ephemeral key you then delete. |
| Backend 401 `invalid_token` | Hub's xsuaa missing the `jwt-bearer` grant (in `xs-security.json` — redeploy), or the destination `scope` doesn't put the backend xsappname in the audience (2a). |
| `Unable to map issuer` | Hub and backend are in **different subaccounts**. v1 needs same subaccount. |
| Destination "did not yield a per-user bearer" | The destination isn't `OAuth2JWTBearer` (2a). |
| Tools list is empty (0) | The exchanged token reached the backend but carries no backend scope — finish the 2b-2 + 2c chain. Not a transport bug. |
| `No BTP destination service binding` at startup | Hub isn't bound to a destination service — check `cf services`. |

---

## Optional: the `/all` endpoint — one URL, every system

By default each system has its own path (`/dev/mcp`), binding the system to the connection. To let a
client reach **all** systems through one URL, enable the aggregated endpoint:

```bash
# optionally label each system for the model
cf set-env arc-mcp-hub HUB_BACKENDS '[{"name":"dev","destination":"arc1-dev","description":"S/4HANA 2023 (758)"},{"name":"s4-2025","destination":"arc1-2025","description":"ABAP Platform 2025 (816)"}]'
cf set-env arc-mcp-hub HUB_ALL_ENDPOINT true
cf restart arc-mcp-hub
```

Connect a client to `https://<hub>/all/mcp`. Every tool gains a **required `system` parameter** whose enum
lists the systems that expose it; the model names the target system on each call. Cost is ≈ one tool set
(homogeneous backends → no per-system description duplication), not N×.

> **Safety:** `/all` lets the model choose the system per call, so it does **not** have the per-connection
> isolation of the path-scoped routes. Make a misroute *harmless*, not merely unlikely: on any PROD
> backend set `SAP_ALLOW_WRITES=false` **and** point ARC-1 at a **read-only SAP user**. The `system` enum
> and server instructions steer the model but are not controls (per the MCP spec, instructions are
> best-effort).

**Verify:** connect to `/all/mcp`, confirm the tools show a `system` parameter, then run a read on two
systems (e.g. `SAPRead` `type=COMPONENTS` with `system=dev` vs `system=s4-2025`) and check the `SAP_BASIS`
release differs — proving each call routed to a distinct backend as you.
