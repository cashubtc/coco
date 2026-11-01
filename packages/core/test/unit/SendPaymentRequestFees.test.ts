import { Amount } from '@cashu/cashu-ts';
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

describe('Payment Request fee planning with controlled keyset metadata', () => {
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
