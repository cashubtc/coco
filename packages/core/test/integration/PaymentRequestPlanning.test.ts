import { Amount, PaymentRequest, sumProofs } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeCoco, type Manager } from '../../Manager.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';
const oldKeysetId = testMintKeysetId('sat', { input_fee_ppk: 100 });
const activeKeysetId = testMintKeysetId('sat', { input_fee_ppk: 8000 });

// The integration mint cannot rotate to this uneconomic keyset on demand. Seed a historical
// Wallet store and exercise the public API with real services and repositories instead.
describe('Payment Request planning after keyset rotation', () => {
  let coco: Manager | undefined;

  afterEach(async () => {
    await coco?.dispose();
    coco = undefined;
  });

  async function wallet() {
    const repositories = new MemoryRepositories();
    await repositories.init();
    const now = Math.floor(Date.now() / 1000);
    await repositories.mintRepository.addNewMint({
      mintUrl,
      name: 'Rotated mint',
      trusted: true,
      mintInfo: testMintInfo,
      createdAt: now,
      updatedAt: now,
    });
    for (const [id, feePpk, active] of [
      [oldKeysetId, 100, false],
      [activeKeysetId, 8000, true],
    ] as const) {
      await repositories.keysetRepository.addKeyset({
        mintUrl,
        id,
        unit: 'sat',
        keypairs: testMintKeypairs,
        active,
        feePpk,
      });
    }
    await repositories.proofRepository.saveProofs(mintUrl, [
      {
        id: oldKeysetId,
        amount: Amount.from(8),
        C: testMintKeypairs['8'],
        secret: 'historical-proof',
        mintUrl,
        unit: 'sat',
        state: 'ready',
      },
    ]);
    const seed = crypto.getRandomValues(new Uint8Array(64));
    coco = await initializeCoco({
      repo: repositories,
      seedGetter: async () => seed,
      watchers: {
        mintOperationWatcher: { disabled: true },
        proofStateWatcher: { disabled: true },
        meltQuoteWatcher: { disabled: true },
      },
      processors: {
        mintOperationProcessor: { disabled: true },
        meltSettlementProcessor: { disabled: true },
        mintSwapOperationProcessor: { disabled: true },
      },
    });
    return { payer: coco, repositories };
  }

  it('pays directly from older proofs without planning unusable new outputs', async () => {
    const { payer, repositories } = await wallet();
    const encoded = new PaymentRequest([], 'direct', Amount.from(7), 'sat', [
      mintUrl,
    ]).toEncodedRequest();
    const prepared = await payer.paymentRequests.prepare(
      await payer.paymentRequests.parse(encoded),
      { mintUrl },
    );
    expect(prepared.request.amount).toEqual(Amount.from(7));
    expect(prepared.sendOperation.amount).toEqual(Amount.from(8));
    expect(prepared.sendOperation.fee).toEqual(Amount.zero());
    expect(prepared.sendOperation.needsSwap).toBe(false);
    expect(prepared.sendOperation.outputData).toBeUndefined();
    expect(await repositories.counterRepository.getCounter(mintUrl, activeKeysetId)).toBeNull();
    expect(await repositories.counterRepository.getCounter(mintUrl, oldKeysetId)).toBeNull();
    expect((await payer.wallet.balances.total()).spendable).toEqual(Amount.zero());

    const result = await payer.paymentRequests.execute(prepared);
    expect(result.type).toBe('inband');
    if (result.type !== 'inband') throw new Error('Expected an in-band payment');
    expect(result.token.proofs.map(({ id, secret }) => ({ id, secret }))).toEqual([
      { id: oldKeysetId, secret: 'historical-proof' },
    ]);
    expect(sumProofs(result.token.proofs).subtract(1)).toEqual(Amount.from(7));
    expect((await payer.ops.send.get(prepared.sendOperation.id))?.state).toBe('pending');
  });

  it('lets the Send API opt into direct receiver fee coverage after keyset rotation', async () => {
    const { payer, repositories } = await wallet();
    const prepared = await payer.ops.send.prepare({
      mintUrl,
      amount: 7,
      coverReceiverFees: true,
    });
    expect(prepared.amount).toEqual(Amount.from(8));
    expect(prepared.fee).toEqual(Amount.zero());
    expect(prepared.needsSwap).toBe(false);
    expect(prepared.outputData).toBeUndefined();
    expect(await repositories.counterRepository.getCounter(mintUrl, activeKeysetId)).toBeNull();
    await payer.ops.send.cancel(prepared.id);
    expect((await payer.wallet.balances.total()).spendable).toEqual(Amount.from(8));
  });

  it.each([false, true])(
    'rejects unusable swap outputs without reservations (P2PK: %s)',
    async (locked) => {
      const { payer, repositories } = await wallet();
      const encoded = new PaymentRequest(
        [],
        'swap',
        Amount.from(locked ? 7 : 8),
        'sat',
        [mintUrl],
        undefined,
        undefined,
        locked ? { kind: 'P2PK', data: testMintKeypairs['1'], tags: [] } : undefined,
      ).toEncodedRequest();
      await expect(
        payer.paymentRequests.prepare(await payer.paymentRequests.parse(encoded), { mintUrl }),
      ).rejects.toThrow('Unable to fund receiver input fees');
      expect(await payer.ops.send.listPrepared()).toHaveLength(0);
      expect((await payer.wallet.balances.total()).spendable).toEqual(Amount.from(8));
      expect(await repositories.counterRepository.getCounter(mintUrl, activeKeysetId)).toBeNull();
      expect(await repositories.counterRepository.getCounter(mintUrl, oldKeysetId)).toBeNull();
    },
  );
});
