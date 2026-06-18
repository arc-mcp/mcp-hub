// Inbound auth: the developer authenticates once to the hub.
//
// RFC 9728 §3.3 requires each MCP endpoint's protected-resource-metadata `resource`
// to equal the URL the client called. So every `/<env>/mcp` advertises its OWN
// resource (`${appUrl}/<env>/mcp`) while sharing ONE authorization server (one
// login). `@arc-mcp/xsuaa-auth`'s `setupHttpAuth` facade is single-resource, so we
// use it ONLY to mount the shared AS (authorize/token/register/callback + AS
// metadata + DCR) and add per-env protected-resource-metadata + bearer ourselves.

import {
  createChainedTokenVerifier,
  createXsuaaTokenVerifier,
  loadXsuaaCredentials,
  resolveAppUrl,
  setupHttpAuth,
} from '@arc-mcp/xsuaa-auth';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Express, Request, RequestHandler } from 'express';

// The hub needs NO arc-1 resource scope of its own: the backend scope (arc1-mcp.admin)
// reaches the exchanged token via the user's role collection at jwt-bearer time, NOT via
// the authorize request. But the client must still request a scope that yields a clean,
// XSUAA-valid hub token. Empirically (verified live on this joule2/IAS subaccount):
//   • advertise arc-1's scopes → client requests `admin` → hub xsuaa has no such scope → invalid_scope
//   • advertise none ([])      → client requests no scope → token (foreign-app aud) fails @sap/xssec → invalid_token
//   • advertise ['openid']     → token = {scope:[openid], aud:[openid,<hub-client>]} → xssec validates ✓
// So advertise exactly `openid` — a reserved OIDC scope passed through un-qualified
// (see qualifyXsuaaScopes); the backend ARC-1 still enforces real authorization.
export const HUB_SCOPES: string[] = ['openid'];

/** Build one env's protected-resource-metadata (RFC 9728): the well-known path + the doc. */
export function protectedResourceMetadata(appUrl: string, env: string) {
  const base = appUrl.replace(/\/$/, '');
  const path = `/.well-known/oauth-protected-resource/${env}/mcp`;
  const doc = {
    resource: `${base}/${env}/mcp`,
    authorization_servers: [`${base}/`],
    scopes_supported: HUB_SCOPES,
  };
  return { path, doc, resourceMetadataUrl: `${base}${path}` };
}

/**
 * Mount the shared OAuth AS + per-env bearer middleware. Returns a bearer handler
 * per env name (apply it to that env's `/<env>/mcp` routes in server.ts).
 */
export function setupInboundAuth(app: Express, envNames: string[]): Record<string, RequestHandler> {
  const credentials = loadXsuaaCredentials();
  const appUrl = resolveAppUrl(process.env, { publicUrlEnvVar: 'ARC_HUB_PUBLIC_URL' }).replace(/\/$/, '');

  // Shared AS only — we ignore the returned single-`/mcp`-resource bearer handler.
  setupHttpAuth(app, {
    xsuaa: {
      credentials,
      appUrl,
      scopesSupported: HUB_SCOPES,
      dcrSigningSecret: process.env.ARC_HUB_DCR_SIGNING_SECRET,
    },
    allowedOrigins: splitCsv(process.env.ARC_HUB_ALLOWED_ORIGINS),
    required: true,
  });

  const verifier = createChainedTokenVerifier({}, createXsuaaTokenVerifier(credentials, {}));

  const bearers: Record<string, RequestHandler> = {};
  for (const env of envNames) {
    const { path, doc, resourceMetadataUrl } = protectedResourceMetadata(appUrl, env);
    app.get(path, (_req, res) => {
      res.json(doc);
    });
    bearers[env] = requireBearerAuth({ verifier: { verifyAccessToken: verifier }, resourceMetadataUrl });
  }
  return bearers;
}

/** Read the validated user JWT off a request (set by requireBearerAuth as `req.auth`). */
export function getUserJwt(req: Request): string {
  const token = (req as Request & { auth?: { token?: string } }).auth?.token;
  if (!token) {
    throw new Error('No authenticated user token on request.');
  }
  return token;
}

function splitCsv(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
