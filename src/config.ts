// Hub configuration: the list of backends to multiplex.
//
// A backend's URL *and* per-user auth both come from its BTP destination
// (resolved at request time), so they are NOT in this config. Adding a system
// is: create a destination + add one `{ name, destination }` entry here.

export interface Backend {
  /** URL path segment and display name, e.g. 'dev'. Lowercase / digits / hyphen. */
  name: string;
  /** BTP destination name that resolves to the backend MCP server (URL + auth). */
  destination: string;
  /** Optional human/LLM-readable label, e.g. 'ABAP Platform 2025'. Surfaced in the
   *  `/all` endpoint's `system` enum + server instructions. */
  description?: string;
}

export interface HubConfig {
  backends: Backend[];
  /** Mount the aggregated `/all/mcp` endpoint (one URL, all systems via a required
   *  `system` param). Opt-in via `HUB_ALL_ENDPOINT`; the per-system paths are the default. */
  allEndpoint: boolean;
}

const NAME_RE = /^[a-z0-9-]+$/;

/** Parse + validate `HUB_BACKENDS` (a JSON array of `{ name, destination }`). Throws on any problem. */
export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const raw = env.HUB_BACKENDS;
  if (!raw || raw.trim() === '') {
    throw new Error('HUB_BACKENDS is required: a JSON array of { name, destination }.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`HUB_BACKENDS is not valid JSON: ${(e as Error).message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('HUB_BACKENDS must be a non-empty JSON array of { name, destination }.');
  }

  const seen = new Set<string>();
  const backends = parsed.map((entry, i): Backend => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`HUB_BACKENDS[${i}] must be an object { name, destination }.`);
    }
    const { name, destination, description } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(`HUB_BACKENDS[${i}].name must match ${NAME_RE} — got ${JSON.stringify(name)}.`);
    }
    if (name === 'all') {
      throw new Error(`HUB_BACKENDS[${i}].name 'all' is reserved for the aggregated /all/mcp endpoint.`);
    }
    if (typeof destination !== 'string' || destination.trim() === '') {
      throw new Error(
        `HUB_BACKENDS[${i}].destination must be a non-empty string — got ${JSON.stringify(destination)}.`,
      );
    }
    if (description !== undefined && typeof description !== 'string') {
      throw new Error(
        `HUB_BACKENDS[${i}].description must be a string if present — got ${JSON.stringify(description)}.`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`HUB_BACKENDS has a duplicate name '${name}'.`);
    }
    seen.add(name);
    return description ? { name, destination, description } : { name, destination };
  });

  const allEndpoint = /^(1|true|yes|on)$/i.test((env.HUB_ALL_ENDPOINT ?? '').trim());
  return { backends, allEndpoint };
}
