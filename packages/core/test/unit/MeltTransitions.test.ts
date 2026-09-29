import { Amount } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { meltQuoteFromBolt11Response } from '../../models/MeltQuote.ts';
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
    change: [] = [],
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
