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
}

export interface HubConfig {
  backends: Backend[];
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
    const { name, destination } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(`HUB_BACKENDS[${i}].name must match ${NAME_RE} — got ${JSON.stringify(name)}.`);
    }
    if (typeof destination !== 'string' || destination.trim() === '') {
      throw new Error(
        `HUB_BACKENDS[${i}].destination must be a non-empty string — got ${JSON.stringify(destination)}.`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`HUB_BACKENDS has a duplicate name '${name}'.`);
    }
    seen.add(name);
    return { name, destination };
  });

  return { backends };
}
