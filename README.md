# arc-mcp-hub

[![CI](https://github.com/arc-mcp/mcp-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/arc-mcp/mcp-hub/actions/workflows/ci.yml)

A thin, **deterministic** MCP hub for SAP BTP. It puts multiple [ARC-1](https://github.com/arc-mcp)
instances — one per SAP system (DEV / QA / PROD) — behind **one front door** with **one login**, while
keeping each system fully isolated and preserving per-user SAP identity.

```
                        one login
  MCP client  ───────────────────────────►  arc-mcp-hub  (one BTP app)
  (VS Code / Claude / Cursor)                  │  /dev/mcp  ─► ARC-1 (DEV)   ─► SAP DEV
                                               │  /qa/mcp   ─► ARC-1 (QA)    ─► SAP QA
                                               │  /prod/mcp ─► ARC-1 (PROD)  ─► SAP PROD
```

You connect your MCP client to `https://<hub>/dev/mcp` (or `/qa/mcp`, `/prod/mcp`). The hub validates
your login, propagates **your** identity to that system's ARC-1 (so SAP sees the real you), and
transparently relays the connection. Each system's tools come through unchanged.

---

## When to use it

- You run **ARC-1 against several SAP systems** and want one endpoint host + one login instead of N
  independently-configured servers.
- You want **per-user SAP identity** preserved end-to-end (principal propagation), per system.
- All those ARC-1 instances live in **one BTP subaccount**.
- You want to front **other SAP MCP servers** too, not only ARC-1 — any XSUAA-protected,
  Streamable-HTTP MCP server qualifies ([how](docs/integrating-an-mcp-server.md)).

## When NOT to use it

- **One SAP system only** → just point your client at that ARC-1 directly. The hub adds nothing.
- **You want a natural-language assistant** that reasons across systems → that's a different,
  LLM-in-the-middle product. This hub is **deterministic routing only — no server-side LLM** (the
  optional [`/all`](#optional-one-endpoint-for-every-system) endpoint merges tool lists, but never
  reasons or calls a model).
- **Backends in different subaccounts** → not supported in v1 (the token exchange only maps within one
  subaccount). See [roadmap](#roadmap).
- **You want the model to pick the system at call time** → off by default (the path-scoped routes bind
  the system to *which endpoint you connect to*, so an agent can't accidentally write to PROD from a DEV
  conversation). If you do want it, enable the opt-in
  [`/all` endpoint](#optional-one-endpoint-for-every-system) — but keep PROD read-only at the backend,
  because that structural guard (not the tool surface) is what makes a misroute harmless.

---

## How it works (one paragraph)

The hub is an OAuth 2.1 resource server (one shared authorization server → one login). Each
`/<env>/mcp` advertises its own resource (per RFC 9728) so standards-compliant clients connect cleanly.
On each request the hub takes your validated token, exchanges it via a **BTP destination**
(`OAuth2JWTBearer`) for a per-user token scoped to that backend, and bridges the MCP Streamable-HTTP
session to it. The backend (ARC-1) does its own principal propagation to SAP, so **SAP enforces your
real authorizations** — a user without PROD access simply can't do anything on PROD, even if they
connect to `/prod/mcp`.

There is no shared service account and no LLM in the path. See [docs/architecture.md](docs/architecture.md).

---

## Optional: one endpoint for every system

By default you point a client at *one* system (`/dev/mcp`). If instead you want **all systems through a
single connection**, enable the aggregated endpoint:

```bash
cf set-env arc-mcp-hub HUB_ALL_ENDPOINT true && cf restart arc-mcp-hub
```

Then connect a client to `https://<hub>/all/mcp`. It exposes every backend's tools **once**, each with a
**required `system` parameter** naming which SAP system to act on (`dev`, `s4-2025`, …). Add an optional
`description` per backend so the model sees what each system is:

```json
[{ "name": "dev", "destination": "arc1-dev", "description": "S/4HANA 2023 (758)" },
 { "name": "s4-2025", "destination": "arc1-2025", "description": "ABAP Platform 2025 (816)" }]
```

- **Cost ≈ one tool set.** The backends are the same server (ARC-1) against different SAP targets, so a
  shared tool set + a `system` param doesn't duplicate descriptions — `/all` costs about the same as a
  single per-system endpoint, not N×.
- **Trade-off — no structural isolation.** The model picks the system per call, so `/all` does **not**
  have the per-connection safety of the path-scoped routes. Make a misroute harmless instead: a PROD
  backend must run **`SAP_ALLOW_WRITES=false` + a read-only SAP user**. The `system` enum, server
  `instructions`, and a required-no-default param are disambiguation aids — not controls.
- **Sessions are principal-bound + idle-reaped.** Each `/all` session is tied to the user who created it
  (a different principal is rejected — the session id is not a credential) and is closed after an idle
  timeout together with its backend connections. A backend whose *own* tools already declare a `system`
  parameter is unsupported by `/all` (it fails loud at list time) — use that backend's per-system route.
- Prefer the per-system routes for routine single-system work; use `/all` for cross-system tasks.

---

## Quick start

1. **Deploy** the hub into the **same BTP subaccount** as your ARC-1 instances:
   ```bash
   npm ci && npm run build
   cf push                 # uses manifest.yml  (or: mbt build && cf deploy *.mtar  for MTA)
   ```
2. **Wire each backend** (a one-time per-system setup) — full steps in
   [docs/operator-setup.md](docs/operator-setup.md): create a destination, grant the hub a scope on the
   backend, assign developers the role collection.
3. **Configure backends** — set `HUB_BACKENDS`:
   ```json
   [{ "name": "dev", "destination": "arc1-dev" }, { "name": "prod", "destination": "arc1-prod" }]
   ```
   Adding a system later = create a destination + add one entry here. No code change.
4. **Connect a client** to one system, e.g. in VS Code `.vscode/mcp.json`:
   ```jsonc
   { "servers": { "sap-dev": { "type": "http", "url": "https://<hub>/dev/mcp" } } }
   ```
   First use → one browser login → the system's ARC-1 tools appear.

---

## Configuration

| Env var | Required | Description |
|---|---|---|
| `HUB_BACKENDS` | yes | JSON array of `{ name, destination, description? }`. `name` is the URL segment (lowercase/digits/hyphen, not `all`); `destination` is the BTP destination resolving to that backend; optional `description` (e.g. `"ABAP Platform 2025"`) labels the system in the `/all` endpoint's `system` enum + instructions. |
| `HUB_ALL_ENDPOINT` | no | `true` mounts the optional aggregated [`/all/mcp`](#optional-one-endpoint-for-every-system) (one URL, every system via a required `system` param). Default off — the per-system routes are the safe default. |
| `ARC_HUB_PUBLIC_URL` | no | The hub's public URL for OAuth metadata. Derived from the CF route if unset; set it behind a reverse proxy/custom domain. |
| `ARC_HUB_DCR_SIGNING_SECRET` | recommended | Stable secret so cached client_ids survive `cf deploy`. `openssl rand -base64 48`. |
| `ARC_HUB_ALLOWED_ORIGINS` | no | CSV CORS allowlist for browser MCP clients (e.g. `https://claude.ai`). |
| `PORT` | no | Defaults to 9000 (CF sets it). |

---

## Safety model

- **Connection-scoped systems.** A session on `/dev/mcp` can only ever see DEV's tools. There is no
  runtime system selector to get wrong.
- **PROD is read-only at the backend.** Set `SAP_ALLOW_WRITES=false` **and** a read-only SAP user on the
  PROD ARC-1 instance. Even if someone connects to `/prod/mcp`, writes are refused at the strongest
  boundary (SAP).
- **Per-user identity.** Every call runs as the logged-in user via principal propagation — no shared
  service account.

---

## Limits (v1)

- **Same subaccount** for hub + backends (cross-subaccount → roadmap).
- **Single instance** (in-memory session map). Scaling >1 needs sticky sessions or a shared store.
- **No server-side LLM** — by design.

## Roadmap

- Cross-subaccount backends (`OAuth2SAMLBearerAssertion` / shared IAS).
- Horizontal scale (shared session store).

## Development

```bash
npm ci
npm test          # unit + local integration (proxy ↔ in-process MCP backend)
npm run typecheck
npm run lint
npm run build
```

## Docs

- [architecture.md](docs/architecture.md) — request flow, modules, invariants.
- [operator-setup.md](docs/operator-setup.md) — step-by-step BTP wiring per backend.
- [integrating-an-mcp-server.md](docs/integrating-an-mcp-server.md) — requirements + what to change to
  put **any** MCP server behind the hub, with primary-source BTP/XSUAA references.

## License

MIT
