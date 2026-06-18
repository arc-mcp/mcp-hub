import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { getUserJwt, HUB_SCOPES, protectedResourceMetadata } from '../src/auth.js';

describe('protectedResourceMetadata', () => {
  it('advertises a per-env resource matching the called URL (RFC 9728 §3.3)', () => {
    const dev = protectedResourceMetadata('https://hub.example.com', 'dev');
    expect(dev.path).toBe('/.well-known/oauth-protected-resource/dev/mcp');
    expect(dev.doc.resource).toBe('https://hub.example.com/dev/mcp');
    expect(dev.doc.authorization_servers).toEqual(['https://hub.example.com/']);
    expect(dev.doc.scopes_supported).toEqual(HUB_SCOPES);
    expect(dev.resourceMetadataUrl).toBe('https://hub.example.com/.well-known/oauth-protected-resource/dev/mcp');
  });

  it('gives distinct resources per env', () => {
    const dev = protectedResourceMetadata('https://hub.example.com/', 'dev');
    const prod = protectedResourceMetadata('https://hub.example.com/', 'prod');
    expect(dev.doc.resource).toBe('https://hub.example.com/dev/mcp');
    expect(prod.doc.resource).toBe('https://hub.example.com/prod/mcp');
  });

  it('normalizes a trailing slash on appUrl', () => {
    const dev = protectedResourceMetadata('https://hub.example.com/', 'dev');
    expect(dev.doc.resource).toBe('https://hub.example.com/dev/mcp');
  });
});

describe('getUserJwt', () => {
  it('returns the token set by the bearer middleware', () => {
    const req = { auth: { token: 'jwt-123' } } as unknown as Request;
    expect(getUserJwt(req)).toBe('jwt-123');
  });

  it('throws when no auth is present', () => {
    expect(() => getUserJwt({} as Request)).toThrow(/No authenticated user token/);
  });
});
