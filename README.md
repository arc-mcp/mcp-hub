# arc-mcp-hub

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

## When NOT to use it

- **One SAP system only** → just point your client at that ARC-1 directly. The hub adds nothing.
- **You want a natural-language assistant** that reasons across systems → that's a different,
  LLM-in-the-middle product. This hub is **deterministic routing only — no server-side LLM**, no merged
  tool list, no "ask it anything."
- **Backends in different subaccounts** → not supported in v1 (the token exchange only maps within one
  subaccount). See [roadmap](#roadmap).
- **You want the model to pick the system at call time** → intentionally unsupported. The system is
  bound by *which endpoint you connect to*, so an agent can never accidentally write to PROD from a DEV
  conversation. That safety is the whole point.

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
| `HUB_BACKENDS` | yes | JSON array of `{ name, destination }`. `name` is the URL segment (lowercase/digits/hyphen); `destination` is the BTP destination resolving to that backend. |
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

## License

MIT
