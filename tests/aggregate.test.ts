// Tests for the aggregated /all/mcp endpoint: pure merge/route helpers + an
// in-process integration over TWO distinguishable backends (merge + routing +
// the required `system` param), mirroring integration.local.test.ts.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInstructions, createAllHandlers, mergeTools, parseSystemArg, SYSTEM_PARAM } from '../src/aggregate.js';
import type { Backend } from '../src/config.js';
import { type FakeBackend, startFakeBackend } from './helpers/mcp-backend.js';

const tool = (name: string, props: Record<string, unknown> = {}, required: string[] = []): Tool =>
  ({ name, description: name, inputSchema: { type: 'object', properties: props, required } }) as Tool;

const sysSchema = (t: Tool): { enum?: string[]; description?: string } =>
  (t.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>)[SYSTEM_PARAM];

describe('mergeTools', () => {
  const merged = mergeTools([
    { name: 'dev', description: 'Dev box', tools: [tool('ping'), tool('SAPGit', { x: { type: 'string' } }, ['x'])] },
    { name: 'qa', tools: [tool('ping')] },
  ]);
  const byName = (n: string) => merged.find((t) => t.name === n);

  it('unifies shared tools and dedupes by name', () => {
    expect(merged.map((t) => t.name).sort()).toEqual(['SAPGit', 'ping']);
  });

  it('injects a required `system` enum on every tool', () => {
    for (const t of merged) {
      expect(t.inputSchema.required).toContain(SYSTEM_PARAM);
      expect(sysSchema(t)?.enum).toBeDefined();
    }
  });

  it('scopes each tool`s system enum to the systems that expose it', () => {
    expect(sysSchema(byName('ping') as Tool)?.enum?.sort()).toEqual(['dev', 'qa']);
    expect(sysSchema(byName('SAPGit') as Tool)?.enum).toEqual(['dev']); // absent on qa
  });

  it('preserves the original schema (properties + required)', () => {
    const git = byName('SAPGit') as Tool;
    expect(git.inputSchema.required).toEqual(expect.arrayContaining(['system', 'x']));
    expect((git.inputSchema.properties as Record<string, unknown>).x).toBeDefined();
  });

  it('surfaces the backend description in the enum hint', () => {
    expect(sysSchema(byName('ping') as Tool)?.description).toContain('Dev box');
  });
});

describe('parseSystemArg', () => {
  const valid = ['dev', 'qa'];

  it('returns the system and strips it from the rest', () => {
    expect(parseSystemArg({ system: 'qa', name: 'ZFOO' }, valid)).toEqual({ system: 'qa', rest: { name: 'ZFOO' } });
  });
  it('errors when system is missing', () => {
    expect(parseSystemArg({ name: 'ZFOO' }, valid)).toHaveProperty('error');
    expect(parseSystemArg(undefined, valid)).toHaveProperty('error');
  });
  it('errors when system is unknown', () => {
    const r = parseSystemArg({ system: 'prod' }, valid);
    expect(r).toHaveProperty('error');
    if ('error' in r) expect(r.error).toContain('prod');
  });
});

describe('buildInstructions', () => {
  it('names each system (with description) and mandates the system param', () => {
    const s = buildInstructions([
      { name: 'dev', destination: 'd', description: 'S/4 2023' },
      { name: 'qa', destination: 'q' },
    ]);
    expect(s).toContain('dev (S/4 2023)');
    expect(s).toContain('qa');
    expect(s).toContain(SYSTEM_PARAM);
  });
});

describe('local integration: /all -> two backends', () => {
  let dev: FakeBackend;
  let qa: FakeBackend;
  let http: Server;
  let url: string;

  beforeAll(async () => {
    dev = await startFakeBackend({ label: 'dev', extraTools: ['SAPGit'] });
    qa = await startFakeBackend({ label: 'qa' });
    const backends: Backend[] = [
      { name: 'dev', destination: 'dest-dev' },
      { name: 'qa', destination: 'dest-qa' },
    ];
    const h = createAllHandlers({
      backends,
      getUserJwt: () => 'user-jwt',
      resolve: async (destination) => ({
        url: destination === 'dest-dev' ? dev.url : qa.url,
        bearer: 'test-bearer',
      }),
    });
    const app = express();
    app.use(express.json());
    app.post('/all/mcp', (req, res) => void h.post(req, res));
    app.get('/all/mcp', (req, res) => void h.get(req, res));
    app.delete('/all/mcp', (req, res) => void h.del(req, res));
    http = app.listen(0);
    await new Promise<void>((r) => http.once('listening', () => r()));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/all/mcp`;
  });

  afterAll(async () => {
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    await dev.close();
    await qa.close();
  });

  it('merges both backends` tools with per-tool system enums', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['SAPGit', 'ping', 'whoami']);
    const sysOf = (n: string) =>
      (tools.find((t) => t.name === n)?.inputSchema.properties as Record<string, { enum?: string[] }>)[SYSTEM_PARAM]
        ?.enum;
    expect(sysOf('whoami')?.sort()).toEqual(['dev', 'qa']);
    expect(sysOf('SAPGit')).toEqual(['dev']);
    await client.close();
  });

  it('routes a call to the system named by the `system` arg', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const onQa = await client.callTool({ name: 'whoami', arguments: { system: 'qa' } });
    expect(JSON.stringify(onQa)).toContain('qa');
    const onDev = await client.callTool({ name: 'whoami', arguments: { system: 'dev' } });
    expect(JSON.stringify(onDev)).toContain('dev');
    await client.close();
  });

  it('rejects a call with missing or unknown system', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const missing = await client.callTool({ name: 'whoami', arguments: {} });
    expect(missing.isError).toBe(true);
    const unknown = await client.callTool({ name: 'whoami', arguments: { system: 'prod' } });
    expect(unknown.isError).toBe(true);
    await client.close();
  });
});
