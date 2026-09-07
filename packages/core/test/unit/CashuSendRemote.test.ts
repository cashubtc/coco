import {
  Amount,
  OutputData,
  createBlindSignature,
  createNewMintKeys,
  hashToCurve,
  pointFromHex,
  serializeMintKeys,
  sumProofs,
  type MintKeys,
  type Proof,
} from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';
import { CashuSendRemote } from '../../infra/handlers/send/CashuSendRemote.ts';
import type { MintRequestFn } from '../../infra/MintRequestProvider.ts';
import type { MintMetadata } from '../../mints/MintMetadata.ts';
import { ProofValidationError } from '../../models/Error.ts';
import { serializeOutputData } from '../../utils.ts';
import { testMintInfo } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';
const unit = 'sat';
const seed = new Uint8Array(64).fill(1);
const keyset = createNewMintKeys(8, new Uint8Array(32).fill(2));
const keys: MintKeys = { id: keyset.keysetId, unit, keys: serializeMintKeys(keyset.pubKeys) };
const metadata: MintMetadata = {
  mint: {
    mintUrl,
    name: 'Test Mint',
    trusted: true,
    mintInfo: testMintInfo,
    createdAt: 1,
    updatedAt: 1,
  },
  keysets: [
    { mintUrl, id: keys.id, unit, keypairs: keys.keys, active: true, feePpk: 0, updatedAt: 1 },
  ],
};

function inputProof(): Proof {
  const secret = 'synthetic-input';
  const signature = createBlindSignature(
    hashToCurve(new TextEncoder().encode(secret)),
    keyset.privKeys['16']!,
    keys.id,
  );
  return { id: keys.id, secret, amount: Amount.from(16), C: signature.C_.toHex(true) };
}

type WireOutput = { id: string; amount: number; B_: string };
function sign(outputs: WireOutput[], signingKeyset = keyset) {
  return outputs.map((output) => {
    const signature = createBlindSignature(
      pointFromHex(output.B_),
      signingKeyset.privKeys[String(output.amount)]!,
      output.id,
    );
    return { id: output.id, amount: output.amount, C_: signature.C_.toHex(true) };
  });
}

function environment(signingKeyset = keyset) {
  const calls: Array<{ endpoint: string; body?: Record<string, unknown> }> = [];
  const request: MintRequestFn = async <T>({
    endpoint,
    requestBody,
  }: Parameters<MintRequestFn>[0]): Promise<T> => {
    calls.push({ endpoint, body: requestBody });
    if (endpoint.endsWith('/swap'))
      return { signatures: sign(requestBody!.outputs as WireOutput[], signingKeyset) } as T;
    if (endpoint.endsWith('/restore'))
      return {
        outputs: requestBody!.outputs,
        signatures: sign(requestBody!.outputs as WireOutput[], signingKeyset),
      } as T;
    if (endpoint.endsWith('/checkstate'))
      return { states: (requestBody!.Ys as string[]).map((Y) => ({ Y, state: 'UNSPENT' })) } as T;
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const mint = {
    getAuthProvider: () => undefined,
    fetchMintInfo: mock(async () => testMintInfo),
    fetchKeysets: mock(async () => ({
      keysets: [{ id: keys.id, unit, active: true, input_fee_ppk: 0 }],
    })),
    fetchKeysForId: mock(async () => keys.keys),
  };
  return { remote: new CashuSendRemote(mint, { getRequestFn: () => request }), calls, mint };
}

describe('CashuSendRemote', () => {
  it.each(['swap', 'reclaim'] as const)(
    'unblinds %s with the persisted output keyset when another active keyset is cheaper',
    async (operation) => {
      const original = createNewMintKeys(8, new Uint8Array(32).fill(3), {
        input_fee_ppk: 1000,
      });
      const originalKeys: MintKeys = {
        id: original.keysetId,
        unit,
        keys: serializeMintKeys(original.pubKeys),
      };
      const keep = OutputData.createDeterministicData(
        Amount.from(operation === 'swap' ? 8 : 16),
        seed,
        0,
        originalKeys,
      );
      const send =
        operation === 'swap'
          ? OutputData.createDeterministicData(Amount.from(8), seed, keep.length, originalKeys)
          : [];
      const outputData = serializeOutputData({ keep, send });
      const { remote, calls } = environment(original);
      const session = remote.open(
        {
          ...metadata,
          keysets: [
            ...metadata.keysets,
            {
              mintUrl,
              id: originalKeys.id,
              unit,
              keypairs: originalKeys.keys,
              active: true,
              feePpk: 1000,
              updatedAt: 1,
            },
          ],
        },
        unit,
      );
      // Inputs belong to the cheaper keyset. Only the output plan determines unblinding keys.
      const result =
        operation === 'swap'
          ? await session.swap({
              mintUrl,
              unit,
              amount: Amount.from(8),
              inputProofs: [inputProof()],
              outputData,
            })
          : { keep: await session.reclaim([inputProof()], outputData), send: [] };
      expect(calls).toHaveLength(1);
      expect(sumProofs([...result.keep, ...result.send]).toString()).toBe('16');
      for (const proof of [...result.keep, ...result.send]) {
        const expected = createBlindSignature(
          hashToCurve(new TextEncoder().encode(proof.secret)),
          original.privKeys[proof.amount.toString()]!,
          originalKeys.id,
        );
        expect(proof.id).toBe(originalKeys.id);
        expect(proof.C).toBe(expected.C_.toHex(true));
      }
      expect((calls[0]!.body!.outputs as WireOutput[]).map((output) => output.B_).sort()).toEqual(
        [...keep, ...send].map((output) => output.blindedMessage.B_).sort(),
      );
    },
  );

  it.each(['swap', 'reclaim'] as const)(
    'rejects invalid %s output keysets before contacting the mint',
    async (operation) => {
      const outputs = serializeOutputData({
        keep: OutputData.createDeterministicData(Amount.from(8), seed, 0, keys),
        send: OutputData.createDeterministicData(Amount.from(8), seed, 1, keys),
      });
      const missing = {
        ...outputs.keep[0]!,
        blindedMessage: { ...outputs.keep[0]!.blindedMessage, id: '' },
      };
      const different = {
        ...outputs.send[0]!,
        blindedMessage: { ...outputs.send[0]!.blindedMessage, id: 'different-keyset' },
      };
      const mixed =
        operation === 'swap'
          ? { keep: outputs.keep, send: [different] }
          : { keep: [...outputs.keep, different], send: [] };
      for (const outputData of [{ keep: [], send: [] }, { keep: [missing], send: [] }, mixed]) {
        const { remote, calls } = environment();
        const session = remote.open(metadata, unit);
        await expect(
          (async () =>
            operation === 'swap'
              ? session.swap({
                  mintUrl,
                  unit,
                  amount: Amount.from(8),
                  inputProofs: [inputProof()],
                  outputData,
                })
              : session.reclaim([inputProof()], outputData))(),
        ).rejects.toBeInstanceOf(ProofValidationError);
        expect(calls).toHaveLength(0);
      }
    },
  );

  it.each(['default', 'p2pk'] as const)(
    'submits fixed %s outputs and unblinds without seed access or additional metadata calls',
    async (method) => {
      const { remote, calls } = environment();
      const keep = OutputData.createDeterministicData(Amount.from(8), seed, 0, keys);
      const send =
        method === 'default'
          ? OutputData.createDeterministicData(Amount.from(8), seed, 1, keys)
          : OutputData.createP2PKData(
              { kind: 'P2PK', data: keys.keys['1']! },
              Amount.from(8),
              keys,
            );
      const outputData = serializeOutputData({ keep, send });
      const session = remote.open(metadata, unit);
      const result = await session.swap({
        mintUrl,
        unit,
        amount: Amount.from(8),
        inputProofs: [inputProof()],
        outputData,
      });
      expect(sumProofs(result.keep).toString()).toBe('8');
      expect(sumProofs(result.send).toString()).toBe('8');
      expect(result.send[0]!.secret).toBe(new TextDecoder().decode(send[0]!.secret));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.endpoint).toBe(`${mintUrl}/v1/swap`);
      expect((calls[0]!.body!.outputs as WireOutput[]).map((output) => output.B_).sort()).toEqual(
        [...keep, ...send].map((output) => output.blindedMessage.B_).sort(),
      );
      const states = await session.checkProofStates(result.send);
      expect(states.map((state) => state.state)).toEqual(['UNSPENT']);
    },
  );

  it('restores and reclaims only the supplied output plan', async () => {
    const { remote, calls } = environment();
    const keep = OutputData.createDeterministicData(Amount.from(16), seed, 0, keys);
    const outputData = serializeOutputData({ keep, send: [] });
    const session = remote.open(metadata, unit);
    const reclaimed = await session.reclaim([inputProof()], outputData);
    const restored = await session.restoreOutputs(outputData);
    expect(restored).toEqual(reclaimed);
    expect(sumProofs(restored).toString()).toBe('16');
    expect(calls.map((call) => call.endpoint)).toEqual([
      `${mintUrl}/v1/swap`,
      `${mintUrl}/v1/restore`,
      `${mintUrl}/v1/checkstate`,
    ]);
  });

  it('returns refreshed metadata while reusing immutable known keys', async () => {
    const { remote, mint } = environment();
    const result = await remote.fetchMintMetadata(mintUrl, metadata.keysets);
    expect(result.mintInfo).toEqual(testMintInfo);
    expect(result.keysets[0]!.keypairs).toEqual(keys.keys);
    expect(mint.fetchKeysForId).not.toHaveBeenCalled();
    await remote.fetchMintMetadata(mintUrl, []);
    expect(mint.fetchKeysForId).toHaveBeenCalledWith(mintUrl, keys.id);
  });
});
