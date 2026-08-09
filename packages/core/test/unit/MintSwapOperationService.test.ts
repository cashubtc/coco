import { Amount, type Proof } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';

import { meltQuoteFromBolt11Response } from '../../models/MeltQuote.ts';
import { mintQuoteFromBolt11Response } from '../../models/MintQuote.ts';
import type { RepositoryTransactionScope } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type {
  ExecutingMeltOperation,
  FinalizedMeltOperation,
  PreparedMeltOperation,
} from '../../operations/melt/MeltOperation.ts';
import type {
  ExecutingMintOperation,
  FinalizedMintOperation,
  PendingMintOperation,
} from '../../operations/mint/MintOperation.ts';
import { MintSwapOperationService } from '../../operations/mintSwap/MintSwapOperationService.ts';
import { makePreparingMintSwapOperation } from '../fixtures/MintSwap.ts';

describe('MintSwapOperationService', () => {
  const sourceMintUrl = 'https://source.mint.test';
  const destinationMintUrl = 'https://destination.mint.test';
  const destinationKey = `02${'11'.repeat(32)}`;
  const now = 1_800_000_000_000;
  let clock: number;
  let repositories: MemoryRepositories;
  let service: MintSwapOperationService;
  let secondService: MintSwapOperationService;
  let remoteSourceCalls: number;
  let remoteDestinationCalls: number;
  let sourceRemoteState: 'PAID' | 'PENDING' | 'UNPAID';

  beforeEach(async () => {
    repositories = new MemoryRepositories();
    await repositories.proofRepository.saveProofs(sourceMintUrl, [
      {
        mintUrl: sourceMintUrl,
        id: 'source-keyset',
        amount: Amount.from(106),
        secret: 'source-input',
        C: 'source-C',
        unit: 'sat',
        state: 'ready',
      },
    ]);
    remoteSourceCalls = 0;
    remoteDestinationCalls = 0;
    sourceRemoteState = 'PAID';
    clock = now;

    const destinationQuote = mintQuoteFromBolt11Response(destinationMintUrl, {
      quote: 'destination-quote',
      request: 'lnbc1locked',
      method: 'bolt11',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: Math.floor(now / 1_000) + 600,
      state: 'UNPAID',
      pubkey: destinationKey,
      amount_paid: Amount.zero(),
      amount_issued: Amount.zero(),
      updated_at: null,
    });
    const sourceQuote = meltQuoteFromBolt11Response(sourceMintUrl, {
      quote: 'source-quote',
      request: destinationQuote.request,
      amount: Amount.from(100),
      unit: 'sat',
      fee_reserve: Amount.from(5),
      expiry: Math.floor(now / 1_000) + 600,
      state: 'UNPAID',
      payment_preimage: null,
    });
    const quoteLifecycle = {
      createMintQuote: async () => {
        await repositories.mintQuoteRepository.upsertMintQuote(destinationQuote);
        return destinationQuote;
      },
      createMeltQuote: async () => {
        await repositories.meltQuoteRepository.upsertMeltQuote(sourceQuote);
        return sourceQuote;
      },
      getMintQuote: (...args: Parameters<typeof repositories.mintQuoteRepository.getMintQuote>) =>
        repositories.mintQuoteRepository.getMintQuote(...args),
      getMeltQuote: (...args: Parameters<typeof repositories.meltQuoteRepository.getMeltQuote>) =>
        repositories.meltQuoteRepository.getMeltQuote(...args),
    };

    const mintOperationService = {
      planOwnedPreparation: async ({ operationId, parentSwapOperationId }: any) =>
        ({
          id: operationId,
          state: 'pending',
          mintUrl: destinationMintUrl,
          method: 'bolt11',
          methodData: {},
          quoteId: destinationQuote.quoteId,
          amount: Amount.from(100),
          unit: 'sat',
          request: destinationQuote.request,
          expiry: destinationQuote.expiry,
          pubkey: destinationKey,
          outputData: {
            keep: [
              {
                blindedMessage: { amount: '100', id: 'destination-keyset', B_: 'destination-B' },
                blindingFactor: '01',
                secret: 'destination-output',
              },
            ],
            send: [],
          },
          parentSwapOperationId,
          createdAt: now,
          updatedAt: now,
        }) as PendingMintOperation,
      prepareOwnedInTransaction: async ({ preparedOperation, repositories: scope }: any) => {
        await scope.mintOperationRepository.create(preparedOperation);
        return preparedOperation;
      },
      authorizeOwnedExecutionInTransaction: async (
        id: string,
        _parentId: string,
        scope: RepositoryTransactionScope,
      ) => {
        const current = (await scope.mintOperationRepository.getById(id)) as PendingMintOperation;
        const executing = { ...current, state: 'executing' as const };
        await scope.mintOperationRepository.update(executing);
        return executing;
      },
      executeOwnedRemote: async (id: string) => {
        remoteDestinationCalls++;
        return {
          operationId: id,
          status: 'ISSUED' as const,
          proofs: [
            {
              id: 'destination-keyset',
              amount: Amount.from(100),
              secret: 'destination-output',
              C: 'destination-C',
            } as Proof,
          ],
        };
      },
      applyOwnedExecutionInTransaction: async (
        id: string,
        _parentId: string,
        _result: unknown,
        scope: RepositoryTransactionScope,
      ) => {
        const current = (await scope.mintOperationRepository.getById(id)) as ExecutingMintOperation;
        const finalized = { ...current, state: 'finalized' as const };
        await scope.mintOperationRepository.update(finalized);
        return finalized as FinalizedMintOperation;
      },
    };

    const meltOperationService = {
      planOwnedPreparation: async ({ operationId, parentSwapOperationId }: any) =>
        ({
          id: operationId,
          state: 'prepared',
          mintUrl: sourceMintUrl,
          method: 'bolt11',
          methodData: { invoice: destinationQuote.request },
          quoteId: sourceQuote.quoteId,
          amount: Amount.from(100),
          fee_reserve: Amount.from(5),
          swap_fee: Amount.zero(),
          needsSwap: false,
          inputAmount: Amount.from(106),
          inputProofSecrets: ['source-input'],
          changeOutputData: { keep: [], send: [] },
          unit: 'sat',
          parentSwapOperationId,
          createdAt: now,
          updatedAt: now,
        }) as PreparedMeltOperation,
      prepareOwnedInTransaction: async ({ preparedOperation, repositories: scope }: any) => {
        await scope.proofRepository.reserveProofs(
          sourceMintUrl,
          preparedOperation.inputProofSecrets,
          preparedOperation.id,
        );
        await scope.meltOperationRepository.create(preparedOperation);
        return preparedOperation;
      },
      rollbackOwnedPreparedInTransaction: async (
        id: string,
        _parentId: string,
        scope: RepositoryTransactionScope,
      ) => {
        const current = (await scope.meltOperationRepository.getById(id)) as PreparedMeltOperation;
        await scope.proofRepository.releaseProofs(sourceMintUrl, current.inputProofSecrets);
        const rolledBack = { ...current, state: 'rolled_back' as const };
        await scope.meltOperationRepository.update(rolledBack);
        return rolledBack;
      },
      authorizeOwnedExecutionInTransaction: async (
        id: string,
        _parentId: string,
        scope: RepositoryTransactionScope,
      ) => {
        const current = (await scope.meltOperationRepository.getById(id)) as PreparedMeltOperation;
        await scope.proofRepository.setProofState(
          sourceMintUrl,
          current.inputProofSecrets,
          'inflight',
        );
        const executing: ExecutingMeltOperation = {
          ...current,
          state: 'executing',
          parentExecutionPhase: 'melt_authorized',
        };
        await scope.meltOperationRepository.update(executing);
        return executing;
      },
      executeOwnedRemoteStep: async (id: string) => {
        remoteSourceCalls++;
        return {
          operationId: id,
          phase: 'melt' as const,
          observedAt: clock + 10,
          response: { state: sourceRemoteState, change: [], payment_preimage: 'preimage' },
        };
      },
      observeOwnedRecovery: async (id: string) => ({
        status: 'REMOTE_RESULT' as const,
        result: {
          operationId: id,
          phase: 'melt' as const,
          observedAt: clock,
          response: { state: sourceRemoteState, change: [], payment_preimage: 'preimage' },
        },
      }),
      applyOwnedRemoteStepInTransaction: async (
        id: string,
        _parentId: string,
        _result: unknown,
        scope: RepositoryTransactionScope,
      ) => {
        const current = (await scope.meltOperationRepository.getById(id)) as ExecutingMeltOperation;
        if (sourceRemoteState === 'PENDING') {
          const pending = { ...current, state: 'pending' as const };
          await scope.meltOperationRepository.update(pending);
          return pending;
        }
        if (sourceRemoteState === 'UNPAID') {
          await scope.proofRepository.setProofState(
            sourceMintUrl,
            current.inputProofSecrets,
            'ready',
          );
          await scope.proofRepository.releaseProofs(sourceMintUrl, current.inputProofSecrets);
          const failed = { ...current, state: 'failed' as const };
          await scope.meltOperationRepository.update(failed);
          return failed;
        }
        await scope.proofRepository.setProofState(
          sourceMintUrl,
          current.inputProofSecrets,
          'spent',
        );
        const finalized = {
          ...current,
          state: 'finalized',
          changeAmount: Amount.zero(),
          effectiveFee: Amount.from(6),
          finalizedData: { preimage: 'preimage' },
        } as unknown as FinalizedMeltOperation<'bolt11'>;
        await scope.meltOperationRepository.update(finalized);
        return finalized;
      },
    };

    const makeService = (workerId: string, idPrefix: string) =>
      new MintSwapOperationService(
        repositories,
        quoteLifecycle as never,
        mintOperationService as never,
        meltOperationService as never,
        {
          isTrustedMint: async () => true,
          assertMethodUnitSupported: async () => {},
          assertNutSupported: async () => {},
        } as never,
        {
          getWalletWithActiveKeysetId: async () => ({
            wallet: { getFeesForProofs: () => Amount.from(1) },
          }),
        } as never,
        {
          generateMintQuoteKeyPair: async () => ({
            publicKeyHex: destinationKey,
            secretKey: new Uint8Array(32),
            derivationIndex: 1,
            purpose: 'nut20_mint_quote',
          }),
        } as never,
        {
          debug: () => {},
          info: () => {},
          error: () => {},
          warn: (message, context) => {
            if (process.env.DEBUG_MINT_SWAP_TEST) console.warn(message, context);
          },
        },
        {
          now: () => clock,
          workerId,
          generateId: (() => {
            let id = 0;
            return () => `${idPrefix}-${++id}`;
          })(),
        },
      );
    service = makeService('worker-a', 'generated');
    secondService = makeService('worker-b', 'second');
  });

  it('prepares value-neutrally and completes source before destination issuance', async () => {
    const prepared = await service.prepare({
      sourceMintUrl,
      destinationMintUrl,
      amount: 100,
      requiredDispatchWindowSeconds: 180,
    });

    expect(prepared.state).toBe('prepared');
    expect(prepared.requiredDispatchWindowSeconds).toBe(180);
    expect(prepared.preparedPlan?.requiredDispatchWindowSeconds).toBe(180);
    expect(prepared.preparedPlan?.maximumSourceDebit.toString()).toBe('106');
    expect(remoteSourceCalls).toBe(0);
    expect(remoteDestinationCalls).toBe(0);
    expect(
      (await repositories.proofRepository.getProofBySecret(sourceMintUrl, 'source-input'))
        ?.usedByOperationId,
    ).toBe(prepared.sourceMeltOperationId);

    const completed = await service.execute(prepared.id);

    expect(completed.state).toBe('completed');
    expect(completed.settlement?.finalSourceDebit.toString()).toBe('106');
    expect(completed.settlement?.destinationAmountIssued?.toString()).toBe('100');
    expect(remoteSourceCalls).toBe(1);
    expect(remoteDestinationCalls).toBe(1);
  });

  it('cancels an undispatched plan and releases its source reservation', async () => {
    const prepared = await service.prepare({
      sourceMintUrl,
      destinationMintUrl,
      amount: 100,
    });
    const cancelled = await service.cancel(prepared.id);

    expect(cancelled.state).toBe('cancelled');
    expect(remoteSourceCalls).toBe(0);
    expect(
      (await repositories.proofRepository.getProofBySecret(sourceMintUrl, 'source-input'))
        ?.usedByOperationId,
    ).toBeUndefined();
  });

  it('fails an expired prepared plan without dispatching or retaining value', async () => {
    const prepared = await service.prepare({
      sourceMintUrl,
      destinationMintUrl,
      amount: 100,
    });
    clock += 600_000;

    const failed = await service.execute(prepared.id);

    expect(failed.state).toBe('failed');
    expect(failed.terminalFailure?.code).toBe('dispatch_window_elapsed');
    expect(remoteSourceCalls).toBe(0);
    expect(
      (await repositories.proofRepository.getProofBySecret(sourceMintUrl, 'source-input'))
        ?.usedByOperationId,
    ).toBeUndefined();
  });

  it('allows only one manager to dispatch each authorized remote effect', async () => {
    const prepared = await service.prepare({
      sourceMintUrl,
      destinationMintUrl,
      amount: 100,
    });

    const [first, second] = await Promise.all([
      service.execute(prepared.id),
      secondService.execute(prepared.id),
    ]);
    const stored = await service.get(prepared.id);

    expect([first.state, second.state]).toContain('completed');
    expect(stored?.state).toBe('completed');
    expect(remoteSourceCalls).toBe(1);
    expect(remoteDestinationCalls).toBe(1);
  });

  it('cancels inflight work only after canonical UNPAID reclamation', async () => {
    sourceRemoteState = 'PENDING';
    const prepared = await service.prepare({
      sourceMintUrl,
      destinationMintUrl,
      amount: 100,
    });
    const pending = await service.execute(prepared.id);

    expect(pending.state).toBe('source_inflight');
    expect(
      (await repositories.meltOperationRepository.getById(pending.sourceMeltOperationId!))?.state,
    ).toBe('pending');
    expect((await service.cancel(prepared.id)).state).toBe('source_inflight');

    sourceRemoteState = 'UNPAID';
    clock += 2_000;
    const cancelled = await secondService.reconcile(prepared.id);

    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.sourceReclaimedAt).toBe(clock);
    expect(
      (await repositories.proofRepository.getProofBySecret(sourceMintUrl, 'source-input'))?.state,
    ).toBe('ready');
  });

  it('records processor failure and its delayed event atomically', async () => {
    const operation = makePreparingMintSwapOperation({
      id: 'processor-failure',
      preparationLease: {
        ownerId: 'processor-worker',
        token: 'processor-lease',
        stage: 'destination_quote',
        acquiredAt: clock,
        expiresAt: clock + 30_000,
      },
      createdAt: clock,
      updatedAt: clock,
    });
    await repositories.mintSwap!.mintSwapOperationRepository.create(operation);

    expect(await service.recordProcessorFailure(operation.id, clock + 5_000)).toBe(true);

    const stored = await service.get(operation.id);
    expect(stored?.retry).toMatchObject({
      attemptCount: 1,
      lastAttemptAt: clock,
      nextAttemptAt: clock + 5_000,
      lastError: 'Mint swap reconciliation failed; retry is scheduled',
    });
    expect(
      await repositories.mintSwap!.operationEventOutboxRepository.getById(
        `${operation.id}:1:mint-swap-op:delayed`,
      ),
    ).not.toBeNull();
  });

  it('does not add processor retry bookkeeping after terminal settlement', async () => {
    const operation = makePreparingMintSwapOperation({
      id: 'processor-terminal',
      state: 'failed',
      preparationLease: undefined,
      terminalFailure: { code: 'test', reason: 'Terminal test state', at: clock },
      createdAt: clock,
      updatedAt: clock,
    });
    await repositories.mintSwap!.mintSwapOperationRepository.create(operation);

    expect(await service.recordProcessorFailure(operation.id, clock + 5_000)).toBe(false);
    expect((await service.get(operation.id))?.revision).toBe(0);
  });
});
