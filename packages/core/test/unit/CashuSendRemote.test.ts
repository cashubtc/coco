import { ProofValidationError } from '../../models/Error.ts';
import {
  Amount,
  OutputData,
  sumProofs,
  createNewMintKeys,
  serializeMintKeys,
  createBlindSignature,
  hashToCurve,
  type MintKeys,
} from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { CashuSendRemote } from '../../infra/handlers/send/CashuSendRemote.ts';
import { serializeOutputData } from '../../utils.ts';
import { testMintInfo } from '../fixtures/MintMetadata.ts';
import {
  createProtocolMintEnvironment,
  inputProof,
  keys,
  metadata,
  mintUrl,
  seed,
  unit,
} from '../fixtures/ProtocolMint.ts';

function environment(signingKeyset?: ReturnType<typeof createNewMintKeys>) {
  const environment = createProtocolMintEnvironment({ signingKeyset });
  return { ...environment, remote: new CashuSendRemote(environment.client) };
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
      expect(
        (calls[0]!.body!.outputs as Array<{ B_: string }>).map((output) => output.B_).sort(),
      ).toEqual([...keep, ...send].map((output) => output.blindedMessage.B_).sort());
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
      expect(
        (calls[0]!.body!.outputs as Array<{ B_: string }>).map((output) => output.B_).sort(),
      ).toEqual([...keep, ...send].map((output) => output.blindedMessage.B_).sort());
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
