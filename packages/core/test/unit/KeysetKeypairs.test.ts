import { describe, expect, it } from 'bun:test';
import { KeysetKeysConflictError } from '../../models/Error.ts';
import { reconcileKeysetKeypairs } from '../../models/Keyset.ts';

const mintUrl = 'https://mint.test';
const keysetId = 'keyset-id';
const keys = { '1': '02aa', '2': '02bb' };

describe('reconcileKeysetKeypairs', () => {
  it('adopts incoming keys when nothing is stored', () => {
    expect(reconcileKeysetKeypairs(mintUrl, keysetId, undefined, keys)).toEqual(keys);
    expect(reconcileKeysetKeypairs(mintUrl, keysetId, null, keys)).toEqual(keys);
    expect(reconcileKeysetKeypairs(mintUrl, keysetId, {}, keys)).toEqual(keys);
  });

  it('keeps stored keys when the same keys arrive in any order', () => {
    const stored = reconcileKeysetKeypairs(mintUrl, keysetId, keys, { '2': '02bb', '1': '02aa' });
    expect(stored).toEqual(keys);
  });

  it('keeps stored keys when a metadata-only write carries none', () => {
    expect(reconcileKeysetKeypairs(mintUrl, keysetId, keys, {})).toEqual(keys);
  });

  it('rejects keys that differ from the ones the id commits to', () => {
    expect(() => reconcileKeysetKeypairs(mintUrl, keysetId, keys, { '1': '02ff' })).toThrow(
      KeysetKeysConflictError,
    );
  });
});
