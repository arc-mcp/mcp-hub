# Integrating an MCP server behind arc-mcp-hub

How to put **any** MCP server — not just ARC-1 — behind the hub: the hard requirements, what you
change in your server, and where [`@arc-mcp/xsuaa-auth`](https://github.com/arc-mcp/xsuaa-auth) saves
you work. Every BTP/XSUAA claim below links to a primary source ([References](#references)); the three
facts SAP doesn't document in a reference page but this project verified live are flagged as such.

> The hub is **multi-MCP-backend**, not just multi-SAP-system. ARC-1 across DEV/QA/PROD is the headline
> use case, but a *different* SAP MCP server (e.g. an i18n/translation server) drops in the same way —
> its tools simply appear on their own path. Nothing in the hub is ARC-1-specific.

---

## TL;DR — the fit checklist

A server can sit behind the hub today if **all** of these hold. The first two make it *routable*; the
last two preserve *per-user identity* (the hub's whole point).

| # | Requirement | Why | Source |
|---|---|---|---|
| 1 | Speaks **MCP over Streamable HTTP** at a stable path (e.g. `/mcp`) | The proxy bridges `StreamableHTTPServerTransport`⇄`ClientTransport`; stdio-only has no network endpoint | [MCP transports][M1] · [`src/proxy.ts`](../src/proxy.ts) |
| 2 | **Reachable via a BTP destination** | The hub reads the backend URL **and** its auth from a destination, never from config | [Find a Destination API][D5] · [`src/exchange.ts`](../src/exchange.ts) |
| 3 | **XSUAA resource server in the *same subaccount*** | The hub mints an XSUAA JWT from that subaccount's auth server; trust is bounded to the subaccount | [tenant-mode `dedicated`][T1] |
| 4 | **Exposes ≥1 scope and grants it to the hub** (`granted-apps`) | The exchange must put the backend's app in the token audience and the user must actually carry that scope | [`granted-apps`][X1] · [RFC 8707][R2] |

ARC-1 and the LISA i18n server both satisfy all four, so they need **zero hub code** — just config
([operator-setup.md](operator-setup.md)).

---

## How the hub reaches a backend (the mechanism you must satisfy)

On every backend request the hub does exactly this ([`src/exchange.ts`](../src/exchange.ts),
[`src/proxy.ts`](../src/proxy.ts)):

1. Validates the caller's inbound XSUAA bearer (one shared login, [RFC 9728][R3] per-path discovery).
2. Calls `lookupDestinationWithUserToken(cfg, destination, userJwt)` — the BTP Destination Service
   **find-a-destination** call with the user's JWT passed as `X-User-Token`. Because the destination is
   typed **`OAuth2JWTBearer`**, the service *exchanges* that user token for a per-user token to the
   backend and returns it under `authTokens` (`type: "Bearer"`, `value`, ready `http_header`).[^d1][D6]
3. Reads the backend URL from the **same** destination, and injects `Authorization: Bearer <token>` on
   the proxied `/mcp` call — **re-resolved per outbound request** against the session's *current* user
   token (never cached for the session).

The load-bearing line is the guard in `createResolver`:

```ts
const { destination: dest, authTokens } = await lookupDestinationWithUserToken(cfg, destination, userJwt);
const bearer = authTokens.bearerToken;
if (!bearer) {
  throw new Error(`Destination '${destination}' did not yield a per-user bearer. ` +
    'Configure it as type OAuth2JWTBearer (per-user principal propagation) on the backend MCP server.');
}
```

So **the destination must be `OAuth2JWTBearer`** and the backend must accept the token it produces.
`OAuth2JWTBearer` is one of SAP's *named-user* (principal-propagation) auth types — it carries the
logged-in user, not a technical user.[D1][D8] That is what makes "SAP sees the real you" true end to end.

---

## Requirements in detail

### 1. MCP over Streamable HTTP

The proxy is a raw transport bridge (the MCP Inspector pattern): it relays `initialize`, the session id,
SSE, `tools/list`, and `tools/call` verbatim, so your tool surface passes through unchanged. It connects
with `StreamableHTTPClientTransport`, so your server must expose the **Streamable HTTP** transport (the
current MCP HTTP transport, which replaced HTTP+SSE as of spec revision 2025-06-18).[M1] A **stdio-only**
server cannot be fronted — wrap it in Streamable HTTP first.

### 2. Reachable via a BTP destination

The hub resolves both URL and auth from the destination, so it never needs the backend baked into its
own config — adding a backend is "create a destination + one `HUB_BACKENDS` entry"
([`src/config.ts`](../src/config.ts)). The destination can point at a public URL **or** an on-prem system
via the Cloud Connector — that's the destination's concern, transparent to the hub. (For on-prem
*backends*, note the destination type is still `OAuth2JWTBearer` to the **MCP server**; whatever the MCP
server does to reach *its* SAP — basic auth, or its own principal propagation via Cloud Connector[D4] —
is a separate hop the hub never sees.)

### 3. XSUAA resource server, same subaccount

The token the hub injects is an **XSUAA-issued JWT** scoped to the backend. Your server must validate it
as an OAuth 2.1 resource server. **Same subaccount is mandatory in v1:** with XSUAA `tenant-mode:
dedicated`, a token is only issued for a user who authenticates against the identity zone where the
xsuaa instance was created — cross-subaccount reuse fails until explicit trust is configured.[T1]
*(Project-verified: cross-subaccount attempts surface as "Unable to map issuer" — see
[Verification status](#verification-status).)*

### 4. Expose a scope and grant it to the hub

Two BTP constructs make the user's scope reach the backend through the exchange:

- **On the backend's** `xs-security.json`: a scope with **`granted-apps`** naming the hub, e.g.
  `"granted-apps": ["$XSAPPNAME(application,arc-mcp-hub)"]`. This authorizes the hub to receive that
  scope as a *foreign* scope.[X1]
- **On the hub:** a matching **`foreign-scope-references`** entry plus a role-template/role-collection
  that carries it, and a destination whose **`scope`** property requests it (which audience-restricts the
  exchanged token to the backend, per [RFC 8707][R2]). These hub-side steps are already documented in
  [operator-setup.md §2](operator-setup.md) — repeat them once per new xsappname.

A scope reaches a *user* only via `scope-reference → role-template → role-collection → assignment`;[X1]
a backend role collection assigned to the user is **invisible** to a hub-issued token — the reference
must live on the hub. This is the single most common onboarding mistake (see operator-setup
troubleshooting).

---

## What you change in your MCP server

If you're building or adapting a Node/TypeScript SAP MCP server, the delta to become hub-ready is small
and **none of it touches your tools or business logic** (the proxy is transparent):

| Change | Effort | Helped by `@arc-mcp/xsuaa-auth`? |
|---|---|---|
| Expose Streamable HTTP `/mcp` (if stdio-only today) | MCP SDK's `StreamableHTTPServerTransport` | No — that's the MCP SDK |
| Validate the hub's XSUAA bearer in front of `/mcp` | a few lines | **Yes** — `setupHttpAuth` / `createXsuaaTokenVerifier` |
| Ship an `xs-security.json` with a scope + `granted-apps` for the hub | config file | No — XSUAA platform config |
| Deploy on CF in the hub's subaccount, bound to an xsuaa instance | `cf push` + `manifest.yml` | No — platform |

What you **don't** change: your existing tools, and however your server already reaches *its* SAP system
(basic auth, principal propagation, etc.) — the hub doesn't care.

---

## Where `@arc-mcp/xsuaa-auth` helps (and where it can't)

[`@arc-mcp/xsuaa-auth`](https://www.npmjs.com/package/@arc-mcp/xsuaa-auth) (MIT, public on npm, v0.1.3)
is the auth layer **extracted from ARC-1** — its own header says it is *"lifted near-verbatim from arc-1
`src/adt/btp.ts`."* It's a thin, MCP-shaped wrapper over SAP's official libraries
([`@sap/xssec`](https://www.npmjs.com/package/@sap/xssec) for XSUAA validation,
[`@sap-cloud-sdk/connectivity`](https://www.npmjs.com/package/@sap-cloud-sdk/connectivity) for the
destination lookup). **The hub itself is built on it** ([`src/auth.ts`](../src/auth.ts),
[`src/exchange.ts`](../src/exchange.ts)), and so is ARC-1 — using it for a new backend means doing the
exact thing two production servers already do.

**Inbound (the part you need to satisfy requirement 3)** — core entrypoint `.`:

```ts
import express from 'express';
import { setupHttpAuth, loadXsuaaCredentials, resolveAppUrl } from '@arc-mcp/xsuaa-auth';

const app = express();
app.use(express.json());

// Validates XSUAA bearers (the token the hub mints) and returns requireBearerAuth middleware.
const bearer = setupHttpAuth(app, {
  xsuaa: { credentials: loadXsuaaCredentials(), appUrl: resolveAppUrl(process.env) },
  required: true,
});

app.post('/mcp', bearer, handleStreamableHttpMcp); // your MCP server, now guarded
```

`loadXsuaaCredentials()` reads the bound xsuaa from `VCAP_SERVICES`; `setupHttpAuth` mounts the OAuth
router + returns the bearer middleware. That's the whole inbound requirement. (It also supports OIDC /
Entra ID and API keys via the same `AuthOptions` if you want non-XSUAA callers too.) A runnable example
ships in the package: `examples/express-setup-http-auth.ts`.

**Outbound (only if your backend itself does per-user SAP principal propagation)** — `./btp` entrypoint
exposes `parseVCAPServices`, `lookupDestination`, `lookupDestinationWithUserToken`, and
`createConnectivityProxy` (Cloud Connector). ARC-1 uses these to reach on-prem SAP as the user; your
server would too if it needs the same.

**What it does *not* do** — and no library can:

- The **BTP platform wiring** — `granted-apps`, `foreign-scope-references`, the role-template/collection,
  the destination — is XSUAA *configuration*, not code. ([operator-setup.md](operator-setup.md) covers it.)
- It's **Node/TypeScript only.** A Python or black-box MCP server brings its own XSUAA validation (SAP
  ships [`sap-xssec`](https://pypi.org/project/sap-xssec/) for Python), or takes the shared-identity path
  below.

---

## The end-to-end auth chain

```
 MCP client            arc-mcp-hub                         your MCP backend            SAP
 ──────────            ───────────                         ────────────────            ───
  discover  ─────────► /.well-known/oauth-protected-resource/<env>/mcp   [RFC 9728]
  one login ─────────► shared XSUAA AS  ──► user XSUAA JWT (for the hub)
  call /<env>/mcp ───► validate bearer
                       lookupDestinationWithUserToken(dest, userJwt)
                         └─ OAuth2JWTBearer exchange  [RFC 7523 jwt-bearer grant]
                            → per-user token, aud = backend  [RFC 8707]   ──► validate XSUAA bearer
                       proxy bridge (bearer per request) ──────────────────► /mcp tools  ──► (server's own
  tools/call ────────► relayed verbatim ◄───────────────────────────────── result          principal prop.) ─► SAP
```

Each hop is grounded: discovery [RFC 9728][R3]; the exchange grant type [RFC 7523][R1]; audience binding
[RFC 8707][R2]; the destination exchange + `X-User-Token`/`authTokens` [SAP Destination Service][D1][D6];
named-user vs technical auth types [SAP][D8]; the backend's own on-prem hop [SAP principal propagation][D4].

---

## The boundary: non-XSUAA or non-Node backends

Today the hub **requires** a per-user bearer — `createResolver` throws without one (above). So a server
that isn't XSUAA-protected (an API-key or BasicAuth MCP server) **cannot** be fronted as-is.

Supporting it would be a small, deliberate change (~15–20 lines in [`src/exchange.ts`](../src/exchange.ts)):
when the destination yields no per-user bearer, fall back to the destination's own technical auth
(`OAuth2ClientCredentials` token or a `BasicAuthentication` header — both returned by the same
find-destination call). **The cost is the product's core property: per-user identity is lost** — every
user reaches the backend as one shared technical identity, which SAP explicitly recommends against in
favour of named users.[D8] It's only acceptable for an inherently shared, low-risk backend (e.g. a
read-only reference-data server). **Not implemented** — documented here as the known extension point so
the boundary is explicit, not accidental.

---

## Worked example: an i18n MCP server (LISA-shaped)

A translation/i18n MCP server that is Node/TS, Streamable HTTP, XSUAA-protected, and does principal
propagation to SAP satisfies all four requirements, so it onboards with **no hub code change**:

1. Deploy it in the hub's subaccount with its own xsappname (e.g. `lisa`), bound to an xsuaa instance.
2. On its `xs-security.json`, add `granted-apps: ["$XSAPPNAME(application,arc-mcp-hub)"]` to the scope
   the hub should obtain; `cf update-service <lisa-xsuaa> -c xs-security.json`.[X1]
3. On the hub: add a `foreign-scope-references` + a role-template + role-collection for that scope, and a
   destination (`OAuth2JWTBearer`) to the server's `/mcp` with the matching `scope`
   ([operator-setup.md §2](operator-setup.md)).
4. `HUB_BACKENDS += {"name":"i18n","destination":"lisa"}`; restart. The server's tools appear at
   `/i18n/mcp`.
5. Assign yourself the new role-collection (under the right IdP, e.g. `--of-idp sap.custom`) and re-login.

The **only** extra versus adding another ARC-1 dev system that *shares* ARC-1's xsappname is steps 2–3 +
5: a distinct xsappname needs its own foreign-scope chain and a re-login. Different tool surfaces (i18n
vs dev) are a feature here — an LLM cannot confuse `/i18n/mcp` with `/dev/mcp`.

---

## Verification status

Three facts used above are **not stated on a SAP Help *reference* page**, but were **verified live in
this project** against real BTP (joule2 subaccount) and corroborated by SAP examples. They are presented
as project-verified, not as SAP-documented, on purpose:

| Fact | SAP Help reference page? | Evidence used |
|---|---|---|
| `oauth2-configuration.grant-types` is an allowlist; **`urn:ietf:params:oauth:grant-type:jwt-bearer` must be added explicitly** (not in the default) | Not enumerated on the [xs-security syntax page][X1] | Live: the exchange failed with *"Unauthorized grant type"* until the URN was added to the **hub's** xsuaa; the grant itself is [RFC 7523][R1]; SAP Cloud SDK XSUAA examples show it added explicitly |
| The live xsappname/scope carries an **instance suffix** (`arc1-mcp!t627062.admin`) | Suffix scheme not formally documented; a `!b`-suffixed `clientid` appears in a SAP sample[X2] | Live: read from the backend's `VCAP_SERVICES.xsuaa.xsappname`; used verbatim as the destination `scope` |
| Cross-subaccount exchange fails with **"Unable to map issuer"** | Trust *boundary* documented[T1]; exact symptom string not | Live: observed cross-subaccount; the boundary cause is the `tenant-mode: dedicated` trust model[T1] |

Everything else carries a primary-source citation below.

---

## References

### A — SAP BTP: Destination Service & Principal Propagation

- **[D1]** OAuth2JWTBearer Authentication — *"the cloud user identity has to be passed … as a token
  represented by a JSON Web token (JWT) … the token will be passed as an 'X-User-Token' to the
  Destination service, which then will return authTokens."*
  <https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/oauth-jwt-bearer-authentication-a728ae0850594b0d828cb4e426ac518e>
- **[D2]** OAuth2SAMLBearerAssertion Authentication — *"You can call an OAuth2-protected remote system/API
  and propagate a user ID to the remote system by using the `OAuth2SAMLBearerAssertion` authentication
  type."*
  <https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/oauth-saml-bearer-assertion-authentication>
- **[D3]** Principal Propagation (auth-type overview) — *"The user is propagated from a cloud application
  to another remote (cloud) system using a destination configuration with authentication types
  `OAuth2SAMLBearerAssertion` or `OAuth2JWTBearer`."*
  <https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/principal-propagation-e2cbb48def4342048362039cc157b12e>
- **[D4]** Principal Propagation to on-premise — *"forwarded via the Transparent Proxy to the
  Connectivity Proxy … and then to the Cloud Connector, which validates and further processes it to
  establish SSO with the on-premise system."*
  <https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/principal-propagation-456b58cd5cd541d897f4bd3edf8ef7d2>
- **[D5]** Calling the Destination Service REST API (`/destination-configuration/v1/destinations`).
  <https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/calling-the-destination-service-rest-api>
- **[D6]** Find a Destination — Response Structure — `authTokens`: *"`type`: the type of the token.
  `value`: the actual token."* (Bearer entries also carry a ready `http_header`.)
  <https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/find-a-destination-response-structure>
- **[D7]** OAuth User Token Exchange Authentication — `authTokens` Bearer `value` + `http_header`;
  `tokenServiceURLType` `Dedicated`/`Common`.
  <https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/oauth-user-token-exchange-authentication>
- **[D8]** SAP Cloud SDK — Destinations: flows that **require a user JWT** (OAuth2UserTokenExchange,
  OAuth2JWTBearer, OAuth2SAMLBearerAssertion, PrincipalPropagation) vs technical flows
  (BasicAuthentication, OAuth2ClientCredentials, ClientCertificateAuthentication).
  <https://sap.github.io/cloud-sdk/docs/js/features/connectivity/destinations>
- **[D9]** SAP-samples (Kyma user-propagation) — `X-user-token` header → *"Destination Service after
  validating the token responds … an opaque OAuth2 token for the logged-in user."*
  <https://github.com/SAP-samples/kyma-runtime-extension-samples/blob/main/user-propagation/README.md>

### B — SAP BTP: XSUAA Application Security (`xs-security.json`)

- **[X1]** Application Security Descriptor Configuration Syntax — `foreign-scope-references` (*"reference
  scopes in foreign applications (for a user scenario)"*); `granted-apps` (*"specify the application you
  want to grant your scope to … receives the scope as a 'foreign' scope"*); `$XSAPPNAME(<plan>,<xsappname>).<scope>`
  syntax; `scope-references` → role-templates → role-collections → user assignment.
  <https://help.sap.com/docs/btp/sap-business-technology-platform/application-security-descriptor-configuration-syntax>
- **[X2]** Getting an Application Access Token (sample `clientid` exhibits the `!b`-style instance suffix).
  <https://help.sap.com/docs/btp/sap-business-technology-platform/getting-application-access-token>

### C — OAuth RFCs & MCP

- **[R1]** RFC 7523 — JWT Profile for OAuth 2.0 Authorization Grants: grant type
  `urn:ietf:params:oauth:grant-type:jwt-bearer`. <https://www.rfc-editor.org/rfc/rfc7523>
- **[R2]** RFC 8707 — Resource Indicators: *"The authorization server SHOULD audience-restrict issued
  access tokens to the resource(s) indicated by the 'resource' parameter."* <https://www.rfc-editor.org/rfc/rfc8707>
- **[R3]** RFC 9728 — OAuth 2.0 Protected Resource Metadata: the `resource` identifier (REQUIRED) +
  `authorization_servers`. <https://www.rfc-editor.org/rfc/rfc9728>
- **[M1]** MCP specification (2025-06-18) — Transports: Streamable HTTP, *"This replaces the HTTP+SSE
  transport from protocol version 2024-11-05."* <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>

### D — SAP: trust boundary

- **[T1]** SAP-samples (BTP multitenant SaaS) — `tenant-mode: dedicated`: *"XSUAA (overall) would only
  issue a token for a user, if he authenticates against the identity-zone in which the Auth. & Trust
  Mgmt. service instance was created."*
  <https://github.com/SAP-samples/btp-cap-multitenant-saas/blob/main/docu/2-basic/7-explore-the-components/components/Multitenancy.md>

### E — Project code & the auth module

- Hub: [`src/exchange.ts`](../src/exchange.ts) · [`src/auth.ts`](../src/auth.ts) ·
  [`src/proxy.ts`](../src/proxy.ts) · [`src/config.ts`](../src/config.ts) ·
  [architecture.md](architecture.md) · [operator-setup.md](operator-setup.md)
- `@arc-mcp/xsuaa-auth`: <https://github.com/arc-mcp/xsuaa-auth> ·
  <https://www.npmjs.com/package/@arc-mcp/xsuaa-auth> — wraps
  [`@sap/xssec`](https://www.npmjs.com/package/@sap/xssec) +
  [`@sap-cloud-sdk/connectivity`](https://www.npmjs.com/package/@sap-cloud-sdk/connectivity).

[D1]: https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/oauth-jwt-bearer-authentication-a728ae0850594b0d828cb4e426ac518e
[D4]: https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/principal-propagation-456b58cd5cd541d897f4bd3edf8ef7d2
[D5]: https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/calling-the-destination-service-rest-api
[D6]: https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/find-a-destination-response-structure
[D8]: https://sap.github.io/cloud-sdk/docs/js/features/connectivity/destinations
[X1]: https://help.sap.com/docs/btp/sap-business-technology-platform/application-security-descriptor-configuration-syntax
[X2]: https://help.sap.com/docs/btp/sap-business-technology-platform/getting-application-access-token
[R1]: https://www.rfc-editor.org/rfc/rfc7523
[R2]: https://www.rfc-editor.org/rfc/rfc8707
[R3]: https://www.rfc-editor.org/rfc/rfc9728
[M1]: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
[T1]: https://github.com/SAP-samples/btp-cap-multitenant-saas/blob/main/docu/2-basic/7-explore-the-components/components/Multitenancy.md

[^d1]: The hub uses the SAP Cloud SDK's destination lookup (via `@arc-mcp/xsuaa-auth/btp`), which calls
the find-a-destination API and returns the exchanged per-user token in `authTokens` — see [D6], [D8].
