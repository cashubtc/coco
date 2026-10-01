import { Amount, type SerializedBlindedSignature } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import {
  meltQuoteFromBolt11Response,
  meltQuoteFromBolt12Response,
  meltQuoteFromOnchainResponse,
} from '../../models/MeltQuote.ts';
import type { ExecutingMeltOperation } from '../../operations/melt/MeltOperation.ts';
import { prepareMint } from '../../operations/mint/MintTransitions.ts';
import {
  applyMeltPaidResult,
  applyMeltPending,
  applyMeltSwapResult,
  beginMeltExecution,
  cancelPreparedMelt,
  deferMeltRecovery,
  prepareMelt,
  releaseMeltAfterNonPayment,
} from '../../operations/melt/MeltTransitions.ts';
import type { PrepareMeltInput } from '../../operations/melt/MeltTransitionTypes.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { deserializeOutputData } from '../../utils.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import { mintQuoteFromBolt11Fixture } from '../normalizedMintQuoteFixtures.ts';
import { overrideTransactions } from '../overrideTransactions.ts';

const mintUrl = 'https://mint.test';
const keysetId = testMintKeysetId();

describe.each(['memory', 'sqlite'] as const)('Melt transitions (%s)', (adapter) => {
  let repositories: Repositories;
  let database: Database | undefined;
  let runner: RepositoryCoreTransactionRunner;

  beforeEach(async () => {
    if (adapter === 'sqlite') {
      database = new Database(':memory:');
      repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    } else {
      repositories = new MemoryRepositories();
    }
    await repositories.init();
    await repositories.mintRepository.addNewMint({
      mintUrl,
      name: 'Test',
      trusted: true,
      mintInfo: {
        ...testMintInfo,
        nuts: {
          ...testMintInfo.nuts,
          '4': {
            disabled: false,
            methods: [
              {
                method: 'bolt11',
                method_name: 'bolt11',
                unit: 'sat',
                min_amount: 1,
                max_amount: 1000,
              },
              {
                method: 'bolt12',
                method_name: 'bolt12',
                unit: 'sat',
                min_amount: 1,
                max_amount: 1000,
              },
              {
                method: 'onchain',
                method_name: 'onchain',
                unit: 'sat',
                min_amount: 1,
                max_amount: 1000,
              },
            ],
          },
          '5': {
            disabled: false,
            methods: [
              {
                method: 'bolt11',
                method_name: 'bolt11',
                unit: 'sat',
                min_amount: 1,
                max_amount: 1000,
              },
              {
                method: 'bolt12',
                method_name: 'bolt12',
                unit: 'sat',
                min_amount: 1,
                max_amount: 1000,
              },
              {
                method: 'onchain',
                method_name: 'onchain',
                unit: 'sat',
                min_amount: 1,
                max_amount: 1000,
              },
            ],
          },
        },
      },
      createdAt: 1,
      updatedAt: 1,
    });
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: keysetId,
      unit: 'sat',
      keypairs: testMintKeypairs,
      active: true,
      feePpk: 0,
    });
    await saveQuote('UNPAID', 1_000);
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Fixture(mintUrl, {
        quote: 'mint-quote',
        request: 'lnbc1mint',
        amount: Amount.from(4),
        unit: 'sat',
        state: 'PAID',
        expiry: 100,
      }),
    );
    runner = new RepositoryCoreTransactionRunner(repositories);
  });

  afterEach(() => database?.close());

  function input(operationId = 'melt-1'): PrepareMeltInput {
    return {
      operationId,
      mintUrl,
      method: 'bolt11',
      methodData: { invoice: 'lnbc1test' },
      quoteId: 'quote-1',
      unit: 'sat',
      activeKeys: { id: keysetId, unit: 'sat', keys: testMintKeypairs },
      seed: new Uint8Array(32).fill(1),
      now: 1_000,
    };
  }

  async function saveQuote(
    state: 'UNPAID' | 'PENDING' | 'PAID',
    observedAt: number,
    change: SerializedBlindedSignature[] = [],
  ) {
    await repositories.meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromBolt11Response(
        mintUrl,
        {
          quote: 'quote-1',
          request: 'lnbc1test',
          amount: Amount.from(8),
          unit: 'sat',
          fee_reserve: Amount.from(2),
          expiry: 100,
          state,
          payment_preimage: state === 'PAID' ? 'preimage' : null,
          change,
        },
        { now: observedAt },
      ),
    );
  }

  async function saveReadyProof(amount: number, secret = `input-${amount}`) {
    await repositories.proofRepository.saveProofs(mintUrl, [
      {
        id: keysetId,
        amount: Amount.from(amount),
        secret,
        C: testMintKeypairs['1'],
        mintUrl,
        unit: 'sat',
        state: 'ready',
      },
    ]);
  }

  function swapProofs(operation: ExecutingMeltOperation) {
    const data = deserializeOutputData(operation.swapOutputData!);
    const make = (output: (typeof data.keep)[number]) => ({
      id: output.blindedMessage.id,
      amount: Amount.from(output.blindedMessage.amount),
      secret: new TextDecoder().decode(output.secret),
      C: testMintKeypairs['1'],
    });
    return { keep: data.keep.map(make), send: data.send.map(make) };
  }

  it('prepares, authorizes, records pending, and finalizes a direct Melt atomically', async () => {
    await saveReadyProof(10);
    const prepared = await runner.run((tx) => tx.perform(prepareMelt, input()));
    expect(prepared.operation.needsSwap).toBe(false);
    expect(prepared.operation.updatedAt).toBe(1_000);
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'input-10'))?.usedByOperationId,
    ).toBe('melt-1');

    const authorization = await runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: 'melt-1', now: 2_000 }),
    );
    expect(authorization.operation.state).toBe('executing');
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, 'input-10'))?.state).toBe(
      'inflight',
    );

    await saveQuote('PENDING', 3_000);
    const pending = await runner.run((tx) =>
      tx.perform(applyMeltPending, {
        operation: authorization.operation as ExecutingMeltOperation,
        now: 3_000,
      }),
    );
    expect(pending.operation.state).toBe('pending');

    await saveQuote('PAID', 4_000);
    const finalized = await runner.run((tx) =>
      tx.perform(applyMeltPaidResult, {
        operation: pending.operation as any,
        changeProofs: [],
        finalizedData: { preimage: 'preimage' },
        now: 4_000,
      }),
    );
    expect(finalized.operation.state).toBe('finalized');
    expect(finalized.operation.effectiveFee?.equals(Amount.from(2))).toBe(true);
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, 'input-10'))?.state).toBe(
      'spent',
    );
  });

  it.each([
    [10, false],
    [11, true],
    [12, true],
  ] as const)(
    'uses the 110 percent pre-swap boundary for selected input %i',
    async (selectedAmount, needsSwap) => {
      await saveReadyProof(selectedAmount);

      const prepared = await runner.run((tx) => tx.perform(prepareMelt, input()));

      expect(prepared.operation.needsSwap).toBe(needsSwap);
    },
  );

  it('rejects a quote unit mismatch before reserving proofs', async () => {
    await repositories.meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromBolt11Response(mintUrl, {
        quote: 'quote-usd',
        request: 'lnbc1usd',
        amount: Amount.from(8),
        unit: 'usd',
        fee_reserve: Amount.from(2),
        expiry: 100,
        state: 'UNPAID',
        payment_preimage: null,
        change: [],
      }),
    );
    await saveReadyProof(10, 'unit-mismatch-input');

    await expect(
      runner.run((tx) =>
        tx.perform(prepareMelt, {
          ...input('unit-mismatch'),
          methodData: { invoice: 'lnbc1usd' },
          quoteId: 'quote-usd',
        }),
      ),
    ).rejects.toThrow('Unit mismatch: expected sat, received usd');

    expect(await repositories.meltOperationRepository.getById('unit-mismatch')).toBeNull();
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'unit-mismatch-input'))
        ?.usedByOperationId,
    ).toBeUndefined();
  });

  it('rejects an expired quote before reserving proofs', async () => {
    await repositories.meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromBolt11Response(mintUrl, {
        quote: 'quote-expired',
        request: 'lnbc1expired',
        amount: Amount.from(8),
        unit: 'sat',
        fee_reserve: Amount.from(2),
        expiry: 1,
        state: 'UNPAID',
        payment_preimage: null,
        change: [],
      }),
    );
    await saveReadyProof(10, 'expired-input');

    await expect(
      runner.run((tx) =>
        tx.perform(prepareMelt, {
          ...input('expired'),
          methodData: { invoice: 'lnbc1expired' },
          quoteId: 'quote-expired',
        }),
      ),
    ).rejects.toThrow('Cannot prepare expired melt quote');

    expect(await repositories.meltOperationRepository.getById('expired')).toBeNull();
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'expired-input'))
        ?.usedByOperationId,
    ).toBeUndefined();
  });

  it('does not reserve inputs that cannot cover the quote and fee reserve', async () => {
    await saveReadyProof(9, 'insufficient-input');

    await expect(
      runner.run((tx) => tx.perform(prepareMelt, input('insufficient'))),
    ).rejects.toThrow('Not enough proofs to send');

    expect(await repositories.meltOperationRepository.getById('insufficient')).toBeNull();
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'insufficient-input'))
        ?.usedByOperationId,
    ).toBeUndefined();
  });

  it('rejects paid settlement when the canonical quote still omits change', async () => {
    await saveReadyProof(10);
    await runner.run((tx) => tx.perform(prepareMelt, input()));
    const authorization = await runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: 'melt-1', now: 2_000 }),
    );
    await repositories.meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromBolt11Response(
        mintUrl,
        {
          quote: 'quote-1',
          request: 'lnbc1test',
          amount: Amount.from(8),
          unit: 'sat',
          fee_reserve: Amount.from(2),
          expiry: 100,
          state: 'PAID',
          payment_preimage: 'preimage',
        },
        { now: 3_000 },
      ),
    );

    await expect(
      runner.run((tx) =>
        tx.perform(applyMeltPaidResult, {
          operation: authorization.operation as ExecutingMeltOperation,
          changeProofs: [],
          finalizedData: { preimage: 'preimage' },
          now: 3_000,
        }),
      ),
    ).rejects.toThrow('canonical settlement change is incomplete');

    expect((await repositories.meltOperationRepository.getById('melt-1'))?.state).toBe('executing');
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, 'input-10'))?.state).toBe(
      'inflight',
    );
  });

  it('saves canonical change and finalizes the input spend in one transition', async () => {
    await saveReadyProof(10);
    const prepared = await runner.run((tx) => tx.perform(prepareMelt, input('melt-change')));
    const authorization = await runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: 'melt-change', now: 2_000 }),
    );
    const output = deserializeOutputData(prepared.operation.changeOutputData).keep[0]!;
    const secret = new TextDecoder().decode(output.secret);
    await saveQuote('PAID', 3_000, [
      {
        id: output.blindedMessage.id,
        amount: Amount.from(1),
        C_: testMintKeypairs['1'],
      },
    ]);

    const finalized = await runner.run((tx) =>
      tx.perform(applyMeltPaidResult, {
        operation: authorization.operation as ExecutingMeltOperation,
        changeProofs: [
          {
            id: output.blindedMessage.id,
            amount: Amount.from(1),
            secret,
            C: testMintKeypairs['1'],
          },
        ],
        finalizedData: { preimage: 'preimage' },
        now: 3_000,
      }),
    );

    expect(finalized.operation.changeAmount?.equals(Amount.from(1))).toBe(true);
    expect(finalized.operation.effectiveFee?.equals(Amount.from(1))).toBe(true);
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, secret))?.state).toBe(
      'ready',
    );
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, 'input-10'))?.state).toBe(
      'spent',
    );
  });

  it('prepares and finalizes BOLT12 settlement with its canonical offer and preimage', async () => {
    await repositories.meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromBolt12Response(mintUrl, {
        quote: 'quote-bolt12',
        request: 'lno1offer',
        amount: Amount.from(8),
        unit: 'sat',
        fee_reserve: Amount.from(2),
        expiry: 100,
        state: 'UNPAID',
        payment_preimage: null,
        change: [],
      }),
    );
    await saveReadyProof(10, 'bolt12-input');
    const prepared = await runner.run((tx) =>
      tx.perform(prepareMelt, {
        ...input('melt-bolt12'),
        method: 'bolt12',
        methodData: { offer: 'lno1offer' },
        quoteId: 'quote-bolt12',
      }),
    );
    const authorized = await runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: prepared.operation.id, now: 2_000 }),
    );
    await repositories.meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromBolt12Response(mintUrl, {
        quote: 'quote-bolt12',
        request: 'lno1offer',
        amount: Amount.from(8),
        unit: 'sat',
        fee_reserve: Amount.from(2),
        expiry: 100,
        state: 'PAID',
        payment_preimage: 'bolt12-preimage',
        change: [],
      }),
    );

    const finalized = await runner.run((tx) =>
      tx.perform(applyMeltPaidResult, {
        operation: authorized.operation as ExecutingMeltOperation,
        changeProofs: [],
        finalizedData: { preimage: 'bolt12-preimage' },
        now: 3_000,
      }),
    );

    expect(finalized.operation.state).toBe('finalized');
    expect(finalized.operation.finalizedData).toEqual({ preimage: 'bolt12-preimage' });
  });

  it('uses the selected on-chain fee reserve and validates its settlement outpoint', async () => {
    const feeOptions = [
      { fee_index: 1, fee_reserve: Amount.from(1), estimated_blocks: 12 },
      { fee_index: 7, fee_reserve: Amount.from(2), estimated_blocks: 3 },
    ];
    await repositories.meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromOnchainResponse(mintUrl, {
        quote: 'quote-onchain',
        request: 'bc1ptest',
        amount: Amount.from(8),
        unit: 'sat',
        fee_options: feeOptions,
        selected_fee_index: null,
        expiry: 100,
        state: 'UNPAID',
        outpoint: null,
        change: [],
      }),
    );
    await saveReadyProof(10, 'onchain-input');
    const prepared = await runner.run((tx) =>
      tx.perform(prepareMelt, {
        ...input('melt-onchain'),
        method: 'onchain',
        methodData: { address: 'bc1ptest', amountSats: Amount.from(8), feeIndex: 7 },
        quoteId: 'quote-onchain',
      }),
    );
    expect(prepared.operation.fee_reserve.equals(Amount.from(2))).toBe(true);
    const authorized = await runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: prepared.operation.id, now: 2_000 }),
    );
    await repositories.meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromOnchainResponse(mintUrl, {
        quote: 'quote-onchain',
        request: 'bc1ptest',
        amount: Amount.from(8),
        unit: 'sat',
        fee_options: feeOptions,
        selected_fee_index: 7,
        expiry: 100,
        state: 'PAID',
        outpoint: 'txid:7',
        change: [],
      }),
    );

    const finalized = await runner.run((tx) =>
      tx.perform(applyMeltPaidResult, {
        operation: authorized.operation as ExecutingMeltOperation,
        changeProofs: [],
        finalizedData: { outpoint: 'txid:7' },
        now: 3_000,
      }),
    );

    expect(finalized.operation.state).toBe('finalized');
    expect(finalized.operation.finalizedData).toEqual({ outpoint: 'txid:7' });
  });

  it('rejects missing or unavailable on-chain fee indexes before reserving proofs', async () => {
    for (const feeIndex of [undefined, 99] as const) {
      await repositories.meltQuoteRepository.upsertMeltQuote(
        meltQuoteFromOnchainResponse(mintUrl, {
          quote: 'quote-onchain-invalid-fee',
          request: 'bc1ptest',
          amount: Amount.from(8),
          unit: 'sat',
          fee_options: [
            { fee_index: 1, fee_reserve: Amount.from(1), estimated_blocks: 12 },
            { fee_index: 7, fee_reserve: Amount.from(2), estimated_blocks: 3 },
          ],
          selected_fee_index: null,
          expiry: 100,
          state: 'UNPAID',
          outpoint: null,
          change: [],
        }),
      );
      await saveReadyProof(10, `onchain-invalid-fee-${String(feeIndex)}`);

      await expect(
        runner.run((tx) =>
          tx.perform(prepareMelt, {
            ...input(`melt-onchain-invalid-fee-${String(feeIndex)}`),
            method: 'onchain',
            methodData: {
              address: 'bc1ptest',
              amountSats: Amount.from(8),
              ...(feeIndex === undefined ? {} : { feeIndex }),
            },
            quoteId: 'quote-onchain-invalid-fee',
          }),
        ),
      ).rejects.toThrow(
        feeIndex === undefined ? 'requires an explicit feeIndex' : 'does not include',
      );

      expect(
        await repositories.meltOperationRepository.getById(
          `melt-onchain-invalid-fee-${String(feeIndex)}`,
        ),
      ).toBeNull();
    }
  });

  it('commits the pre-swap checkpoint before restoring send proofs and clearing ownership', async () => {
    await saveReadyProof(16);
    const prepared = await runner.run((tx) => tx.perform(prepareMelt, input()));
    expect(prepared.operation.needsSwap).toBe(true);
    const authorization = await runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: 'melt-1', now: 2_000 }),
    );
    const executing = authorization.operation as ExecutingMeltOperation;
    const candidates = swapProofs(executing);
    const applied = await runner.run((tx) =>
      tx.perform(applyMeltSwapResult, {
        operation: executing,
        keepProofs: candidates.keep,
        sendProofs: candidates.send,
        now: 3_000,
      }),
    );
    expect(applied.operation.state).toBe('executing');
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, 'input-16'))?.state).toBe(
      'spent',
    );
    expect(applied.sendProofs.every((proof) => proof.state === 'inflight')).toBe(true);

    const replayed = await runner.run((tx) =>
      tx.perform(applyMeltSwapResult, {
        operation: executing,
        keepProofs: candidates.keep,
        sendProofs: candidates.send,
        now: 3_500,
      }),
    );
    expect(replayed.changed).toBe(false);
    expect(replayed.sendProofs).toHaveLength(applied.sendProofs.length);

    await saveQuote('UNPAID', 4_000);
    const released = await runner.run((tx) =>
      tx.perform(releaseMeltAfterNonPayment, {
        operationId: 'melt-1',
        evidence: {
          kind: 'quote-observation-unpaid',
          mintUrl,
          method: 'bolt11',
          quoteId: 'quote-1',
          observedAt: 4_000,
        },
        reason: 'not paid',
        now: 4_000,
      }),
    );
    expect(released.operation.state).toBe('rolled_back');
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, 'input-16'))?.state).toBe(
      'spent',
    );
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'input-16'))?.usedByOperationId,
    ).toBeUndefined();
    for (const proof of applied.sendProofs) {
      const stored = await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret);
      expect(stored?.state).toBe('ready');
      expect(stored?.usedByOperationId).toBeUndefined();
    }
  });

  it('includes the future Melt input fee in pre-swap send outputs', async () => {
    await repositories.keysetRepository.updateKeyset({
      mintUrl,
      id: keysetId,
      unit: 'sat',
      active: true,
      feePpk: 100,
    });
    await saveReadyProof(16);

    const prepared = await runner.run((tx) => tx.perform(prepareMelt, input()));
    const outputs = deserializeOutputData(prepared.operation.swapOutputData!);
    const keepAmount = Amount.sum(outputs.keep.map((output) => output.blindedMessage.amount));
    const sendAmount = Amount.sum(outputs.send.map((output) => output.blindedMessage.amount));

    expect(prepared.operation.swap_fee.equals(Amount.from(1))).toBe(true);
    expect(sendAmount.equals(Amount.from(11))).toBe(true);
    expect(keepAmount.equals(Amount.from(4))).toBe(true);
    expect(
      sendAmount.add(keepAmount).add(prepared.operation.swap_fee).equals(Amount.from(16)),
    ).toBe(true);
  });

  it('persists a pre-swap result after its source inputs were observed spent', async () => {
    await saveReadyProof(16);
    const prepared = await runner.run((tx) => tx.perform(prepareMelt, input()));
    const authorization = await runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: 'melt-1', now: 2_000 }),
    );
    const executing = authorization.operation as ExecutingMeltOperation;
    const candidates = swapProofs(executing);

    await repositories.proofRepository.setProofState(mintUrl, ['input-16'], 'spent');
    const applied = await runner.run((tx) =>
      tx.perform(applyMeltSwapResult, {
        operation: executing,
        keepProofs: candidates.keep,
        sendProofs: candidates.send,
        now: 3_000,
      }),
    );

    expect(applied.changed).toBe(true);
    expect(applied.sendProofs.every((proof) => proof.state === 'inflight')).toBe(true);
    for (const proof of [...candidates.keep, ...candidates.send]) {
      expect(
        await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret),
      ).not.toBeNull();
    }
  });

  it('finalizes a paid pre-swap Melt when its inputs are partially observed spent', async () => {
    await saveReadyProof(16);
    await runner.run((tx) => tx.perform(prepareMelt, input()));
    const authorization = await runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: 'melt-1', now: 2_000 }),
    );
    const executing = authorization.operation as ExecutingMeltOperation;
    const candidates = swapProofs(executing);
    const applied = await runner.run((tx) =>
      tx.perform(applyMeltSwapResult, {
        operation: executing,
        keepProofs: candidates.keep,
        sendProofs: candidates.send,
        now: 3_000,
      }),
    );
    expect(applied.sendProofs.length).toBeGreaterThan(1);
    const alreadySpent = applied.sendProofs[0]!;
    await repositories.proofRepository.setProofState(mintUrl, [alreadySpent.secret], 'spent');
    await saveQuote('PAID', 4_000);

    const finalized = await runner.run((tx) =>
      tx.perform(applyMeltPaidResult, {
        operation: applied.operation,
        changeProofs: [],
        finalizedData: { preimage: 'preimage' },
        now: 4_000,
      }),
    );

    expect(finalized.operation.state).toBe('finalized');
    expect(finalized.spentInputSecrets).not.toContain(alreadySpent.secret);
    for (const proof of applied.sendProofs) {
      expect(
        (await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
      ).toBe('spent');
    }
  });

  it('rolls reservation, counters, and operation back when preparation persistence fails', async () => {
    await saveReadyProof(10);
    await expect(
      repositories.withTransaction(async (scope) => {
        const scopedRunner = new RepositoryCoreTransactionRunner(
          overrideTransactions(repositories, (work) => work(scope)),
        );
        await scopedRunner.run((tx) => tx.perform(prepareMelt, input()));
        throw new Error('parent failed');
      }),
    ).rejects.toThrow('parent failed');
    expect(await repositories.meltOperationRepository.getById('melt-1')).toBeNull();
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'input-10'))?.usedByOperationId,
    ).toBeUndefined();
  });

  it('composes Melt and Mint preparation and rolls the whole parent transaction back', async () => {
    await saveReadyProof(10);
    await expect(
      runner.run(async (tx) => {
        await tx.perform(prepareMelt, input('melt-child'));
        await tx.perform(prepareMint, {
          operationId: 'mint-child',
          mintUrl,
          method: 'bolt11',
          quoteId: 'mint-quote',
          amount: Amount.from(4),
          unit: 'sat',
          activeKeys: { id: keysetId, unit: 'sat', keys: testMintKeypairs },
          seed: new Uint8Array(32).fill(2),
          now: 1_000,
        });
        throw new Error('parent composition failed');
      }),
    ).rejects.toThrow('parent composition failed');

    expect(await repositories.meltOperationRepository.getById('melt-child')).toBeNull();
    expect(await repositories.mintOperationRepository.getById('mint-child')).toBeNull();
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'input-10'))?.usedByOperationId,
    ).toBeUndefined();
  });

  it('reuses the exact prepared child without allocating twice and rejects changed intent', async () => {
    await saveReadyProof(10);
    const first = await runner.run((tx) => tx.perform(prepareMelt, input('child')));
    const repeated = await runner.run((tx) =>
      tx.perform(prepareMelt, { ...input('child'), now: 2_000 }),
    );
    expect(repeated.changed).toBe(false);
    expect(repeated.operation.changeOutputData).toEqual(first.operation.changeOutputData);
    const counter = await repositories.counterRepository.getCounter(mintUrl, keysetId);
    expect(counter?.counter).toBe(1);
    await expect(
      runner.run((tx) =>
        tx.perform(prepareMelt, {
          ...input('child'),
          methodData: { invoice: 'different' },
        }),
      ),
    ).rejects.toThrow('request does not match');
  });

  it('allows only one prepared operation to own a canonical quote', async () => {
    await saveReadyProof(10);
    const results = await Promise.allSettled([
      runner.run((tx) => tx.perform(prepareMelt, input('winner-a'))),
      runner.run((tx) => tx.perform(prepareMelt, input('winner-b'))),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stored = [
      await repositories.meltOperationRepository.getById('winner-a'),
      await repositories.meltOperationRepository.getById('winner-b'),
    ].filter(Boolean);
    expect(stored).toHaveLength(1);
  });

  it('rolls back a rejected paid settlement and retains pending ownership', async () => {
    await saveReadyProof(10);
    const prepared = await runner.run((tx) => tx.perform(prepareMelt, input('settlement')));
    const authorization = await runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: 'settlement', now: 2_000 }),
    );
    await saveQuote('PENDING', 3_000);
    const pending = await runner.run((tx) =>
      tx.perform(applyMeltPending, {
        operation: authorization.operation as ExecutingMeltOperation,
        now: 3_000,
      }),
    );
    await saveQuote('PAID', 4_000);
    await expect(
      runner.run((tx) =>
        tx.perform(applyMeltPaidResult, {
          operation: pending.operation as any,
          changeProofs: [
            { id: keysetId, amount: Amount.from(1), secret: 'wrong', C: testMintKeypairs['1'] },
          ],
          finalizedData: { preimage: 'preimage' },
          now: 4_000,
        }),
      ),
    ).rejects.toThrow('canonical settlement');
    expect((await repositories.meltOperationRepository.getById('settlement'))?.state).toBe(
      'pending',
    );
    const retained = await repositories.proofRepository.getProofBySecret(
      mintUrl,
      prepared.operation.inputProofSecrets[0]!,
    );
    expect(retained?.state).toBe('inflight');
    expect(retained?.usedByOperationId).toBe('settlement');
  });

  it('cancels prepared operations but retains ambiguous executing resources', async () => {
    await saveReadyProof(10);
    await runner.run((tx) => tx.perform(prepareMelt, input('cancel')));
    const cancelled = await runner.run((tx) =>
      tx.perform(cancelPreparedMelt, { operationId: 'cancel', reason: 'user', now: 2_000 }),
    );
    expect(cancelled.operation.state).toBe('rolled_back');
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'input-10'))?.usedByOperationId,
    ).toBeUndefined();

    await repositories.meltOperationRepository.delete('cancel');
    await repositories.proofRepository.deleteProofs(mintUrl, ['input-10']);
    await saveReadyProof(10, 'ambiguous');
    await runner.run((tx) => tx.perform(prepareMelt, input('ambiguous')));
    await runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: 'ambiguous', now: 3_000 }),
    );
    await runner.run((tx) =>
      tx.perform(deferMeltRecovery, {
        operationId: 'ambiguous',
        error: 'timeout',
        now: 4_000,
      }),
    );
    expect((await repositories.meltOperationRepository.getById('ambiguous'))?.state).toBe(
      'executing',
    );
    const proof = await repositories.proofRepository.getProofBySecret(mintUrl, 'ambiguous');
    expect(proof?.state).toBe('inflight');
    expect(proof?.usedByOperationId).toBe('ambiguous');
  });
});
