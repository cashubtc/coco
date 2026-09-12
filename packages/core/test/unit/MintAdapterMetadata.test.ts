import { describe, expect, it, mock } from 'bun:test';
import { MintAdapter } from '../../infra/MintAdapter.ts';
import { MintRequestProvider } from '../../infra/MintRequestProvider.ts';
import { KeysetSyncError, MintFetchError } from '../../models/Error.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';
const keyset = { id: testMintKeysetId(), unit: 'sat', active: true, input_fee_ppk: 2 };
function environment() {
  const adapter = Object.assign(new MintAdapter(new MintRequestProvider()), {
    fetchMintInfo: mock(async () => testMintInfo),
    fetchKeysets: mock(async () => ({ keysets: [keyset] })),
    fetchKeysForId: mock(async () => testMintKeypairs),
  });
  return adapter;
}

describe('MintAdapter.fetchMintMetadata', () => {
  it('reuses immutable known keys and fetches missing keys', async () => {
    const adapter = environment();
    const known = { mintUrl, ...keyset, feePpk: 0, updatedAt: 0, keypairs: testMintKeypairs };
    const result = await adapter.fetchMintMetadata(mintUrl, [known]);
    expect(result.mintInfo).toEqual(testMintInfo);
    expect(result.keysets[0]?.keypairs).toEqual(testMintKeypairs);
    expect(result.keysets[0]?.feePpk).toBe(2);
    expect(adapter.fetchKeysForId).not.toHaveBeenCalled();
    await adapter.fetchMintMetadata(mintUrl, []);
    expect(adapter.fetchKeysForId).toHaveBeenCalledWith(mintUrl, keyset.id);
  });

  it('excludes unsupported BLS keysets before fetching keys', async () => {
    const adapter = environment();
    adapter.fetchKeysets.mockResolvedValue({ keysets: [{ ...keyset, id: '0200000000000000' }] });
    expect((await adapter.fetchMintMetadata(mintUrl, [])).keysets).toEqual([]);
    expect(adapter.fetchKeysForId).not.toHaveBeenCalled();
  });

  it('preserves domain errors for failed metadata or key fetches', async () => {
    const adapter = environment();
    adapter.fetchMintInfo.mockRejectedValueOnce(new Error('offline'));
    await expect(adapter.fetchMintMetadata(mintUrl, [])).rejects.toBeInstanceOf(MintFetchError);
    adapter.fetchKeysets.mockRejectedValueOnce(new Error('offline'));
    await expect(adapter.fetchMintMetadata(mintUrl, [])).rejects.toBeInstanceOf(MintFetchError);
    adapter.fetchKeysForId.mockRejectedValueOnce(new Error('offline'));
    await expect(adapter.fetchMintMetadata(mintUrl, [])).rejects.toBeInstanceOf(KeysetSyncError);
  });
});
