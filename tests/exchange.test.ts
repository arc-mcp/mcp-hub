import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@arc-mcp/xsuaa-auth/btp', () => ({
  parseVCAPServices: vi.fn(),
  lookupDestinationWithUserToken: vi.fn(),
}));

import { lookupDestinationWithUserToken, parseVCAPServices } from '@arc-mcp/xsuaa-auth/btp';
import { createResolver } from '../src/exchange.js';

const mockedParse = vi.mocked(parseVCAPServices);
const mockedLookup = vi.mocked(lookupDestinationWithUserToken);

beforeEach(() => {
  vi.clearAllMocks();
  mockedParse.mockReturnValue({} as never);
});

describe('createResolver', () => {
  it('throws at startup when no BTP destination binding', () => {
    mockedParse.mockReturnValue(null);
    expect(() => createResolver({} as never)).toThrow(/destination service/);
  });

  it('resolves backend url + per-user bearer', async () => {
    mockedLookup.mockResolvedValue({
      destination: { URL: 'https://backend.example/mcp' },
      authTokens: { bearerToken: 'tok' },
    } as never);
    const resolve = createResolver({} as never);
    await expect(resolve('arc1-dev', 'ujwt')).resolves.toEqual({ url: 'https://backend.example/mcp', bearer: 'tok' });
  });

  it('appends /mcp when the destination URL lacks it', async () => {
    mockedLookup.mockResolvedValue({
      destination: { URL: 'https://backend.example/' },
      authTokens: { bearerToken: 'tok' },
    } as never);
    const resolve = createResolver({} as never);
    await expect(resolve('arc1-dev', 'ujwt')).resolves.toEqual({ url: 'https://backend.example/mcp', bearer: 'tok' });
  });

  it('throws when no bearer is returned (destination not OAuth2JWTBearer)', async () => {
    mockedLookup.mockResolvedValue({ destination: { URL: 'https://x/mcp' }, authTokens: {} } as never);
    const resolve = createResolver({} as never);
    await expect(resolve('arc1-dev', 'ujwt')).rejects.toThrow(/OAuth2JWTBearer/);
  });
});
