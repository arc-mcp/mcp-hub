// Transparent per-environment MCP proxy.
//
// Each `/<env>/mcp` bridges a client-facing StreamableHTTPServerTransport to a
// backend-facing StreamableHTTPClientTransport via `mcpProxy` (the MCP Inspector
// pattern). Raw messages — including tool lists and notifications — pass through
// verbatim, so the backend's tool surface is preserved unchanged.
//
// The backend URL + per-user bearer come from a `resolve(userJwt)` callback
// (injected by server.ts), so this module has no auth/BTP dependency and is
// unit-testable. The bearer is injected on EVERY outbound request, re-resolved
// against the session's CURRENT user JWT — never cached for the session lifetime
// (a stale-per-session token was a proven failure in the spike).

import { randomUUID } from 'node:crypto';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { log } from './log.js';

/** Resolve the backend URL + per-user bearer for a given (current) user JWT. */
export type Resolve = (userJwt: string) => Promise<{ url: string; bearer: string }>;

/** Read the validated user JWT off an inbound request (set by the bearer middleware). */
export type GetUserJwt = (req: Request) => string;

interface Session {
  client: StreamableHTTPServerTransport;
  backend: StreamableHTTPClientTransport;
  /** Updated on every inbound request so the outbound bearer tracks the latest user token. */
  currentUserJwt: string;
}

export interface EnvHandlers {
  post: (req: Request, res: Response) => Promise<void>;
  get: (req: Request, res: Response) => Promise<void>;
  del: (req: Request, res: Response) => Promise<void>;
}

const isBenign = (e: Error): boolean => /terminated|abort/i.test(e?.message ?? ''); // SSE stream closing on teardown

/** Bridge two raw MCP transports so messages (incl. notifications) pass through verbatim. */
export function mcpProxy({ toClient, toServer }: { toClient: Transport; toServer: Transport }): void {
  let clientClosed = false;
  let serverClosed = false;

  toClient.onmessage = (m) => {
    void toServer.send(m).catch((e: Error) => log.error('proxy ->backend send failed', { error: e.message }));
  };
  toServer.onmessage = (m) => {
    void toClient.send(m).catch((e: Error) => log.error('proxy ->client send failed', { error: e.message }));
  };
  toClient.onclose = () => {
    if (serverClosed) return;
    clientClosed = true;
    void toServer.close().catch(() => {});
  };
  toServer.onclose = () => {
    if (clientClosed) return;
    serverClosed = true;
    void toClient.close().catch(() => {});
  };
  toClient.onerror = (e) => {
    if (!isBenign(e)) log.error('proxy client transport error', { error: e.message });
  };
  toServer.onerror = (e) => {
    if (!isBenign(e)) log.error('proxy backend transport error', { error: e.message });
  };
}

/**
 * Build the POST/GET/DELETE Express handlers for one environment's `/<env>/mcp`.
 * `getUserJwt` extracts the validated user token; `resolve` turns it into the
 * backend URL + per-user bearer.
 */
export function createEnvHandlers(opts: { getUserJwt: GetUserJwt; resolve: Resolve }): EnvHandlers {
  const { getUserJwt, resolve } = opts;
  const sessions = new Map<string, Session>();

  const post = async (req: Request, res: Response): Promise<void> => {
    const userJwt = getUserJwt(req);
    const sid = req.headers['mcp-session-id'] as string | undefined;

    const existing = sid ? sessions.get(sid) : undefined;
    if (existing) {
      existing.currentUserJwt = userJwt;
      await existing.client.handleRequest(req, res, req.body);
      return;
    }

    if (!sid && isInitializeRequest(req.body)) {
      const { url } = await resolve(userJwt); // backend URL is fixed for the session
      const session = { currentUserJwt: userJwt } as Session;

      const backend = new StreamableHTTPClientTransport(new URL(url), {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          const { bearer } = await resolve(session.currentUserJwt); // per outbound request, latest user
          headers.set('Authorization', `Bearer ${bearer}`);
          return fetch(input, { ...init, headers });
        },
      });
      const client = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, session);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      session.client = client;
      session.backend = backend;

      mcpProxy({ toClient: client, toServer: backend });
      await backend.start();
      await client.start();
      await client.handleRequest(req, res, req.body);
      return;
    }

    res
      .status(400)
      .json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: no valid session' } });
  };

  const byId = async (req: Request, res: Response): Promise<void> => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const session = sid ? sessions.get(sid) : undefined;
    if (!session) {
      res.status(404).end(); // -> client re-initializes (MetaMCP #294)
      return;
    }
    session.currentUserJwt = getUserJwt(req);
    await session.client.handleRequest(req, res);
  };

  return { post, get: byId, del: byId };
}
