import { Amount, OutputData, type BatchMintPreview, type Proof } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import { mintQuoteGroupKey } from '../../infra/MintQuotePollingKey.ts';
import type { MintHandlerProvider } from '../../infra/handlers/mint/MintHandlerProvider.ts';
import { MintOperationError, NetworkError } from '../../models/Error.ts';
import { getMintQuoteRemoteState, mintQuoteFromBolt11Response } from '../../models/MintQuote.ts';
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
import { Nut29BatchLimitCache } from '../../quotes/MintQuoteBatchTransport.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import type { CoreProof, MintInfo } from '../../types.ts';
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
  let walletBatchMint: Mock<(preview: BatchMintPreview) => Promise<Proof[]>>;
  let createMintOutputsAtCounter: Mock<ProofService['createMintOutputsAtCounter']>;
  let getMintInfo: Mock<MintService['getMintInfo']>;
  let nut29BatchLimitCache: Nut29BatchLimitCache;
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

  const compatibleMintInfo = (): MintInfo =>
    ({
      nuts: {
        '4': { methods: [{ method: 'bolt11', unit: 'sat' }] },
        '29': { methods: ['bolt11'], max_batch_size: 100 },
      },
    }) as MintInfo;

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
      nut29BatchLimitCache,
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
    nut29BatchLimitCache = new Nut29BatchLimitCache();
    eventBus = new EventBus<CoreEvents>();
    walletMint = mock(async () => [proof]);
    walletBatchMint = mock(async (_preview: BatchMintPreview) => [proof]);
    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({
        wallet: { mintProofsBolt11: walletMint, completeBatchMint: walletBatchMint },
        keysetId,
        keys: { id: keysetId, unit: 'sat', keys: {} },
      })),
    } as unknown as WalletService;
    getMintInfo = mock(async () => compatibleMintInfo());
    mintService = {
      isTrustedMint: mock(async () => true),
      assertMethodUnitSupported: mock(async () => {}),
      getMintInfo,
    } as unknown as MintService;
    createMintOutputsAtCounter = mock(async (_mintUrl, _intent, counterStart) => ({
      keysetId,
      outputData,
      counterStart,
      counterEnd: counterStart + 1,
    }));
    proofService = {
      createMintOutputsAtCounter,
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
      name: 'Test Mint',
      mintInfo: compatibleMintInfo(),
      trusted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
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
    const create = repositories.mintIssuanceAttemptRepository.create.bind(
      repositories.mintIssuanceAttemptRepository,
    );
    repositories.mintIssuanceAttemptRepository.create = mock(async (attempt) => {
      await create(attempt);
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

  it('cancels processor-scheduled issuance before a later coordination turn', () => {
    service.scheduleIssuance(operationId);
    expect(service.isIssuanceScheduled(operationId)).toBe(true);

    service.unscheduleIssuance(operationId);

    expect(service.isIssuanceScheduled(operationId)).toBe(false);
  });

  it('redeems a processor-selected cohort through one successful Mint Batch', async () => {
    const peerQuoteId = 'quote-peer';
    const peerOperationId = 'operation-peer';
    const batchSecret = 'batch-output-secret';
    const batchOutputData = serializeOutputData({
      keep: [
        new OutputData(
          { amount: Amount.from(20), id: keysetId, B_: 'B_batch-output-secret' },
          2n,
          new TextEncoder().encode(batchSecret),
        ),
      ],
      send: [],
    });
    const batchProof: Proof = {
      id: keysetId,
      amount: Amount.from(20),
      secret: batchSecret,
      C: 'C_batch-output-secret',
    };
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
      createdAt: pendingOperation().createdAt + 1,
    });
    createMintOutputsAtCounter.mockResolvedValueOnce({
      keysetId,
      outputData: batchOutputData,
      counterStart: 0,
      counterEnd: 1,
    });
    walletBatchMint.mockResolvedValueOnce([batchProof]);

    coordinator.schedule(operationId);
    coordinator.schedule(peerOperationId);
    await coordinator.coordinate();

    const attempt =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    const first = await repositories.mintOperationRepository.getById(operationId);
    const peer = await repositories.mintOperationRepository.getById(peerOperationId);
    const saved = await repositories.proofRepository.getProofBySecret(mintUrl, batchSecret);

    expect(attempt?.memberOperationIds).toEqual([operationId, peerOperationId]);
    expect(attempt?.quoteIds).toEqual([quoteId, peerQuoteId]);
    expect(attempt?.request.kind).toBe('batch');
    expect(attempt?.state).toBe('succeeded');
    expect(first?.state).toBe('finalized');
    expect(peer?.state).toBe('finalized');
    expect(saved?.createdByAttemptId).toBe(attempt?.id);
    expect(walletBatchMint).toHaveBeenCalledTimes(1);
    expect(walletMint).not.toHaveBeenCalled();
    expect(walletBatchMint.mock.calls[0]?.[0]).toMatchObject({
      method: 'bolt11',
      keysetId,
      payload: {
        quotes: [quoteId, peerQuoteId],
        quote_amounts: [Amount.from(10), Amount.from(10)],
      },
    });
  });

  it('retries single attempts while deferring ambiguous Mint Batch recovery', async () => {
    walletMint.mockRejectedValueOnce(new NetworkError('single transport unavailable'));
    await expect(service.execute(operationId)).rejects.toThrow('single transport unavailable');
    await expect(service.canRetryIssuance(operationId)).resolves.toBe(true);

    const batchAttemptId = 'attempt-batch-recovering';
    const batchOperationIds = ['operation-batch-a', 'operation-batch-b'];
    const batchQuoteIds = ['quote-batch-a', 'quote-batch-b'];
    const batchOutputData = serializeOutputData({
      keep: [
        new OutputData(
          { amount: Amount.from(20), id: keysetId, B_: 'B_deferred-batch-output' },
          4n,
          new TextEncoder().encode('deferred-batch-output'),
        ),
      ],
      send: [],
    });
    for (const [index, batchOperationId] of batchOperationIds.entries()) {
      const batchQuoteId = batchQuoteIds[index]!;
      await repositories.mintOperationRepository.create({
        ...pendingOperation(),
        id: batchOperationId,
        state: 'executing',
        quoteId: batchQuoteId,
        request: `lnbc1${batchQuoteId}`,
        outputData: batchOutputData,
        attemptId: batchAttemptId,
        createdAt: pendingOperation().createdAt + index + 1,
      });
    }
    const now = Date.now();
    await repositories.mintIssuanceAttemptRepository.create({
      id: batchAttemptId,
      mintUrl,
      method: 'bolt11',
      unit: 'sat',
      keysetId,
      state: 'recovering',
      memberOperationIds: batchOperationIds,
      quoteIds: batchQuoteIds,
      quoteAmounts: [Amount.from(10), Amount.from(10)],
      signingRequirements: [null, null],
      outputData: batchOutputData,
      request: {
        kind: 'batch',
        quoteIds: batchQuoteIds,
        quoteAmounts: [Amount.from(10), Amount.from(10)],
      },
      createdAt: now,
      updatedAt: now,
      submittedAt: now,
      recoveryStartedAt: now,
    });

    await expect(service.canRetryIssuance(batchOperationIds[0]!)).resolves.toBe(false);
    await expect(service.canRetryIssuance(batchOperationIds[1]!)).resolves.toBe(false);
  });

  it('lets an explicit target join its processor-created Mint Batch', async () => {
    const peerQuoteId = 'quote-peer';
    const peerOperationId = 'operation-peer';
    const batchSecret = 'joined-batch-output';
    const batchOutputData = serializeOutputData({
      keep: [
        new OutputData(
          { amount: Amount.from(20), id: keysetId, B_: 'B_joined-batch-output' },
          3n,
          new TextEncoder().encode(batchSecret),
        ),
      ],
      send: [],
    });
    const batchProof: Proof = {
      id: keysetId,
      amount: Amount.from(20),
      secret: batchSecret,
      C: 'C_joined-batch-output',
    };
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
    createMintOutputsAtCounter.mockResolvedValueOnce({
      keysetId,
      outputData: batchOutputData,
      counterStart: 0,
      counterEnd: 1,
    });
    let releaseBatch!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    walletBatchMint.mockImplementationOnce(async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      return [batchProof];
    });

    coordinator.schedule(operationId);
    coordinator.schedule(peerOperationId);
    const processorTurn = coordinator.coordinate();
    await started;
    const joined = coordinator.coordinate(peerOperationId);
    releaseBatch();

    await expect(joined).resolves.toMatchObject({ id: peerOperationId, state: 'finalized' });
    await processorTurn;
    expect(walletBatchMint).toHaveBeenCalledTimes(1);
  });

  it('deduplicates an explicit join immediately after the processor attempt commits', async () => {
    const peerQuoteId = 'quote-peer';
    const peerOperationId = 'operation-peer';
    const batchSecret = 'commit-race-batch-output';
    const batchOutputData = serializeOutputData({
      keep: [
        new OutputData(
          { amount: Amount.from(20), id: keysetId, B_: 'B_commit-race-batch-output' },
          4n,
          new TextEncoder().encode(batchSecret),
        ),
      ],
      send: [],
    });
    const batchProof: Proof = {
      id: keysetId,
      amount: Amount.from(20),
      secret: batchSecret,
      C: 'C_commit-race-batch-output',
    };
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
    createMintOutputsAtCounter.mockResolvedValueOnce({
      keysetId,
      outputData: batchOutputData,
      counterStart: 0,
      counterEnd: 1,
    });

    let markCounterCommitted!: () => void;
    let releaseCounterEvent!: () => void;
    const counterCommitted = new Promise<void>((resolve) => {
      markCounterCommitted = resolve;
    });
    eventBus.once('counter:updated', async () => {
      markCounterCommitted();
      await new Promise<void>((resolve) => {
        releaseCounterEvent = resolve;
      });
    });
    let markExecutingEmitted!: () => void;
    const executingEmitted = new Promise<void>((resolve) => {
      markExecutingEmitted = resolve;
    });
    eventBus.once('mint-op:executing', () => markExecutingEmitted());
    let markBatchStarted!: () => void;
    let releaseBatch!: () => void;
    const batchStarted = new Promise<void>((resolve) => {
      markBatchStarted = resolve;
    });
    walletBatchMint.mockImplementationOnce(async () => {
      markBatchStarted();
      await new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      return [batchProof];
    });

    coordinator.schedule(operationId);
    coordinator.schedule(peerOperationId);
    const processorTurn = coordinator.coordinate();
    await counterCommitted;
    const explicit = coordinator.coordinate(peerOperationId);
    await batchStarted;
    releaseCounterEvent();
    await executingEmitted;
    releaseBatch();

    await expect(explicit).resolves.toMatchObject({ id: peerOperationId, state: 'finalized' });
    await processorTurn;
    expect(walletBatchMint).toHaveBeenCalledTimes(1);
  });

  it('joins an explicit attempt attached while a processor cohort is being selected', async () => {
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

    let releaseCapability!: () => void;
    let markCapabilityStarted!: () => void;
    const capabilityStarted = new Promise<void>((resolve) => {
      markCapabilityStarted = resolve;
    });
    getMintInfo.mockImplementationOnce(async () => {
      markCapabilityStarted();
      await new Promise<void>((resolve) => {
        releaseCapability = resolve;
      });
      return {
        nuts: {
          '4': { methods: [{ method: 'bolt11', unit: 'sat' }] },
          '29': { methods: ['bolt11'], max_batch_size: 100 },
        },
      } as MintInfo;
    });
    let releaseSingle!: () => void;
    let markSingleStarted!: () => void;
    const singleStarted = new Promise<void>((resolve) => {
      markSingleStarted = resolve;
    });
    walletMint.mockImplementationOnce(async () => {
      markSingleStarted();
      await new Promise<void>((resolve) => {
        releaseSingle = resolve;
      });
      return [proof];
    });

    coordinator.schedule(operationId);
    coordinator.schedule(peerOperationId);
    const processorTurn = coordinator.coordinate();
    await capabilityStarted;
    const explicit = coordinator.coordinate(operationId);
    await singleStarted;
    releaseCapability();
    releaseSingle();

    await Promise.all([processorTurn, explicit]);
    expect(walletMint).toHaveBeenCalledTimes(1);
    expect(walletBatchMint).not.toHaveBeenCalled();
    expect((await repositories.mintOperationRepository.getById(operationId))?.state).toBe(
      'finalized',
    );
    expect((await repositories.mintOperationRepository.getById(peerOperationId))?.state).toBe(
      'pending',
    );
  });

  it('uses single-member attempts when processor batch redemption is forced off', async () => {
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
    coordinator.configureProcessorRedemption({ forceSingleRedemption: true });

    coordinator.schedule(operationId);
    coordinator.schedule(peerOperationId);
    await coordinator.coordinate();

    const first = await repositories.mintOperationRepository.getById(operationId);
    const peer = await repositories.mintOperationRepository.getById(peerOperationId);
    expect([first?.state, peer?.state].filter((state) => state === 'finalized')).toHaveLength(1);
    expect([first?.state, peer?.state].filter((state) => state === 'pending')).toHaveLength(1);
    expect(walletMint).toHaveBeenCalledTimes(1);
    expect(walletBatchMint).not.toHaveBeenCalled();

    const secondSecret = 'force-single-second-output';
    const secondOutputData = serializeOutputData({
      keep: [
        new OutputData(
          { amount: Amount.from(10), id: keysetId, B_: 'B_force-single-second-output' },
          5n,
          new TextEncoder().encode(secondSecret),
        ),
      ],
      send: [],
    });
    createMintOutputsAtCounter.mockImplementationOnce(async (_mint, _intent, counterStart) => ({
      keysetId,
      outputData: secondOutputData,
      counterStart,
      counterEnd: counterStart + 1,
    }));
    walletMint.mockResolvedValueOnce([
      {
        id: keysetId,
        amount: Amount.from(10),
        secret: secondSecret,
        C: 'C_force-single-second-output',
      },
    ]);

    await coordinator.coordinate();

    const completed = await Promise.all([
      repositories.mintOperationRepository.getById(operationId),
      repositories.mintOperationRepository.getById(peerOperationId),
    ]);
    const attempts = await Promise.all(
      completed.map((operation) =>
        repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operation!.id),
      ),
    );
    const quoteStates = await Promise.all(
      [quoteId, peerQuoteId].map(async (id) =>
        getMintQuoteRemoteState(
          (await repositories.mintQuoteRepository.getMintQuote(mintUrl, 'bolt11', id))!,
        ),
      ),
    );
    const savedProofs = (
      await Promise.all(
        attempts.map((attempt) =>
          repositories.proofRepository.getProofsByAttemptId(mintUrl, attempt!.id),
        ),
      )
    ).flat();
    expect(completed.map((operation) => operation?.state)).toEqual(['finalized', 'finalized']);
    expect(attempts.map((attempt) => attempt?.request.kind)).toEqual(['single', 'single']);
    expect(quoteStates).toEqual(['ISSUED', 'ISSUED']);
    expect(savedProofs.reduce((total, saved) => total.add(saved.amount), Amount.zero())).toEqual(
      Amount.from(20),
    );
    expect(walletMint).toHaveBeenCalledTimes(2);
  });

  it('normalizes the mint denylist before selecting a processor cohort', async () => {
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
    coordinator.configureProcessorRedemption({
      batchRedemptionDenylist: ['https://mint.test/'],
    });

    coordinator.schedule(operationId);
    coordinator.schedule(peerOperationId);
    await coordinator.coordinate();

    const attempts = await repositories.mintIssuanceAttemptRepository.listRecoverable();
    const first = await repositories.mintOperationRepository.getById(operationId);
    const peer = await repositories.mintOperationRepository.getById(peerOperationId);
    expect(attempts).toHaveLength(0);
    expect([first?.state, peer?.state].filter((state) => state === 'finalized')).toHaveLength(1);
    expect([first?.state, peer?.state].filter((state) => state === 'pending')).toHaveLength(1);
    expect(walletBatchMint).not.toHaveBeenCalled();
  });

  it('falls back to single transport when the mint no longer advertises NUT-29', async () => {
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
    getMintInfo.mockResolvedValue({
      nuts: { '4': { methods: [{ method: 'bolt11', unit: 'sat' }] } },
    } as MintInfo);

    coordinator.schedule(operationId);
    coordinator.schedule(peerOperationId);
    await coordinator.coordinate();

    const first = await repositories.mintOperationRepository.getById(operationId);
    const peer = await repositories.mintOperationRepository.getById(peerOperationId);
    expect([first?.state, peer?.state].filter((state) => state === 'finalized')).toHaveLength(1);
    expect([first?.state, peer?.state].filter((state) => state === 'pending')).toHaveLength(1);
    expect(walletMint).toHaveBeenCalledTimes(1);
    expect(walletBatchMint).not.toHaveBeenCalled();
  });

  it('aborts when NUT-29 capability changes during multi-member attempt construction', async () => {
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
    createMintOutputsAtCounter.mockImplementationOnce(async (_mint, _intent, counterStart) => {
      const storedMint = await repositories.mintRepository.getMintByUrl(mintUrl);
      await repositories.mintRepository.updateMint({
        ...storedMint,
        mintInfo: {
          nuts: { '4': { methods: [{ method: 'bolt11', unit: 'sat' }] } },
        } as MintInfo,
        updatedAt: Date.now(),
      });
      return {
        keysetId,
        outputData,
        counterStart,
        counterEnd: counterStart + 1,
      };
    });

    coordinator.schedule(operationId);
    coordinator.schedule(peerOperationId);

    await expect(coordinator.coordinate()).rejects.toThrow(
      'Mint NUT-29 capability changed before attempt creation committed',
    );
    expect(
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId),
    ).toBeNull();
    expect((await repositories.mintOperationRepository.getById(operationId))?.state).toBe(
      'pending',
    );
    expect((await repositories.mintOperationRepository.getById(peerOperationId))?.state).toBe(
      'pending',
    );
    expect(walletMint).not.toHaveBeenCalled();
    expect(walletBatchMint).not.toHaveBeenCalled();
  });

  it('chunks at the advertised limit and rotates the next ready mint group fairly', async () => {
    const baseCreatedAt = pendingOperation().createdAt;
    const batchSecret = 'limited-batch-output';
    const batchOutputData = serializeOutputData({
      keep: [
        new OutputData(
          { amount: Amount.from(20), id: keysetId, B_: 'B_limited-batch-output' },
          4n,
          new TextEncoder().encode(batchSecret),
        ),
      ],
      send: [],
    });
    const batchProof: Proof = {
      id: keysetId,
      amount: Amount.from(20),
      secret: batchSecret,
      C: 'C_limited-batch-output',
    };
    getMintInfo.mockResolvedValue({
      nuts: {
        '4': { methods: [{ method: 'bolt11', unit: 'sat' }] },
        '29': { methods: ['bolt11'], max_batch_size: 100 },
      },
    } as MintInfo);
    nut29BatchLimitCache.lower(mintQuoteGroupKey(mintUrl, 'bolt11'), 2);
    createMintOutputsAtCounter.mockResolvedValueOnce({
      keysetId,
      outputData: batchOutputData,
      counterStart: 0,
      counterEnd: 1,
    });
    walletBatchMint.mockResolvedValueOnce([batchProof]);

    for (const [index, suffix] of ['a', 'b'].entries()) {
      const peerQuoteId = `quote-${suffix}`;
      await repositories.mintQuoteRepository.upsertMintQuote(
        mintQuoteFromBolt11Response(mintUrl, {
          quote: peerQuoteId,
          request: `lnbc1${suffix}`,
          amount: Amount.from(10),
          unit: 'sat',
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'PAID',
        }),
      );
      await repositories.mintOperationRepository.create({
        ...pendingOperation(),
        id: `operation-${suffix}`,
        quoteId: peerQuoteId,
        request: `lnbc1${suffix}`,
        createdAt: baseCreatedAt + index + 1,
      });
    }
    const otherMintUrl = 'https://z-mint.test';
    const otherOperationId = 'operation-z';
    await repositories.mintRepository.addNewMint({
      mintUrl: otherMintUrl,
      name: 'Z Mint',
      mintInfo: {} as MintInfo,
      trusted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Response(otherMintUrl, {
        quote: 'quote-z',
        request: 'lnbc1z',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      }),
    );
    await repositories.mintOperationRepository.create({
      ...pendingOperation(),
      id: otherOperationId,
      mintUrl: otherMintUrl,
      quoteId: 'quote-z',
      request: 'lnbc1z',
      createdAt: baseCreatedAt + 3,
    });

    for (const id of [operationId, 'operation-a', 'operation-b', otherOperationId]) {
      coordinator.schedule(id);
    }
    await coordinator.coordinate();
    await coordinator.coordinate();

    const batch =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operationId);
    expect(batch?.memberOperationIds).toEqual([operationId, 'operation-a']);
    expect((await repositories.mintOperationRepository.getById('operation-b'))?.state).toBe(
      'pending',
    );
    expect((await repositories.mintOperationRepository.getById(otherOperationId))?.state).toBe(
      'finalized',
    );
    expect(walletBatchMint).toHaveBeenCalledTimes(1);
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
