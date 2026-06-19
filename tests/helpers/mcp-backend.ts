// A minimal in-process MCP backend over Streamable HTTP, for the local integration
// test. Two no-input tools; one McpServer + transport per session.

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';

export interface FakeBackend {
  url: string;
  close: () => Promise<void>;
}

export async function startFakeBackend(opts: { label?: string; extraTools?: string[] } = {}): Promise<FakeBackend> {
  const label = opts.label ?? 'backend-user';
  const extraTools = opts.extraTools ?? [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          if (transport) transports.set(id, transport);
        },
      });
      const server = new McpServer({ name: 'fake-backend', version: '1.0.0' });
      server.registerTool('ping', { description: 'returns pong' }, async () => ({
        content: [{ type: 'text' as const, text: 'pong' }],
      }));
      server.registerTool('whoami', { description: 'returns a fixed id' }, async () => ({
        content: [{ type: 'text' as const, text: label }],
      }));
      for (const tname of extraTools) {
        server.registerTool(tname, { description: `extra tool ${tname}` }, async () => ({
          content: [{ type: 'text' as const, text: `${tname}@${label}` }],
        }));
      }
      await server.connect(transport);
    }
    if (!transport) {
      res.status(400).json({ error: 'no session' });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const byId = async (req: Request, res: Response) => {
    const transport = transports.get(req.headers['mcp-session-id'] as string);
    if (!transport) {
      res.status(404).end();
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', byId);
  app.delete('/mcp', byId);

  const httpServer = app.listen(0);
  await new Promise<void>((resolve) => httpServer.once('listening', () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections(); // drop lingering SSE/keep-alive so close() returns
        httpServer.close(() => resolve());
      }),
  };
}
