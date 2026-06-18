// Local integration test: the transparent proxy relays a real in-process MCP
// backend's tools through, end-to-end (the spike, automated — no BTP). Auth is
// stubbed open here; real inbound auth + the per-user exchange are verified in
// the live BTP e2e.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnvHandlers } from '../src/proxy.js';
import { type FakeBackend, startFakeBackend } from './helpers/mcp-backend.js';

describe('local integration: proxy -> backend', () => {
  let backend: FakeBackend;
  let proxyHttp: Server;
  let proxyUrl: string;

  beforeAll(async () => {
    backend = await startFakeBackend();
    const app = express();
    app.use(express.json());
    const h = createEnvHandlers({
      getUserJwt: () => 'user-jwt',
      resolve: async () => ({ url: backend.url, bearer: 'test-bearer' }),
    });
    app.post('/dev/mcp', (req, res) => {
      void h.post(req, res);
    });
    app.get('/dev/mcp', (req, res) => {
      void h.get(req, res);
    });
    app.delete('/dev/mcp', (req, res) => {
      void h.del(req, res);
    });
    proxyHttp = app.listen(0);
    await new Promise<void>((r) => proxyHttp.once('listening', () => r()));
    proxyUrl = `http://127.0.0.1:${(proxyHttp.address() as AddressInfo).port}/dev/mcp`;
  });

  afterAll(async () => {
    proxyHttp.closeAllConnections(); // drop lingering SSE/keep-alive so close() returns
    await new Promise<void>((r) => proxyHttp.close(() => r()));
    await backend.close();
  });

  it('relays initialize + tools/list + tools/call through the proxy', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(proxyUrl)));

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ping', 'whoami']);

    const result = await client.callTool({ name: 'ping' });
    expect(JSON.stringify(result)).toContain('pong');

    await client.close();
  });
});
