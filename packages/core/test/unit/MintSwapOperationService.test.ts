import { Amount, type Proof } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import type { MintQuote } from '../../models/MintQuote.ts';
import type { MeltQuote } from '../../models/MeltQuote.ts';
import {
  MintSwapOperationService,
  type PrepareMintSwapInput,
} from '../../operations/mintSwap/MintSwapOperationService.ts';
import type { ExecutingMintOperation } from '../../operations/mint/MintOperation.ts';
import type { ExecutingMeltOperation } from '../../operations/melt/MeltOperation.ts';
import { MintScopedLock } from '../../operations/MintScopedLock.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

describe('MintSwapOperationService', () => {
  const sourceMintUrl = 'https://source.test';
  const destinationMintUrl = 'https://destination.test';
  const amount = Amount.from(100);
  const futureExpiry = Math.floor(Date.now() / 1000) + 600;
  const destinationQuote: MintQuote<'bolt11'> = {
    mintUrl: destinationMintUrl,
    method: 'bolt11',
    quoteId: 'destination-quote',
    quote: 'destination-quote',
    request: 'lnbc1destination',
    amount,
    unit: 'sat',
    expiry: futureExpiry,
    state: 'UNPAID',
    pubkey: '02destination',
    reusable: false,
    amountPaid: Amount.zero(),
    amountIssued: Amount.zero(),
    remoteUpdatedAt: 1,
    quoteData: { amount },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const sourceQuote: MeltQuote<'bolt11'> = {
    mintUrl: sourceMintUrl,
    method: 'bolt11',
    quoteId: 'source-quote',
    quote: 'source-quote',
    request: 'lnbc1destination',
    amount,
    unit: 'sat',
    fee_reserve: Amount.from(8),
    expiry: futureExpiry,
    state: 'UNPAID',
    payment_preimage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  let repositories: MemoryRepositories;
  let service: MintSwapOperationService;
  let mintService: any;
  let quoteLifecycle: any;
  let mintOperationService: any;
  let meltOperationService: any;
  let keyRingService: any;

  const input: PrepareMintSwapInput = {
    sourceMintUrl: `${sourceMintUrl}/`,
    destinationMintUrl: `${destinationMintUrl}/`,
    amount,
  };

  beforeEach(() => {
    repositories = new MemoryRepositories();
    mintService = {
      isTrustedMint: mock(async () => true),
      assertMethodUnitSupported: mock(async () => {}),
      assertNutSupported: mock(async () => {}),
      supportsNut: mock(async () => true),
    };
    quoteLifecycle = {
      createMintQuote: mock(async () => ({ ...destinationQuote })),
      createMeltQuote: mock(async () => ({ ...sourceQuote })),
      refreshMintQuote: mock(async () => ({
        ...destinationQuote,
        state: 'PAID',
        amountPaid: amount,
      })),
      refreshMeltQuote: mock(async () => ({ ...sourceQuote, state: 'PAID' })),
      getMeltQuote: mock(async () => sourceQuote),
    };

    mintOperationService = {
      prepareOwnedInTransaction: mock(async (command: any) => {
        const child = {
          id: command.operationId,
          state: 'pending',
          mintUrl: destinationMintUrl,
          method: 'bolt11',
          methodData: {},
          quoteId: destinationQuote.quoteId,
          amount,
          unit: 'sat',
          request: destinationQuote.request,
          expiry: destinationQuote.expiry,
          pubkey: destinationQuote.pubkey,
          outputData: { keep: [], send: [] },
          parentSwapOperationId: command.parentSwapOperationId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await command.repositories.mintOperationRepository.create(child);
        return child;
      }),
      authorizeOwnedExecutionInTransaction: mock(
        async (id: string, _parentId: string, scope: any) => {
          const child = await scope.mintOperationRepository.getById(id);
          const executing = { ...child, state: 'executing', updatedAt: Date.now() };
          await scope.mintOperationRepository.update(executing);
          return executing;
        },
      ),
      executeOwnedRemote: mock(async () => ({ status: 'ISSUED', proofs: [] })),
      applyOwnedExecutionInTransaction: mock(
        async (executing: ExecutingMintOperation, _parentId: string, _result: any, scope: any) => {
          const proof = {
            id: 'destination-keyset',
            amount,
            secret: 'destination-proof',
            C: 'C-destination',
            mintUrl: destinationMintUrl,
            unit: 'sat',
            state: 'ready',
            createdByOperationId: executing.id,
          };
          await scope.proofRepository.saveProofs(destinationMintUrl, [proof]);
          const finalized = { ...executing, state: 'finalized', updatedAt: Date.now() };
          await scope.mintOperationRepository.update(finalized);
          return finalized;
        },
      ),
      recoverOwnedExecuting: mock(async () => {}),
    };

    meltOperationService = {
      prepareOwnedInTransaction: mock(async (command: any) => {
        const child = {
          id: command.operationId,
          state: 'prepared',
          mintUrl: sourceMintUrl,
          method: 'bolt11',
          methodData: { invoice: destinationQuote.request },
          quoteId: sourceQuote.quoteId,
          amount,
          unit: 'sat',
          fee_reserve: Amount.from(8),
          swap_fee: Amount.zero(),
          needsSwap: false,
          inputAmount: Amount.from(110),
          inputProofSecrets: ['source-proof'],
          changeOutputData: { keep: [], send: [] },
          parentSwapOperationId: command.parentSwapOperationId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const proof = {
          id: 'source-keyset',
          amount: Amount.from(110),
          secret: 'source-proof',
          C: 'C-source',
          mintUrl: sourceMintUrl,
          unit: 'sat',
          state: 'ready',
          usedByOperationId: child.id,
        };
        await command.repositories.proofRepository.saveProofs(sourceMintUrl, [proof]);
        await command.repositories.meltOperationRepository.create(child);
        return child;
      }),
      authorizeOwnedExecutionInTransaction: mock(
        async (id: string, _parentId: string, scope: any) => {
          const child = await scope.meltOperationRepository.getById(id);
          const executing = { ...child, state: 'executing', updatedAt: Date.now() };
          await scope.meltOperationRepository.update(executing);
          return executing;
        },
      ),
      executeOwnedRemote: mock(async () => ({ status: 'PAID' })),
      applyOwnedExecutionInTransaction: mock(
        async (executing: ExecutingMeltOperation, _parentId: string, _result: any, scope: any) => {
          const finalized = {
            ...executing,
            state: 'finalized',
            changeAmount: Amount.from(4),
            effectiveFee: Amount.from(6),
            updatedAt: Date.now(),
          };
          await scope.meltOperationRepository.update(finalized);
          return finalized;
        },
      ),
      rollbackOwnedPreparedInTransaction: mock(
        async (id: string, _parentId: string, _wallet: any, scope: any) => {
          const child = await scope.meltOperationRepository.getById(id);
          const rolledBack = { ...child, state: 'rolled_back', updatedAt: Date.now() };
          await scope.meltOperationRepository.update(rolledBack);
          return rolledBack;
        },
      ),
      recoverOwnedExecuting: mock(async () => {}),
    };

    keyRingService = {
      generateMintQuoteKeyPair: mock(async () => ({
        publicKeyHex: destinationQuote.pubkey,
        secretKey: new Uint8Array(32),
        derivationIndex: 1,
        purpose: 'nut20_mint_quote',
      })),
      getMintQuoteKeyPair: mock(async () => ({
        publicKeyHex: destinationQuote.pubkey,
        secretKey: new Uint8Array(32),
        derivationIndex: 1,
        purpose: 'nut20_mint_quote',
      })),
    };

    service = new MintSwapOperationService(
      repositories,
      quoteLifecycle,
      mintOperationService,
      meltOperationService,
      mintService,
      {
        getWalletWithActiveKeysetId: mock(async () => ({
          wallet: { getFeesForProofs: (_proofs: Proof[]) => Amount.from(2) },
        })),
      } as any,
      keyRingService,
      new MintScopedLock(),
    );
  });

  it('prepares an immutable exact-receive plan without dispatching payment', async () => {
    const operation = await service.prepare(input);

    expect(operation.state).toBe('prepared');
    expect(operation.preparedPlan?.minimumSourceDebit.toString()).toBe('102');
    expect(operation.preparedPlan?.maximumSourceDebit.toString()).toBe('110');
    expect(operation.preparedPlan?.reservedSourceAmount.toString()).toBe('110');
    expect(operation.destinationNut20Key?.derivationIndex).toBe(1);
    expect(meltOperationService.executeOwnedRemote).not.toHaveBeenCalled();
    expect(await repositories.operationEventOutboxRepository.getUnpublished(10)).toHaveLength(1);
  });

  it('rejects a compatibility-only destination quote without remote accounting order', async () => {
    quoteLifecycle.createMintQuote = mock(async () => ({
      ...destinationQuote,
      remoteUpdatedAt: null,
    }));

    await expect(service.prepare(input)).rejects.toThrow('could not be prepared');

    const [failed] = await service.list({ state: 'failed' });
    expect(failed?.terminalFailure?.code).toBe('preparation_failed');
    expect(quoteLifecycle.createMeltQuote).not.toHaveBeenCalled();
  });

  it('keeps a live preparation locked against recovery sweeps', async () => {
    let releaseQuote!: () => void;
    const quoteBarrier = new Promise<void>((resolve) => {
      releaseQuote = resolve;
    });
    quoteLifecycle.createMintQuote = mock(async () => {
      await quoteBarrier;
      return { ...destinationQuote };
    });

    const preparing = service.prepare(input);
    let operation = (await service.list({ state: 'preparing' }))[0];
    while (!operation) {
      await Promise.resolve();
      operation = (await service.list({ state: 'preparing' }))[0];
    }

    expect(service.isOperationLocked(operation.id)).toBe(true);
    await expect(service.refresh(operation.id)).rejects.toThrow('already in progress');
    expect((await service.get(operation.id))?.state).toBe('preparing');

    releaseQuote();
    expect((await preparing).state).toBe('prepared');
  });

  it('commits source authorization, settles accounting, then issues exactly once', async () => {
    const prepared = await service.prepare(input);
    const funded = await service.execute(prepared.id);

    expect(funded.state).toBe('destination_funded');
    expect(funded.settlement?.finalSourceDebit.toString()).toBe('106');
    expect(funded.settlement?.totalSourceFee.toString()).toBe('6');
    const completed = await service.refresh(prepared.id);
    expect(completed.state).toBe('completed');
    expect(completed.settlement?.destinationAmountIssued?.toString()).toBe('100');
    expect(meltOperationService.executeOwnedRemote).toHaveBeenCalledTimes(1);
    expect(mintOperationService.executeOwnedRemote).toHaveBeenCalledTimes(1);
  });

  it('waits for canonical destination funding before authorizing issuance', async () => {
    const prepared = await service.prepare(input);
    await service.execute(prepared.id);
    quoteLifecycle.refreshMintQuote = mock(async () => ({ ...destinationQuote }));

    const waiting = await service.refresh(prepared.id);

    expect(waiting.state).toBe('destination_funded');
    expect(mintOperationService.authorizeOwnedExecutionInTransaction).not.toHaveBeenCalled();
    expect(mintOperationService.executeOwnedRemote).not.toHaveBeenCalled();
  });

  it('restores observed destination issuance without posting another mint request', async () => {
    const prepared = await service.prepare(input);
    await service.execute(prepared.id);
    quoteLifecycle.refreshMintQuote = mock(async () => ({
      ...destinationQuote,
      state: 'ISSUED',
      amountPaid: amount,
      amountIssued: amount,
    }));

    const recovering = await service.refresh(prepared.id);

    expect(recovering.state).toBe('issuing');
    expect(mintOperationService.recoverOwnedExecuting).toHaveBeenCalledTimes(1);
    expect(mintOperationService.executeOwnedRemote).not.toHaveBeenCalled();
  });

  it('moves to attention when destination refresh loses the remote accounting order', async () => {
    const prepared = await service.prepare(input);
    await service.execute(prepared.id);
    quoteLifecycle.refreshMintQuote = mock(async () => ({
      ...destinationQuote,
      amountPaid: amount,
      remoteUpdatedAt: null,
    }));

    const attention = await service.refresh(prepared.id);

    expect(attention.state).toBe('needs_attention');
    expect(attention.attention?.reason).toBe('canonical_observation_conflict');
    expect(mintOperationService.executeOwnedRemote).not.toHaveBeenCalled();
  });

  it('rolls back the source reservation when cancelling before dispatch', async () => {
    const prepared = await service.prepare(input);
    const cancelled = await service.cancel(prepared.id, 'changed mind');

    expect(cancelled.state).toBe('cancelled');
    expect(meltOperationService.rollbackOwnedPreparedInTransaction).toHaveBeenCalledTimes(1);
    expect(meltOperationService.executeOwnedRemote).not.toHaveBeenCalled();
  });

  it('rejects untrusted mints before creating a parent', async () => {
    mintService.isTrustedMint = mock(async (mintUrl: string) => mintUrl !== sourceMintUrl);

    await expect(service.prepare(input)).rejects.toThrow('explicitly trusted');
    expect(await service.list()).toHaveLength(0);
  });

  it('rechecks normalized trust before source dispatch', async () => {
    const prepared = await service.prepare(input);
    expect(mintService.isTrustedMint).toHaveBeenCalledWith(sourceMintUrl);
    expect(mintService.isTrustedMint).toHaveBeenCalledWith(destinationMintUrl);
    mintService.isTrustedMint = mock(async () => false);

    await expect(service.execute(prepared.id)).rejects.toThrow('explicitly trusted');
    expect((await service.get(prepared.id))?.state).toBe('failed');
    expect(
      (await repositories.meltOperationRepository.getById(prepared.sourceMeltOperationId!))?.state,
    ).toBe('rolled_back');
    expect(meltOperationService.executeOwnedRemote).not.toHaveBeenCalled();
  });

  it('fails safely before dispatch when the destination recovery key is missing', async () => {
    const prepared = await service.prepare(input);
    keyRingService.getMintQuoteKeyPair = mock(async () => null);

    await expect(service.execute(prepared.id)).rejects.toThrow('recovery key is unavailable');
    expect((await service.get(prepared.id))?.state).toBe('failed');
    expect(
      (await repositories.meltOperationRepository.getById(prepared.sourceMeltOperationId!))?.state,
    ).toBe('rolled_back');
    expect(meltOperationService.executeOwnedRemote).not.toHaveBeenCalled();
  });

  it('halts before dispatch when persisted child data no longer matches the prepared plan', async () => {
    const prepared = await service.prepare(input);
    const child = await repositories.mintOperationRepository.getById(
      prepared.destinationMintOperationId!,
    );
    await repositories.mintOperationRepository.update({
      ...child!,
      outputData: { keep: [{ tampered: true }], send: [] },
      updatedAt: Date.now(),
    } as any);

    const attention = await service.execute(prepared.id);
    expect(attention.state).toBe('needs_attention');
    expect(attention.attention?.reason).toBe('prepared_plan_mismatch');
    expect(meltOperationService.executeOwnedRemote).not.toHaveBeenCalled();
  });

  it('fails preparation when the immutable dispatch window is too short', async () => {
    await expect(
      service.prepare({ ...input, requiredDispatchWindowSeconds: 1_000 }),
    ).rejects.toBeInstanceOf(Error);

    const [failed] = await service.list({ state: 'failed' });
    expect(failed?.terminalFailure?.code).toBe('preparation_failed');
    expect(meltOperationService.executeOwnedRemote).not.toHaveBeenCalled();
  });

  it('moves to attention when the destination becomes terminal after source payment', async () => {
    const prepared = await service.prepare(input);
    const funded = await service.execute(prepared.id);
    mintOperationService.executeOwnedRemote = mock(async () => ({ status: 'ALREADY_ISSUED' }));
    mintOperationService.applyOwnedExecutionInTransaction = mock(
      async (executing: ExecutingMintOperation) => executing,
    );

    const issuing = await service.refresh(funded.id);
    expect(issuing.state).toBe('issuing');
    const destinationChild = await repositories.mintOperationRepository.getById(
      issuing.destinationMintOperationId!,
    );
    await repositories.mintOperationRepository.update({
      ...destinationChild!,
      state: 'failed',
      updatedAt: Date.now(),
    } as any);

    const attention = await service.refresh(issuing.id);
    expect(attention.state).toBe('needs_attention');
    expect(attention.attention?.reason).toBe('source_paid_destination_terminal');
  });

  it('moves to attention when the destination recovery key is missing after source payment', async () => {
    const prepared = await service.prepare(input);
    const funded = await service.execute(prepared.id);
    keyRingService.getMintQuoteKeyPair = mock(async () => null);

    const attention = await service.refresh(funded.id);

    expect(attention.state).toBe('needs_attention');
    expect(attention.attention?.reason).toBe('required_recovery_capability_missing');
    expect(mintOperationService.executeOwnedRemote).not.toHaveBeenCalled();
  });

  it('rejects cancellation after source funding', async () => {
    const prepared = await service.prepare(input);
    const funded = await service.execute(prepared.id);

    await expect(service.cancel(funded.id)).rejects.toThrow('after destination funding');
  });

  it('serializes execute against concurrent refresh and retry calls', async () => {
    const prepared = await service.prepare(input);
    let releaseRemote!: () => void;
    const remoteBarrier = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    meltOperationService.executeOwnedRemote = mock(async () => {
      await remoteBarrier;
      return { status: 'PAID' };
    });

    const executing = service.execute(prepared.id);
    while (!service.isOperationLocked(prepared.id)) await Promise.resolve();
    await expect(service.refresh(prepared.id)).rejects.toThrow('already in progress');
    await expect(service.retry(prepared.id)).rejects.toThrow('already in progress');
    releaseRemote();
    expect((await executing).state).toBe('destination_funded');
    expect(meltOperationService.executeOwnedRemote).toHaveBeenCalledTimes(1);
  });
});
