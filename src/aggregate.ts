// The aggregated `/all/mcp` endpoint: ONE MCP server exposing every backend's
// tools, disambiguated by a REQUIRED `system` parameter.
//
// Why a `system` param and not tool-name prefixing (`s4-2025__SAPRead`): the
// backends are HOMOGENEOUS — the same ARC-1 server against different SAP targets.
// A shared tool set + a target param costs ~1x tokens; prefixing would triplicate
// identical, large tool descriptions (~Nx). Prefixing is the right call only for
// heterogeneous servers (GitHub + Slack + …).
//
// SAFETY: this endpoint lets the model pick the system per call, so it does NOT
// have the structural per-connection isolation of the `/<env>/mcp` routes. "No
// accidental prod write" must be enforced at the BACKEND (prod = read-only SAP
// user + SAP_ALLOW_WRITES=false), never by this tool surface. The `system` enum,
// instructions, and required-no-default are disambiguation aids, not controls.
//
// Each session holds N backend MCP clients, so it is (a) bound to the principal
// that initialized it (a different user is rejected — the mcp-session-id is not a
// bearer) and (b) idle-reaped so a crashed/no-DELETE client can't leak N backend
// sessions until process restart.

import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import type { Backend } from './config.js';
import type { Resolver } from './exchange.js';
import { log } from './log.js';
import type { GetUserJwt } from './proxy.js';
import { expiredSessionIds, principalKey } from './session.js';

// Re-exported so existing imports/tests that reach for these via ./aggregate keep working.
export { expiredSessionIds, principalKey } from './session.js';

export const SYSTEM_PARAM = 'system';
const DEFAULT_SESSION_TTL_MS = 30 * 60_000; // reap a session idle longer than this

type JsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
};

export interface BackendTools {
  name: string;
  description?: string;
  tools: Tool[];
}

const systemLabel = (name: string, description?: string): string => (description ? `${name} (${description})` : name);

/**
 * Merge per-backend tool lists into ONE set, injecting a required `system` enum
 * into every tool. A tool present on multiple systems is unified; its `system`
 * enum lists only the systems that actually expose it (so e.g. SAPGit, absent on
 * a NetWeaver box, can't be requested there). First backend wins on the base tool
 * definition; backend annotations pass through unchanged.
 *
 * Throws if a backend tool already declares a `system` parameter — the aggregator
 * would otherwise silently overwrite it and strip the backend's own argument. Fail
 * loud so the operator excludes that backend from `/all` (or renames the param).
 */
export function mergeTools(perBackend: BackendTools[]): Tool[] {
  const byName = new Map<string, { tool: Tool; systems: string[] }>();
  for (const b of perBackend) {
    for (const t of b.tools) {
      const entry = byName.get(t.name);
      if (entry) entry.systems.push(b.name);
      else byName.set(t.name, { tool: t, systems: [b.name] });
    }
  }
  const descOf = (n: string): string | undefined => perBackend.find((b) => b.name === n)?.description;

  const merged: Tool[] = [];
  for (const { tool, systems } of byName.values()) {
    const schema: JsonSchema = (tool.inputSchema as JsonSchema | undefined) ?? { type: 'object', properties: {} };
    const properties: Record<string, unknown> = { ...(schema.properties ?? {}) };
    if (SYSTEM_PARAM in properties) {
      throw new Error(
        `Cannot aggregate tool '${tool.name}' on /all: it already declares a '${SYSTEM_PARAM}' parameter, which ` +
          'the aggregator needs as the system selector. Exclude that backend from /all (or rename the parameter).',
      );
    }
    properties[SYSTEM_PARAM] = {
      type: 'string',
      enum: [...systems],
      description: `REQUIRED. Which SAP system to run this tool against — one of: ${systems
        .map((s) => systemLabel(s, descOf(s)))
        .join('; ')}. Match the user's intended system; never assume.`,
    };
    const required = Array.isArray(schema.required) ? [...schema.required] : [];
    if (!required.includes(SYSTEM_PARAM)) required.unshift(SYSTEM_PARAM);
    merged.push({ ...tool, inputSchema: { ...schema, properties, required } as Tool['inputSchema'] });
  }
  return merged;
}

/** Read + validate the `system` arg and strip it from the rest of the arguments. */
export function parseSystemArg(
  args: Record<string, unknown> | undefined,
  validSystems: string[],
): { system: string; rest: Record<string, unknown> } | { error: string } {
  const a = args ?? {};
  const system = a[SYSTEM_PARAM];
  if (typeof system !== 'string' || system === '') {
    return { error: `Missing required '${SYSTEM_PARAM}'. Choose one of: ${validSystems.join(', ')}.` };
  }
  if (!validSystems.includes(system)) {
    return { error: `Unknown system '${system}'. Valid systems: ${validSystems.join(', ')}.` };
  }
  const rest = { ...a };
  delete rest[SYSTEM_PARAM];
  return { system, rest };
}

/** Build the server `instructions` from the backends (a soft nudge — not a control). */
export function buildInstructions(backends: Backend[]): string {
  const list = backends.map((b) => `  - ${systemLabel(b.name, b.description)}`).join('\n');
  return (
    'This endpoint fronts multiple SAP systems through ARC-1. Every tool takes a ' +
    `REQUIRED \`${SYSTEM_PARAM}\` parameter naming which SAP system to act on:\n${list}\n` +
    `Always set \`${SYSTEM_PARAM}\` to the system the user intends — never assume. ` +
    'A tool may be unavailable on some systems. When unsure which system, ask the user.'
  );
}

interface AllSession {
  transport: StreamableHTTPServerTransport;
  currentUserJwt: string;
  owner: string;
  lastSeen: number;
  clients: Map<string, Client>;
}

export interface AllHandlers {
  post: (req: Request, res: Response) => Promise<void>;
  get: (req: Request, res: Response) => Promise<void>;
  del: (req: Request, res: Response) => Promise<void>;
}

const forbidden = (res: Response): void => {
  res.status(403).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'Forbidden: session belongs to a different user' },
  });
};

/**
 * Build the POST/GET/DELETE handlers for `/all/mcp`: an aggregating MCP server
 * that fans `tools/list` out to every backend (as the user) and routes each
 * `tools/call` to the backend named by the `system` argument.
 */
export function createAllHandlers(opts: {
  backends: Backend[];
  getUserJwt: GetUserJwt;
  resolve: Resolver;
  version?: string;
  now?: () => number;
  sessionTtlMs?: number;
}): AllHandlers {
  const { backends, getUserJwt, resolve } = opts;
  const version = opts.version ?? process.env.npm_package_version ?? '0.0.0';
  const now = opts.now ?? Date.now;
  const ttlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessions = new Map<string, AllSession>();
  const instructions = buildInstructions(backends);
  const validSystems = backends.map((b) => b.name);

  function closeSession(id: string): void {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id); // delete first so a re-entrant onsessionclosed is a no-op
    for (const c of s.clients.values()) void c.close().catch(() => {});
    void s.transport.close().catch(() => {});
  }

  // Opportunistic idle reaping (no leaked timer): every request bounds the session
  // map, closing sessions — and their N backend clients — idle past the TTL.
  function reapIdle(): void {
    for (const id of expiredSessionIds(sessions, now(), ttlMs)) {
      log.info('all: reaping idle session', { id });
      closeSession(id);
    }
  }

  // Get-or-connect a backend MCP client for this session. The backend URL is fixed
  // for the session; the per-user bearer is re-resolved on every outbound request
  // (the exchange is cached per tenant-user), never cached for the session lifetime.
  async function getClient(session: AllSession, backend: Backend): Promise<Client> {
    const existing = session.clients.get(backend.name);
    if (existing) return existing;
    const { url } = await resolve(backend.destination, session.currentUserJwt);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        const { bearer } = await resolve(backend.destination, session.currentUserJwt);
        headers.set('Authorization', `Bearer ${bearer}`);
        return fetch(input, { ...init, headers });
      },
    });
    const client = new Client({ name: 'arc-mcp-hub-all', version }, { capabilities: {} });
    await client.connect(transport);
    session.clients.set(backend.name, client);
    return client;
  }

  function buildServer(session: AllSession): Server {
    const server = new Server({ name: 'arc-mcp-hub', version }, { capabilities: { tools: {} }, instructions });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const settled = await Promise.allSettled(
        backends.map(async (b): Promise<BackendTools> => {
          const client = await getClient(session, b);
          const { tools } = await client.listTools();
          return { name: b.name, description: b.description, tools };
        }),
      );
      const ok: BackendTools[] = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') ok.push(r.value);
        else log.warn('all: backend tools/list failed, skipping', { env: backends[i].name, error: String(r.reason) });
      });
      return { tools: mergeTools(ok) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const parsed = parseSystemArg(req.params.arguments as Record<string, unknown> | undefined, validSystems);
      if ('error' in parsed) {
        return { content: [{ type: 'text', text: parsed.error }], isError: true };
      }
      const backend = backends.find((b) => b.name === parsed.system);
      if (!backend) {
        return { content: [{ type: 'text', text: `Unknown system '${parsed.system}'.` }], isError: true };
      }
      const client = await getClient(session, backend);
      return client.callTool({ name: req.params.name, arguments: parsed.rest });
    });

    return server;
  }

  const post = async (req: Request, res: Response): Promise<void> => {
    reapIdle();
    const userJwt = getUserJwt(req);
    const owner = principalKey(userJwt);
    const sid = req.headers['mcp-session-id'] as string | undefined;

    const existing = sid ? sessions.get(sid) : undefined;
    if (existing) {
      if (existing.owner !== owner) {
        forbidden(res);
        return;
      }
      existing.currentUserJwt = userJwt;
      existing.lastSeen = now();
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sid && isInitializeRequest(req.body)) {
      const session: AllSession = { currentUserJwt: userJwt, owner, lastSeen: now(), clients: new Map() } as AllSession;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, session);
        },
        onsessionclosed: (id) => {
          closeSession(id);
        },
      });
      session.transport = transport;
      await buildServer(session).connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res
      .status(400)
      .json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: no valid session' } });
  };

  const byId = async (req: Request, res: Response): Promise<void> => {
    reapIdle();
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const session = sid ? sessions.get(sid) : undefined;
    if (!session) {
      res.status(404).end(); // -> client re-initializes
      return;
    }
    const userJwt = getUserJwt(req);
    if (session.owner !== principalKey(userJwt)) {
      forbidden(res);
      return;
    }
    session.currentUserJwt = userJwt;
    session.lastSeen = now();
    await session.transport.handleRequest(req, res);
  };

  return { post, get: byId, del: byId };
}
