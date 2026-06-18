// Outbound hub->backend principal-propagation hop.
//
// Given the logged-in user's JWT and a BTP destination name, exchange it for a
// per-user backend bearer (the destination is configured as `OAuth2JWTBearer`)
// and read the backend URL from that same destination. The SAP Cloud SDK caches
// per tenant-user, so calling this per request is cheap.

import { lookupDestinationWithUserToken, parseVCAPServices } from '@arc-mcp/xsuaa-auth/btp';

export type Resolver = (destination: string, userJwt: string) => Promise<{ url: string; bearer: string }>;

/** Build the resolver. Throws at startup if the hub is not bound to a destination service. */
export function createResolver(env: NodeJS.ProcessEnv = process.env): Resolver {
  const cfg = parseVCAPServices(env);
  if (!cfg) {
    throw new Error(
      'No BTP destination service binding found (VCAP_SERVICES). Bind the hub to a destination service instance.',
    );
  }

  return async (destination, userJwt) => {
    const { destination: dest, authTokens } = await lookupDestinationWithUserToken(cfg, destination, userJwt);
    const bearer = authTokens.bearerToken;
    if (!bearer) {
      throw new Error(
        `Destination '${destination}' did not yield a per-user bearer. Configure it as type OAuth2JWTBearer ` +
          '(per-user principal propagation) on the backend MCP server.',
      );
    }
    const base = dest.URL.replace(/\/$/, '');
    const url = base.endsWith('/mcp') ? base : `${base}/mcp`;
    return { url, bearer };
  };
}
