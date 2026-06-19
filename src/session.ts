// Shared MCP-session helpers used by BOTH the per-env proxy and the /all
// aggregator: bind a session to its principal, and reap idle sessions. Pure (no
// SDK imports) so both modules can use them without a circular dependency.

/**
 * Stable owner key from an (already bearer-verified) hub token, used to bind a
 * session to one principal. The mcp-session-id is a routing token, not proof of
 * identity, so a request whose principal differs from the session's owner must be
 * rejected. Falls back to the raw token for non-JWT inputs (e.g. tests).
 */
export function principalKey(jwt: string): string {
  const parts = jwt.split('.');
  if (parts.length === 3) {
    try {
      const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
      const id = p.user_name ?? p.sub ?? p.email;
      const zone = p.zid ?? p.zone_uuid ?? '';
      if (typeof id === 'string' && id) return `${id}|${String(zone)}`;
    } catch {
      // not a decodable JWT — fall through to the raw-token key
    }
  }
  return jwt;
}

/** Session ids whose `lastSeen` is older than `ttlMs` (idle-expiry sweep). */
export function expiredSessionIds(sessions: Map<string, { lastSeen: number }>, now: number, ttlMs: number): string[] {
  const out: string[] = [];
  for (const [id, s] of sessions) if (now - s.lastSeen > ttlMs) out.push(id);
  return out;
}
