import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { OutputData, type MintQuoteBolt11Response, type Proof } from '@cashu/cashu-ts';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import { MintOperationService } from '../../operations/mint/MintOperationService';
import type {
  ExecutingMintOperation,
  InitMintOperation,
  PendingMintOperation,
} from '../../operations/mint/MintOperation';
import type {
  MintExecutionResult,
  MintMethodHandler,
  PendingMintCheckResult,
  RecoverExecutingResult,
} from '../../operations/mint/MintMethodHandler';
import type { MintHandlerProvider } from '../../infra/handlers/mint';
import { MemoryMintOperationRepository } from '../../repositories/memory/MemoryMintOperationRepository';
import { MemoryMintQuoteRepository } from '../../repositories/memory/MemoryMintQuoteRepository';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository';
import { mintQuoteFromBolt11Response } from '../../models/MintQuote';
import { QuoteLifecycle } from '../../quotes/QuoteLifecycle';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { MintAdapter } from '../../infra/MintAdapter';
import { serializeOutputData } from '../../utils';
import type { CoreProof } from '../../types';

describe('MintOperationService', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-1';
  const keysetId = 'keyset-1';

  let operationRepo: MemoryMintOperationRepository;
  let quoteRepo: MemoryMintQuoteRepository;
  let proofRepo: MemoryProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let mintAdapter: MintAdapter;
  let eventBus: EventBus<CoreEvents>;
  let handler: MintMethodHandler<'bolt11'>;
  let handlerProvider: MintHandlerProvider;
  let quoteLifecycle: QuoteLifecycle;
  let service: MintOperationService;

  function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject } as const;
  }

  const makeProof = (secret: string): Proof =>
    ({
      id: keysetId,
      amount: Amount.from(10),
      secret,
      C: `C_${secret}`,
    }) as Proof;

  const makeSerializedOutputData = (secret: string) =>
    serializeOutputData({
      keep: [
        new OutputData(
          {
            amount: Amount.from(10),
            id: keysetId,
            B_: `B_${secret}`,
          },
          BigInt(1),
          new TextEncoder().encode(secret),
        ),
      ],
      send: [],
    });

  const toCoreProof = (secret: string, operationId: string): CoreProof => ({
    id: keysetId,
    amount: Amount.from(10),
    secret,
    C: `C_${secret}`,
    mintUrl,
    unit: 'sat',
    state: 'ready',
    createdByOperationId: operationId,
  });

  const makeInitOp = (id: string): InitMintOperation => ({
    id,
    state: 'init',
    mintUrl,
    method: 'bolt11',
    methodData: {},
    amount: Amount.from(10),
    unit: 'sat',
    quoteId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const persistQuote = async (quote = quoteId): Promise<void> => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      }),
    );
  };

  const makePendingOp = (id: string, secret = 'out-1'): PendingMintOperation => ({
    ...makeInitOp(id),
    state: 'pending',
    quoteId,
    amount: Amount.from(10),
    request: 'lnbc1test',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    lastObservedRemoteState: 'PAID',
    lastObservedRemoteStateAt: Date.now(),
    outputData: makeSerializedOutputData(secret),
  });

  const makeExecutingOp = (id: string, secret = 'out-1'): ExecutingMintOperation => ({
    ...makePendingOp(id, secret),
    state: 'executing',
  });

  beforeEach(async () => {
    operationRepo = new MemoryMintOperationRepository();
    quoteRepo = new MemoryMintQuoteRepository();
    proofRepo = new MemoryProofRepository();
    eventBus = new EventBus<CoreEvents>();

    const mockPrepare = mock(async ({ operation }: { operation: InitMintOperation<'bolt11'> }) => {
      return makePendingOp(operation.id) as PendingMintOperation<'bolt11'>;
    });

    const mockExecute = mock(async (): Promise<MintExecutionResult> => {
      return { status: 'ISSUED', proofs: [makeProof('out-1')] };
    });

    const mockRecoverExecuting = mock(async (): Promise<RecoverExecutingResult> => {
      return { status: 'PENDING' };
    });

    const mockCheckPending = mock(
      async (): Promise<PendingMintCheckResult<'bolt11'>> => ({
        observedRemoteState: 'UNPAID',
        observedRemoteStateAt: Date.now(),
        category: 'waiting',
      }),
    );

    handler = {
      createQuote: mock(async ({ mintUrl: quoteMintUrl, createQuoteData }) =>
        mintQuoteFromBolt11Response(quoteMintUrl, {
          quote: quoteId,
          request: 'lnbc1test',
          amount: createQuoteData.amount.amount,
          unit: createQuoteData.amount.unit,
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'UNPAID',
        }),
      ),
      fetchRemoteQuote: mock(async ({ quote }) =>
        mintQuoteFromBolt11Response(quote.mintUrl, {
          quote: quote.quoteId,
          request: 'lnbc1paid',
          amount: quote.amount,
          unit: quote.unit,
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'PAID',
        }),
      ),
      prepare: mockPrepare,
      execute: mockExecute,
      recoverExecuting: mockRecoverExecuting,
      checkPending: mockCheckPending,
    };

    handlerProvider = {
      get: mock(() => handler),
    } as unknown as MintHandlerProvider;

    proofService = {
      saveProofs: mock(async (_mintUrl: string, proofs: CoreProof[]) => {
        await proofRepo.saveProofs(mintUrl, proofs);
      }),
      recoverProofsFromOutputData: mock(async (_mintUrl: string, _outputData, options) => {
        if (!options?.createdByOperationId) {
          return [];
        }
        await proofRepo.saveProofs(mintUrl, [toCoreProof('out-1', options.createdByOperationId)]);
        return [makeProof('out-1')];
      }),
    } as unknown as ProofService;

    mintService = {
      isTrustedMint: mock(async () => true),
      assertMethodUnitSupported: mock(async () => {}),
    } as unknown as MintService;

    walletService = {
      getWalletWithActiveKeysetId: mock(async (_mintUrl: string, unit: string) => ({
        wallet: {
          createMintQuoteBolt11: mock(async (amount: Amount) => ({
            quote: quoteId,
            request: 'lnbc1test',
            amount,
            unit,
            expiry: Math.floor(Date.now() / 1000) + 3600,
            state: 'UNPAID',
          })),
        },
      })),
    } as unknown as WalletService;

    mintAdapter = {
      checkMintQuoteState: mock(async () => ({
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      })),
    } as unknown as MintAdapter;

    quoteLifecycle = new QuoteLifecycle({
      mintHandlerProvider: handlerProvider,
      meltHandlerProvider: {} as any,
      mintQuoteRepository: quoteRepo,
      meltQuoteRepository: {} as any,
      proofRepository: proofRepo,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
    });

    service = new MintOperationService(
      handlerProvider,
      operationRepo,
      quoteLifecycle,
      proofRepo,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
    );
  });

  it('prepareExistingQuote persists a pending operation and emits mint-op:pending', async () => {
    const pendingEvents: Array<CoreEvents['mint-op:pending']> = [];
    eventBus.on('mint-op:pending', (event) => {
      pendingEvents.push(event);
    });

    const quote = await quoteLifecycle.createMintQuote(mintUrl, {
      amount: Amount.from(10),
      unit: 'sat',
    });

    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({ operation }: { operation: InitMintOperation }) => ({
        ...makePendingOp(operation.id),
        quoteId: quote.quoteId,
        request: quote.request,
        lastObservedRemoteState: 'UNPAID',
      }),
    );

    const pending = await service.prepareExistingQuote(mintUrl, 'bolt11', quote.quoteId);

    expect(pending.state).toBe('pending');
    expect(pending.quoteId).toBe(quote.quoteId);
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.operationId).toBe(pending.id);
    const createdOperation = pendingEvents[0]?.operation as PendingMintOperation | undefined;
    expect(createdOperation?.quoteId).toBe(quote.quoteId);
    expect(createdOperation?.request).toBe(quote.request);
    expect(createdOperation?.lastObservedRemoteState).toBe('UNPAID');
  });

  it('prepareExistingQuote accepts normalized custom-unit quotes', async () => {
    const quote = await quoteLifecycle.createMintQuote(mintUrl, {
      amount: Amount.from(10),
      unit: 'USD',
    });

    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({ operation }: { operation: InitMintOperation }) => ({
        ...makePendingOp(operation.id),
        amount: operation.amount,
        unit: operation.unit,
        quoteId: quote.quoteId,
        request: quote.request,
        lastObservedRemoteState: 'UNPAID',
      }),
    );

    const pending = await service.prepareExistingQuote(mintUrl, 'bolt11', quote.quoteId, {}, 'USD');

    expect(pending.unit).toBe('usd');
    expect(mintService.assertMethodUnitSupported).toHaveBeenCalledWith(mintUrl, 4, 'bolt11', {
      amount: Amount.from(10),
      unit: 'usd',
    });
  });

  it('createQuote persists a canonical quote without creating operation output data', async () => {
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const created = await quoteLifecycle.createMintQuote(mintUrl, {
      amount: Amount.from(10),
      unit: 'sat',
    });

    const storedQuote = await quoteRepo.getMintQuote(mintUrl, 'bolt11', created.quoteId);
    const operations = await operationRepo.getAll();

    expect(storedQuote?.quoteId).toBe(created.quoteId);
    expect(storedQuote?.method).toBe('bolt11');
    expect(storedQuote?.reusable).toBe(false);
    expect(operations).toHaveLength(0);
    expect(handler.createQuote).toHaveBeenCalled();
    expect(handler.prepare).not.toHaveBeenCalled();
    expect(quoteUpdatedEvents).toHaveLength(0);
  });

  it('getQuote returns a persisted quote by full identity', async () => {
    await persistQuote('quote-exact');

    const found = await quoteLifecycle.getMintQuote(mintUrl, 'bolt11', 'quote-exact');
    const wrongQuoteId = await quoteLifecycle.getMintQuote(mintUrl, 'bolt11', 'quote-other');
    const wrongMint = await quoteLifecycle.getMintQuote(
      'https://other-mint.test',
      'bolt11',
      'quote-exact',
    );

    expect(found?.quoteId).toBe('quote-exact');
    expect(wrongQuoteId).toBeNull();
    expect(wrongMint).toBeNull();
  });

  it('getPendingQuotes returns non-issued canonical quotes with optional method filtering', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: 'quote-unpaid',
        request: 'lnbc1unpaid',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'UNPAID',
      }),
    );
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: 'quote-issued',
        request: 'lnbc1issued',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'ISSUED',
      }),
    );

    const allPending = await quoteLifecycle.getPendingMintQuotes();
    const bolt11Pending = await quoteLifecycle.getPendingMintQuotes('bolt11');

    expect(allPending.map((quote) => quote.quoteId)).toEqual(['quote-unpaid']);
    expect(bolt11Pending.map((quote) => quote.quoteId)).toEqual(['quote-unpaid']);
  });

  it('refreshMintQuote fails when the canonical quote is missing', async () => {
    await expect(
      quoteLifecycle.refreshMintQuote(mintUrl, 'bolt11', 'missing-quote'),
    ).rejects.toThrow('was not found');

    expect(handler.fetchRemoteQuote).not.toHaveBeenCalled();
  });

  it('refreshMintQuote persists the canonical quote before emitting mint-quote:updated', async () => {
    await persistQuote();
    const observedAt = Date.now();
    (handler.fetchRemoteQuote as Mock<any>).mockImplementationOnce(async ({ quote }: any) =>
      mintQuoteFromBolt11Response(quote.mintUrl, {
        quote: quote.quoteId,
        request: 'lnbc1paid',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      }),
    );

    const persistedDuringEvent: Array<string | undefined> = [];
    eventBus.on('mint-quote:updated', async ({ quote }) => {
      const storedQuote = await quoteRepo.getMintQuote(quote.mintUrl, quote.method, quote.quoteId);
      persistedDuringEvent.push(storedQuote?.state);
    });

    const refreshed = await quoteLifecycle.refreshMintQuote(mintUrl, 'bolt11', quoteId);

    expect(handler.fetchRemoteQuote).toHaveBeenCalled();
    expect(refreshed.state).toBe('PAID');
    expect(refreshed.request).toBe('lnbc1paid');
    expect(refreshed.lastObservedRemoteState).toBe('PAID');
    expect(refreshed.lastObservedRemoteStateAt).toBeGreaterThanOrEqual(observedAt);
    expect(persistedDuringEvent).toEqual(['PAID']);
  });

  it('prepareExistingQuote fails before creating an operation when the quote is missing', async () => {
    await expect(
      service.prepareExistingQuote(mintUrl, 'bolt11', 'missing-quote', {}),
    ).rejects.toThrow('was not found');

    await expect(operationRepo.getAll()).resolves.toHaveLength(0);
    expect(handler.prepare).not.toHaveBeenCalled();
  });

  it('prepareExistingQuote fails before creating an operation when the quote is terminal', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: 'issued-quote',
        request: 'lnbc1issued',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'ISSUED',
      }),
    );

    await expect(
      service.prepareExistingQuote(mintUrl, 'bolt11', 'issued-quote', {}),
    ).rejects.toThrow('quote is terminal');

    await expect(operationRepo.getAll()).resolves.toHaveLength(0);
    expect(handler.prepare).not.toHaveBeenCalled();
  });

  it('prepareExistingQuote rejects duplicate operations for non-reusable quotes', async () => {
    const quote = await quoteLifecycle.createMintQuote(mintUrl, {
      amount: Amount.from(10),
      unit: 'sat',
    });

    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({ operation }: { operation: InitMintOperation }) => ({
        ...makePendingOp(operation.id),
        quoteId: quote.quoteId,
        request: quote.request,
        lastObservedRemoteState: 'UNPAID',
      }),
    );

    const first = await service.prepareExistingQuote(mintUrl, 'bolt11', quote.quoteId);

    await expect(service.prepareExistingQuote(mintUrl, 'bolt11', quote.quoteId)).rejects.toThrow(
      `Mint quote ${quote.quoteId} is already tracked by operation ${first.id} in state pending`,
    );

    const operations = await operationRepo.getByQuoteId(mintUrl, 'bolt11', quote.quoteId);
    expect(operations).toHaveLength(1);
    expect(handler.prepare).toHaveBeenCalledTimes(1);
  });

  it('init rejects duplicate operations for non-reusable quote-bound operations', async () => {
    await persistQuote();
    const variantMintUrl = 'https://MINT.test/';

    const first = await service.init(
      variantMintUrl,
      { amount: Amount.from(10), unit: 'sat' },
      'bolt11',
      {},
      { quoteId },
    );

    await expect(
      service.init(mintUrl, { amount: Amount.from(10), unit: 'sat' }, 'bolt11', {}, { quoteId }),
    ).rejects.toThrow(
      `Mint quote ${quoteId} is already tracked by operation ${first.id} in state init`,
    );

    const operations = await operationRepo.getByQuoteId(mintUrl, 'bolt11', quoteId);
    expect(first.mintUrl).toBe(mintUrl);
    expect(operations).toHaveLength(1);
  });

  it('init allows repeated operations for reusable quote-bound operations', async () => {
    const reusableQuote = {
      ...mintQuoteFromBolt11Response(mintUrl, {
        quote: 'quote-reusable',
        request: 'lnbc1reusable',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'UNPAID',
      }),
      reusable: true,
    };
    await quoteRepo.upsertMintQuote(reusableQuote);

    const first = await service.init(
      mintUrl,
      { amount: Amount.from(10), unit: 'sat' },
      'bolt11',
      {},
      { quoteId: reusableQuote.quoteId },
    );
    const second = await service.init(
      mintUrl,
      { amount: Amount.from(10), unit: 'sat' },
      'bolt11',
      {},
      { quoteId: reusableQuote.quoteId },
    );

    const operations = await operationRepo.getByQuoteId(mintUrl, 'bolt11', reusableQuote.quoteId);
    expect(first.id).not.toBe(second.id);
    expect(operations).toHaveLength(2);
  });

  it('importQuote persists a pending operation and emits mint-op:pending', async () => {
    const pendingEvents: Array<CoreEvents['mint-op:pending']> = [];
    eventBus.on('mint-op:pending', (event) => {
      pendingEvents.push(event);
    });

    const importedQuote: MintQuoteBolt11Response = {
      quote: 'quote-imported',
      request: 'lnbc1imported',
      amount: Amount.from(12),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
    };

    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({ operation }: { operation: InitMintOperation }) => ({
        ...makePendingOp(operation.id),
        quoteId: importedQuote.quote,
        amount: importedQuote.amount,
        request: importedQuote.request,
        expiry: importedQuote.expiry,
        lastObservedRemoteState: importedQuote.state,
      }),
    );

    const pending = await service.importQuote(mintUrl, importedQuote, 'bolt11', {});

    expect(pending.state).toBe('pending');
    expect(pending.quoteId).toBe(importedQuote.quote);
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.operationId).toBe(pending.id);
    const importedOperation = pendingEvents[0]?.operation as PendingMintOperation | undefined;
    expect(importedOperation?.quoteId).toBe(importedQuote.quote);
    expect(importedOperation?.request).toBe(importedQuote.request);
    expect(importedOperation?.lastObservedRemoteState).toBe(importedQuote.state);
  });

  it('importQuote resolves existing operations by canonical imported quote identity', async () => {
    const variantMintUrl = 'https://MINT.test/';
    const importedQuote: MintQuoteBolt11Response = {
      quote: 'quote-canonical-import',
      request: 'lnbc1canonicalimport',
      amount: Amount.from(12),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
    };

    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({ operation }: { operation: InitMintOperation }) => ({
        ...makePendingOp(operation.id),
        mintUrl: operation.mintUrl,
        quoteId: importedQuote.quote,
        amount: importedQuote.amount,
        request: importedQuote.request,
        expiry: importedQuote.expiry,
        lastObservedRemoteState: importedQuote.state,
      }),
    );

    const first = await service.importQuote(variantMintUrl, importedQuote, 'bolt11', {});
    const second = await service.importQuote(variantMintUrl, importedQuote, 'bolt11', {});
    const operations = await operationRepo.getAll();

    expect(second.id).toBe(first.id);
    expect(second.mintUrl).toBe(mintUrl);
    expect(operations).toHaveLength(1);
    expect(handler.prepare).toHaveBeenCalledTimes(1);
  });

  it('importQuote does not downgrade canonical state for an already tracked pending quote', async () => {
    const pendingOp = makePendingOp('pending-import-stale');
    await operationRepo.create(pendingOp);
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: pendingOp.quoteId,
        request: pendingOp.request,
        amount: pendingOp.amount,
        unit: pendingOp.unit,
        expiry: pendingOp.expiry,
        state: 'PAID',
      }),
    );

    const staleQuote: MintQuoteBolt11Response = {
      quote: pendingOp.quoteId,
      request: pendingOp.request,
      amount: pendingOp.amount,
      unit: pendingOp.unit,
      expiry: pendingOp.expiry,
      state: 'UNPAID',
    };

    const imported = await service.importQuote(mintUrl, staleQuote, 'bolt11', {});
    const storedQuote = await quoteRepo.getMintQuote(mintUrl, 'bolt11', pendingOp.quoteId);

    expect(imported.id).toBe(pendingOp.id);
    expect(storedQuote?.state).toBe('PAID');
    expect(storedQuote?.lastObservedRemoteState).toBe('PAID');
    expect(handler.prepare).not.toHaveBeenCalled();
  });

  it('importQuote upgrades canonical state for an already tracked pending quote', async () => {
    const pendingOp = makePendingOp('pending-import-upgrade');
    await operationRepo.create(pendingOp);
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: pendingOp.quoteId,
        request: pendingOp.request,
        amount: pendingOp.amount,
        unit: pendingOp.unit,
        expiry: pendingOp.expiry,
        state: 'UNPAID',
      }),
    );

    const paidQuote: MintQuoteBolt11Response = {
      quote: pendingOp.quoteId,
      request: pendingOp.request,
      amount: pendingOp.amount,
      unit: pendingOp.unit,
      expiry: pendingOp.expiry,
      state: 'PAID',
    };

    const imported = await service.importQuote(mintUrl, paidQuote, 'bolt11', {});
    const storedQuote = await quoteRepo.getMintQuote(mintUrl, 'bolt11', pendingOp.quoteId);

    expect(imported.id).toBe(pendingOp.id);
    expect(storedQuote?.state).toBe('PAID');
    expect(storedQuote?.lastObservedRemoteState).toBe('PAID');
    expect(handler.prepare).not.toHaveBeenCalled();
  });

  it('importQuote prepares an already tracked init operation from an upgraded canonical quote', async () => {
    const initOp = makeInitOp('init-import-upgrade');
    const initQuoteId = initOp.quoteId;
    if (!initQuoteId) {
      throw new Error('Test setup expected init operation to have a quote id');
    }
    await operationRepo.create(initOp);
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: initQuoteId,
        request: 'lnbc1init',
        amount: initOp.amount,
        unit: initOp.unit,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'UNPAID',
      }),
    );

    const paidQuote: MintQuoteBolt11Response = {
      quote: initQuoteId,
      request: 'lnbc1init',
      amount: initOp.amount,
      unit: initOp.unit,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
    };

    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({
        operation,
        importedQuote,
      }: {
        operation: InitMintOperation;
        importedQuote: MintQuoteBolt11Response;
      }) => ({
        ...makePendingOp(operation.id),
        quoteId: importedQuote.quote,
        amount: importedQuote.amount,
        request: importedQuote.request,
        expiry: importedQuote.expiry,
        lastObservedRemoteState: importedQuote.state,
      }),
    );

    const pending = await service.importQuote(mintUrl, paidQuote, 'bolt11', {});
    const storedQuote = await quoteRepo.getMintQuote(mintUrl, 'bolt11', initQuoteId);

    expect(pending.id).toBe(initOp.id);
    expect(pending.lastObservedRemoteState).toBe('PAID');
    expect(storedQuote?.state).toBe('PAID');
    expect(storedQuote?.lastObservedRemoteState).toBe('PAID');
  });

  it('importQuote prepares new operations from the persisted canonical quote state', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: 'quote-canonical-paid',
        request: 'lnbc1canonical',
        amount: Amount.from(12),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      }),
    );

    const staleQuote: MintQuoteBolt11Response = {
      quote: 'quote-canonical-paid',
      request: 'lnbc1canonical',
      amount: Amount.from(12),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'UNPAID',
    };

    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({
        operation,
        importedQuote,
      }: {
        operation: InitMintOperation;
        importedQuote: MintQuoteBolt11Response;
      }) => ({
        ...makePendingOp(operation.id),
        quoteId: importedQuote.quote,
        amount: importedQuote.amount,
        request: importedQuote.request,
        expiry: importedQuote.expiry,
        lastObservedRemoteState: importedQuote.state,
      }),
    );

    const pending = await service.importQuote(mintUrl, staleQuote, 'bolt11', {});
    const storedQuote = await quoteRepo.getMintQuote(mintUrl, 'bolt11', staleQuote.quote);

    expect(pending.quoteId).toBe(staleQuote.quote);
    expect(pending.lastObservedRemoteState).toBe('PAID');
    expect(storedQuote?.state).toBe('PAID');
  });

  it('importQuote delegates unsupported quote units to capability validation', async () => {
    const importedQuote: MintQuoteBolt11Response = {
      quote: 'quote-usd',
      request: 'lnbc1imported',
      amount: Amount.from(12),
      unit: 'usd',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
    };
    (mintService.assertMethodUnitSupported as Mock<any>).mockRejectedValueOnce(
      new Error('Mint https://mint.test does not advertise NUT-04 support for bolt11/usd'),
    );

    await expect(service.importQuote(mintUrl, importedQuote, 'bolt11', {})).rejects.toThrow(
      'does not advertise NUT-04 support for bolt11/usd',
    );

    expect(handler.prepare).not.toHaveBeenCalled();
  });

  it('prepare + finalize runs init -> pending -> execute for an existing tracked operation', async () => {
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    const finalizedEvents: Array<CoreEvents['mint-op:finalized']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });
    eventBus.on('mint-op:finalized', (event) => {
      finalizedEvents.push(event);
    });

    const initOp = makeInitOp('mint-op-redeem');
    await operationRepo.create(initOp);
    await persistQuote();

    const pending = await service.prepare(initOp.id);
    const finalized = await service.finalize(pending.id);

    expect(finalized?.state).toBe('finalized');

    const stored = await operationRepo.getByQuoteId(mintUrl, 'bolt11', quoteId);
    expect(stored.length).toBe(1);
    expect(stored[0]?.state).toBe('finalized');

    const saved = await proofRepo.getProofBySecret(mintUrl, 'out-1');
    expect(saved).not.toBeNull();
    expect(saved?.createdByOperationId).toBe(finalized?.id);

    expect(quoteUpdatedEvents.length).toBe(1);
    expect(quoteUpdatedEvents[0]?.quoteId).toBe(quoteId);
    expect(quoteUpdatedEvents[0]?.method).toBe('bolt11');
    expect(quoteUpdatedEvents[0]?.quote.state).toBe('ISSUED');
    expect(finalizedEvents.length).toBe(1);
    expect(finalizedEvents[0]?.operationId).toBe(finalized?.id);
    expect(finalizedEvents[0]?.operation.state).toBe('finalized');
  });

  it('finalize is idempotent after finalize', async () => {
    const initOp = makeInitOp('mint-op-idempotent');
    await operationRepo.create(initOp);
    await persistQuote();

    const pending = await service.prepare(initOp.id);
    const first = await service.finalize(pending.id);
    const second = await service.finalize(first.id);

    expect(first?.state).toBe('finalized');
    expect(second?.id).toBe(first?.id);

    const ops = await operationRepo.getByQuoteId(mintUrl, 'bolt11', quoteId);
    expect(ops.length).toBe(1);
  });

  it('recoverExecutingOperation finalizes when handler marks FINALIZED', async () => {
    const op = makeExecutingOp('exec-1');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({ status: 'FINALIZED' });

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);
    expect(stored?.state).toBe('finalized');
  });

  it('recoverExecutingOperation returns to pending when quote was not issued remotely', async () => {
    const op = makeExecutingOp('exec-2');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({
      status: 'PENDING',
      error: 'Recovered: quote not issued remotely',
    });

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);
    expect(stored?.state).toBe('pending');
    expect(stored?.error).toBe('Recovered: quote not issued remotely');
  });

  it('recoverExecutingOperation returns to pending when proofs are not recoverable', async () => {
    const op = makeExecutingOp('exec-3');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({ status: 'FINALIZED' });
    (proofService.recoverProofsFromOutputData as Mock<any>).mockResolvedValueOnce([]);

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);
    expect(stored?.state).toBe('pending');
  });

  it('recoverExecutingOperation finalizes expired quotes as terminal failures', async () => {
    const op = makeExecutingOp('exec-expired');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({
      status: 'TERMINAL',
      error: `Recovered: quote ${quoteId} expired while executing mint`,
    });

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);

    expect(stored?.state).toBe('failed');
    expect(stored?.error).toBe(`Recovered: quote ${quoteId} expired while executing mint`);
  });

  it('finalize returns a failed operation when recovery finds an expired quote', async () => {
    const op = makeExecutingOp('exec-expired-redeem');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({
      status: 'TERMINAL',
      error: `Recovered: quote ${quoteId} expired while executing mint`,
    });

    const result = await service.finalize(op.id);

    expect(result?.state).toBe('failed');
    expect(result?.id).toBe(op.id);
  });

  it('finalize throws when executing operation is recovered back to pending', async () => {
    const op = makeExecutingOp('exec-4');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({ status: 'PENDING' });

    await expect(service.finalize(op.id)).rejects.toThrow(
      `Operation ${op.id} remains pending after recovery`,
    );
  });

  it('getOperationByQuote returns null when no tracked operation exists for the quote', async () => {
    await expect(service.getOperationByQuote(mintUrl, 'bolt11', quoteId)).resolves.toBeNull();
  });

  it('execute finalizes when already issued proofs cannot be restored', async () => {
    const pendingOp = makePendingOp('pending-2');
    await operationRepo.create(pendingOp);

    (handler.execute as Mock<any>).mockResolvedValueOnce({ status: 'ALREADY_ISSUED' });
    (proofService.recoverProofsFromOutputData as Mock<any>).mockResolvedValueOnce([]);

    const finalized = await service.execute(pendingOp.id);

    const stored = await operationRepo.getById(pendingOp.id);

    expect(finalized.state).toBe('finalized');
    expect(finalized.error).toBe(
      `Recovered issued quote ${pendingOp.quoteId} but no proofs could be restored`,
    );
    expect(stored?.state).toBe('finalized');
    expect(stored?.error).toBe(
      `Recovered issued quote ${pendingOp.quoteId} but no proofs could be restored`,
    );
  });

  it('recoverPendingOperations cleans init operations and reconciles stale pending ones', async () => {
    const initOp = makeInitOp('init-1');
    const pendingOp = makePendingOp('pending-1');

    await operationRepo.create(initOp);
    await operationRepo.create(pendingOp);

    (handler.checkPending as Mock<any>).mockResolvedValueOnce({
      observedRemoteState: 'PAID',
      observedRemoteStateAt: Date.now(),
      category: 'ready',
    });

    await service.recoverPendingOperations();

    const initStored = await operationRepo.getById(initOp.id);
    const pendingStored = await operationRepo.getById(pendingOp.id);

    expect(initStored).toBeNull();
    expect(pendingStored?.state).toBe('finalized');
  });

  it('checkPendingOperation leaves unpaid operations pending', async () => {
    const pendingOp = makePendingOp('pending-3');
    await operationRepo.create(pendingOp);

    const result = await service.checkPendingOperation(pendingOp.id);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(result.category).toBe('waiting');
    expect(result.observedRemoteState).toBe('UNPAID');
    expect(stored?.state).toBe('pending');
    if (!stored || stored.state !== 'pending') {
      throw new Error('Expected pending operation to remain pending after unpaid check');
    }
    expect(stored.lastObservedRemoteState).toBe('UNPAID');
    expect(stored.lastObservedRemoteStateAt).toEqual(expect.any(Number));
  });

  it('recordPendingObservation updates the stored remote state and emits pending operation update', async () => {
    const pendingOp = makePendingOp('pending-4');
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    const pendingEvents: Array<CoreEvents['mint-op:pending']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });
    eventBus.on('mint-op:pending', (event) => {
      pendingEvents.push(event);
    });
    await operationRepo.create(pendingOp);

    const observedAt = Date.now();
    const result = await service.recordPendingObservation(pendingOp.id, 'PAID', observedAt);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(result.lastObservedRemoteState).toBe('PAID');
    expect(result.lastObservedRemoteStateAt).toBe(observedAt);
    expect(stored?.state).toBe('pending');
    if (!stored || stored.state !== 'pending') {
      throw new Error('Expected pending operation to remain pending after recording observation');
    }
    expect(stored.lastObservedRemoteState).toBe('PAID');
    expect(stored.lastObservedRemoteStateAt).toBe(observedAt);
    expect(handler.checkPending).not.toHaveBeenCalled();
    expect(quoteUpdatedEvents).toHaveLength(0);
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.mintUrl).toBe(pendingOp.mintUrl);
    expect(pendingEvents[0]?.operationId).toBe(pendingOp.id);
    expect(pendingEvents[0]?.operation).toMatchObject({
      id: pendingOp.id,
      state: 'pending',
      lastObservedRemoteState: 'PAID',
      lastObservedRemoteStateAt: observedAt,
    });
  });

  it('serializes pending quote observations with operation execution', async () => {
    const pendingOp = makePendingOp('pending-observation-race');
    await operationRepo.create(pendingOp);

    const observationReady = createDeferred();
    const allowObservationWrite = createDeferred();
    const originalUpdate = operationRepo.update.bind(operationRepo);
    operationRepo.update = mock(async (operation) => {
      if (
        operation.id === pendingOp.id &&
        operation.state === 'pending' &&
        operation.lastObservedRemoteState === 'PAID'
      ) {
        observationReady.resolve();
        await allowObservationWrite.promise;
      }
      return originalUpdate(operation);
    });

    let executeStarted = false;
    (handler.execute as Mock<any>).mockImplementationOnce(
      async (): Promise<MintExecutionResult> => {
        executeStarted = true;
        return { status: 'ISSUED', proofs: [makeProof('out-1')] };
      },
    );

    const observationPromise = service.recordPendingObservation(pendingOp.id, 'PAID', Date.now());
    await observationReady.promise;

    const executePromise = service.execute(pendingOp.id);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(executeStarted).toBe(false);
    allowObservationWrite.resolve();

    const [, finalized] = await Promise.all([observationPromise, executePromise]);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(finalized.state).toBe('finalized');
    expect(stored?.state).toBe('finalized');
  });

  it('recordQuoteObservation persists the canonical quote before emitting mint-quote:updated', async () => {
    const pendingOp = makePendingOp('pending-quote-event');
    await operationRepo.create(pendingOp);

    const observedAt = Date.now();
    const persistedDuringEvent: Array<string | undefined> = [];
    eventBus.on('mint-quote:updated', async ({ quote }) => {
      const storedQuote = await quoteRepo.getMintQuote(quote.mintUrl, quote.method, quote.quoteId);
      persistedDuringEvent.push(storedQuote?.state);
    });

    const quote = await service.recordQuoteObservation(pendingOp, 'PAID', observedAt);

    expect(quote.state).toBe('PAID');
    expect(quote.lastObservedRemoteStateAt).toBe(observedAt);
    expect(persistedDuringEvent).toEqual(['PAID']);
  });

  it('persists a pending operation observation from a canonical quote update', async () => {
    const pendingOp = makePendingOp('pending-5');
    const pendingEvents: Array<CoreEvents['mint-op:pending']> = [];
    eventBus.on('mint-op:pending', (event) => {
      pendingEvents.push(event);
    });
    await operationRepo.create(pendingOp);

    const observedAt = Date.now();
    await eventBus.emit('mint-quote:updated', {
      mintUrl,
      method: pendingOp.method,
      quoteId: pendingOp.quoteId,
      quote: {
        mintUrl,
        method: 'bolt11',
        quoteId: pendingOp.quoteId,
        quote: pendingOp.quoteId,
        request: pendingOp.request,
        amount: pendingOp.amount,
        unit: pendingOp.unit,
        expiry: pendingOp.expiry,
        state: 'PAID',
        lastObservedRemoteState: 'PAID',
        lastObservedRemoteStateAt: observedAt,
        reusable: false,
        quoteData: {
          amount: pendingOp.amount,
        },
        createdAt: pendingOp.createdAt,
        updatedAt: observedAt,
      },
    });

    const stored = await operationRepo.getById(pendingOp.id);

    expect(stored?.state).toBe('pending');
    if (!stored || stored.state !== 'pending') {
      throw new Error('Expected pending operation to remain pending after event persistence');
    }
    expect(stored.lastObservedRemoteState).toBe('PAID');
    expect(stored.lastObservedRemoteStateAt).toBe(observedAt);
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.operationId).toBe(pendingOp.id);
    expect(pendingEvents[0]?.operation).toMatchObject({
      id: pendingOp.id,
      state: 'pending',
      lastObservedRemoteState: 'PAID',
      lastObservedRemoteStateAt: observedAt,
    });
    expect(handler.checkPending).not.toHaveBeenCalled();
  });
});
