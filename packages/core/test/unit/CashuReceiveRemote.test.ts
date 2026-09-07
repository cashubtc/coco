import {
  Amount,
  OutputData,
  sumProofs,
  createNewMintKeys,
  serializeMintKeys,
  createBlindSignature,
  hashToCurve,
} from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { CashuReceiveRemote } from '../../infra/handlers/receive/CashuReceiveRemote.ts';
import { serializeOutputData } from '../../utils.ts';
import {
  createProtocolMintEnvironment,
  inputProof,
  keys,
  metadata,
  mintUrl,
  seed,
  unit,
} from '../fixtures/ProtocolMint.ts';

describe('CashuReceiveRemote', () => {
  it('unblinds replay with persisted output keys when the active preference changes', async () => {
    const original = createNewMintKeys(8, new Uint8Array(32).fill(3), { input_fee_ppk: 1000 });
    const originalKeys = { id: original.keysetId, unit, keys: serializeMintKeys(original.pubKeys) };
    const keep = OutputData.createDeterministicData(Amount.from(16), seed, 0, originalKeys);
    const { client } = createProtocolMintEnvironment({ signingKeyset: original });
    const remote = new CashuReceiveRemote(client).open(
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
    const result = await remote.receive({
      mintUrl,
      unit,
      inputProofs: [inputProof()],
      outputData: serializeOutputData({ keep, send: [] }),
    });
    expect(sumProofs(result).toString()).toBe('16');
    for (const proof of result) {
      const expected = createBlindSignature(
        hashToCurve(new TextEncoder().encode(proof.secret)),
        original.privKeys[proof.amount.toString()]!,
        originalKeys.id,
      );
      expect(proof.id).toBe(originalKeys.id);
      expect(proof.C).toBe(expected.C_.toHex(true));
    }
  });

  it('preserves 100-proof input-state batches during recovery', async () => {
    const { client, calls } = createProtocolMintEnvironment();
    const remote = new CashuReceiveRemote(client).open(metadata, unit);
    const proofs = Array.from({ length: 201 }, (_, index) => ({
      ...inputProof(),
      secret: `input-${index}`,
    }));
    const states = await remote.checkProofStates(proofs);
    expect(states).toHaveLength(201);
    expect(states.every((state) => state.state === 'UNSPENT')).toBe(true);
    expect(calls.map((call) => (call.body!.Ys as string[]).length)).toEqual([100, 100, 1]);
  });

  it('replays signed inputs and committed outputs without seed or metadata loading', async () => {
    const { client, calls, mint } = createProtocolMintEnvironment();
    const remote = new CashuReceiveRemote(client).open(metadata, unit);
    const input = {
      ...inputProof(),
      secret: JSON.stringify(['P2PK', { nonce: 'fixed-nonce', data: keys.keys['1']!, tags: [] }]),
      witness: '{"signatures":["persisted-signature"]}',
    };
    const keep = OutputData.createDeterministicData(Amount.from(16), seed, 0, keys);
    const outputData = serializeOutputData({ keep, send: [] });
    const request = { mintUrl, unit, inputProofs: [input], outputData };

    const first = await remote.receive(request);
    const replay = await remote.receive(request);

    expect(first).toEqual(replay);
    expect(sumProofs(first).toString()).toBe('16');
    expect(first[0]!.secret).toBe(new TextDecoder().decode(keep[0]!.secret));
    expect(calls.map((call) => call.endpoint)).toEqual([
      `${mintUrl}/v1/swap`,
      `${mintUrl}/v1/swap`,
    ]);
    expect(calls[0]!.body).toEqual(calls[1]!.body);
    expect((calls[0]!.body!.inputs as Array<{ witness: string }>)[0]!.witness).toBe(input.witness);
    expect((calls[0]!.body!.outputs as Array<{ B_: string }>).map((output) => output.B_)).toEqual(
      keep.map((output) => output.blindedMessage.B_),
    );
    expect(mint.fetchMintInfo).not.toHaveBeenCalled();
    expect(mint.fetchKeysForId).not.toHaveBeenCalled();
  });

  it.each([
    { restore: undefined, states: ['UNSPENT', 'UNSPENT'], status: 'complete-unspent', count: 2 },
    { restore: undefined, states: ['SPENT', 'SPENT'], status: 'complete-spent', count: 2 },
    { restore: undefined, states: ['SPENT', 'UNSPENT'], status: 'inconclusive', count: 2 },
    { restore: undefined, states: ['PENDING', 'PENDING'], status: 'inconclusive', count: 2 },
    { restore: 'none', states: [], status: 'none', count: 0 },
    { restore: 'partial', states: ['UNSPENT'], status: 'inconclusive', count: 1 },
    { restore: 'duplicate', states: ['UNSPENT'], status: 'inconclusive', count: 1 },
  ] as const)(
    'classifies Restore evidence: $restore $states → $status',
    async ({ restore, states, status, count }) => {
      const { client, calls } = createProtocolMintEnvironment({ restore, states: [...states] });
      const remote = new CashuReceiveRemote(client).open(metadata, unit);
      const keep = OutputData.createDeterministicData(Amount.from(12), seed, 0, keys);
      const observation = await remote.observeRestore(serializeOutputData({ keep, send: [] }));

      expect(observation.status).toBe(status);
      expect(observation.expectedOutputCount).toBe(2);
      expect(observation.restoredProofs).toHaveLength(count);
      expect(observation.unspentProofs).toHaveLength(
        states.slice(0, count).filter((state) => state === 'UNSPENT').length,
      );
      expect(calls[0]!.endpoint).toBe(`${mintUrl}/v1/restore`);
    },
  );
});
