import { describe, expect, it } from 'vitest';
import { configuredKeys, keyFailure } from './gemini.js';

describe('configuredKeys', () => {
  it('reads a list in any separator, then the single key, without repeats', () => {
    expect(configuredKeys('k1, k2\nk3;k1', 'k4')).toEqual(['k1', 'k2', 'k3', 'k4']);
    expect(configuredKeys('', 'only')).toEqual(['only']);
    expect(configuredKeys('', '')).toEqual([]);
  });
});

describe('keyFailure', () => {
  it('moves on from an expired or invalid key for hours', () => {
    const f = keyFailure(Object.assign(new Error('{"error":{"code":400,"message":"API key expired. Please renew the API key."}}'), { status: 400 }));
    expect(f?.reason).toBe('invalid or expired');
    expect(f!.cooldownMs).toBeGreaterThan(60 * 60_000);
    expect(keyFailure(Object.assign(new Error('API_KEY_INVALID'), { status: 400 }))?.reason).toBe('invalid or expired');
    expect(keyFailure(Object.assign(new Error('denied'), { status: 403 }))?.reason).toBe('not authorised');
  });

  it('rests a key out of quota for a minute', () => {
    expect(keyFailure(Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }))).toEqual({ reason: 'out of quota or rate-limited', cooldownMs: 60_000 });
  });

  it('leaves other errors to the record retry', () => {
    expect(keyFailure(Object.assign(new Error('Internal error'), { status: 500 }))).toBeNull();
    expect(keyFailure(Object.assign(new Error('Request contains an invalid argument.'), { status: 400 }))).toBeNull();
  });
});
