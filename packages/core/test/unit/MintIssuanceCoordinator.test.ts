import { Amount, OutputData, type Proof } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { MintHandlerProvider } from '../../infra/handlers/mint/MintHandlerProvider.ts';
import { MintOperationError } from '../../models/Error.ts';
import { MintIssuanceRetryError } from '../../models/MintIssuanceRetryError.ts';
import { mintQuoteFromBolt11Response } from '../../models/MintQuote.ts';
import { MintScopedLock } from '../../operations/MintScopedLock.ts';
import { MintIssuanceCoordinator } from '../../operations/mint/MintIssuanceCoordinator.ts';
import type { MintIssuanceAttempt } from '../../operations/mint/MintIssuanceAttempt.ts';
import type {
  ExecutingMintOperationRecord,
  PendingMintOperationRecord,
} from '../../operations/mint/MintOperation.ts';
import { MintOperationService } from '../../operations/mint/MintOperationService.ts';
import type { MintMethodHandler } from '../../operations/mint/MintMethodHandler.ts';
import { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import { MemoryMintIssuanceAttemptRepository } from '../../repositories/memory/MemoryMintIssuanceAttemptRepository.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import type { CoreProof } from '../../types.ts';
import { serializeOutputData } from '../../utils.ts';

describe('MintOperationService durable single BOLT11 issuance', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-1';
  const operationId = 'operation-1';
  const keysetId = 'keyset-1';
  const outputSecret = 'output-secret';

  let repositories: MemoryRepositories;
  let eventBus: EventBus<CoreEvents>;
  let mintService: MintService;
  let walletService: WalletService;
  let proofService: ProofService;
  let mintAdapter: MintAdapter;
  let walletMint: Mock<any>;
  let coordinator: MintIssuanceCoordinator;
  let service: MintOperationService;

  const outputData = serializeOutputData({
    keep: [
      new OutputData(
        { amount: Amount.from(10), id: keysetId, B_: 'B_output-secret' },
        1n,
        new TextEncoder().encode(outputSecret),
      ),
    ],
    send: [],
  });

  const proof: Proof = {
    id: keysetId,
    amount: Amount.from(10),
    secret: outputSecret,
    C: 'C_output-secret',
  };

  const pendingOperation = (): PendingMintOperationRecord<'bolt11'> => ({
    id: operationId,
    state: 'pending',
    mintUrl,
    method: 'bolt11',
    methodData: {},
    amount: Amount.from(10),
    unit: 'sat',
    quoteId,
    request: 'lnbc1test',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    outputData: serializeOutputData({ keep: [], send: [] }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  function createService(): MintOperationService {
    const handler = {
      checkPending: mock(async () => ({
        observedRemoteState: 'PAID' as const,
        observedRemoteStateAt: Date.now(),
        category: 'ready' as const,
      })),
    } as unknown as MintMethodHandler<'bolt11'>;
    const handlerProvider = {
      get: mock(() => handler),
    } as unknown as MintHandlerProvider;
    const quoteLifecycle = new QuoteLifecycle({
      mintHandlerProvider: handlerProvider,
      meltHandlerProvider: {} as any,
      mintQuoteRepository: repositories.mintQuoteRepository,
      meltQuoteRepository: repositories.meltQuoteRepository,
      proofRepository: repositories.proofRepository,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
    });
    const mintScopedLock = new MintScopedLock();
    coordinator = new MintIssuanceCoordinator({
      repositories,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
      mintScopedLock,
    });

    return new MintOperationService(
      handlerProvider,
      repositories.mintOperationRepository,
      quoteLifecycle,
      repositories.proofRepository,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
      undefined,
      mintScopedLock,
      coordinator,
    );
  }

  async function seedLegacyBolt12Attempt(
    legacyOperationId: string,
    state: 'prepared' | 'recovering',
  ): Promise<{ operation: ExecutingMintOperationRecord<'bolt12'>; attempt: MintIssuanceAttempt }> {
    const legacyAttemptId = `legacy-mint-operation:${legacyOperationId}`;
    const operation: ExecutingMintOperationRecord<'bolt12'> = {
      ...pendingOperation(),
      id: legacyOperationId,
      method: 'bolt12',
      state: 'executing',
      quoteId: `quote-${legacyOperationId}`,
      request: 'bolt12-request',
      pubkey: 'quote-pubkey',
      outputData,
      attemptId: legacyAttemptId,
    };
    const now = Date.now();
    const attempt: MintIssuanceAttempt = {
      id: legacyAttemptId,
      mintUrl,
      method: 'bolt12',
      unit: 'sat',
      keysetId,
      state,
      memberOperationIds: [legacyOperationId],
      quoteIds: [operation.quoteId],
      quoteAmounts: [Amount.from(10)],
      signingRequirements: [null],
      outputData,
      request: { kind: 'single', quoteId: operation.quoteId },
      createdAt: now,
      updatedAt: now,
      ...(state === 'recovering' ? { submittedAt: now, recoveryStartedAt: now } : {}),
    };
    await repositories.mintOperationRepository.create(operation);
    await repositories.mintIssuanceAttemptRepository.create(attempt);
    return { operation, attempt };
  }

  beforeEach(async () => {
    repositories = new MemoryRepositories();
    eventBus = new EventBus<CoreEvents>();
    walletMint = mock(async () => [proof]);
    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({
        wallet: { mintProofsBolt11: walletMint },
        keysetId,
        keys: { id: keysetId, unit: 'sat', keys: {} },
      })),
    } as unknown as WalletService;
    mintService = {
      isTrustedMint: mock(async () => true),
      assertMethodUnitSupported: mock(async () => {}),
    } as unknown as MintService;
    proofService = {
      createMintOutputsAtCounter: mock(async (_mintUrl, _intent, counterStart) => ({
        keysetId,
        outputData,
        counterStart,
        counterEnd: counterStart + 1,
      })),
      recoverProofsFromOutputData: mock(async () => []),
    } as unknown as ProofService;
    mintAdapter = {
      checkMintQuote: mock(async () => ({
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID' as const,
      })),
    } as unknown as MintAdapter;

    await repositories.mintRepository.addNewMint({
      mintUrl,
      trusted: true,
      updatedAt: Date.now(),
    } as any);
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      }),
    );
    await repositories.mintOperationRepository.create(pendingOperation());
    service = createService();
  });

  it('finalizes through one durable attempt with exact proof provenance', async () => {
    const submissionStates: string[] = [];
    walletMint.mockImplementationOnce(async () => {
      const attempt =
        await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
      submissionStates.push(attempt?.state ?? 'missing');
      return [proof];
    });

    const result = await service.execute(operationId);

    expect(result.state).toBe('finalized');
    const operation = await repositories.mintOperationRepository.getById(operationId);
    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    const counter = await repositories.counterRepository.getCounter(mintUrl, keysetId);
    const saved = await repositories.proofRepository.getProofBySecret(mintUrl, outputSecret);

    expect(operation?.state).toBe('finalized');
    expect(operation?.attemptId).toBe(attempt?.id);
    expect(attempt?.state).toBe('succeeded');
    expect(attempt?.outputData).toEqual(outputData);
    expect(counter?.counter).toBe(1);
    expect(saved?.createdByAttemptId).toBe(attempt?.id);
    expect(saved?.createdByOperationId).toBeUndefined();
    expect(submissionStates).toEqual(['submitting']);
    expect(walletMint).toHaveBeenCalledTimes(1);
    expect(walletMint.mock.calls[0]?.[2]).toEqual({ keysetId });
  });

  it('fails a coordinated single attempt when the mint quote expires during submission', async () => {
    const failedEvents: Array<CoreEvents['mint-op:failed']> = [];
    eventBus.on('mint-op:failed', (event) => {
      failedEvents.push(event);
    });
    walletMint.mockRejectedValueOnce(new MintOperationError(20007, 'Quote expired'));

    const result = await service.execute(operationId);

    const operation = await repositories.mintOperationRepository.getById(operationId);
    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    expect(result.state).toBe('failed');
    expect(operation?.state).toBe('failed');
    expect(operation?.terminalFailure?.reason).toBe('Quote expired');
    expect(attempt?.state).toBe('failed');
    expect(attempt?.terminalError?.message).toBe('Quote expired');
    expect(failedEvents).toHaveLength(1);
  });

  it('fails an unattached operation whose canonical quote was already issued', async () => {
    await repositories.mintQuoteRepository.setMintQuoteState(
      mintUrl,
      'bolt11',
      quoteId,
      'ISSUED',
      Date.now(),
    );

    const result = await service.finalize(operationId);

    const operation = await repositories.mintOperationRepository.getById(operationId);
    expect(result.state).toBe('failed');
    expect(operation).toMatchObject({
      state: 'failed',
      terminalFailure: { code: 'quote_already_issued', retryable: false },
    });
    expect(operation).not.toHaveProperty('attemptId');
    await expect(
      repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId),
    ).resolves.toBeNull();
    expect(walletMint).not.toHaveBeenCalled();
  });

  it('keeps a rejected dispatch recoverable when canonical state remains paid', async () => {
    walletMint.mockRejectedValueOnce(new MintOperationError(20001, 'Quote is not paid'));
    (mintAdapter.checkMintQuote as Mock<any>).mockResolvedValueOnce({
      quote: quoteId,
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'UNPAID' as const,
    });

    await expect(service.execute(operationId)).rejects.toBeInstanceOf(MintIssuanceRetryError);

    const operation = await repositories.mintOperationRepository.getById(operationId);
    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    const canonicalQuote = await repositories.mintQuoteRepository.getMintQuote(
      mintUrl,
      'bolt11',
      quoteId,
    );
    expect(operation).toMatchObject({ state: 'executing', attemptId: attempt?.id });
    expect(attempt?.state).toBe('recovering');
    expect(canonicalQuote?.state).toBe('PAID');
  });

  it('requeues a recovering single attempt from an unexpired unpaid quote', async () => {
    walletMint.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.execute(operationId)).rejects.toBeInstanceOf(MintIssuanceRetryError);
    await repositories.mintQuoteRepository.setMintQuoteState(
      mintUrl,
      'bolt11',
      quoteId,
      'UNPAID',
      Date.now(),
    );
    (mintAdapter.checkMintQuote as Mock<any>).mockResolvedValueOnce({
      quote: quoteId,
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'UNPAID' as const,
    });

    const result = await service.finalize(operationId);

    const operation = await repositories.mintOperationRepository.getById(operationId);
    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    expect(result.state).toBe('pending');
    expect(operation).toMatchObject({ state: 'pending', attemptId: undefined });
    expect(attempt?.state).toBe('rejected');
    expect(attempt?.terminalError?.code).toBe('QUOTE_UNPAID');
  });

  it('fails a recovering single attempt from an expired unpaid quote', async () => {
    walletMint.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.execute(operationId)).rejects.toBeInstanceOf(MintIssuanceRetryError);
    await repositories.mintQuoteRepository.setMintQuoteState(
      mintUrl,
      'bolt11',
      quoteId,
      'UNPAID',
      Date.now(),
    );
    (mintAdapter.checkMintQuote as Mock<any>).mockResolvedValueOnce({
      quote: quoteId,
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) - 60,
      state: 'UNPAID' as const,
    });

    const result = await service.finalize(operationId);

    const operation = await repositories.mintOperationRepository.getById(operationId);
    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    expect(result.state).toBe('failed');
    expect(operation?.terminalFailure?.reason).toBe(
      `Mint quote ${quoteId} expired before issuance`,
    );
    expect(attempt?.state).toBe('failed');
  });

  it('rejects returned proofs from a different keyset than the persisted outputs', async () => {
    walletMint.mockResolvedValueOnce([{ ...proof, id: 'rotated-keyset' }]);

    await expect(service.execute(operationId)).rejects.toThrow('exact proof set');

    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    expect(attempt?.state).toBe('recovering');
    await expect(
      repositories.proofRepository.getProofBySecret(mintUrl, outputSecret),
    ).resolves.toBeNull();
  });

  it('rejects returned proofs with a different amount than the persisted outputs', async () => {
    walletMint.mockResolvedValueOnce([{ ...proof, amount: Amount.from(9) }]);

    await expect(service.execute(operationId)).rejects.toThrow('exact proof set');

    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    expect(attempt?.state).toBe('recovering');
    await expect(
      repositories.proofRepository.getProofBySecret(mintUrl, outputSecret),
    ).resolves.toBeNull();
  });

  it('rolls back the operation, attempt, and counter when attempt creation fails', async () => {
    const create = MemoryMintIssuanceAttemptRepository.prototype.create;
    repositories.mintIssuanceAttemptRepository.create = mock(async (attempt) => {
      await create.call(
        repositories.mintIssuanceAttemptRepository as MemoryMintIssuanceAttemptRepository,
        attempt,
      );
      throw new Error('attempt transaction failed');
    });

    await expect(service.execute(operationId)).rejects.toThrow('attempt transaction failed');

    const operation = await repositories.mintOperationRepository.getById(operationId);
    expect(operation?.state).toBe('pending');
    expect(operation?.attemptId).toBeUndefined();
    await expect(
      repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId),
    ).resolves.toBeNull();
    await expect(repositories.counterRepository.getCounter(mintUrl, keysetId)).resolves.toBeNull();
    expect(walletMint).not.toHaveBeenCalled();
  });

  it('joins concurrent explicit calls to the same attempt', async () => {
    let releaseDispatch!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      walletMint.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseDispatch = release;
        });
        return [proof];
      });
    });

    const first = service.execute(operationId);
    await dispatchStarted;
    const second = service.finalize(operationId);
    releaseDispatch();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.state).toBe('finalized');
    expect(secondResult.state).toBe('finalized');
    expect(walletMint).toHaveBeenCalledTimes(1);
    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    expect(attempt?.state).toBe('succeeded');
  });

  it('shares an active join across coordinator instances using the same repositories', async () => {
    let releaseDispatch!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      walletMint.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseDispatch = release;
        });
        return [proof];
      });
    });

    const first = coordinator.coordinate(operationId);
    await dispatchStarted;
    const peer = new MintIssuanceCoordinator({
      repositories,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
      mintScopedLock: new MintScopedLock(),
    });
    const joined = peer.coordinate(operationId);

    expect(joined).toBe(first);
    releaseDispatch();
    const [firstResult, joinedResult] = await Promise.all([first, joined]);
    expect(firstResult.state).toBe('finalized');
    expect(joinedResult.state).toBe('finalized');
    expect(walletMint).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit execution target-scoped and terminal-idempotent', async () => {
    const peerQuoteId = 'quote-peer';
    const peerOperationId = 'operation-peer';
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: peerQuoteId,
        request: 'lnbc1peer',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      }),
    );
    await repositories.mintOperationRepository.create({
      ...pendingOperation(),
      id: peerOperationId,
      quoteId: peerQuoteId,
      request: 'lnbc1peer',
    });

    const first = await service.execute(operationId);
    const repeated = await service.execute(operationId);
    const peer = await repositories.mintOperationRepository.getById(peerOperationId);
    const peerAttempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(peerOperationId);

    expect(first.state).toBe('finalized');
    expect(repeated.state).toBe('finalized');
    expect(peer?.state).toBe('pending');
    expect(peerAttempt).toBeNull();
    expect(walletMint).toHaveBeenCalledTimes(1);
  });

  it('emits executing and finalized events only after their transactions commit', async () => {
    const observed: string[] = [];
    eventBus.on('mint-op:executing', async () => {
      const operation = await repositories.mintOperationRepository.getById(operationId);
      const attempt =
        await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
      observed.push(`executing:${operation?.state}:${attempt?.state}`);
    });
    eventBus.on('mint-op:finalized', async () => {
      const operation = await repositories.mintOperationRepository.getById(operationId);
      const attempt =
        await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
      const proofs = await repositories.proofRepository.getProofsByAttemptId(
        mintUrl,
        attempt?.id ?? '',
      );
      observed.push(`finalized:${operation?.state}:${attempt?.state}:${proofs.length}`);
    });

    await service.execute(operationId);

    expect(observed).toEqual(['executing:executing:prepared', 'finalized:finalized:succeeded:1']);
  });

  it('leaves an ambiguous submission restart-visible and resumes the same attempt', async () => {
    walletMint.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.execute(operationId)).rejects.toThrow('connection lost');

    const interrupted =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    const operation = await repositories.mintOperationRepository.getById(operationId);
    expect(interrupted?.state).toBe('recovering');
    expect(operation?.state).toBe('executing');
    expect(operation?.attemptId).toBe(interrupted?.id);

    service = createService();
    const resumed = await service.finalize(operationId);
    const completed = await repositories.mintIssuanceAttemptRepository.getById(interrupted!.id);

    expect(resumed.state).toBe('finalized');
    expect(completed?.state).toBe('succeeded');
    expect(walletMint).toHaveBeenCalledTimes(2);
  });

  it('fails an issued quote when its exact proofs cannot be recovered', async () => {
    walletMint.mockRejectedValueOnce(new MintOperationError(20002, 'Quote already issued'));
    (mintAdapter.checkMintQuote as Mock<any>).mockResolvedValueOnce({
      quote: quoteId,
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'ISSUED' as const,
    });

    const result = await service.execute(operationId);
    const operation = await repositories.mintOperationRepository.getById(operationId);
    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);

    expect(result.state).toBe('failed');
    expect(operation?.state).toBe('failed');
    expect(attempt?.state).toBe('failed');
    expect(attempt?.terminalError?.code).toBe('EXACT_PROOFS_UNRECOVERABLE');
  });

  it('keeps single restore failures retryable', async () => {
    walletMint.mockRejectedValueOnce(new MintOperationError(20002, 'Quote already issued'));
    (mintAdapter.checkMintQuote as Mock<any>).mockResolvedValueOnce({
      quote: quoteId,
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'ISSUED' as const,
    });
    (proofService.recoverProofsFromOutputData as Mock<any>).mockRejectedValueOnce(
      new Error('proof state temporarily indeterminate'),
    );

    await expect(service.execute(operationId)).rejects.toBeInstanceOf(MintIssuanceRetryError);

    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    expect(attempt?.state).toBe('recovering');
  });

  it('dispatches a migrated prepared BOLT12 attempt through its method handler', async () => {
    const { operation, attempt } = await seedLegacyBolt12Attempt(
      'legacy-prepared-bolt12',
      'prepared',
    );
    const execute = mock(async () => ({ status: 'ISSUED' as const, proofs: [proof] }));
    const recoverExecuting = mock(async () => ({ status: 'PENDING' as const }));
    const handler = { execute, recoverExecuting } as unknown as MintMethodHandler<'bolt12'>;
    const handlerGet = mock(() => handler);
    const legacyCoordinator = new MintIssuanceCoordinator({
      repositories,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      mintHandlerProvider: { get: handlerGet } as unknown as MintHandlerProvider,
      eventBus,
    });

    const result = await legacyCoordinator.coordinate(operation.id);

    expect(result.state).toBe('finalized');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(recoverExecuting).not.toHaveBeenCalled();
    expect(handlerGet).toHaveBeenCalledWith('bolt12');
    expect((await repositories.mintIssuanceAttemptRepository.getById(attempt.id))?.state).toBe(
      'succeeded',
    );
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, outputSecret))
        ?.createdByAttemptId,
    ).toBe(attempt.id);
  });

  it('fails a migrated recovering BOLT12 attempt when its handler reports terminal', async () => {
    const { operation, attempt } = await seedLegacyBolt12Attempt(
      'legacy-terminal-bolt12',
      'recovering',
    );
    const execute = mock(async () => ({ status: 'ALREADY_ISSUED' as const }));
    const recoverExecuting = mock(async () => ({
      status: 'TERMINAL' as const,
      error: 'quote can no longer be claimed',
    }));
    const handler = { execute, recoverExecuting } as unknown as MintMethodHandler<'bolt12'>;
    const legacyCoordinator = new MintIssuanceCoordinator({
      repositories,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      mintHandlerProvider: { get: mock(() => handler) } as unknown as MintHandlerProvider,
      eventBus,
    });

    const result = await legacyCoordinator.coordinate(operation.id);
    const failedOperation = await repositories.mintOperationRepository.getById(operation.id);
    const failedAttempt = await repositories.mintIssuanceAttemptRepository.getById(attempt.id);

    expect(result.state).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
    expect(recoverExecuting).toHaveBeenCalledTimes(1);
    expect(failedOperation).toMatchObject({
      state: 'failed',
      error: 'quote can no longer be claimed',
    });
    expect(failedAttempt).toMatchObject({
      state: 'failed',
      terminalError: { message: 'quote can no longer be claimed' },
    });
  });

  it('finalizes a migrated non-BOLT11 recovering attempt from its persisted exact proofs', async () => {
    const legacyOperationId = 'legacy-bolt12-operation';
    const legacyAttemptId = `legacy-mint-operation:${legacyOperationId}`;
    const legacyOperation: ExecutingMintOperationRecord<'bolt12'> = {
      ...pendingOperation(),
      id: legacyOperationId,
      method: 'bolt12',
      state: 'executing',
      quoteId: 'quote-bolt12',
      request: 'bolt12-request',
      pubkey: 'quote-pubkey',
      outputData,
      attemptId: legacyAttemptId,
    };
    await repositories.mintOperationRepository.create(legacyOperation);
    const legacyAttempt: MintIssuanceAttempt = {
      id: legacyAttemptId,
      mintUrl,
      method: 'bolt12',
      unit: 'sat',
      keysetId,
      state: 'recovering',
      memberOperationIds: [legacyOperationId],
      quoteIds: ['quote-bolt12'],
      quoteAmounts: [Amount.from(10)],
      signingRequirements: [null],
      outputData,
      request: { kind: 'single', quoteId: 'quote-bolt12' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      submittedAt: Date.now(),
      recoveryStartedAt: Date.now(),
    };
    await repositories.mintIssuanceAttemptRepository.create(legacyAttempt);
    await repositories.proofRepository.saveProofs(mintUrl, [
      {
        ...proof,
        mintUrl,
        unit: 'sat',
        state: 'ready',
        createdByOperationId: legacyOperationId,
      },
    ]);
    const handlerGet = mock(() => {
      throw new Error('handler recovery should not run when exact proofs are already persisted');
    });
    const legacyCoordinator = new MintIssuanceCoordinator({
      repositories,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      mintHandlerProvider: { get: handlerGet } as unknown as MintHandlerProvider,
      eventBus,
    });

    const result = await legacyCoordinator.coordinate(legacyOperationId);

    expect(result.state).toBe('finalized');
    expect((await repositories.mintIssuanceAttemptRepository.getById(legacyAttemptId))?.state).toBe(
      'succeeded',
    );
    expect(handlerGet).not.toHaveBeenCalled();
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, outputSecret))
        ?.createdByOperationId,
    ).toBe(legacyOperationId);
  });
});
