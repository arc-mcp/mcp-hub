import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it, vi } from 'vitest';
import { createEnvHandlers, mcpProxy } from '../src/proxy.js';

// Minimal fake Transport (start/send/close + the optional event hooks mcpProxy assigns).
function fakeTransport() {
  const sent: unknown[] = [];
  const t = {
    sent,
    closed: false,
    start: async () => {},
    send: async (m: unknown) => {
      sent.push(m);
    },
    close: async () => {
      t.closed = true;
      (t as unknown as Transport).onclose?.();
    },
  };
  return t as typeof t & Transport;
}

describe('mcpProxy', () => {
  it('forwards messages in both directions', async () => {
    const toClient = fakeTransport();
    const toServer = fakeTransport();
    mcpProxy({ toClient, toServer });
    toClient.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'ping' } as never, undefined);
    toServer.onmessage?.({ jsonrpc: '2.0', id: 1, result: {} } as never, undefined);
    await Promise.resolve();
    expect(toServer.sent).toHaveLength(1); // client -> backend
    expect(toClient.sent).toHaveLength(1); // backend -> client
  });

  it('propagates close from one side to the other', () => {
    const toClient = fakeTransport();
    const toServer = fakeTransport();
    mcpProxy({ toClient, toServer });
    toClient.onclose?.();
    expect(toServer.closed).toBe(true);
  });

  it('swallows benign SSE-teardown errors but logs real ones', () => {
    const toClient = fakeTransport();
    const toServer = fakeTransport();
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    mcpProxy({ toClient, toServer });
    toServer.onerror?.(new Error('SSE stream disconnected: terminated'));
    expect(spy).not.toHaveBeenCalled();
    toServer.onerror?.(new Error('connection refused'));
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe('createEnvHandlers', () => {
  const getUserJwt = () => 'u';
  const resolve = async () => ({ url: 'http://127.0.0.1:1/mcp', bearer: 'b' });

  function fakeRes() {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(c: number) {
        res.statusCode = c;
        return res;
      },
      json(b: unknown) {
        res.body = b;
        return res;
      },
      end() {
        return res;
      },
    };
    return res;
  }

  it('returns 400 for a non-initialize request without a session', async () => {
    const { post } = createEnvHandlers({ getUserJwt, resolve });
    const res = fakeRes();
    await post({ headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown session id on GET', async () => {
    const { get } = createEnvHandlers({ getUserJwt, resolve });
    const res = fakeRes();
    await get({ headers: { 'mcp-session-id': 'nope' } } as never, res as never);
    expect(res.statusCode).toBe(404);
  });
});
