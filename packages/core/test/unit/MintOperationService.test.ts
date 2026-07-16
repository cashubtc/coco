import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import {
  OutputData,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
  type Proof,
} from '@cashu/cashu-ts';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import { MintOperationService } from '../../operations/mint/MintOperationService';
import type {
  ExecutingMintOperationRecord as ExecutingMintOperation,
  FinalizedMintOperationRecord as FinalizedMintOperation,
  InitMintOperationRecord as InitMintOperation,
  PendingMintOperation as PublicPendingMintOperation,
  PendingMintOperationRecord as PendingMintOperation,
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
import {
  getMintQuoteAvailableAmount,
  mintQuoteFromBolt11Response,
  mintQuoteFromBolt12Response,
  mintQuoteFromOnchainResponse,
} from '../../models/MintQuote';
import { QuoteLifecycle } from '../../quotes/QuoteLifecycle';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { MintAdapter } from '../../infra/MintAdapter';
import { QuoteSpecificMintOperationError } from '../../infra/MintQuoteBatchError.ts';
import { serializeOutputData } from '../../utils';
import type { CoreProof } from '../../types';
import {
  HttpResponseError,
  MintOperationError,
  NetworkError,
  QuoteIdentityConflictError,
} from '../../models/Error';

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

  const makeSerializedOutputData = (secret: string, amount = Amount.from(10)) =>
    serializeOutputData({
      keep: [
        new OutputData(
          {
            amount,
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

  const persistOnchainQuote = async (
    quote = 'onchain-quote-1',
    amounts: { paid?: Amount; issued?: Amount; expiry?: number } = {},
  ): Promise<void> => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromOnchainResponse(mintUrl, {
        quote,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: amounts.expiry ?? Math.floor(Date.now() / 1000) + 3600,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: amounts.paid ?? Amount.zero(),
        amount_issued: amounts.issued ?? Amount.zero(),
      }),
    );
  };

  const persistBolt12Quote = async (
    quote = 'bolt12-quote-1',
    amounts: { amount?: Amount; paid?: Amount; issued?: Amount; expiry?: number } = {},
  ): Promise<void> => {
    const response: MintQuoteBolt12Response = {
      quote,
      request: 'lno1test',
      amount: amounts.amount ?? null,
      unit: 'sat',
      expiry: amounts.expiry ?? Math.floor(Date.now() / 1000) + 3600,
      pubkey: '02'.padEnd(66, '2'),
      amount_paid: amounts.paid ?? Amount.zero(),
      amount_issued: amounts.issued ?? Amount.zero(),
    };

    await quoteRepo.upsertMintQuote(mintQuoteFromBolt12Response(mintUrl, response));
  };

  const useAutoClaimOnchainHandler = (paid = Amount.from(10)) => {
    let issued = Amount.zero();
    let lastExecutedAmount = Amount.zero();
    const executedAmounts: string[] = [];

    const onchainHandler = {
      ...handler,
      validateQuoteForPrepare: mock(async () => {}),
      prepare: mock(async ({ operation, importedQuote }: any) => ({
        ...operation,
        state: 'pending',
        quoteId: importedQuote.quote,
        request: importedQuote.request,
        expiry: importedQuote.expiry,
        pubkey: importedQuote.pubkey,
        outputData: makeSerializedOutputData(operation.id, operation.amount),
      })),
      execute: mock(async ({ operation }: any): Promise<MintExecutionResult> => {
        lastExecutedAmount = operation.amount;
        executedAmounts.push(operation.amount.toString());
        return { status: 'ISSUED', proofs: [makeProof(operation.id)] };
      }),
      fetchRemoteQuote: mock(async ({ quote }) => {
        issued = issued.add(lastExecutedAmount);
        return mintQuoteFromOnchainResponse(quote.mintUrl, {
          quote: quote.quoteId,
          request: quote.request,
          unit: quote.unit,
          expiry: quote.expiry,
          pubkey: quote.quoteData.pubkey,
          amount_paid: paid,
          amount_issued: issued,
        });
      }),
    } as unknown as MintMethodHandler<'onchain'>;

    (handlerProvider.get as Mock<any>).mockImplementation((method: string) =>
      method === 'onchain' ? onchainHandler : handler,
    );

    return { onchainHandler, executedAmounts };
  };

  const makePendingOp = (id: string, secret = 'out-1'): PendingMintOperation => ({
    ...makeInitOp(id),
    state: 'pending',
    quoteId,
    amount: Amount.from(10),
    request: 'lnbc1test',
    expiry: Math.floor(Date.now() / 1000) + 3600,
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
      getMintInfo: mock(async () => ({
        nuts: {
          '4': { methods: [], disabled: false },
          '5': { methods: [], disabled: false },
        },
      })),
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
      checkMintQuote: mock(async () => ({
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      })),
      checkMintQuoteBatch: mock(async () => []),
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

  it('prepare persists a pending operation and emits mint-op:pending', async () => {
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
      }),
    );

    const pending = await service.prepare(quote, Amount.from(10));

    expect(pending.state).toBe('pending');
    expect(pending.quoteId).toBe(quote.quoteId);
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.operationId).toBe(pending.id);
    const createdOperation = pendingEvents[0]?.operation as PublicPendingMintOperation | undefined;
    expect(createdOperation?.quoteId).toBe(quote.quoteId);
    expect(createdOperation?.request).toBe(quote.request);
    expect(createdOperation).not.toHaveProperty('outputData');
    expect(createdOperation).not.toHaveProperty('attemptId');
  });

  it('prepare accepts normalized custom-unit quotes', async () => {
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
      }),
    );

    const pending = await service.prepare(quote, Amount.from(10));

    expect(pending.unit).toBe('usd');
    expect(mintService.assertMethodUnitSupported).toHaveBeenCalledWith(mintUrl, 4, 'bolt11', {
      amount: Amount.from(10),
      unit: 'usd',
    });
  });

  it('prepare accepts reusable onchain quotes with an explicit amount', async () => {
    const onchainQuoteId = 'onchain-quote-1';
    await persistOnchainQuote(onchainQuoteId);
    const onchainHandler = {
      ...handler,
      validateQuoteForPrepare: mock(async () => {}),
      prepare: mock(async ({ operation, importedQuote }: any) => ({
        ...operation,
        state: 'pending' as const,
        quoteId: importedQuote.quote,
        request: importedQuote.request,
        expiry: importedQuote.expiry,
        pubkey: importedQuote.pubkey,
        outputData: makeSerializedOutputData('onchain-out-1'),
      })),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => onchainHandler);

    const pending = await service.prepare(
      { mintUrl, method: 'onchain', quoteId: onchainQuoteId },
      Amount.from(10),
    );

    expect(onchainHandler.validateQuoteForPrepare).toHaveBeenCalled();
    expect(mintService.assertMethodUnitSupported).toHaveBeenCalledWith(
      mintUrl,
      4,
      'onchain',
      'sat',
    );
    expect(pending.method).toBe('onchain');
    expect(pending.amount.equals(Amount.from(10))).toBe(true);
    expect(pending.quoteId).toBe(onchainQuoteId);
  });

  it('prepare accepts fixed-amount BOLT12 quotes with a different explicit mint amount', async () => {
    const bolt12QuoteId = 'bolt12-quote-1';
    await persistBolt12Quote(bolt12QuoteId, {
      amount: Amount.from(21),
      paid: Amount.from(63),
      issued: Amount.zero(),
    });
    const bolt12Handler = {
      ...handler,
      validateQuoteForPrepare: mock(async () => {}),
      prepare: mock(async ({ operation, importedQuote }: any) => ({
        ...operation,
        state: 'pending' as const,
        quoteId: importedQuote.quote,
        request: importedQuote.request,
        expiry: importedQuote.expiry,
        pubkey: importedQuote.pubkey,
        outputData: makeSerializedOutputData('bolt12-out-1', operation.amount),
      })),
    } as unknown as MintMethodHandler<'bolt12'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => bolt12Handler);

    const pending = await service.prepare(
      { mintUrl, method: 'bolt12', quoteId: bolt12QuoteId },
      Amount.from(10),
    );

    expect(bolt12Handler.validateQuoteForPrepare).toHaveBeenCalled();
    expect(pending.method).toBe('bolt12');
    expect(pending.amount.equals(Amount.from(10))).toBe(true);
    expect(pending.quoteId).toBe(bolt12QuoteId);
  });

  it('prepare fails before persisting onchain operations when key material is missing', async () => {
    const onchainQuoteId = 'onchain-quote-1';
    await persistOnchainQuote(onchainQuoteId);
    const onchainHandler = {
      ...handler,
      validateQuoteForPrepare: mock(async () => {
        throw new Error('Missing NUT-20 mint quote key for pubkey 02...');
      }),
      prepare: mock(async () => {
        throw new Error('prepare should not run');
      }),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => onchainHandler);

    await expect(
      service.prepare({ mintUrl, method: 'onchain', quoteId: onchainQuoteId }, Amount.from(10)),
    ).rejects.toThrow('Missing NUT-20 mint quote key');

    expect(onchainHandler.prepare).not.toHaveBeenCalled();
    expect(await operationRepo.getAll()).toHaveLength(0);
  });

  it('prepare allows sibling onchain operations for one reusable quote', async () => {
    const onchainQuoteId = 'onchain-quote-1';
    await persistOnchainQuote(onchainQuoteId);
    const onchainHandler = {
      ...handler,
      validateQuoteForPrepare: mock(async () => {}),
      prepare: mock(async ({ operation, importedQuote }: any) => ({
        ...operation,
        state: 'pending' as const,
        quoteId: importedQuote.quote,
        request: importedQuote.request,
        expiry: importedQuote.expiry,
        pubkey: importedQuote.pubkey,
        outputData: makeSerializedOutputData(operation.id),
      })),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => onchainHandler);

    await service.prepare({ mintUrl, method: 'onchain', quoteId: onchainQuoteId }, Amount.from(10));
    await service.prepare({ mintUrl, method: 'onchain', quoteId: onchainQuoteId }, Amount.from(5));

    const operations = await operationRepo.getAll();

    expect(operations).toHaveLength(2);
    expect(operations.every((operation) => operation.quoteId === onchainQuoteId)).toBe(true);
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(2);
  });

  it('prepare cleans init operations but keeps consumed counters when onchain persistence fails', async () => {
    const onchainQuoteId = 'onchain-quote-1';
    const consumedCounters: string[] = [];
    await persistOnchainQuote(onchainQuoteId);
    const onchainHandler = {
      ...handler,
      validateQuoteForPrepare: mock(async () => {}),
      prepare: mock(async ({ operation, importedQuote }: any) => {
        consumedCounters.push(operation.id);
        return {
          ...operation,
          state: 'pending' as const,
          quoteId: importedQuote.quote,
          request: importedQuote.request,
          expiry: importedQuote.expiry,
          pubkey: importedQuote.pubkey,
          outputData: makeSerializedOutputData(operation.id),
        };
      }),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => onchainHandler);
    operationRepo.update = mock(async () => {
      throw new Error('pending persistence failed');
    }) as typeof operationRepo.update;

    await expect(
      service.prepare({ mintUrl, method: 'onchain', quoteId: onchainQuoteId }, Amount.from(10)),
    ).rejects.toThrow('pending persistence failed');

    expect(consumedCounters).toHaveLength(1);
    expect(await operationRepo.getAll()).toHaveLength(0);
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
    expect(quoteUpdatedEvents).toHaveLength(1);
    expect(quoteUpdatedEvents[0]).toMatchObject({
      mintUrl,
      method: 'bolt11',
      quoteId: created.quoteId,
      quote: {
        quoteId: created.quoteId,
      },
    });
  });

  it('getQuoteById returns a persisted quote by canonical identity', async () => {
    await persistQuote('quote-exact');

    const found = await quoteLifecycle.getMintQuoteById({ mintUrl, quoteId: 'quote-exact' });
    const wrongQuoteId = await quoteLifecycle.getMintQuoteById({ mintUrl, quoteId: 'quote-other' });
    const wrongMint = await quoteLifecycle.getMintQuoteById({
      mintUrl: 'https://other-mint.test',
      quoteId: 'quote-exact',
    });

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
      quoteLifecycle.refreshMintQuoteById({ mintUrl, quoteId: 'missing-quote' }),
    ).rejects.toThrow('was not found');

    expect(handler.fetchRemoteQuote).not.toHaveBeenCalled();
  });

  it('refreshMintQuote uses an advertised NUT-29 batch check and persists its observation', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'UNPAID',
      }),
    );
    (mintService.getMintInfo as Mock<any>).mockResolvedValueOnce({
      nuts: {
        '4': { methods: [{ method: 'bolt11', unit: 'sat' }], disabled: false },
        '29': { methods: ['bolt11'], max_batch_size: 10 },
      },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockResolvedValueOnce([
      {
        quote: quoteId,
        request: 'lnbc1test',
        amount: 10,
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      },
    ]);

    const refreshed = await quoteLifecycle.refreshMintQuoteById({ mintUrl, quoteId });

    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledWith(mintUrl, 'bolt11', [quoteId]);
    expect(handler.fetchRemoteQuote).not.toHaveBeenCalled();
    expect(refreshed.method).toBe('bolt11');
    if (refreshed.method !== 'bolt11') throw new Error('Expected BOLT11 quote');
    expect(refreshed.state).toBe('PAID');
  });

  it('refreshMintQuote joins identical in-flight NUT-29 checks', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'UNPAID',
      }),
    );
    (mintService.getMintInfo as Mock<any>).mockResolvedValue({
      nuts: { '29': { methods: ['bolt11'], max_batch_size: 10 } },
    });
    const response = createDeferred<unknown>();
    const started = createDeferred();
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockImplementationOnce(async () => {
      started.resolve();
      return response.promise;
    });

    const first = quoteLifecycle.refreshMintQuoteById({ mintUrl, quoteId });
    const second = quoteLifecycle.refreshMintQuoteById({ mintUrl, quoteId });
    await started.promise;
    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledTimes(1);

    response.resolve([
      {
        quote: quoteId,
        request: 'lnbc1test',
        amount: 10,
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      },
    ]);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
  });

  it('refreshMintQuote joins identical watcher-created in-flight NUT-29 work', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: null,
        state: 'UNPAID',
      }),
    );
    (mintService.getMintInfo as Mock<any>).mockResolvedValue({
      nuts: { '29': { methods: ['bolt11'], max_batch_size: 10 } },
    });
    const response = createDeferred<unknown>();
    const started = createDeferred();
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockImplementationOnce(async () => {
      started.resolve();
      return response.promise;
    });

    const watcherCheck = quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [quoteId]);
    await started.promise;
    const explicitCheck = quoteLifecycle.refreshMintQuoteById({ mintUrl, quoteId });
    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledTimes(1);

    response.resolve([
      {
        quote: quoteId,
        request: 'lnbc1test',
        amount: 10,
        unit: 'sat',
        expiry: null,
        state: 'PAID',
      },
    ]);

    await watcherCheck;
    await expect(explicitCheck).resolves.toMatchObject({ quoteId, state: 'PAID' });
    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledTimes(1);
  });

  it('refreshMintQuote does not join watcher work that excluded it at the batch limit', async () => {
    for (const id of ['quote-peer', quoteId]) {
      await quoteRepo.upsertMintQuote(
        mintQuoteFromBolt11Response(mintUrl, {
          quote: id,
          request: `request-${id}`,
          amount: Amount.from(10),
          unit: 'sat',
          expiry: null,
          state: 'UNPAID',
        }),
      );
    }
    (mintService.getMintInfo as Mock<any>).mockResolvedValue({
      nuts: { '29': { methods: ['bolt11'], max_batch_size: 1 } },
    });
    const peerResponse = createDeferred<unknown>();
    const peerStarted = createDeferred();
    (mintAdapter.checkMintQuoteBatch as Mock<any>)
      .mockImplementationOnce(async () => {
        peerStarted.resolve();
        return peerResponse.promise;
      })
      .mockResolvedValueOnce([
        {
          quote: quoteId,
          request: `request-${quoteId}`,
          amount: 10,
          unit: 'sat',
          expiry: null,
          state: 'PAID',
        },
      ]);

    const watcherCheck = quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [
      'quote-peer',
      quoteId,
    ]);
    await peerStarted.promise;
    const explicitCheck = quoteLifecycle.refreshMintQuoteById({ mintUrl, quoteId });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();

    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledTimes(2);
    peerResponse.resolve([
      {
        quote: 'quote-peer',
        request: 'request-quote-peer',
        amount: 10,
        unit: 'sat',
        expiry: null,
        state: 'PAID',
      },
    ]);
    await watcherCheck;
    await expect(explicitCheck).resolves.toMatchObject({ quoteId, state: 'PAID' });
  });

  it('refreshMintQuote fails when its NUT-29 response has no usable requested observation', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: null,
        state: 'UNPAID',
      }),
    );
    (mintService.getMintInfo as Mock<any>).mockResolvedValueOnce({
      nuts: { '29': { methods: ['bolt11'] } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockResolvedValueOnce([
      {
        quote: 'extra-quote',
        request: 'extra-request',
        amount: 10,
        unit: 'sat',
        expiry: null,
        state: 'PAID',
      },
    ]);

    await expect(quoteLifecycle.refreshMintQuoteById({ mintUrl, quoteId })).rejects.toThrow(
      `did not return a usable observation for ${quoteId}`,
    );
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId)).resolves.toMatchObject({
      state: 'UNPAID',
    });
  });

  it('batch-check polling deduplicates deterministically and respects the advertised limit', async () => {
    for (const id of ['quote-a', 'quote-b', 'quote-c']) {
      await quoteRepo.upsertMintQuote(
        mintQuoteFromBolt11Response(mintUrl, {
          quote: id,
          request: `request-${id}`,
          amount: Amount.from(10),
          unit: 'sat',
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'UNPAID',
        }),
      );
    }
    (mintService.getMintInfo as Mock<any>).mockResolvedValueOnce({
      nuts: {
        '4': { methods: [{ method: 'bolt11', unit: 'sat' }], disabled: false },
        '29': { max_batch_size: 2 },
      },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockResolvedValueOnce([
      {
        quote: 'quote-b',
        request: 'request-quote-b',
        amount: 10,
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      },
      {
        quote: 'quote-a',
        request: 'request-quote-a',
        amount: 10,
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      },
    ]);

    const result = await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [
      'quote-a',
      'quote-a',
      'quote-b',
      'quote-c',
    ]);

    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledWith(mintUrl, 'bolt11', [
      'quote-a',
      'quote-b',
    ]);
    expect(result.attemptedQuoteIds).toEqual(['quote-a', 'quote-b']);
    expect(result.observations.map((quote) => quote.quote)).toEqual(['quote-a', 'quote-b']);
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', 'quote-a')).resolves.toMatchObject({
      state: 'PAID',
    });
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', 'quote-c')).resolves.toMatchObject({
      state: 'UNPAID',
    });
  });

  it('batch-check polling persists attributable observations despite malformed, extra, and missing peers', async () => {
    for (const id of ['quote-a', 'quote-b', 'quote-c']) {
      await quoteRepo.upsertMintQuote(
        mintQuoteFromBolt11Response(mintUrl, {
          quote: id,
          request: `request-${id}`,
          amount: Amount.from(10),
          unit: 'sat',
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'UNPAID',
        }),
      );
    }
    (mintService.getMintInfo as Mock<any>).mockResolvedValueOnce({
      nuts: { '29': { methods: ['bolt11'] } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockResolvedValueOnce([
      {
        quote: 'quote-a',
        request: 'wrong-request',
        amount: 10,
        unit: 'sat',
        expiry: null,
        state: 'PAID',
      },
      { quote: 'identity-only-malformed-peer' },
      {
        quote: 'quote-b',
        request: 'request-quote-b',
        amount: 10,
        unit: 'sat',
        expiry: null,
        state: 'PAID',
      },
      {
        quote: 'extra-quote',
        request: 'extra-request',
        amount: 10,
        unit: 'sat',
        expiry: null,
        state: 'PAID',
      },
    ]);

    const result = await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [
      'quote-a',
      'quote-b',
      'quote-c',
    ]);

    expect(result.observations.map((quote) => quote.quote)).toEqual(['quote-b']);
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', 'quote-a')).resolves.toMatchObject({
      state: 'UNPAID',
    });
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', 'quote-b')).resolves.toMatchObject({
      state: 'PAID',
    });
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', 'quote-c')).resolves.toMatchObject({
      state: 'UNPAID',
    });
  });

  it('batch-check polling rejects conflicting duplicate observations for one quote', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: null,
        state: 'UNPAID',
      }),
    );
    (mintService.getMintInfo as Mock<any>).mockResolvedValueOnce({
      nuts: { '29': { methods: ['bolt11'] } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockResolvedValueOnce([
      {
        quote: quoteId,
        request: 'lnbc1test',
        amount: 10,
        unit: 'sat',
        expiry: null,
        state: 'PAID',
      },
      {
        quote: quoteId,
        request: 'lnbc1test',
        amount: 10,
        unit: 'sat',
        expiry: null,
        state: 'UNPAID',
      },
    ]);

    const result = await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [quoteId]);

    expect(result.observations).toEqual([]);
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId)).resolves.toMatchObject({
      state: 'UNPAID',
    });
  });

  it('batch-check polling rejects structurally invalid method responses', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: null,
        state: 'UNPAID',
      }),
    );
    (mintService.getMintInfo as Mock<any>).mockResolvedValueOnce({
      nuts: { '29': { methods: ['bolt11'] } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockResolvedValueOnce([
      {
        quote: quoteId,
        request: 'lnbc1test',
        amount: 10,
        unit: 'sat',
        expiry: null,
        state: 'UNKNOWN',
      },
    ]);

    const result = await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [quoteId]);

    expect(result.observations).toEqual([]);
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId)).resolves.toMatchObject({
      state: 'UNPAID',
    });
  });

  it('batch-check polling rejects method-specific immutable field conflicts', async () => {
    await persistOnchainQuote('onchain-conflict');
    await persistBolt12Quote('bolt12-conflict', { amount: Amount.from(12) });
    (mintService.getMintInfo as Mock<any>).mockResolvedValue({
      nuts: { '29': { methods: ['onchain', 'bolt12'] } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>)
      .mockResolvedValueOnce([
        {
          quote: 'onchain-conflict',
          request: 'bc1qtest',
          unit: 'sat',
          expiry: null,
          pubkey: 'different-pubkey',
          amount_paid: 10,
          amount_issued: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          quote: 'bolt12-conflict',
          request: 'lno1test',
          amount: 13,
          unit: 'sat',
          expiry: null,
          pubkey: '02'.padEnd(66, '2'),
          amount_paid: 20,
          amount_issued: 0,
        },
      ]);

    const onchain = await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'onchain', [
      'onchain-conflict',
    ]);
    const bolt12 = await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt12', [
      'bolt12-conflict',
    ]);

    expect(onchain.observations).toEqual([]);
    expect(bolt12.observations).toEqual([]);
  });

  it('batch-check polling lowers the effective limit after NUT-29 error 11017', async () => {
    const quoteIds = ['quote-a', 'quote-b', 'quote-c', 'quote-d'];
    for (const id of quoteIds) {
      await quoteRepo.upsertMintQuote(
        mintQuoteFromBolt11Response(mintUrl, {
          quote: id,
          request: `request-${id}`,
          amount: Amount.from(10),
          unit: 'sat',
          expiry: null,
          state: 'UNPAID',
        }),
      );
    }
    (mintService.getMintInfo as Mock<any>).mockResolvedValue({
      nuts: { '29': { methods: ['bolt11'], max_batch_size: 4 } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>)
      .mockRejectedValueOnce(new MintOperationError(11017, 'batch too large'))
      .mockImplementation(async (_mintUrl: string, _method: string, requested: string[]) =>
        requested.map((quote) => ({
          quote,
          request: `request-${quote}`,
          amount: 10,
          unit: 'sat',
          expiry: null,
          state: 'PAID',
        })),
      );

    const first = await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', quoteIds);
    const second = await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', quoteIds);

    expect(
      (mintAdapter.checkMintQuoteBatch as Mock<any>).mock.calls.map((call) => call[2]),
    ).toEqual([quoteIds, ['quote-a', 'quote-b'], ['quote-a', 'quote-b']]);
    expect(first.attemptedQuoteIds).toEqual(['quote-a', 'quote-b']);
    expect(second.attemptedQuoteIds).toEqual(['quote-a', 'quote-b']);
  });

  it('batch-check polling splits confirmed validation errors and isolates one bad quote', async () => {
    const quoteIds = ['quote-a', 'quote-bad', 'quote-c'];
    for (const id of quoteIds) {
      await quoteRepo.upsertMintQuote(
        mintQuoteFromBolt11Response(mintUrl, {
          quote: id,
          request: `request-${id}`,
          amount: Amount.from(10),
          unit: 'sat',
          expiry: null,
          state: 'UNPAID',
        }),
      );
    }
    (mintService.getMintInfo as Mock<any>).mockResolvedValue({
      nuts: { '29': { methods: ['bolt11'] } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockImplementation(
      async (_mintUrl: string, _method: string, requested: string[]) => {
        if (requested.includes('quote-bad')) {
          throw new QuoteSpecificMintOperationError(10000, 'unknown quote', 'quote-bad');
        }
        return requested.map((quote) => ({
          quote,
          request: `request-${quote}`,
          amount: 10,
          unit: 'sat',
          expiry: null,
          state: 'PAID',
        }));
      },
    );

    const result = await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', quoteIds);

    expect(result.attemptedQuoteIds).toEqual(quoteIds);
    expect(result.observations.map((quote) => quote.quote)).toEqual(['quote-a', 'quote-c']);
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', 'quote-bad')).resolves.toMatchObject({
      state: 'UNPAID',
    });
  });

  it('does not split an unconfirmed whole-request protocol rejection', async () => {
    for (const id of ['quote-a', 'quote-b']) {
      await quoteRepo.upsertMintQuote(
        mintQuoteFromBolt11Response(mintUrl, {
          quote: id,
          request: `request-${id}`,
          amount: Amount.from(10),
          unit: 'sat',
          expiry: null,
          state: 'UNPAID',
        }),
      );
    }
    (mintService.getMintInfo as Mock<any>).mockResolvedValue({
      nuts: { '29': { methods: ['bolt11'] } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockRejectedValue(
      new MintOperationError(30000, 'authentication required'),
    );

    await expect(
      quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', ['quote-a', 'quote-b']),
    ).rejects.toThrow('authentication required');
    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledTimes(1);
  });

  it('surfaces an isolated quote protocol error to its explicit caller', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: null,
        state: 'UNPAID',
      }),
    );
    (mintService.getMintInfo as Mock<any>).mockResolvedValue({
      nuts: { '29': { methods: ['bolt11'] } },
    });
    const rejection = new QuoteSpecificMintOperationError(10000, 'unknown quote', quoteId);
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockRejectedValue(rejection);

    await expect(quoteLifecycle.refreshMintQuoteById({ mintUrl, quoteId })).rejects.toBe(rejection);
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId)).resolves.toMatchObject({
      state: 'UNPAID',
    });
  });

  it('batch-check polling retries transient transport failures without changing canonical state', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: null,
        state: 'UNPAID',
      }),
    );
    (mintService.getMintInfo as Mock<any>).mockResolvedValueOnce({
      nuts: { '29': { methods: ['bolt11'] } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockRejectedValue(
      new NetworkError('connection lost'),
    );

    await expect(
      quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [quoteId]),
    ).rejects.toThrow('connection lost');

    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledTimes(3);
    await expect(quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId)).resolves.toMatchObject({
      state: 'UNPAID',
    });
  });

  it('batch-check polling falls back to single checks after endpoint incompatibility', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: null,
        state: 'UNPAID',
      }),
    );
    (mintService.getMintInfo as Mock<any>).mockResolvedValue({
      nuts: { '29': { methods: ['bolt11'] } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>).mockRejectedValueOnce(
      new HttpResponseError('not found', 404),
    );
    (mintAdapter.checkMintQuote as Mock<any>).mockResolvedValue({
      quote: quoteId,
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: null,
      state: 'PAID',
    });

    await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [quoteId]);
    await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [quoteId]);

    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledTimes(1);
    expect(mintAdapter.checkMintQuote).toHaveBeenCalledTimes(2);
  });

  it('retries an incompatible endpoint only after mint capability refresh', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: null,
        state: 'UNPAID',
      }),
    );
    (mintService.getMintInfo as Mock<any>).mockResolvedValue({
      nuts: { '29': { methods: ['bolt11'] } },
    });
    (mintAdapter.checkMintQuoteBatch as Mock<any>)
      .mockRejectedValueOnce(new HttpResponseError('not found', 404))
      .mockResolvedValueOnce([
        {
          quote: quoteId,
          request: 'lnbc1test',
          amount: 10,
          unit: 'sat',
          expiry: null,
          state: 'PAID',
        },
      ]);
    (mintAdapter.checkMintQuote as Mock<any>).mockResolvedValue({
      quote: quoteId,
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: null,
      state: 'PAID',
    });

    await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [quoteId]);
    await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [quoteId]);
    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledTimes(1);

    await eventBus.emit('mint:updated', {
      mint: {
        mintUrl,
        name: 'Mint',
        mintInfo: {
          name: 'Mint',
          pubkey: 'mint-pubkey',
          version: 'test',
          contact: [],
          nuts: {
            '4': { methods: [], disabled: false },
            '5': { methods: [], disabled: false },
            '29': { methods: ['bolt11'] },
          },
        },
        trusted: true,
        createdAt: 0,
        updatedAt: 1,
      },
      keysets: [],
    });
    await quoteLifecycle.checkMintQuotesForPolling(mintUrl, 'bolt11', [quoteId]);

    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledTimes(2);
  });
  it('refreshMintQuote keeps the method-aware exact refresh path for internal callers', async () => {
    await persistQuote('quote-exact-refresh');

    const refreshed = await quoteLifecycle.refreshMintQuote(
      mintUrl,
      'bolt11',
      'quote-exact-refresh',
    );

    expect(handlerProvider.get).toHaveBeenCalledWith('bolt11');
    expect(handler.fetchRemoteQuote).toHaveBeenCalled();
    expect(refreshed.quoteId).toBe('quote-exact-refresh');
  });

  it('refreshMintQuote persists the canonical quote before emitting mint-quote:updated', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'UNPAID',
      }),
    );
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

    const refreshed = await quoteLifecycle.refreshMintQuoteById({ mintUrl, quoteId });

    expect(handler.fetchRemoteQuote).toHaveBeenCalled();
    expect(refreshed.state).toBe('PAID');
    expect(refreshed.request).toBe('lnbc1paid');
    expect(persistedDuringEvent).toEqual(['PAID']);
  });

  it('refreshMintQuote updates reusable onchain quote data before emitting', async () => {
    const pubkey = '02'.padEnd(66, '1');
    const onchainQuoteId = 'onchain-quote-1';
    await quoteRepo.upsertMintQuote(
      mintQuoteFromOnchainResponse(mintUrl, {
        quote: onchainQuoteId,
        request: 'bc1qold',
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        pubkey,
        amount_paid: Amount.from(0),
        amount_issued: Amount.from(0),
      }),
    );

    const onchainHandler = {
      ...handler,
      fetchRemoteQuote: mock(async ({ quote }) =>
        mintQuoteFromOnchainResponse(quote.mintUrl, {
          quote: quote.quoteId,
          request: 'bc1qold',
          unit: 'sat',
          expiry: quote.expiry,
          pubkey,
          amount_paid: Amount.from(21),
          amount_issued: Amount.from(8),
        }),
      ),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementationOnce(() => onchainHandler);

    const persistedDuringEvent: Array<string> = [];
    eventBus.on('mint-quote:updated', async ({ quote }) => {
      const storedQuote = await quoteRepo.getMintQuote(quote.mintUrl, quote.method, quote.quoteId);
      if (storedQuote?.method === 'onchain') {
        persistedDuringEvent.push(storedQuote.quoteData.amountPaid.toString());
      }
    });

    const refreshed = await quoteLifecycle.refreshMintQuoteById({
      mintUrl,
      quoteId: onchainQuoteId,
    });

    expect(handlerProvider.get).toHaveBeenCalledWith('onchain');
    expect(onchainHandler.fetchRemoteQuote).toHaveBeenCalled();
    expect(refreshed.method).toBe('onchain');
    if (refreshed.method !== 'onchain') throw new Error('Expected onchain quote');
    expect(refreshed.quoteData.amountPaid.equals(Amount.from(21))).toBe(true);
    expect(refreshed.quoteData.amountIssued.equals(Amount.from(8))).toBe(true);
    expect(getMintQuoteAvailableAmount(refreshed).equals(Amount.from(13))).toBe(true);
    expect(persistedDuringEvent).toEqual(['21']);
  });

  it('prepare fails before creating an operation when the quote is missing', async () => {
    await expect(
      service.prepare({ mintUrl, method: 'bolt11', quoteId: 'missing-quote' }, Amount.from(10)),
    ).rejects.toThrow('was not found');

    await expect(operationRepo.getAll()).resolves.toHaveLength(0);
    expect(handler.prepare).not.toHaveBeenCalled();
  });

  it('prepare rejects quote refs whose method differs from canonical storage', async () => {
    await persistQuote('quote-method-conflict');

    await expect(
      service.prepare(
        { mintUrl, method: 'onchain', quoteId: 'quote-method-conflict' },
        Amount.from(10),
      ),
    ).rejects.toThrow(QuoteIdentityConflictError);

    await expect(operationRepo.getAll()).resolves.toHaveLength(0);
    expect(handler.prepare).not.toHaveBeenCalled();
  });

  it('prepare fails before creating an operation when the quote is terminal', async () => {
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
      service.prepare({ mintUrl, method: 'bolt11', quoteId: 'issued-quote' }, Amount.from(10)),
    ).rejects.toThrow('quote is terminal');

    await expect(operationRepo.getAll()).resolves.toHaveLength(0);
    expect(handler.prepare).not.toHaveBeenCalled();
  });

  it('prepare rejects duplicate operations for non-reusable quotes', async () => {
    const quote = await quoteLifecycle.createMintQuote(mintUrl, {
      amount: Amount.from(10),
      unit: 'sat',
    });

    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({ operation }: { operation: InitMintOperation }) => ({
        ...makePendingOp(operation.id),
        quoteId: quote.quoteId,
        request: quote.request,
      }),
    );

    const first = await service.prepare(quote, Amount.from(10));

    await expect(service.prepare(quote, Amount.from(10))).rejects.toThrow(
      `Mint quote ${quote.quoteId} is already tracked by operation ${first.id} in state pending`,
    );

    const operations = await operationRepo.getByQuoteId(mintUrl, 'bolt11', quote.quoteId);
    expect(operations).toHaveLength(1);
    expect(handler.prepare).toHaveBeenCalledTimes(1);
  });

  it('prepare can redeem a quote imported through QuoteLifecycle', async () => {
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
      }),
    );

    const imported = await quoteLifecycle.importMintQuote(mintUrl, 'bolt11', importedQuote);
    const pending = await service.prepare(imported, Amount.from(12));

    expect(pending.state).toBe('pending');
    expect(pending.quoteId).toBe(importedQuote.quote);
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.operationId).toBe(pending.id);
    const importedOperation = pendingEvents[0]?.operation as PendingMintOperation | undefined;
    expect(importedOperation?.quoteId).toBe(importedQuote.quote);
    expect(importedOperation?.request).toBe(importedQuote.request);
  });

  it('prepare uses the persisted canonical quote state after stale import attempts', async () => {
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
      }),
    );

    await quoteLifecycle.importMintQuote(mintUrl, 'bolt11', staleQuote);
    const pending = await service.prepare(
      { mintUrl, method: 'bolt11', quoteId: staleQuote.quote },
      Amount.from(12),
    );
    const storedQuote = await quoteRepo.getMintQuote(mintUrl, 'bolt11', staleQuote.quote);

    expect(pending.quoteId).toBe(staleQuote.quote);
    expect(storedQuote?.state).toBe('PAID');
  });

  it('quote import delegates unsupported quote units to capability validation', async () => {
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

    await expect(quoteLifecycle.importMintQuote(mintUrl, 'bolt11', importedQuote)).rejects.toThrow(
      'does not advertise NUT-04 support for bolt11/usd',
    );

    await expect(
      quoteRepo.getMintQuote(mintUrl, 'bolt11', importedQuote.quote),
    ).resolves.toBeNull();
    expect(handler.prepare).not.toHaveBeenCalled();
  });

  it('prepare + finalize runs pending -> execute for an existing canonical quote', async () => {
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    const executingEvents: Array<CoreEvents['mint-op:executing']> = [];
    const finalizedEvents: Array<CoreEvents['mint-op:finalized']> = [];
    const failedEvents: Array<CoreEvents['mint-op:failed']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });
    eventBus.on('mint-op:finalized', (event) => {
      finalizedEvents.push(event);
    });
    eventBus.on('mint-op:executing', (event) => {
      executingEvents.push(event);
    });
    eventBus.on('mint-op:failed', (event) => {
      failedEvents.push(event);
    });

    await persistQuote();

    const pending = await service.prepare({ mintUrl, method: 'bolt11', quoteId }, Amount.from(10));
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
    expect(executingEvents).toHaveLength(1);
    expect(executingEvents[0]?.operation).not.toHaveProperty('outputData');
    expect(executingEvents[0]?.operation).not.toHaveProperty('attemptId');
    expect(finalizedEvents.length).toBe(1);
    expect(finalizedEvents[0]?.operationId).toBe(finalized?.id);
    expect(finalizedEvents[0]?.operation.state).toBe('finalized');
    expect(finalizedEvents[0]?.operation).not.toHaveProperty('outputData');
    expect(finalizedEvents[0]?.operation).not.toHaveProperty('attemptId');
    expect(failedEvents).toHaveLength(0);
  });

  it('finalize is idempotent after finalize', async () => {
    await persistQuote();

    const pending = await service.prepare({ mintUrl, method: 'bolt11', quoteId }, Amount.from(10));
    const first = await service.finalize(pending.id);
    const second = await service.finalize(first.id);

    expect(first?.state).toBe('finalized');
    expect(second?.id).toBe(first?.id);

    const ops = await operationRepo.getByQuoteId(mintUrl, 'bolt11', quoteId);
    expect(ops.length).toBe(1);
  });

  it('finalize leaves underfunded reusable onchain operations pending', async () => {
    const onchainQuoteId = 'onchain-quote-underfunded';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(4), issued: Amount.zero() });
    const pendingOp: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-underfunded'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(10),
    };
    await operationRepo.create(pendingOp);

    const result = await service.finalize(pendingOp.id);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(result.state).toBe('pending');
    expect(stored?.state).toBe('pending');
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it('finalize executes funded reusable onchain withdrawals without refreshing quote issuance', async () => {
    const onchainQuoteId = 'onchain-quote-funded';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.zero() });
    const pendingOp: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-funded'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(5),
      pubkey: '02'.padEnd(66, '1'),
    };
    await operationRepo.create(pendingOp);

    const onchainHandler = {
      ...handler,
      execute: mock(
        async (): Promise<MintExecutionResult> => ({
          status: 'ISSUED',
          proofs: [makeProof('out-1')],
        }),
      ),
      fetchRemoteQuote: mock(async ({ quote }) =>
        mintQuoteFromOnchainResponse(quote.mintUrl, {
          quote: quote.quoteId,
          request: quote.request,
          unit: quote.unit,
          expiry: quote.expiry,
          pubkey: quote.quoteData.pubkey,
          amount_paid: Amount.from(10),
          amount_issued: Amount.from(5),
        }),
      ),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => onchainHandler);

    const result = await service.finalize(pendingOp.id);
    const stored = await operationRepo.getById(pendingOp.id);
    const quote = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(result.state).toBe('finalized');
    expect(stored?.state).toBe('finalized');
    expect(onchainHandler.execute).toHaveBeenCalled();
    expect(onchainHandler.fetchRemoteQuote).not.toHaveBeenCalled();
    expect(quote?.method).toBe('onchain');
    if (quote?.method !== 'onchain') throw new Error('Expected onchain quote');
    expect(quote.quoteData.amountIssued.equals(Amount.zero())).toBe(true);
  });

  it('finalize subtracts executing reusable onchain siblings from claimable balance', async () => {
    const onchainQuoteId = 'onchain-quote-reserved';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.zero() });
    await operationRepo.create({
      ...makeExecutingOp('onchain-executing-sibling'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(7),
      pubkey: '02'.padEnd(66, '1'),
    });
    const pendingOp: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-reserved-pending'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(5),
      pubkey: '02'.padEnd(66, '1'),
    };
    await operationRepo.create(pendingOp);

    const result = await service.finalize(pendingOp.id);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(result.state).toBe('pending');
    expect(stored?.state).toBe('pending');
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it('finalize treats finalized reusable onchain siblings as issued when quote data is stale', async () => {
    const onchainQuoteId = 'onchain-quote-local-issued';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.zero() });
    const finalized: FinalizedMintOperation<'onchain'> = {
      ...makeExecutingOp('onchain-local-issued-finalized'),
      method: 'onchain',
      state: 'finalized',
      quoteId: onchainQuoteId,
      amount: Amount.from(7),
      pubkey: '02'.padEnd(66, '1'),
    };
    await operationRepo.create(finalized);
    const pendingOp: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-local-issued-pending'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(5),
      pubkey: '02'.padEnd(66, '1'),
    };
    await operationRepo.create(pendingOp);

    const onchainHandler = {
      ...handler,
      execute: mock(
        async (): Promise<MintExecutionResult> => ({
          status: 'ISSUED',
          proofs: [makeProof('out-1')],
        }),
      ),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation((method: string) =>
      method === 'onchain' ? onchainHandler : handler,
    );

    const result = await service.finalize(pendingOp.id);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(result.state).toBe('pending');
    expect(stored?.state).toBe('pending');
    expect(onchainHandler.execute).not.toHaveBeenCalled();
  });

  it('claimMintQuote executes the ordered funded prefix of reusable onchain siblings', async () => {
    const onchainQuoteId = 'onchain-quote-prefix';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.zero() });
    const first: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-prefix-a'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(7),
      pubkey: '02'.padEnd(66, '1'),
      createdAt: 1,
    };
    const second: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-prefix-b'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(5),
      pubkey: '02'.padEnd(66, '1'),
      createdAt: 2,
    };
    await operationRepo.create(first);
    await operationRepo.create(second);

    const onchainHandler = {
      ...handler,
      execute: mock(
        async ({ operation }: any): Promise<MintExecutionResult> => ({
          status: 'ISSUED',
          proofs: [makeProof(operation.id)],
        }),
      ),
      fetchRemoteQuote: mock(async ({ quote }) =>
        mintQuoteFromOnchainResponse(quote.mintUrl, {
          quote: quote.quoteId,
          request: quote.request,
          unit: quote.unit,
          expiry: quote.expiry,
          pubkey: quote.quoteData.pubkey,
          amount_paid: Amount.from(10),
          amount_issued: Amount.from(7),
        }),
      ),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => onchainHandler);

    const claimed = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId, {
      autoClaimRemaining: false,
    });
    const storedFirst = await operationRepo.getById(first.id);
    const storedSecond = await operationRepo.getById(second.id);

    expect(claimed.map((operation) => operation.id)).toEqual([first.id]);
    expect(storedFirst?.state).toBe('finalized');
    expect(storedSecond?.state).toBe('pending');
  });

  it('claimMintQuote ignores duplicate unchanged reusable quote snapshots', async () => {
    const onchainQuoteId = 'onchain-quote-duplicate';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.zero() });
    const first: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-duplicate-a'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(7),
      pubkey: '02'.padEnd(66, '1'),
      createdAt: 1,
    };
    const second: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-duplicate-b'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(5),
      pubkey: '02'.padEnd(66, '1'),
      createdAt: 2,
    };
    await operationRepo.create(first);
    await operationRepo.create(second);

    const onchainHandler = {
      ...handler,
      execute: mock(
        async ({ operation }: any): Promise<MintExecutionResult> => ({
          status: 'ISSUED',
          proofs: [makeProof(operation.id)],
        }),
      ),
      fetchRemoteQuote: mock(async ({ quote }) =>
        mintQuoteFromOnchainResponse(quote.mintUrl, {
          quote: quote.quoteId,
          request: quote.request,
          unit: quote.unit,
          expiry: quote.expiry,
          pubkey: quote.quoteData.pubkey,
          amount_paid: Amount.from(10),
          amount_issued: Amount.from(7),
        }),
      ),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => onchainHandler);

    const firstClaim = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId, {
      autoClaimRemaining: false,
    });
    const secondClaim = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId, {
      autoClaimRemaining: false,
    });
    const storedSecond = await operationRepo.getById(second.id);

    expect(firstClaim.map((operation) => operation.id)).toEqual([first.id]);
    expect(secondClaim).toEqual([]);
    expect(onchainHandler.execute).toHaveBeenCalledTimes(1);
    expect(storedSecond?.state).toBe('pending');
  });

  it('claimMintQuote supports multiple partial withdrawals from one reusable quote', async () => {
    const onchainQuoteId = 'onchain-quote-partials';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.zero() });
    const first: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-partial-a'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(7),
      pubkey: '02'.padEnd(66, '1'),
      createdAt: 1,
    };
    const second: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-partial-b'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(5),
      pubkey: '02'.padEnd(66, '1'),
      createdAt: 2,
    };
    await operationRepo.create(first);
    await operationRepo.create(second);

    const issuedSnapshots = [Amount.from(7), Amount.from(12)];
    const paidSnapshots = [Amount.from(10), Amount.from(12)];
    const onchainHandler = {
      ...handler,
      execute: mock(
        async ({ operation }: any): Promise<MintExecutionResult> => ({
          status: 'ISSUED',
          proofs: [makeProof(operation.id)],
        }),
      ),
      fetchRemoteQuote: mock(async ({ quote }) => {
        const issued = issuedSnapshots.shift() ?? Amount.from(12);
        const paid = paidSnapshots.shift() ?? Amount.from(12);
        return mintQuoteFromOnchainResponse(quote.mintUrl, {
          quote: quote.quoteId,
          request: quote.request,
          unit: quote.unit,
          expiry: quote.expiry,
          pubkey: quote.quoteData.pubkey,
          amount_paid: paid,
          amount_issued: issued,
        });
      }),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => onchainHandler);

    const firstClaim = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId, {
      autoClaimRemaining: false,
    });
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(12), issued: Amount.from(7) });
    const secondClaim = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId, {
      autoClaimRemaining: false,
    });

    expect(firstClaim.map((operation) => operation.id)).toEqual([first.id]);
    expect(secondClaim.map((operation) => operation.id)).toEqual([second.id]);
    expect((await operationRepo.getById(first.id))?.state).toBe('finalized');
    expect((await operationRepo.getById(second.id))?.state).toBe('finalized');
  });

  it('claimMintQuote creates one auto-claim operation when a reusable quote has no pending siblings', async () => {
    const onchainQuoteId = 'onchain-quote-auto-empty';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.zero() });
    const { executedAmounts } = useAutoClaimOnchainHandler(Amount.from(10));

    const claimed = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const operations = await operationRepo.getByQuoteId(mintUrl, 'onchain', onchainQuoteId);

    expect(claimed).toHaveLength(1);
    expect(executedAmounts).toEqual(['10']);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.state).toBe('finalized');
    expect(operations[0]?.amount.equals(Amount.from(10))).toBe(true);
  });

  it('claimMintQuote keeps a reusable no-expiry sentinel quote claimable', async () => {
    const onchainQuoteId = 'onchain-quote-no-expiry';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.zero(),
      expiry: 0,
    });
    useAutoClaimOnchainHandler(Amount.from(10));

    const hasClaimableBalance = await service.hasLocallyClaimableMintQuoteBalance(
      mintUrl,
      'onchain',
      onchainQuoteId,
    );
    const claimed = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(hasClaimableBalance).toBe(true);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.state).toBe('finalized');
  });

  it('claimMintQuote treats expired reusable onchain quotes as unclaimable', async () => {
    const onchainQuoteId = 'onchain-quote-expired';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.zero(),
      expiry: Math.floor(Date.now() / 1000) - 1,
    });
    const { onchainHandler } = useAutoClaimOnchainHandler(Amount.from(10));

    const hasClaimableBalance = await service.hasLocallyClaimableMintQuoteBalance(
      mintUrl,
      'onchain',
      onchainQuoteId,
    );
    const claimed = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const operations = await operationRepo.getByQuoteId(mintUrl, 'onchain', onchainQuoteId);

    expect(hasClaimableBalance).toBe(false);
    expect(claimed).toEqual([]);
    expect(operations).toEqual([]);
    expect(onchainHandler.execute).not.toHaveBeenCalled();
  });

  it('claimMintQuote auto-claims the remaining reusable quote balance after pending siblings', async () => {
    const onchainQuoteId = 'onchain-quote-auto-remainder';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.zero() });
    const pending: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-auto-existing', 'onchain-auto-existing'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(7),
      pubkey: '02'.padEnd(66, '1'),
      createdAt: 1,
      outputData: makeSerializedOutputData('onchain-auto-existing', Amount.from(7)),
    };
    await operationRepo.create(pending);
    const { executedAmounts } = useAutoClaimOnchainHandler(Amount.from(10));

    const claimed = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const operations = await operationRepo.getByQuoteId(mintUrl, 'onchain', onchainQuoteId);

    expect(claimed).toHaveLength(2);
    expect(executedAmounts).toEqual(['7', '3']);
    expect(operations).toHaveLength(2);
    expect(operations.every((operation) => operation.state === 'finalized')).toBe(true);
    expect(
      operations
        .map((operation) => operation.amount.toString())
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual(['3', '7']);
  });

  it('recoverExecutingOperation finalizes one reusable quote sibling without touching another', async () => {
    const onchainQuoteId = 'onchain-quote-recover-sibling';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.from(10) });
    const executing: ExecutingMintOperation<'onchain'> = {
      ...makeExecutingOp('onchain-recover-executing'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      pubkey: '02'.padEnd(66, '1'),
    };
    const pending: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-recover-pending'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      pubkey: '02'.padEnd(66, '1'),
    };
    await operationRepo.create(executing);
    await operationRepo.create(pending);

    const onchainHandler = {
      ...handler,
      recoverExecuting: mock(
        async (): Promise<RecoverExecutingResult> => ({ status: 'FINALIZED' }),
      ),
      fetchRemoteQuote: mock(async ({ quote }) =>
        mintQuoteFromOnchainResponse(quote.mintUrl, {
          quote: quote.quoteId,
          request: quote.request,
          unit: quote.unit,
          expiry: quote.expiry,
          pubkey: quote.quoteData.pubkey,
          amount_paid: Amount.from(10),
          amount_issued: Amount.from(10),
        }),
      ),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => onchainHandler);

    await service.recoverExecutingOperation(executing);

    expect((await operationRepo.getById(executing.id))?.state).toBe('finalized');
    expect((await operationRepo.getById(pending.id))?.state).toBe('pending');
  });

  it('recoverExecutingOperation finalizes recovered reusable outputs without quote refresh', async () => {
    const onchainQuoteId = 'onchain-quote-recover-offline';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.zero() });
    const executing: ExecutingMintOperation<'onchain'> = {
      ...makeExecutingOp('onchain-recover-offline'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      pubkey: '02'.padEnd(66, '1'),
    };
    await operationRepo.create(executing);

    const onchainHandler = {
      ...handler,
      recoverExecuting: mock(
        async (): Promise<RecoverExecutingResult> => ({ status: 'FINALIZED' }),
      ),
      fetchRemoteQuote: mock(async () => {
        throw new Error('mint offline');
      }),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation(() => onchainHandler);

    await service.recoverExecutingOperation(executing);

    expect((await operationRepo.getById(executing.id))?.state).toBe('finalized');
    expect(onchainHandler.fetchRemoteQuote).not.toHaveBeenCalled();
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

  it('recoverExecutingOperation fails terminally when issued proofs are not recoverable', async () => {
    const op = makeExecutingOp('exec-3');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({ status: 'FINALIZED' });
    (proofService.recoverProofsFromOutputData as Mock<any>).mockResolvedValueOnce([]);

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);
    expect(stored?.state).toBe('failed');
    expect(stored?.terminalFailure?.reason).toBe(
      `Recovered issued quote ${op.quoteId} but no proofs could be restored`,
    );
  });

  it('recoverExecutingOperation finalizes expired quotes as terminal failures', async () => {
    const op = makeExecutingOp('exec-expired');
    const finalizedEvents: Array<CoreEvents['mint-op:finalized']> = [];
    const failedEvents: Array<CoreEvents['mint-op:failed']> = [];
    await operationRepo.create(op);
    eventBus.on('mint-op:finalized', (event) => {
      finalizedEvents.push(event);
    });
    eventBus.on('mint-op:failed', (event) => {
      failedEvents.push(event);
    });

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({
      status: 'TERMINAL',
      error: `Recovered: quote ${quoteId} expired while executing mint`,
    });

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);

    expect(stored?.state).toBe('failed');
    expect(stored?.error).toBe(`Recovered: quote ${quoteId} expired while executing mint`);
    expect(finalizedEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.operationId).toBe(op.id);
    expect(failedEvents[0]?.operation.state).toBe('failed');
    expect(failedEvents[0]?.operation.terminalFailure?.reason).toBe(
      `Recovered: quote ${quoteId} expired while executing mint`,
    );
    expect(failedEvents[0]?.operation).not.toHaveProperty('outputData');
    expect(failedEvents[0]?.operation).not.toHaveProperty('attemptId');
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

  it('execute fails terminally when already issued proofs cannot be restored', async () => {
    const pendingOp = makePendingOp('pending-2');
    await operationRepo.create(pendingOp);

    (handler.execute as Mock<any>).mockResolvedValueOnce({ status: 'ALREADY_ISSUED' });
    (proofService.recoverProofsFromOutputData as Mock<any>).mockResolvedValueOnce([]);

    const failed = await service.execute(pendingOp.id);

    const stored = await operationRepo.getById(pendingOp.id);

    expect(failed.state).toBe('failed');
    expect(failed.error).toBe(
      `Recovered issued quote ${pendingOp.quoteId} but no proofs could be restored`,
    );
    expect(stored?.state).toBe('failed');
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
  });

  it('checkPendingOperation emits mint-op:failed for terminal pending failures', async () => {
    const pendingOp = makePendingOp('pending-terminal');
    const observedAt = Date.now();
    const finalizedEvents: Array<CoreEvents['mint-op:finalized']> = [];
    const failedEvents: Array<CoreEvents['mint-op:failed']> = [];

    await operationRepo.create(pendingOp);
    eventBus.on('mint-op:finalized', (event) => {
      finalizedEvents.push(event);
    });
    eventBus.on('mint-op:failed', (event) => {
      failedEvents.push(event);
    });

    (handler.checkPending as Mock<any>).mockResolvedValueOnce({
      observedRemoteState: 'UNPAID',
      observedRemoteStateAt: observedAt,
      category: 'terminal',
      terminalFailure: {
        reason: 'Quote expired before issuance',
        code: 'quote_expired',
        retryable: false,
        observedAt,
      },
    });

    const result = await service.checkPendingOperation(pendingOp.id);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(result.category).toBe('terminal');
    expect(stored?.state).toBe('failed');
    expect(stored?.error).toBe('Quote expired before issuance');
    expect(stored?.terminalFailure).toMatchObject({
      reason: 'Quote expired before issuance',
      code: 'quote_expired',
      retryable: false,
      observedAt,
    });
    expect(finalizedEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.operationId).toBe(pendingOp.id);
    expect(failedEvents[0]?.operation.state).toBe('failed');
    expect(failedEvents[0]?.operation.terminalFailure?.reason).toBe(
      'Quote expired before issuance',
    );
  });

  it('checkPendingOperation records onchain quote snapshots without protocol state', async () => {
    const onchainQuoteId = 'onchain-quote-pending-check';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.zero(), issued: Amount.zero() });
    const pendingOp: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-pending-check'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      pubkey: '02'.padEnd(66, '1'),
    };
    await operationRepo.create(pendingOp);

    const onchainHandler = {
      ...handler,
      checkPending: mock(
        async (): Promise<PendingMintCheckResult<'onchain'>> => ({
          observedRemoteStateAt: Date.now(),
          quoteSnapshot: {
            quote: onchainQuoteId,
            request: 'bc1qtest',
            unit: 'sat',
            expiry: Math.floor(Date.now() / 1000) + 3600,
            pubkey: '02'.padEnd(66, '1'),
            amount_paid: Amount.from(7),
            amount_issued: Amount.zero(),
          },
          category: 'waiting',
        }),
      ),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation((method: string) =>
      method === 'onchain' ? onchainHandler : handler,
    );

    await service.checkPendingOperation(pendingOp.id);

    const stored = await operationRepo.getById(pendingOp.id);
    const quote = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(stored?.state).toBe('pending');
    expect(quote?.method).toBe('onchain');
    if (quote?.method !== 'onchain') throw new Error('Expected onchain quote');
    expect(quote.quoteData.amountPaid.equals(Amount.from(7))).toBe(true);
  });

  it('checkPendingOperation preserves monotonic onchain quote counters', async () => {
    const onchainQuoteId = 'onchain-quote-stale-check';
    await persistOnchainQuote(onchainQuoteId, { paid: Amount.from(10), issued: Amount.from(8) });
    const pendingOp: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-stale-check'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      pubkey: '02'.padEnd(66, '1'),
    };
    await operationRepo.create(pendingOp);

    const onchainHandler = {
      ...handler,
      checkPending: mock(
        async (): Promise<PendingMintCheckResult<'onchain'>> => ({
          observedRemoteStateAt: Date.now(),
          quoteSnapshot: {
            quote: onchainQuoteId,
            request: 'bc1qtest',
            unit: 'sat',
            expiry: Math.floor(Date.now() / 1000) + 3600,
            pubkey: '02'.padEnd(66, '1'),
            amount_paid: Amount.from(7),
            amount_issued: Amount.from(5),
          },
          category: 'waiting',
        }),
      ),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation((method: string) =>
      method === 'onchain' ? onchainHandler : handler,
    );

    await service.checkPendingOperation(pendingOp.id);

    const quote = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(quote?.method).toBe('onchain');
    if (quote?.method !== 'onchain') throw new Error('Expected onchain quote');
    expect(quote.quoteData.amountPaid.equals(Amount.from(10))).toBe(true);
    expect(quote.quoteData.amountIssued.equals(Amount.from(8))).toBe(true);
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

    const quote = await quoteLifecycle.recordMintQuoteObservation(pendingOp, 'PAID', observedAt);

    expect(quote.state).toBe('PAID');
    expect(persistedDuringEvent).toEqual(['PAID']);
  });

  it('does not mirror canonical quote updates into pending operations', async () => {
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
    expect(pendingEvents).toHaveLength(0);
    expect(handler.checkPending).not.toHaveBeenCalled();
  });
});
