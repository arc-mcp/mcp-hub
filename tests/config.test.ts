import { describe, expect, it } from 'vitest';
import { loadHubConfig } from '../src/config.js';

const env = (HUB_BACKENDS?: string): NodeJS.ProcessEnv => ({ HUB_BACKENDS }) as NodeJS.ProcessEnv;

describe('loadHubConfig', () => {
  it('parses a valid list', () => {
    const cfg = loadHubConfig(env('[{"name":"dev","destination":"arc1-dev"},{"name":"qa","destination":"arc1-qa"}]'));
    expect(cfg.backends).toHaveLength(2);
    expect(cfg.backends[0]).toEqual({ name: 'dev', destination: 'arc1-dev' });
  });

  it('throws when HUB_BACKENDS is missing', () => {
    expect(() => loadHubConfig(env(undefined))).toThrow(/required/);
  });

  it('throws when HUB_BACKENDS is blank', () => {
    expect(() => loadHubConfig(env('   '))).toThrow(/required/);
  });

  it('throws on malformed JSON', () => {
    expect(() => loadHubConfig(env('[not json'))).toThrow(/not valid JSON/);
  });

  it('throws on an empty array', () => {
    expect(() => loadHubConfig(env('[]'))).toThrow(/non-empty/);
  });

  it('throws on a duplicate name', () => {
    const raw = '[{"name":"dev","destination":"a"},{"name":"dev","destination":"b"}]';
    expect(() => loadHubConfig(env(raw))).toThrow(/duplicate/);
  });

  it('throws on a bad name', () => {
    for (const bad of ['DEV', 'a_b', '', 'a b']) {
      expect(() => loadHubConfig(env(`[{"name":${JSON.stringify(bad)},"destination":"a"}]`))).toThrow(
        /name must match/,
      );
    }
  });

  it('throws on a missing destination', () => {
    expect(() => loadHubConfig(env('[{"name":"dev"}]'))).toThrow(/destination/);
  });

  it('throws when an entry is not an object', () => {
    expect(() => loadHubConfig(env('["dev"]'))).toThrow(/must be an object/);
  });
});

describe('session TTL', () => {
  const base = { HUB_BACKENDS: '[{"name":"dev","destination":"a"}]' } as NodeJS.ProcessEnv;
  it('defaults to 30 days', () => {
    expect(loadHubConfig({ ...base }).sessionTtlMs).toBe(30 * 24 * 60 * 60_000);
  });
  it('honors HUB_SESSION_TTL_MINUTES', () => {
    expect(loadHubConfig({ ...base, HUB_SESSION_TTL_MINUTES: '90' }).sessionTtlMs).toBe(90 * 60_000);
  });
  it('throws on a non-positive or non-numeric TTL', () => {
    expect(() => loadHubConfig({ ...base, HUB_SESSION_TTL_MINUTES: '0' })).toThrow(/positive/);
    expect(() => loadHubConfig({ ...base, HUB_SESSION_TTL_MINUTES: 'abc' })).toThrow(/positive/);
  });
});
