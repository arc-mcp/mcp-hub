# Architecture

`arc-mcp-hub` is a transparent, deterministic MCP reverse proxy. It centralizes **auth and routing**
while keeping the data plane (each backend's tool surface) fully separate. No server-side LLM.

## Request flow

```
MCP client                arc-mcp-hub                         backend ARC-1            SAP
───────────               ───────────                         ─────────────            ───
  connect /dev/mcp ──────► requireBearerAuth (per env)
                           validate XSUAA token  ───┐
                           (one login, shared AS)    │
  initialize ────────────► createEnvHandlers ────────┘
                           resolve(userJwt):
                             lookupDestinationWithUserToken
                             → OAuth2JWTBearer exchange ──────► (per-user backend token)
                           mcpProxy session bridge:
                             ServerTransport ⇄ ClientTransport ─► /mcp  (Bearer per-request)
  tools/list ────────────► relayed verbatim ◄────────────────── tool list  ◄── principal
  tools/call ────────────► relayed verbatim ◄────────────────── result     ◄── propagation ─► SAP (as the user)
```

## Modules

| Module | Responsibility |
|---|---|
| `src/config.ts` | Parse + validate `HUB_BACKENDS` → `[{ name, destination }]`. |
| `src/auth.ts` | Inbound: shared OAuth AS (via `@arc-mcp/xsuaa-auth`) + per-env RFC 9728 resource metadata + bearer middleware. |
| `src/exchange.ts` | Outbound: `lookupDestinationWithUserToken` → backend URL + per-user bearer. |
| `src/proxy.ts` | The `mcpProxy` session bridge; transparent passthrough; per-request bearer injection. |
| `src/server.ts` | Wire it: one bearer per env route → exchange → proxy. |

## Two layers, kept separate

- **Layer 1 — where each ARC-1 *instance* lives.** Drives the hub→backend auth. v1: same subaccount.
- **Layer 2 — what SAP system each instance *targets*** (BTP ABAP / on-prem via Cloud Connector /
  private or public S/4). Entirely ARC-1's existing concern. The hub treats every backend identically.

## Design facts (verified live before build)

- **Inbound:** ARC-1's `/mcp` accepts any valid XSUAA bearer regardless of how minted; x5t /
  proof-of-possession is not a blocker for XSUAA tokens.
- **Outbound:** the `jwt-bearer` exchange is **identity-preserving** (`user_name`/`email` survive) and
  must be enabled on the **hub's** xsuaa (the exchange initiator) — it is **not** on by default.
- **Transport:** the `mcpProxy` bridge relays a real backend's full tool surface (initialize + session
  + SSE + `tools/list` + `tools/call`) transparently. The local integration test
  (`tests/integration.local.test.ts`) automates this against an in-process MCP backend.
- **Safety:** scope-based tool pruning flows through the proxy intact — no backend scope ⇒ zero tools.

## Key invariants

1. **Per-request token.** The outbound bearer is re-resolved on every backend request against the
   session's *current* user JWT — never cached for the session (a stale-per-session token was a proven
   failure).
2. **No token passthrough.** The hub never forwards the client's token to a backend; it always mints a
   separate, backend-audienced, per-user token (MCP spec requirement).
3. **Connection-scoped systems.** One env per session — cross-environment is structurally impossible.
4. **SAP is the final authority.** Per-user principal propagation means SAP enforces real
   authorizations; the hub does not need to (and must not) re-implement them.

## See also

- [integrating-an-mcp-server.md](integrating-an-mcp-server.md) — backend requirements + what to change
  in an MCP server to sit behind the hub (with BTP/XSUAA references).
- [operator-setup.md](operator-setup.md) — per-backend BTP wiring.
