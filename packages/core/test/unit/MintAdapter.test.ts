import { describe, expect, it } from 'bun:test';
import { MintAdapter } from '../../infra/MintAdapter.ts';

describe('MintAdapter', () => {
  it('normalizes mint URLs for auth provider lookup and removal', () => {
    const adapter = new MintAdapter({
      getRequestFn() {
        return async () => ({}) as never;
      },
    } as never);
    const provider = { getCAT: () => 'cat-token' } as never;

    adapter.setAuthProvider('https://MINT.TEST:443/', provider);

    expect(adapter.getAuthProvider('https://mint.test')).toBe(provider);
    expect(adapter.getAuthProvider('https://mint.test/')).toBe(provider);

    adapter.clearAuthProvider('https://mint.test/');

    expect(adapter.getAuthProvider('https://mint.test')).toBeUndefined();
  });
});
