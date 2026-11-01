import { Amount, sumProofs, type ProofState } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { createSendEnvironment } from '../fixtures/SendEnvironment.ts';
import { testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';

async function setup(amounts: number[], feePpk = 100) {
  const env = await createSendEnvironment();
  const keysetId = testMintKeysetId('sat', { input_fee_ppk: feePpk });
  await env.repositories.keysetRepository.deleteKeyset(mintUrl, testMintKeysetId());
  await env.repositories.keysetRepository.addKeyset({
    mintUrl,
    id: keysetId,
    unit: 'sat',
    active: true,
    feePpk,
    keypairs: testMintKeypairs,
  });
  await env.repositories.proofRepository.saveProofs(
    mintUrl,
    amounts.map((amount, index) => ({
      mintUrl,
      id: keysetId,
      unit: 'sat',
      amount: Amount.from(amount),
      secret: `input-${index}`,
      C: testMintKeypairs['1'],
      state: 'ready' as const,
    })),
  );
  return { ...env, keysetId };
}

describe('Payment Request Send planning with real selection and allocation', () => {
  it('sends an existing 8-sat proof directly for a 7-sat net target without a swap fee', async () => {
    const env = await setup([8]);
    const init = await env.service.init(mintUrl, { amount: Amount.from(7), unit: 'sat' });
    const prepared = await env.service.preparePaymentRequest(init);
    expect(prepared).toMatchObject({
      amount: Amount.from(8),
      fee: Amount.zero(),
      needsSwap: false,
    });
    expect(prepared.outputData).toBeUndefined();
    const { token } = await env.service.execute(prepared);
    expect(sumProofs(token.proofs)).toEqual(Amount.from(8));
    expect(token.proofs.map((proof) => proof.secret)).toEqual(['input-0']);
    expect(await env.repositories.counterRepository.getCounter(mintUrl, env.keysetId)).toBeNull();
  });
  it.each([
    [1, 2],
    [3, 4],
    [7, 8],
    [8, 9],
    [15, 16],
    [16, 17],
  ])('covers denomination boundary net %i with gross %i at 100 ppk', async (net, gross) => {
    const env = await setup([32]);
    const init = await env.service.init(mintUrl, { amount: Amount.from(net), unit: 'sat' });
    const prepared = await env.service.preparePaymentRequest(init);
    expect(prepared.needsSwap).toBe(true);
    expect(prepared.amount).toEqual(Amount.from(gross));
    expect(prepared.fee).toEqual(Amount.from(1));
    expect(sumProofs(prepared.outputData!.send.map((output) => output.blindedMessage))).toEqual(
      Amount.from(gross),
    );
    expect(sumProofs(prepared.outputData!.keep.map((output) => output.blindedMessage))).toEqual(
      Amount.from(31 - gross),
    );
  });

  it('re-evaluates fees when the allowance adds an outgoing proof', async () => {
    const env = await setup([16], 1000);
    const init = await env.service.init(mintUrl, { amount: Amount.from(8), unit: 'sat' });
    const prepared = await env.service.preparePaymentRequest(init);
    // 9 = 8+1 needs a 2-sat fee, so the first 1-sat allowance is insufficient.
    expect(prepared.amount).toEqual(Amount.from(10));
    expect(
      prepared.outputData!.send.map((output) => output.blindedMessage.amount).toSorted(),
    ).toEqual(['2', '8']);
    expect(prepared.fee).toEqual(Amount.from(1));
  });

  it.each([
    [900, 7],
    [901, 6],
  ])('rounds aggregate mixed-keyset fees once (second rate %i)', async (secondRate, net) => {
    const env = await setup([4]);
    const otherId = testMintKeysetId('sat', { input_fee_ppk: secondRate });
    await env.repositories.keysetRepository.addKeyset({
      mintUrl,
      id: otherId,
      unit: 'sat',
      active: false,
      feePpk: secondRate,
      keypairs: testMintKeypairs,
    });
    await env.repositories.proofRepository.saveProofs(mintUrl, [
      {
        mintUrl,
        id: otherId,
        unit: 'sat',
        amount: Amount.from(4),
        secret: 'other-keyset',
        C: testMintKeypairs['1'],
        state: 'ready',
      },
    ]);
    const prepared = await env.service.preparePaymentRequest(
      await env.service.init(mintUrl, { amount: Amount.from(net), unit: 'sat' }),
    );
    expect(prepared).toMatchObject({
      amount: Amount.from(8),
      needsSwap: false,
      fee: Amount.zero(),
    });
    expect(prepared.inputProofSecrets.toSorted()).toEqual(['input-0', 'other-keyset']);
  });

  it.each([false, true])(
    'keeps zero-fee requests at face value (force swap: %s)',
    async (forceSwap) => {
      const env = await setup(forceSwap ? [8] : [4, 2, 1], 0);
      const prepared = await env.service.preparePaymentRequest(
        await env.service.init(
          mintUrl,
          { amount: Amount.from(7), unit: 'sat' },
          { method: 'default', methodData: { forceSwap } },
        ),
      );
      expect(prepared.amount).toEqual(Amount.from(7));
      expect(prepared.fee).toEqual(Amount.zero());
      expect(prepared.needsSwap).toBe(forceSwap);
    },
  );

  it.each([false, true])(
    'preserves ordinary Send face-value semantics (force swap: %s)',
    async (forceSwap) => {
      const env = await setup(forceSwap ? [16] : [4, 2, 1]);
      const prepared = await env.service.prepare(
        await env.service.init(
          mintUrl,
          { amount: Amount.from(7), unit: 'sat' },
          { method: 'default', methodData: { forceSwap } },
        ),
      );
      expect(prepared.amount).toEqual(Amount.from(7));
      expect(prepared.needsSwap).toBe(forceSwap);
      expect(prepared.fee).toEqual(Amount.from(forceSwap ? 1 : 0));
    },
  );

  it.each([7, 8])(
    'rejects incomplete funding of a locked request with %i sats without reserving or allocating',
    async (balance) => {
      const env = await setup([balance]);
      const init = await env.service.init(
        mintUrl,
        { amount: Amount.from(7), unit: 'sat' },
        {
          method: 'p2pk',
          methodData: { pubkey: testMintKeypairs['1'] },
        },
      );
      await expect(env.service.preparePaymentRequest(init)).rejects.toThrow();
      expect(await env.repositories.sendOperationRepository.getById(init.id)).toBeNull();
      expect(await env.repositories.proofRepository.getReservedProofs()).toEqual([]);
      expect(await env.repositories.counterRepository.getCounter(mintUrl, env.keysetId)).toBeNull();
      expect(env.remote.swap).not.toHaveBeenCalled();
      // A failed request still leaves the original value available to an ordinary direct Send.
      const ordinary = await env.service.prepare(
        await env.service.init(mintUrl, { amount: Amount.from(balance), unit: 'sat' }),
      );
      expect(ordinary.needsSwap).toBe(false);
    },
  );

  it('reuses the committed fee-covered P2PK plan after an ambiguous execution and keyset rotation', async () => {
    const env = await setup([16]);
    const prepared = await env.service.preparePaymentRequest(
      await env.service.init(
        mintUrl,
        { amount: Amount.from(7), unit: 'sat' },
        { method: 'p2pk', methodData: { pubkey: testMintKeypairs['1'] } },
      ),
    );
    const counter = await env.repositories.counterRepository.getCounter(mintUrl, env.keysetId);
    env.remote.swap.mockImplementationOnce(async (request) => {
      expect(request.amount).toEqual(Amount.from(8));
      expect(request.outputData).toEqual(prepared.outputData!);
      throw new Error('connection lost');
    });
    await expect(env.service.execute(prepared)).rejects.toThrow();
    expect((await env.service.getOperation(prepared.id))?.state).toBe('executing');
    await env.repositories.keysetRepository.updateKeyset({
      mintUrl,
      id: env.keysetId,
      unit: 'sat',
      active: false,
      feePpk: 100,
    });
    await env.repositories.keysetRepository.addKeyset({
      mintUrl,
      id: testMintKeysetId(),
      unit: 'sat',
      active: true,
      feePpk: 0,
      keypairs: testMintKeypairs,
    });
    env.remote.checkProofStates.mockImplementation(async (proofs) =>
      proofs.map(
        (proof) =>
          ({
            state: 'UNSPENT',
            Y: `Y-${proof.secret}`,
          }) as ProofState,
      ),
    );
    env.remote.swap.mockImplementation(async (request) => {
      expect(request.amount).toEqual(Amount.from(8));
      expect(request.outputData).toEqual(prepared.outputData!);
      const proofs = (outputs: typeof request.outputData.send) =>
        outputs.map((output) => ({
          id: output.blindedMessage.id,
          amount: Amount.from(output.blindedMessage.amount),
          secret: Buffer.from(output.secret, 'hex').toString(),
          C: testMintKeypairs['1'],
        }));
      return { keep: proofs(request.outputData.keep), send: proofs(request.outputData.send) };
    });
    await env.buildService().recoverPendingOperations();
    const recovered = await env.service.getOperation(prepared.id);
    expect(recovered?.state).toBe('pending');
    expect(recovered && 'outputData' in recovered ? recovered.outputData : undefined).toEqual(
      prepared.outputData,
    );
    expect(await env.repositories.counterRepository.getCounter(mintUrl, env.keysetId)).toEqual(
      counter,
    );
  });

  it.each([8000, 16000])(
    'rejects a keyset whose %i-ppk fees cannot leave positive spendable output value',
    async (feePpk) => {
      const env = await setup([16], feePpk);
      const init = await env.service.init(mintUrl, { amount: Amount.from(7), unit: 'sat' });
      await expect(env.service.preparePaymentRequest(init)).rejects.toThrow(
        'Unable to fund receiver input fees',
      );
      expect(await env.repositories.proofRepository.getReservedProofs()).toEqual([]);
      expect(await env.repositories.counterRepository.getCounter(mintUrl, env.keysetId)).toBeNull();
    },
  );
});
