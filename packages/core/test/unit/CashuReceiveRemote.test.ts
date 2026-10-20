import { createKeyChain } from '../../proofs/KeysetSelection.ts';
import {
  Amount,
  OutputData,
  Wallet,
  Mint,
  createBlindSignature,
  createNewMintKeys,
  hashToCurve,
  pointFromHex,
  serializeMintKeys,
  type MintKeys,
  type Proof,
} from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { CashuReceiveRemote } from '../../infra/handlers/receive/CashuReceiveRemote.ts';
import type { MintRequestFn } from '../../infra/MintRequestProvider.ts';
import type { MintMetadata } from '../../mints/MintMetadata.ts';
import { serializeOutputData, deserializeOutputData } from '../../utils.ts';
import { testMintInfo } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';
const mintKeys = createNewMintKeys(8, new Uint8Array(32).fill(2));
const keys: MintKeys = {
  id: mintKeys.keysetId,
  unit: 'sat',
  keys: serializeMintKeys(mintKeys.pubKeys),
};
const metadata: MintMetadata = {
  mint: {
    mintUrl,
    trusted: true,
    name: 'Test',
    mintInfo: testMintInfo,
    createdAt: 1,
    updatedAt: 1,
  },
  keysets: [
    {
      mintUrl,
      id: keys.id,
      keypairs: keys.keys,
      unit: 'sat',
      active: true,
      feePpk: 0,
      updatedAt: 1,
    },
  ],
};
type WireOutput = { id: string; amount: number; B_: string };

function environment() {
  const calls: Array<{ endpoint: string; body?: Record<string, unknown> }> = [];
  const behavior = { restore: 'all', states: 'UNSPENT', swap: 'valid' };
  const sign = (output: WireOutput) => ({
    id: output.id,
    amount: output.amount,
    C_: createBlindSignature(
      pointFromHex(output.B_),
      mintKeys.privKeys[String(output.amount)]!,
      output.id,
    ).C_.toHex(true),
  });
  const request: MintRequestFn = async <T>(input: Parameters<MintRequestFn>[0]): Promise<T> => {
    calls.push({ endpoint: input.endpoint, body: input.requestBody });
    if (input.endpoint.endsWith('/swap')) {
      const outputs = input.requestBody!.outputs as WireOutput[];
      const signatures = outputs.map(sign);
      if (behavior.swap === 'short') signatures.pop();
      if (behavior.swap === 'wrong-id') signatures[0]!.id = 'wrong-id';
      if (behavior.swap === 'wrong-amount') signatures[0]!.amount = 128;
      return { signatures } as T;
    }
    if (input.endpoint.endsWith('/restore')) {
      let outputs = input.requestBody!.outputs as WireOutput[];
      if (behavior.restore === 'none') outputs = [];
      if (behavior.restore === 'partial') outputs = outputs.slice(0, 1);
      if (behavior.restore === 'duplicate') outputs = [outputs[0]!, outputs[0]!];
      if (behavior.restore === 'reverse') outputs = [...outputs].reverse();
      const signatures = outputs.map(sign);
      if (behavior.restore === 'mismatch') signatures.pop();
      if (behavior.restore === 'wrong-id')
        outputs = outputs.map((output) => ({ ...output, id: 'unexpected' }));
      return { outputs, signatures } as T;
    }
    if (input.endpoint.endsWith('/checkstate')) {
      let states = (input.requestBody!.Ys as string[]).map((Y) => ({
        Y,
        state: behavior.states === 'wrong-Y' ? 'SPENT' : behavior.states,
        witness: null,
      }));
      if (behavior.states === 'short') states = [];
      if (behavior.states === 'wrong-Y') states[0]!.Y = 'other';
      return { states } as T;
    }
    throw new Error(`Unexpected protocol request: ${input.endpoint}`);
  };
  const remote = new CashuReceiveRemote(
    { getAuthProvider: () => undefined },
    { getRequestFn: () => request },
  );
  const outputData = serializeOutputData({
    keep: OutputData.createDeterministicData(7, new Uint8Array(32).fill(1), 0, keys),
    send: [],
  });
  const inputProofs: Proof[] = [
    {
      id: keys.id,
      amount: Amount.from(2),
      secret: JSON.stringify(['P2PK', { nonce: 'first', data: keys.keys['1'], tags: [] }]),
      C: keys.keys['1']!,
      witness: '{"signatures":["persisted"]}',
    },
    { id: keys.id, amount: Amount.from(4), secret: 'second', C: keys.keys['2']! },
    { id: keys.id, amount: Amount.from(1), secret: 'third', C: keys.keys['1']! },
  ];
  return {
    remote,
    calls,
    behavior,
    requestFn: request,
    request: { mintUrl, unit: 'sat', inputProofs, outputData },
  };
}

describe('Cashu Receive protocol', () => {
  it('submits identical input order, witnesses, and outputs on replay and unblinds with the saved keyset', async () => {
    const env = environment();
    // Rotation does not change which keys unblind the committed plan.
    const rotated = createNewMintKeys(8, new Uint8Array(32).fill(3));
    const session = env.remote.open(
      {
        ...metadata,
        keysets: [
          { ...metadata.keysets[0]!, active: false },
          {
            ...metadata.keysets[0]!,
            id: rotated.keysetId,
            keypairs: serializeMintKeys(rotated.pubKeys),
            active: true,
          },
        ],
      },
      'sat',
    );
    const proofs = await session.receive(env.request);
    expect(await session.receive(env.request)).toEqual(proofs);
    expect(env.calls[0]!.body).toEqual(env.calls[1]!.body);
    expect((env.calls[0]!.body!.inputs as Proof[]).map((proof) => proof.secret)).toEqual(
      env.request.inputProofs.map((proof) => proof.secret),
    );
    expect((env.calls[0]!.body!.inputs as Proof[])[0]!.witness).toBe(
      env.request.inputProofs[0]!.witness,
    );
    expect(JSON.stringify(env.calls[0]!.body!.outputs)).toBe(
      JSON.stringify(
        env.request.outputData.keep
          .map((output) => output.blindedMessage)
          .sort((a, b) => Amount.from(a.amount).compareTo(b.amount)),
      ),
    );
    for (const proof of proofs) {
      expect(proof.C).toBe(
        createBlindSignature(
          hashToCurve(new TextEncoder().encode(proof.secret)),
          mintKeys.privKeys[proof.amount.toString()]!,
          keys.id,
        ).C_.toHex(true),
      );
    }
  });

  it('replays legacy Wallet.receive requests with the original wire serialization', async () => {
    const env = environment();
    const wallet = new Wallet(new Mint(mintUrl, { customRequest: env.requestFn }), { unit: 'sat' });
    wallet.loadMintFromCache(
      metadata.mint.mintInfo,
      createKeyChain(mintUrl, 'sat', metadata.keysets).cache,
    );
    await wallet.receive(
      { mint: mintUrl, unit: 'sat', proofs: env.request.inputProofs },
      { keysetId: keys.id },
      { type: 'custom', data: deserializeOutputData(env.request.outputData).keep },
    );
    await env.remote.open(metadata, 'sat').receive(env.request);
    expect(env.calls[0]!.body).toEqual(env.calls[1]!.body);
  });

  it.each(['short', 'wrong-id', 'wrong-amount'])('rejects %s swap signatures', async (kind) => {
    const env = environment();
    env.behavior.swap = kind;
    await expect(env.remote.open(metadata, 'sat').receive(env.request)).rejects.toThrow();
  });

  it('restores by blinded-message identity and retains spent outputs for the coordinator', async () => {
    const env = environment();
    const session = env.remote.open(metadata, 'sat');
    const issued = await session.receive(env.request);
    env.behavior.restore = 'reverse';
    env.behavior.states = 'SPENT';
    const restored = await session.restoreOutputs(env.request.outputData);
    expect(restored).toEqual([...issued].reverse());
    expect(
      (await session.checkProofStates(restored)).every((state) => state.state === 'SPENT'),
    ).toBe(true);
  });

  it.each(['duplicate', 'mismatch', 'wrong-id'])(
    'rejects %s Restore evidence instead of treating it as absent issuance',
    async (kind) => {
      const env = environment();
      env.behavior.restore = kind;
      await expect(
        env.remote.open(metadata, 'sat').restoreOutputs(env.request.outputData),
      ).rejects.toThrow();
    },
  );

  it('distinguishes an empty Restore from a partial one', async () => {
    const env = environment();
    const session = env.remote.open(metadata, 'sat');
    env.behavior.restore = 'none';
    expect(await session.restoreOutputs(env.request.outputData)).toEqual([]);
    env.behavior.restore = 'partial';
    expect(await session.restoreOutputs(env.request.outputData)).toHaveLength(1);
  });

  it('batches proof-state requests at 100 and validates every returned identity', async () => {
    const env = environment();
    const session = env.remote.open(metadata, 'sat');
    const proofs = Array.from({ length: 205 }, (_, i) => ({
      ...env.request.inputProofs[0]!,
      secret: `input-${i}`,
    }));
    expect(await session.checkProofStates(proofs)).toHaveLength(205);
    expect(env.calls.map((call) => (call.body!.Ys as string[]).length)).toEqual([100, 100, 5]);
    env.behavior.states = 'wrong-Y';
    await expect(session.checkProofStates(proofs)).rejects.toThrow();
    env.behavior.states = 'short';
    await expect(session.checkProofStates(proofs)).rejects.toThrow();
  });
});
