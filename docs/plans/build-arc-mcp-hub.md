# Build arc-mcp-hub — multi-system MCP hub

> **Status:** Implemented + **live BTP e2e PASSED** 2026-06-18 — 12 backend tools + a real `SAPSearch`
> read through the deployed hub, as the user (full chain: inbound auth → per-user OAuth2JWTBearer
> exchange → proxy → SAP principal propagation). Ready to publish.

## Overview

`arc-mcp-hub` is a thin, **deterministic** MCP multiplexing hub for SAP BTP Cloud Foundry. It fronts
N backend MCP servers (one ARC-1 instance per SAP system — DEV/QA/PROD) behind **per-environment
paths** (`/dev/mcp`, `/qa/mcp`, …). A developer authenticates **once** to the hub; the hub validates
their XSUAA token (inbound), exchanges it for a **per-user** token via a BTP destination (outbound),
and **transparently proxies** the MCP stream to the matched backend — preserving each backend's own
12-tool surface and per-user SAP principal propagation.

There is **no server-side LLM**: routing is by URL path, not natural language (the backends expose
identical tool surfaces, so there is nothing to route semantically). The hub reuses
`@arc-mcp/xsuaa-auth` for both auth halves and the MCP TypeScript SDK transports for the proxy. This
entire design was de-risked end-to-end against live BTP before this plan was written (see *Verified
Live Evidence*).

Success criteria (plain bullets — not checkboxes, per ralphex Rule 2):
- A client pointed at `https://<hub>/dev/mcp` lists the backend's 12 tools and can call them, as the
  logged-in user, with PROD-class systems enforceable as read-only at the backend.
- Adding/removing a system is **config + a BTP destination** — no code change.
- Local `npm test` / `npm run typecheck` / `npm run lint` are green; the repo is **published only
  after** a live BTP end-to-end test passes (Task 10).

> **Format note:** this plan follows the ralphex structure, but the target is a **fresh standalone
> repo**, not ARC-1. ARC-1-specific rules (three-file schema sync, ADT live-verification, `docs_page/`,
> `compare/`) do **not** apply. The SAP surface this project depends on was already verified live
> during the design phase; the remaining live check is the BTP e2e in Task 10.

## Context

### Current State
- The design is fully de-risked. The working spike lives in `~/dev/mcp-hub-spike/` (`proxy.mjs`,
  `client.mjs`, `get-backend-token.mjs`, `full-chain-test.mjs`, `exchange-test.mjs`). The full design
  record + rejected alternatives + live findings are in the ARC-1 repo at
  `docs/research/mcp-hub-multi-system.md`.
- `@arc-mcp/xsuaa-auth` v0.1.3 is published to npm (public), extracted from ARC-1's own auth stack.
- No `arc-mcp/mcp-hub` repo exists yet. Local dir: `~/dev/arc-mcp-hub`.

### Target State
- A TypeScript ESM (Node ≥22) repo deployable to BTP CF: one hub app, XSUAA + Destination service
  bindings, config-driven backends, per-env routes, transparent MCP proxy, per-user token exchange.

### Key Files

| File | Role |
|------|------|
| `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts` | Project scaffold + gates |
| `src/config.ts` | Parse + validate backends: `[{ name, destination }]` (env `HUB_BACKENDS` JSON) |
| `src/proxy.ts` | `mcpProxy` session-bridge + per-session transport map (from the spike) |
| `src/auth.ts` | Inbound (`xsuaa-auth` building blocks, per-route bearer) + outbound (`lookupDestinationWithUserToken` → bearer) |
| `src/server.ts` | Express app: mount `/<env>/mcp` per backend, wire auth + proxy + exchange |
| `src/index.ts` | Entry point (`startServer()`), reads `PORT`/`VCAP_*` |
| `xs-security.json` | Hub XSUAA: `jwt-bearer` grant + `foreign-scope-references` + redirect-uris |
| `manifest.yml`, `mta.yaml` | CF deploy descriptors (xsuaa + destination bindings) |
| `README.md` | Architecture + operator setup (destination, granted-apps, role collection, PROD read-only) |

### Verified Live Evidence
All captured live on the **joule2** subaccount (`marianzeis-02` global account), us10-001, 2026-06-17/18,
against `arc1-mcp-joule2` (arc-1 v0.6.10) bound to the `arc1-xsuaa` instance:

- **Inbound acceptance:** an `authorization_code` user token (`origin: sap.custom`,
  `user_name=email=marian@zeis.de`) → `POST /mcp initialize` → **HTTP 200**, `serverInfo: arc-1 0.6.10`.
  arc-1 accepts any valid XSUAA bearer regardless of how minted (its `/mcp` only runs `@sap/xssec`).
- **x5t / proof-of-possession:** non-issue — IAS-token-only and off by default for XSUAA bearers.
- **jwt-bearer exchange:** **enabled and identity-preserving** — a throwaway XSUAA instance with
  `urn:ietf:params:oauth:grant-type:jwt-bearer` in its grant-types exchanged a user token and
  preserved `user_name` + `email`. CRUCIAL: the grant is **NOT** enabled by default — arc-1's
  `arc1-xsuaa` grant-types are `[authorization_code, refresh_token]`, so a same-subaccount user-token
  exchange returned `invalid_client / "Unauthorized grant type"`. The HUB's xsuaa needs the
  `jwt-bearer` grant (it is the exchange *initiator*).
- **Transport, end-to-end:** the spike proxy (Inspector `mcpProxy` bridge: client-facing
  `StreamableHTTPServerTransport` ↔ backend-facing `StreamableHTTPClientTransport`, bearer injected
  **per request**) listed **all 12 arc-1 tools through the proxy** — `SAPRead, SAPSearch, SAPWrite,
  SAPActivate, SAPNavigate, SAPQuery, SAPLint, SAPDiagnose, SAPContext, SAPManage, SAPTransport,
  SAPGit` — with `serverInfo` + session bridge + SSE relay all transparent.
- **Scope/authz** flows through the proxy intact: a token with no arc-1 scope lists **0** tools
  (arc-1 prunes by scope); a token with `arc1-mcp!t627062.admin` lists all 12.
- **Gotchas (all reproduced live):** (1) inject bearer **per request**, not per session — a
  per-session static token caused a stale-token `invalid_token`; (2) arc-1 scopes are
  **instance-suffixed** (`arc1-mcp!t627062.admin`, not `arc1-mcp.admin`); (3) the user needs an arc-1
  role collection assigned **`--of-idp sap.custom`** (`origin: sap.custom`) or XSUAA returns
  `invalid_scope`; (4) benign `SSE stream disconnected: terminated` errors on session teardown must
  be filtered from logs.
- **Cross-subaccount** breaks at issuer mapping (`"Unable to map issuer"` = ARC-1 #434) → **same
  subaccount only** for v1.

### xsuaa-auth integration surface (v0.1.3, read from source)
- **Inbound:** `setupHttpAuth(app, { xsuaa: { credentials, appUrl, resourceName?, scopesSupported?,
  requiredScopes?, dcrSigningSecret?, callbackUrl? }, oidc?, apiKeys?, allowedOrigins?, required }, logger)`
  → returns the `requireBearerAuth` `RequestHandler` and mounts the OAuth router/callback. The facade
  binds **one** resource (`${appUrl}/mcp`); for per-path routes use the exported building blocks
  (`createXsuaaOAuthProvider`, `createChainedTokenVerifier`, `createOAuthCallbackHandler`,
  `loadXsuaaCredentials`, `resolveAppUrl`) — see Task 4 design decision.
- **Outbound:** `import { parseVCAPServices, lookupDestinationWithUserToken } from '@arc-mcp/xsuaa-auth/btp'`.
  `lookupDestinationWithUserToken(cfg, destName, userJwt)` → `{ destination, authTokens }` where
  `destination.URL` is the backend URL and `authTokens.bearerToken` is the per-user exchanged bearer
  (populated for `OAuth2JWTBearer` / `OAuth2UserTokenExchange` destinations). The SAP Cloud SDK caches
  per `tenant-user`, so calling it per request is cheap.
- Deps to add: `@arc-mcp/xsuaa-auth`, `@modelcontextprotocol/sdk` (>=1.18.2 <2), `express` (^5),
  `jose` (peer, OIDC). `@sap-cloud-sdk/connectivity` + `@sap/xssec` come transitively via xsuaa-auth.

### Design Principles
1. **Per-path routing = connection-scoped safety.** A session bound to `/dev/mcp` can only ever see
   DEV's tools — cross-environment mistakes are structurally impossible. No `env` parameter, no merged
   tool list. (This is the whole reason the hub is safe; do not add a runtime system selector.)
2. **No server-side LLM.** Deterministic path routing only.
3. **Transparent passthrough.** Tool names/schemas pass through unchanged; the hub never re-registers
   or renames tools. Stateful per-session transport bridge (required for session + SSE).
4. **Per-request token injection.** Re-resolve the per-user bearer on every outbound request (SDK-cached)
   — never cache a token for the session lifetime (proven stale-token failure).
5. **Same subaccount only (v1).** Hub + backends in one subaccount so jwt-bearer issuer-maps.
   Cross-subaccount (SAML-bearer / shared IAS) is explicitly out of scope → roadmap.
6. **Auth is the module's job.** Reuse `@arc-mcp/xsuaa-auth` for both halves; the hub writes glue, not
   crypto.
7. **PROD safety lives at the backend, not the hub.** Operators set `SAP_ALLOW_WRITES=false` + a
   read-only SAP user on the PROD arc-1 instance. The hub documents this; it does not enforce writes.
8. **Single instance (v1).** In-memory session map; document that scaling >1 needs sticky sessions or
   a shared store.

## Development Approach

TDD where it pays: write unit tests alongside `config.ts`, `proxy.ts`, `auth.ts` (mock the backend MCP
server and the xsuaa-auth boundary). The proxy and exchange are the load-bearing parts — test the
failure paths (missing/expired token → re-resolve; backend 404 → client re-init; unknown env → 404;
malformed `HUB_BACKENDS`). Keep `vi.mock` at the `@arc-mcp/xsuaa-auth/btp` boundary so unit tests run
without BTP. A **local** integration test runs the assembled server against a trivial in-process MCP
server (no BTP) to prove the transparent bridge. The **live BTP e2e (Task 10) is the publish gate** —
nothing is pushed to `arc-mcp/mcp-hub` until a real client lists 12 tools through the deployed hub as
the user. Fixtures/spike code provenance: the proxy bridge is ported from the proven
`~/dev/mcp-hub-spike/proxy.mjs` — keep its per-request-token and SSE-teardown-filter behavior.

## Validation Commands

- `npm test`
- `npm run typecheck`
- `npm run lint`

### Task 1: Scaffold the repo, gates, and CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.gitignore`,
  `.github/workflows/ci.yml`, `src/index.ts` (stub), `tests/smoke.test.ts`

Stand up a TypeScript ESM project (Node ≥22) so the validation gates run from task 1 onward. Mirror
the conventions of `@arc-mcp/xsuaa-auth` (ESM-only, Biome, vitest).

- [ ] `package.json`: `"name": "arc-mcp-hub"`, `"type": "module"`, `"engines": { "node": ">=22" }`,
      `"private": true` (flip to publishable in Task 10). Scripts: `build` (`tsc`), `typecheck`
      (`tsc --noEmit`), `test` (`vitest run`), `lint` (`biome check .`), `lint:fix` (`biome check --write .`),
      `dev` (`node --watch --import tsx src/index.ts` or `tsx watch`), `start` (`node dist/index.js`).
- [ ] Dependencies: `@arc-mcp/xsuaa-auth@^0.1.3`, `@modelcontextprotocol/sdk@^1.29.0`, `express@^5`,
      `jose@^6`. devDependencies: `typescript@^5`, `vitest@^3`, `@biomejs/biome`, `@types/express`,
      `@types/node`, `tsx`.
- [ ] `tsconfig.json`: `module`/`moduleResolution` `NodeNext`, `target` ES2023, `strict: true`,
      `noUnusedLocals`/`noUnusedParameters`, `outDir: dist`, `rootDir: src`.
- [ ] `biome.json`: 2-space, single quotes, 120 cols (match xsuaa-auth/arc-1 style).
- [ ] `vitest.config.ts`: node environment, `tests/**/*.test.ts`.
- [ ] `src/index.ts` stub exporting `startServer()` that just logs and listens on `PORT||9000` (filled
      in Task 6). `tests/smoke.test.ts`: one trivial passing test so `npm test` is green.
- [ ] `.github/workflows/ci.yml`: Node 22, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`.
- [ ] Run `npm install`, then `npm run typecheck && npm run lint && npm test` — all green.

### Task 2: Config module — backends from `HUB_BACKENDS`

**Files:**
- Create: `src/config.ts`, `tests/config.test.ts`

The hub's only config is the list of backends. Each backend is `{ name, destination }` — the backend
**URL and auth both come from the BTP destination** (`lookupDestinationWithUserToken` returns
`destination.URL`), so the hub config does NOT carry URLs. `name` becomes the path segment
(`/<name>/mcp`).

- [ ] Define and export:
      interface Backend { name: string; destination: string }
      interface HubConfig { backends: Backend[] }
- [ ] `loadHubConfig(env = process.env): HubConfig` — parse `env.HUB_BACKENDS` as JSON array of
      `{ name, destination }`. Validate: non-empty; each `name` matches `^[a-z0-9-]+$` (safe path
      segment, no `_`); `name` and `destination` non-empty; **names unique**. Throw a clear `Error`
      naming the offending entry on any violation.
- [ ] Add unit tests (~8 tests) in `describe('loadHubConfig')`: happy path (2 backends); empty/missing
      `HUB_BACKENDS` → throws; malformed JSON → throws; duplicate `name` → throws; bad `name`
      (`DEV`, `a_b`, ``) → throws; missing `destination` → throws.
- [ ] Run `npm test`.

### Task 3: Proxy module — transparent session bridge

**Files:**
- Create: `src/proxy.ts`, `tests/proxy.test.ts`

Port the proven bridge from `~/dev/mcp-hub-spike/proxy.mjs`. `mcpProxy` bridges raw transports so tool
names pass through unchanged; the session map keys the proxy's own `Mcp-Session-Id` to a held backend
transport. Backend URL + bearer are supplied by a **resolver callback** (injected by `server.ts`, so
this module has no auth/BTP dependency and is unit-testable).

- [ ] Export `mcpProxy({ toClient, toServer })` exactly as in the spike: forward `onmessage` both ways;
      on either `onclose`, close the other (double-close-guarded); filter benign `onerror` whose
      message matches `/terminated|abort/i` (SSE teardown noise).
- [ ] Export `createEnvHandlers({ getUserJwt, resolve })` where `getUserJwt(req) => string` and
      `resolve(userJwt) => Promise<{ url: string, bearer: string }>`. Returns `{ post, get, del }`
      Express handlers for one env's `/<env>/mcp`. **Per-request user-JWT tracking is the critical
      detail:** the backend transport's `fetch` override is created once at session-init and has no
      access to later requests, so the session object must hold a mutable `currentUserJwt` that every
      incoming request updates — the `fetch` override re-resolves the bearer against `currentUserJwt`,
      not the init JWT (this is how Design Principle 4 "per-request token" is actually achieved).
      - `post`: `const userJwt = getUserJwt(req)`. If `Mcp-Session-Id` maps to a live session →
        set `session.currentUserJwt = userJwt`, then `session.client.handleRequest(req,res,req.body)`.
        Else if `isInitializeRequest(req.body)` → `const { url } = await resolve(userJwt)` (URL fixed
        for the session); create the session object `{ client, backend, currentUserJwt: userJwt }`;
        build a `StreamableHTTPClientTransport(new URL(url), { fetch })` whose `fetch` override does
        `const { bearer } = await resolve(session.currentUserJwt); h.set('Authorization','Bearer '+bearer)`
        on every outbound call; build `StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
        onsessioninitialized: (id)=>store.set(id, session), onsessionclosed: (id)=>store.delete(id) })`;
        `mcpProxy({ toClient: client, toServer: backend })`; `await backend.start(); await client.start();`
        then `client.handleRequest(req,res,req.body)`. Else → 400.
      - `get`/`del`: look up session by `Mcp-Session-Id`; 404 if absent (→ client re-inits — the
        MetaMCP #294 lesson), else update `currentUserJwt` and delegate to `session.client.handleRequest(req,res)`.
- [ ] Module-level session store `Map<string,{client,backend,currentUserJwt}>` behind a tiny interface
      so it can be swapped for a shared store later (Design Principle 8).
- [ ] Add unit tests (~8 tests) in `describe('proxy')` against an **in-process MCP server** (use
      `@modelcontextprotocol/sdk` `McpServer` + an in-memory or loopback HTTP transport exposing 2 fake
      tools): initialize round-trips and returns a session id; `tools/list` relays the 2 tools through;
      a second request with the session id reuses the backend; unknown session on GET → 404; `resolve`
      throwing (no token) → surfaced as an error response, not a crash; benign `terminated` error is
      swallowed (assert it is not rethrown).
- [ ] Run `npm test`.

### Task 4: Inbound auth — per-route XSUAA bearer

**Files:**
- Create: `src/auth.ts`, `tests/auth.test.ts`

Wire `@arc-mcp/xsuaa-auth` so the developer authenticates once to the hub. **This is the
highest-uncertainty task — budget a focused spike inside it.** The crux: RFC 9728 §3.3 requires each
MCP endpoint's protected-resource-metadata `resource` to be **identical to the URL the client called**.
A client connecting to `/dev/mcp` against metadata that advertises `…/mcp` MUST reject it. So the hub
needs **per-route resource metadata** (each `/<env>/mcp` advertises `resource: ${appUrl}/<env>/mcp`)
with a **shared OAuth authorization server** (one `/authorize`, `/token`, `/register`, `/oauth/callback`
for the whole hub — one login). xsuaa-auth's `setupHttpAuth` facade is **single-resource**, so it is
not sufficient as-is for N paths.

- [ ] Spike first (in the task): stand up the shared AS once with xsuaa-auth's building blocks —
      `loadXsuaaCredentials()`, `resolveAppUrl()`, `createXsuaaOAuthProvider(credentials, appUrl, { dcrSigningSecret })`
      (gives `{ provider, clientStore, stateCodec }`), `createChainedTokenVerifier(...)`,
      `createOAuthCallbackHandler(stateCodec, clientStore)`. Mount the SDK `mcpAuthRouter`/authorize
      shim + `/oauth/callback` once. Then for **each** env path mount a `requireBearerAuth` configured
      with that path's own `resourceMetadataUrl` and a protected-resource-metadata document whose
      `resource` is `${appUrl}/<env>/mcp`. Read xsuaa-auth `src/facade.ts` as the reference for exactly
      which SDK calls the facade makes, and replicate them per-route.
- [ ] If the shared-AS-+-per-route-resource wiring cannot be expressed cleanly with xsuaa-auth's current
      exports, the fallback is to (a) use the MCP SDK's auth primitives directly for the per-route
      metadata while still using xsuaa-auth's `provider`/verifier for the AS, or (b) propose a small
      `setupHttpAuth({ resources: [...] })` enhancement upstream to xsuaa-auth. Record which path was
      taken in a code comment. Do NOT ship the spec-incorrect single-`/mcp`-resource shortcut.
- [ ] Export `setupInboundAuth(app, envNames: string[]): RequestHandler[]` (one bearer handler per env,
      or a single handler if the metadata can be selected per-request) and `getUserJwt(req): string`
      (read `req.auth.token`; throw a 401-shaped error if absent). The validated user JWT is consumed by
      Task 5/6.
- [ ] Add unit tests (~6 tests) in `describe('inbound auth')`: assert each env path advertises its own
      `resource` (`${appUrl}/dev/mcp`, `${appUrl}/qa/mcp`) in its protected-resource-metadata; a 401 on
      `/dev/mcp` returns a `WWW-Authenticate` pointing at the dev metadata; `getUserJwt` returns
      `req.auth.token` and throws when `req.auth` is undefined. Mock the xsuaa-auth verifier; do NOT
      re-test `@sap/xssec`. **The definitive check is a real MCP client in the BTP e2e (Task 10).**
- [ ] Run `npm test`.

### Task 5: Outbound exchange — per-user backend bearer

**Files:**
- Create: `src/exchange.ts`, `tests/exchange.test.ts`

The hub→backend principal-propagation hop. Given the user JWT and a destination name, return the
backend URL + per-user bearer via `@arc-mcp/xsuaa-auth/btp`.

- [ ] Export `createResolver(): (destination: string, userJwt: string) => Promise<{ url: string, bearer: string }>`.
      Capture `const cfg = parseVCAPServices()` once at startup (throw a clear error if null — the hub
      MUST be bound to a destination service). Per call: `const { destination, authTokens } =
      await lookupDestinationWithUserToken(cfg, destination, userJwt)`; resolve `url = destination.URL`
      (append `/mcp` only if the destination URL does not already end in `/mcp` — document that the
      destination SHOULD point at the backend's `/mcp`); `bearer = authTokens.bearerToken`. If
      `bearerToken` is absent, throw a clear error naming the destination and instructing the operator
      to configure it as `OAuth2JWTBearer` (this is the "verify extraction" item from the research).
- [ ] Add unit tests (~6 tests) in `describe('exchange')` mocking `@arc-mcp/xsuaa-auth/btp`: happy path
      returns `{ url, bearer }` from a fake `{ destination: { URL }, authTokens: { bearerToken } }`;
      `parseVCAPServices` null at startup → throws; `authTokens.bearerToken` missing → throws with the
      `OAuth2JWTBearer` hint; URL already ending `/mcp` is not double-suffixed.
- [ ] Run `npm test`.

### Task 6: Server assembly + local integration test

**Files:**
- Create: `src/server.ts`, `tests/integration.local.test.ts`
- Modify: `src/index.ts`

Assemble the pieces: express app → inbound auth (all routes) → per-env routes wired to the proxy with a
resolver that runs the outbound exchange using the **current request's** user JWT.

- [ ] `src/server.ts` `createServer(config: HubConfig)`: `express()` + `app.use(express.json())`; mount
      the shared OAuth AS + per-env bearer handlers via `const bearers = setupInboundAuth(app,
      config.backends.map(b => b.name))`; `const resolve = createResolver()`. For each backend `b` (with
      its `bearer`), `const { post, get, del } = createEnvHandlers({ getUserJwt, resolve: (userJwt) =>
      resolve(b.destination, userJwt) })` and mount `app.post('/'+b.name+'/mcp', bearer, post)`,
      `.get('/'+b.name+'/mcp', bearer, get)`, `.delete('/'+b.name+'/mcp', bearer, del)`. Add a health
      route `GET /healthz` (no auth) → 200.
- [ ] `startServer()` in `index.ts`: `loadHubConfig()`, `createServer(config)`, `listen(PORT||9000)`,
      set `server.keepAliveTimeout = 120_000` and `server.requestTimeout = 0` (CF Gorouter 90s; SSE).
      Exclude `*/mcp` from any compression (do not add compression middleware).
- [ ] `tests/integration.local.test.ts`: start the assembled server with auth **stubbed open** (inject a
      fake bearer middleware that sets `req.auth = { token: 'u' }`) and a resolver pointed at an
      in-process MCP server (2 fake tools, served over loopback). Connect a real
      `@modelcontextprotocol/sdk` `Client` to `http://127.0.0.1:<port>/dev/mcp` and assert
      `listTools()` returns the 2 tools and a `callTool` round-trips. This proves the full chain locally
      without BTP. Include a failure test: a second env whose resolver rejects → client `connect` errors
      cleanly (no hang/crash).
- [ ] Run `npm test`.

### Task 7: Hub `xs-security.json`

**Files:**
- Create: `xs-security.json`

The hub's XSUAA descriptor. It is the exchange **initiator**, so it MUST allow the `jwt-bearer` grant
(the single most important config fact from the live testing), and reference the backend scopes it
exchanges for.

- [ ] `xsappname: arc-mcp-hub`, `tenant-mode: dedicated`.
- [ ] `oauth2-configuration.grant-types`: `["authorization_code", "refresh_token",
      "urn:ietf:params:oauth:grant-type:jwt-bearer"]` — **jwt-bearer is required** (without it the
      outbound exchange returns `invalid_client / "Unauthorized grant type"`, proven live).
- [ ] `oauth2-configuration.redirect-uris`: localhost + `https://*.hana.ondemand.com/**` +
      `https://claude.ai/api/mcp/auth_callback` + VS Code/Cursor patterns (mirror arc-1's list).
- [ ] `scopes`: a minimal `$XSAPPNAME.use`; **plus** `foreign-scope-references` referencing each backend
      app, e.g. `"foreign-scope-references": ["$XSAPPNAME(application,arc1-mcp)"]` — documented as
      operator-edited per backend (the matching `granted-apps` lives on the **backend's** xs-security,
      see README/Task 9). Provide one worked example and a comment that this is same-subaccount only.
- [ ] `role-templates` + a `Hub User` role collection granting `$XSAPPNAME.use` (so a developer can be
      assigned access to the hub itself).

### Task 8: CF deploy descriptors

**Files:**
- Create: `manifest.yml`, `mta.yaml`, `.cfignore`

Deployable to BTP CF with XSUAA + Destination service bindings (no Connectivity unless an on-prem
backend is later added).

- [ ] `mta.yaml` (primary): one module `arc-mcp-hub` (nodejs), bound to resources `arc-mcp-hub-xsuaa`
      (xsuaa, `application` plan, `path: ./xs-security.json`) and `arc-mcp-hub-destination` (destination,
      `lite`). Provide `HUB_BACKENDS` and `ARC_HUB_DCR_SIGNING_SECRET` as parameters/env. Health-check
      type `http`, endpoint `/healthz`.
- [ ] `manifest.yml`: simpler `cf push` variant (same bindings, `HUB_BACKENDS` env, `command: npm start`,
      `health-check-http-endpoint: /healthz`).
- [ ] `.cfignore`: `node_modules`, `tests`, `*.md` kept minimal; ensure `dist` is built/pushed (or set a
      buildpack build step). Document the build-before-push step in README.
- [ ] No code; nothing to test. (ralphex runs Validation Commands after this task — they stay green.)

### Task 9: README + operator setup docs

**Files:**
- Create: `README.md`, `docs/operator-setup.md`, `docs/architecture.md`
- Modify: `docs/plans/build-arc-mcp-hub.md` (status note only)

Document the **as-shipped** behavior and the exact operator wiring — this is what makes "add a system"
no-code, and where the cross-app trust chain is explained.

- [ ] `README.md`: what it is, the per-path safety model, quick start, `HUB_BACKENDS` format,
      client config example (`https://<hub>/dev/mcp`), the v1 limits (same-subaccount, single instance,
      no LLM), and a pointer to `docs/operator-setup.md`.
- [ ] `docs/operator-setup.md`: the complete wiring, step by step:
      (1) deploy the hub (mta/manifest); (2) for each backend create a **BTP destination** of type
      `OAuth2JWTBearer` with `URL=https://<backend>/mcp`, `tokenServiceURL=<hub-subaccount>/oauth/token`,
      `clientId/clientSecret=<hub xsuaa>`, `scope=<backend-xsappname>.<scope>`; (3) on each **backend**
      arc-1's `xs-security.json` add `granted-apps: ["$XSAPPNAME(application,arc-mcp-hub)"]` to a scope;
      (4) assign developers the backend role collection **`--of-idp sap.custom`** (the `invalid_scope`
      gotcha); (5) set the PROD backend `SAP_ALLOW_WRITES=false` + a read-only SAP user. Note the
      same-subaccount requirement and the #434 cross-subaccount caveat.
- [ ] `docs/architecture.md`: the request flow diagram (client → inbound auth → per-env route → outbound
      exchange → transparent proxy → backend), and the four de-risked facts with their evidence.
- [ ] Add a one-line status note at the top of this plan file (`docs/plans/build-arc-mcp-hub.md`):
      "Implemented <date>; pending BTP e2e (Task 10) before publish."

### Task 10: Final verification — local gates, then live BTP e2e, then publish

**Files:**
- Verify: entire repo
- Modify: `package.json` (flip `private` → publishable only after BTP e2e passes)

This task gates publication. Local gates first; then a **live** BTP end-to-end against the joule2
subaccount; publish to `arc-mcp/mcp-hub` only after the e2e succeeds.

- [ ] Local gates green: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`.
- [ ] **BTP e2e (manual, with the user — requires the joule2 subaccount).** This is the publish gate:
      - Deploy the hub (`mta`/`cf push`) into the **same subaccount** as `arc1-mcp-joule2`.
      - Configure: hub `xs-security` `foreign-scope-references` → `arc1-mcp`; `arc1-xsuaa`
        `granted-apps` → `arc-mcp-hub`; create a destination `arc1-dev` (`OAuth2JWTBearer`,
        `URL=https://<arc1-mcp-joule2>/mcp`, `scope=arc1-mcp!<id>.admin`); set
        `HUB_BACKENDS=[{"name":"dev","destination":"arc1-dev"}]`.
      - Assign the developer the hub role collection (and the arc-1 role collection on the backend)
        **`--of-idp sap.custom`**.
      - Connect a real MCP client (the spike `client.mjs` pointed at `https://<hub>/dev/mcp`, or
        VS Code/Claude) and assert: one login to the hub, then **12 tools listed through the deployed
        hub**, and a `SAPSearch` (read) call succeeds **as the logged-in user** (verify the SAP-side
        user in the backend audit/response). This exercises inbound auth + outbound jwt-bearer exchange
        + transparent proxy + per-user propagation in one shot.
      - Verify the RFC 9728 nuance: confirm the chosen real client accepts the single-resource model on
        `/dev/mcp`; if not, file the per-route-metadata follow-up (Task 4 design decision) before publish.
      - Tear down throwaway artifacts (destination/role assignment) as needed; do not commit secrets.
    (Requires the live subaccount; cannot run in CI. If credentials are unavailable, STOP and report —
    do not publish.)
- [ ] **Only after the BTP e2e passes:** create the GitHub repo `arc-mcp/mcp-hub`, flip
      `package.json` `private` appropriately, push `main`, and (if publishing to npm) publish
      `arc-mcp-hub`. Add the CI badge to the README.
- [ ] Move this plan to `docs/plans/completed/` and fix any relative links.
