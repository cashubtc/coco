import { describe, expect, it } from 'bun:test';

import {
  assertMintSwapOperationParent,
  createMintSwapOperationParent,
  isMintSwapOperationParent,
} from '../../operations/MintSwapOperationParent.ts';

describe('MintSwapOperationParent', () => {
  it('creates and recognizes a discriminated Mint Swap parent', () => {
    const parent = createMintSwapOperationParent('mint-swap-1');

    expect(parent).toEqual({ kind: 'mint-swap', id: 'mint-swap-1' });
    expect(isMintSwapOperationParent(parent)).toBe(true);
    expect(() => assertMintSwapOperationParent(parent)).not.toThrow();
  });

  it('rejects invalid runtime and persisted parent values', () => {
    for (const invalid of [
      undefined,
      null,
      {},
      { kind: 'mint-swap', id: '' },
      { kind: 'mint-swap', id: '   ' },
      { kind: 'other', id: 'mint-swap-1' },
    ]) {
      expect(isMintSwapOperationParent(invalid)).toBe(false);
      expect(() => assertMintSwapOperationParent(invalid)).toThrow(
        'kind mint-swap and a non-empty id',
      );
    }

    expect(() => createMintSwapOperationParent('')).toThrow('kind mint-swap and a non-empty id');
  });
});
