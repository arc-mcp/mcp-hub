# Roadmap & open items

What's deliberately deferred, researched-but-not-built, or noted for later. The hub's **shipped**
scope is in the [README](../README.md); the full auth/transport decision journey lives in the arc-1
repo's `docs/research/mcp-hub-multi-system.md`.

## Deferred by design

### Cross-subaccount backends
v1 maps only within one BTP subaccount (the `OAuth2JWTBearer` exchange shares one issuer);
cross-subaccount hits `Unable to map issuer`. Options: `OAuth2SAMLBearerAssertion` per hub↔backend
pair, or a shared IAS tenant + RFC 8693 token exchange (collapses N pairwise trusts to one). BTP
configuration only — no hub code change.

### Horizontal scale (> 1 instance)
Sessions live in an in-memory map (now principal-bound + idle-reaped, but still per-instance). Scaling
past one instance needs a shared session store (Redis) or sticky sessions at the router.

### Separate PROD OAuth scope
Deferred — SAP enforces per-user authorization via principal propagation, so a user without PROD SAP
authority can't act on PROD even if they connect. A dedicated PROD scope is additive hardening, not a gap.

### True per-user identity on every backend
Only backends reached via a `PrincipalPropagation` / `OAuth2JWTBearer` destination preserve the real SAP
user end-to-end. A backend wired with a shared technical user (basic auth) loses per-user identity at the
last hop — the hub still carries the user to ARC-1 (and audits them), but SAP sees the shared user.
Upgrading a technical-user backend to PP is per-system BTP/SAP config (Cloud Connector mapping + STRUST CA
+ CERTRULE), not a hub change.

## Security hardening (from the Codex review)

### No hub-local authorization gate
The hub verifies a valid hub-audience token but enforces no hub-specific scope. Access is gated
*downstream*: the `OAuth2JWTBearer` exchange only succeeds if the user holds the backend's foreign scope
(via their role collection), and SAP then enforces the real user's authorizations — so an authenticated
user who lacks the role collection can reach the hub but do nothing. To also stop them from *driving
exchanges they can't use* (a DoS angle, amplified on `/all`): enforce the hub `$XSAPPNAME.use` scope
(advertise it + pass `requiredScopes`), and/or mount an MCP-call rate limiter (`trust proxy` is already
set for accurate per-IP keys). Documented in the README safety model.

## Capability / UX candidates

### Read-only-aware tool surface
When every selected backend is read-only (e.g. all PROD), the listed tool surface should omit write tools
entirely — smaller surface, and the model can't even attempt a write that the backend would refuse.
Approach: derive a read-only flag per backend (an explicit config flag and/or probing the backend's own
read-only state), then filter write tools out of `tools/list` when all selected backends are read-only
(for `/all`, scope a write tool's `system` enum to the writable backends only). Low complexity; the open
question is the source of truth for "is this backend read-only". Applies to both the CF hub and a local edition.

### Tool annotations (write-confirmation tripwire)
Clients (VS Code, Claude) force a human confirmation on non-`readOnlyHint` tools and show the `title`. The
hub passes tool annotations through unchanged — but ARC-1 tools set none, so there's nothing to carry.
Adding `readOnlyHint` / `destructiveHint` to ARC-1's tool definitions (an arc-1-side change) would let the
hub surface per-call write confirmations.

### Local (stdio) edition
A separate npm package that fronts multiple **local** arc-1 configs (stdio) — the same multi-system
experience off-BTP: per-system entries plus an `/all`-style "12 tools + `system` param" surface — without
putting multi-system logic into arc-1 itself. The aggregation/routing core (`mergeTools`, `parseSystemArg`,
the read-only filter) is transport-agnostic and would be shared; only the transport (stdio spawn vs the
BTP destination exchange) differs.

### Heterogeneous (non-arc-1) backends
The hub can in principle front any XSUAA-protected Streamable-HTTP MCP server; the `/all` `system`-collision
guard exists for that case, but it's untested with a real non-arc-1 backend. For *heterogeneous* backends
the tool-name-prefix model beats the `system`-param model (there's no shared tool set to share) — `/all`
currently implements only the param model, which suits homogeneous arc-1 backends.

## Observability / repo maturity
- No structured access audit (who touched which system) or session-count metrics — only stderr logs.
- `tools/list_changed` from a backend isn't propagated to `/all` clients (low value — tool sets are static).
- Hub repo is `0.1.0`; CI is build-only (no Dependabot / dependency scanning / release automation, unlike arc-1).
- `closeSession` / `reapIdle` / principal-binding logic is duplicated across `aggregate.ts` and `proxy.ts`
  (only the pure helpers are shared in `session.ts`) — a small future refactor.

## NOT hub issues (surfaced *through* the hub; fix at the backend/system)
- **NetWeaver 7.50 has no freestyle-SQL ADT endpoint** → `SAPQuery` returns 404 on a 7.50 backend. A
  platform ceiling, not a routing problem.
- **Standard-table DDIC reads (e.g. `MARA`) return 404** → the connection user's DDIC display authorization
  (`S_DEVELOP`) or limited exposure on a sandbox system, not the hub.
