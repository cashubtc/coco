import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import {
  OutputData,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
  type Proof,
} from '@cashu/cashu-ts';
import { MintOpsApi } from '../../api/MintOpsApi';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import { MintOperationService } from '../../operations/mint/MintOperationService';
import type {
  ExecutingMintOperation,
  FailedMintOperation,
  FinalizedMintOperation,
  InitMintOperation,
  PendingMintOperation,
} from '../../operations/mint/MintOperation';
import type {
  MintExecutionResult,
  MintMethodHandler,
  MintMethodQuoteImportSnapshot,
  MintMethodQuoteSnapshot,
  PendingMintObservationResult,
  RecoverExecutingResult,
} from '../../operations/mint/MintMethodHandler';
import type { MintHandlerProvider } from '../../infra/handlers/mint';
import { MemoryMintOperationRepository } from '../../repositories/memory/MemoryMintOperationRepository';
import { MemoryMintQuoteRepository } from '../../repositories/memory/MemoryMintQuoteRepository';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository';
import { getMintQuoteAvailableAmount } from '../../models/MintQuote';
import { mintQuoteObservationFromOnchainResponse } from '../../models/MintQuoteObservationFactory';
import {
  cashuNormalizedBolt11Fixture,
  cashuNormalizedOnchainFixture,
  mintQuoteFromBolt11Fixture as mintQuoteFromBolt11Response,
  mintQuoteFromBolt12Fixture as mintQuoteFromBolt12Response,
  mintQuoteFromOnchainFixture as mintQuoteFromOnchainResponse,
} from '../normalizedMintQuoteFixtures.ts';
import { QuoteLifecycle } from '../../quotes/QuoteLifecycle';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { Logger } from '../../logging/Logger';
import { serializeOutputData } from '../../utils';
import type { CoreProof } from '../../types';
import { MintQuoteValidationError, QuoteIdentityConflictError } from '../../models/Error';

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
  let logger: Logger;
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

  const persistQuote = async (
    quote = quoteId,
    expiry = Math.floor(Date.now() / 1000) + 3600,
  ): Promise<void> => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'PAID',
      }),
    );
  };

  const persistOnchainQuote = async (
    quote = 'onchain-quote-1',
    amounts: {
      paid?: Amount;
      issued?: Amount;
      expiry?: number | null;
      remoteUpdatedAt?: number | null;
    } = {},
  ): Promise<void> => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromOnchainResponse(mintUrl, {
        quote,
        request: 'bc1qtest',
        unit: 'sat',
        expiry:
          amounts.expiry === undefined ? Math.floor(Date.now() / 1000) + 3600 : amounts.expiry,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: amounts.paid ?? Amount.zero(),
        amount_issued: amounts.issued ?? Amount.zero(),
        updated_at: amounts.remoteUpdatedAt ?? null,
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
      method: 'bolt12',
      amount: amounts.amount ?? null,
      unit: 'sat',
      expiry: amounts.expiry ?? Math.floor(Date.now() / 1000) + 3600,
      pubkey: '02'.padEnd(66, '2'),
      amount_paid: amounts.paid ?? Amount.zero(),
      amount_issued: amounts.issued ?? Amount.zero(),
      updated_at: null,
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

  const usePendingOnchainHandler = (quoteSnapshot: MintMethodQuoteSnapshot<'onchain'>) => {
    const checkPending = mock(
      async (): Promise<PendingMintObservationResult<'onchain'>> => ({
        observedAt: Date.now(),
        quoteSnapshot,
      }),
    );
    const onchainHandler = {
      ...handler,
      checkPending,
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementation((method: string) =>
      method === 'onchain' ? onchainHandler : handler,
    );
    return checkPending;
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
    logger = {
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
      debug: mock(() => {}),
    };

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
      async (): Promise<PendingMintObservationResult<'bolt11'>> => ({
        observedAt: Date.now(),
        quoteSnapshot: cashuNormalizedBolt11Fixture({
          quote: quoteId,
          request: 'lnbc1test',
          amount: Amount.from(10),
          unit: 'sat',
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'UNPAID',
          amount_paid: Amount.zero(),
          amount_issued: Amount.zero(),
          updated_at: null,
        }),
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
      checkMintQuote: mock(async () => ({
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
      logger,
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
    const createdOperation = pendingEvents[0]?.operation as PendingMintOperation | undefined;
    expect(createdOperation?.quoteId).toBe(quote.quoteId);
    expect(createdOperation?.request).toBe(quote.request);
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
    expect(storedQuote?.amountPaid.equals(Amount.zero())).toBe(true);
    expect(storedQuote?.amountIssued.equals(Amount.zero())).toBe(true);
    expect(storedQuote?.remoteUpdatedAt).toBe(null);
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
        amount_paid: Amount.from(10),
        amount_issued: Amount.zero(),
        updated_at: 1_721_234_569,
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
    expect(refreshed.amountPaid.equals(Amount.from(10))).toBe(true);
    expect(refreshed.amountIssued.equals(Amount.zero())).toBe(true);
    expect(refreshed.remoteUpdatedAt).toBe(1_721_234_569);
    expect(refreshed.request).toBe('lnbc1paid');
    expect(persistedDuringEvent).toEqual(['PAID']);
  });

  it('persists an accounting increase first observed after expiry and makes it claimable', async () => {
    const onchainQuoteId = 'onchain-quote-paid-after-expiry';
    const expiry = Math.floor(Date.now() / 1000) - 1;
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.zero(),
      issued: Amount.zero(),
      expiry,
      remoteUpdatedAt: 10,
    });

    await quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(10),
        amount_issued: Amount.zero(),
        updated_at: 11,
      }),
    );

    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const assessment = await service.getMintQuoteClaimability(mintUrl, 'onchain', onchainQuoteId);

    expect(stored?.amountPaid.equals(Amount.from(10))).toBe(true);
    expect(stored?.amountIssued.equals(Amount.zero())).toBe(true);
    expect(stored?.remoteUpdatedAt).toBe(11);
    expect(assessment?.status).toBe('claimable');
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
        persistedDuringEvent.push(storedQuote.amountPaid.toString());
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
    expect(refreshed.amountPaid.equals(Amount.from(21))).toBe(true);
    expect(refreshed.amountIssued.equals(Amount.from(8))).toBe(true);
    expect(getMintQuoteAvailableAmount(refreshed).equals(Amount.from(13))).toBe(true);
    expect(persistedDuringEvent).toEqual(['21']);
  });

  it('refreshMintQuote ignores a stale direct BOLT11 observation', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: 'quote-direct-refresh',
        request: 'lnbc1direct',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      }),
    );
    (handler.fetchRemoteQuote as Mock<any>).mockImplementationOnce(async ({ quote }: any) =>
      mintQuoteFromBolt11Response(quote.mintUrl, {
        quote: quote.quoteId,
        request: quote.request,
        amount: quote.amount,
        unit: quote.unit,
        expiry: quote.expiry,
        state: 'UNPAID',
      }),
    );
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const refreshed = await quoteLifecycle.refreshMintQuote(
      mintUrl,
      'bolt11',
      'quote-direct-refresh',
    );
    const stored = await quoteRepo.getMintQuote(mintUrl, 'bolt11', 'quote-direct-refresh');

    expect(refreshed.state).toBe('PAID');
    expect(stored?.state).toBe('PAID');
    expect(quoteUpdatedEvents).toHaveLength(0);
  });

  it('refreshMintQuote ignores stale direct reusable accounting', async () => {
    const onchainQuoteId = 'onchain-quote-direct-refresh';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(8),
    });
    const onchainHandler = {
      ...handler,
      fetchRemoteQuote: mock(async ({ quote }) =>
        mintQuoteFromOnchainResponse(quote.mintUrl, {
          quote: quote.quoteId,
          request: quote.request,
          unit: quote.unit,
          expiry: quote.expiry,
          pubkey: quote.quoteData.pubkey,
          amount_paid: Amount.from(7),
          amount_issued: Amount.from(5),
        }),
      ),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementationOnce(() => onchainHandler);
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const refreshed = await quoteLifecycle.refreshMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(refreshed.method).toBe('onchain');
    if (refreshed.method !== 'onchain') throw new Error('Expected onchain quote');
    expect(stored?.method).toBe('onchain');
    if (stored?.method !== 'onchain') throw new Error('Expected stored onchain quote');
    expect(refreshed.amountPaid.equals(Amount.from(10))).toBe(true);
    expect(refreshed.amountIssued.equals(Amount.from(8))).toBe(true);
    expect(stored.amountPaid.equals(Amount.from(10))).toBe(true);
    expect(stored.amountIssued.equals(Amount.from(8))).toBe(true);
    expect(quoteUpdatedEvents).toHaveLength(0);
  });

  it('refreshMintQuote ignores impossible direct reusable accounting', async () => {
    const onchainQuoteId = 'onchain-quote-invalid-direct-refresh';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(2),
      remoteUpdatedAt: 20,
    });
    const before = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const onchainHandler = {
      ...handler,
      fetchRemoteQuote: mock(async ({ quote }) =>
        mintQuoteObservationFromOnchainResponse(
          quote.mintUrl,
          cashuNormalizedOnchainFixture({
            quote: quote.quoteId,
            request: quote.request,
            unit: quote.unit,
            expiry: quote.expiry,
            pubkey: quote.quoteData.pubkey,
            amount_paid: Amount.from(9),
            amount_issued: Amount.from(11),
            updated_at: 21,
          }),
        ),
      ),
    } as unknown as MintMethodHandler<'onchain'>;
    (handlerProvider.get as Mock<any>).mockImplementationOnce(() => onchainHandler);
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const refreshed = await quoteLifecycle.refreshMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(refreshed.amountPaid.toString()).toBe('10');
    expect(stored?.amountIssued.toString()).toBe('2');
    expect(stored?.updatedAt).toBe(before?.updatedAt);
    expect(quoteUpdatedEvents).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'Ignoring Mint Quote Observation with invalid accounting',
      expect.objectContaining({ mintUrl, method: 'onchain' }),
    );
    expect((logger.warn as Mock<any>).mock.calls[0]?.[1]).toMatchObject({
      quoteId: onchainQuoteId,
    });
  });

  it('recordMintQuoteSnapshot preserves BOLT11 downgrade protection at a newer update time', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: 'quote-snapshot-paid',
        request: 'lnbc1canonical',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
        updated_at: 20,
      }),
    );
    const before = await quoteRepo.getMintQuote(mintUrl, 'bolt11', 'quote-snapshot-paid');
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const observed = await quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'bolt11',
      cashuNormalizedBolt11Fixture({
        quote: 'quote-snapshot-paid',
        request: 'lnbc1stale',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 7200,
        state: 'UNPAID',
        updated_at: 21,
      }),
    );
    const stored = await quoteRepo.getMintQuote(mintUrl, 'bolt11', 'quote-snapshot-paid');

    expect(observed.state).toBe('PAID');
    expect(observed.request).toBe('lnbc1canonical');
    expect(stored?.state).toBe('PAID');
    expect(stored?.request).toBe('lnbc1canonical');
    expect(stored?.remoteUpdatedAt).toBe(20);
    expect(stored?.updatedAt).toBe(before?.updatedAt);
    expect(quoteUpdatedEvents).toHaveLength(0);
  });

  it('recordMintQuoteSnapshot preserves reusable accounting without emitting', async () => {
    const onchainQuoteId = 'onchain-quote-stale-snapshot';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(8),
    });
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const observed = await quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(7),
        amount_issued: Amount.from(5),
      }),
    );
    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(observed.method).toBe('onchain');
    if (observed.method !== 'onchain') throw new Error('Expected onchain quote');
    expect(stored?.method).toBe('onchain');
    if (stored?.method !== 'onchain') throw new Error('Expected stored onchain quote');
    expect(observed.amountPaid.equals(Amount.from(10))).toBe(true);
    expect(observed.amountIssued.equals(Amount.from(8))).toBe(true);
    expect(stored.amountPaid.equals(Amount.from(10))).toBe(true);
    expect(stored.amountIssued.equals(Amount.from(8))).toBe(true);
    expect(quoteUpdatedEvents).toHaveLength(0);
  });

  it('recordMintQuoteSnapshot ignores lower Remote Quote Update Times without emitting', async () => {
    const onchainQuoteId = 'onchain-quote-lower-timestamp';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(2),
      remoteUpdatedAt: 20,
    });
    const before = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const observed = await quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qstale',
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 7200,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(12),
        amount_issued: Amount.from(2),
        updated_at: 19,
      }),
    );
    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(observed.request).toBe('bc1qtest');
    expect(observed.amountPaid.toString()).toBe('10');
    expect(observed.remoteUpdatedAt).toBe(20);
    expect(stored?.request).toBe('bc1qtest');
    expect(stored?.updatedAt).toBe(before?.updatedAt);
    expect(quoteUpdatedEvents).toHaveLength(0);
  });

  for (const accountingDecrease of [
    { field: 'amount paid', paid: 9, issued: 2 },
    { field: 'amount issued', paid: 10, issued: 1 },
  ]) {
    it(`recordMintQuoteSnapshot ignores newer timestamps with decreased ${accountingDecrease.field}`, async () => {
      const quoteIdSuffix = accountingDecrease.field.replace(' ', '-');
      const onchainQuoteId = `onchain-quote-newer-decreased-${quoteIdSuffix}`;
      await persistOnchainQuote(onchainQuoteId, {
        paid: Amount.from(10),
        issued: Amount.from(2),
        remoteUpdatedAt: 20,
      });
      const before = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);
      const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
      eventBus.on('mint-quote:updated', (event) => {
        quoteUpdatedEvents.push(event);
      });

      const observed = await quoteLifecycle.recordMintQuoteSnapshot(
        mintUrl,
        'onchain',
        cashuNormalizedOnchainFixture({
          quote: onchainQuoteId,
          request: 'bc1qtest',
          unit: 'sat',
          expiry: before?.expiry ?? null,
          pubkey: '02'.padEnd(66, '1'),
          amount_paid: Amount.from(accountingDecrease.paid),
          amount_issued: Amount.from(accountingDecrease.issued),
          updated_at: 21,
        }),
      );
      const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

      expect(observed.amountPaid.toString()).toBe('10');
      expect(observed.amountIssued.toString()).toBe('2');
      expect(observed.remoteUpdatedAt).toBe(20);
      expect(stored?.amountPaid.toString()).toBe('10');
      expect(stored?.amountIssued.toString()).toBe('2');
      expect(stored?.updatedAt).toBe(before?.updatedAt);
      expect(quoteUpdatedEvents).toHaveLength(0);
    });
  }

  it('recordMintQuoteSnapshot warns and ignores accounting conflicts at an equal update time', async () => {
    const onchainQuoteId = 'onchain-quote-equal-timestamp';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(2),
      remoteUpdatedAt: 20,
    });
    const before = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const observed = await quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: before?.expiry ?? null,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(11),
        amount_issued: Amount.from(2),
        updated_at: 20,
      }),
    );
    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(observed.amountPaid.toString()).toBe('10');
    expect(stored?.amountPaid.toString()).toBe('10');
    expect(stored?.updatedAt).toBe(before?.updatedAt);
    expect(quoteUpdatedEvents).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'Ignoring Mint Quote Observation with conflicting accounting at unchanged Remote Quote Update Time',
      expect.objectContaining({
        mintUrl,
        method: 'onchain',
        existingAmountPaid: '10',
        incomingAmountPaid: '11',
      }),
    );
    expect((logger.warn as Mock<any>).mock.calls[0]?.[1]).toMatchObject({
      quoteId: onchainQuoteId,
    });
  });

  it('recordMintQuoteSnapshot accepts a monotonic accounting increase without losing freshness', async () => {
    const onchainQuoteId = 'onchain-quote-fallback-increase';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(2),
      remoteUpdatedAt: 20,
    });
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const observed = await quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(11),
        amount_issued: Amount.from(2),
        updated_at: null,
      }),
    );
    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(observed.amountPaid.toString()).toBe('11');
    expect(stored?.amountPaid.toString()).toBe('11');
    expect(stored?.remoteUpdatedAt).toBe(20);
    expect(quoteUpdatedEvents).toHaveLength(1);
  });

  it('recordMintQuoteSnapshot ignores null-time fallback observations with a component decrease', async () => {
    const onchainQuoteId = 'onchain-quote-fallback-component-decrease';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(2),
      remoteUpdatedAt: null,
    });
    const before = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    await quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: before?.expiry ?? null,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(12),
        amount_issued: Amount.from(1),
        updated_at: null,
      }),
    );
    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(stored?.amountPaid.toString()).toBe('10');
    expect(stored?.amountIssued.toString()).toBe('2');
    expect(stored?.updatedAt).toBe(before?.updatedAt);
    expect(quoteUpdatedEvents).toHaveLength(0);
  });

  it('recordMintQuoteSnapshot warns and ignores impossible background accounting', async () => {
    const onchainQuoteId = 'onchain-quote-invalid-background-accounting';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(2),
      remoteUpdatedAt: 20,
    });
    const before = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const observed = await quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: before?.expiry ?? null,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(9),
        amount_issued: Amount.from(11),
        updated_at: 21,
      }),
    );
    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(observed.amountPaid.toString()).toBe('10');
    expect(stored?.amountIssued.toString()).toBe('2');
    expect(stored?.updatedAt).toBe(before?.updatedAt);
    expect(quoteUpdatedEvents).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'Ignoring Mint Quote Observation with invalid accounting',
      expect.objectContaining({
        mintUrl,
        method: 'onchain',
        incomingAmountPaid: '9',
        incomingAmountIssued: '11',
      }),
    );
    expect((logger.warn as Mock<any>).mock.calls[0]?.[1]).toMatchObject({
      quoteId: onchainQuoteId,
    });
  });

  it('recordMintQuoteSnapshot persists timestamp-only freshness without emitting', async () => {
    const onchainQuoteId = 'onchain-quote-timestamp-only';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(2),
      remoteUpdatedAt: 20,
    });
    const before = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    await quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: before?.expiry ?? null,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(10),
        amount_issued: Amount.from(2),
        updated_at: 21,
      }),
    );
    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(stored?.remoteUpdatedAt).toBe(21);
    expect(quoteUpdatedEvents).toHaveLength(0);
  });

  it('recordMintQuoteSnapshot emits the unchanged event shape for a meaningful quote change', async () => {
    const onchainQuoteId = 'onchain-quote-meaningful-change';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(2),
      remoteUpdatedAt: 20,
    });
    const nextExpiry = Math.floor(Date.now() / 1000) + 7200;
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const observed = await quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: nextExpiry,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(10),
        amount_issued: Amount.from(2),
        updated_at: 21,
      }),
    );

    expect(observed.expiry).toBe(nextExpiry);
    expect(quoteUpdatedEvents).toEqual([
      {
        mintUrl,
        method: 'onchain',
        quoteId: onchainQuoteId,
        quote: observed,
      },
    ]);
  });

  it('recordMintQuoteSnapshot serializes concurrent observations before resolving freshness', async () => {
    const onchainQuoteId = 'onchain-quote-concurrent-observations';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.from(2),
      remoteUpdatedAt: 20,
    });
    const olderAtPersist = createDeferred();
    const releaseOlderPersist = createDeferred();
    const originalUpsert = quoteRepo.upsertMintQuote.bind(quoteRepo);
    quoteRepo.upsertMintQuote = mock(async (quote) => {
      if (quote.remoteUpdatedAt === 21) {
        olderAtPersist.resolve();
        await releaseOlderPersist.promise;
      }
      return originalUpsert(quote);
    }) as typeof quoteRepo.upsertMintQuote;

    const olderObservation = quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(11),
        amount_issued: Amount.from(2),
        updated_at: 21,
      }),
    );
    await olderAtPersist.promise;

    const newerObservation = quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'onchain',
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(12),
        amount_issued: Amount.from(2),
        updated_at: 22,
      }),
    );
    await Promise.resolve();
    releaseOlderPersist.resolve();

    await Promise.all([olderObservation, newerObservation]);
    const stored = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(stored?.remoteUpdatedAt).toBe(22);
    expect(stored?.amountPaid.toString()).toBe('12');
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
      method: 'bolt11',
      amount_paid: Amount.from(12),
      amount_issued: Amount.zero(),
      updated_at: 1_721_234_567,
      state: 'PAID',
    };

    let preparedQuote: MintMethodQuoteSnapshot<'bolt11'> | undefined;
    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({
        operation,
        importedQuote: quoteSnapshot,
      }: {
        operation: InitMintOperation;
        importedQuote: MintMethodQuoteSnapshot<'bolt11'>;
      }) => {
        preparedQuote = quoteSnapshot;
        return {
          ...makePendingOp(operation.id),
          quoteId: importedQuote.quote,
          amount: importedQuote.amount,
          request: importedQuote.request,
          expiry: importedQuote.expiry,
        };
      },
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
    expect(preparedQuote).toMatchObject({
      method: 'bolt11',
      amount_paid: Amount.from(12),
      amount_issued: Amount.zero(),
      updated_at: 1_721_234_567,
    });
  });

  it('imports legacy BOLT11 state as canonical Mint Quote Accounting', async () => {
    const imported = await quoteLifecycle.importMintQuote(mintUrl, 'bolt11', {
      quote: 'quote-legacy-accounting',
      request: 'lnbc1legacy',
      amount: Amount.from(12),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
    });

    expect(imported.state).toBe('PAID');
    expect(imported.amountPaid.equals(Amount.from(12))).toBe(true);
    expect(imported.amountIssued.equals(Amount.zero())).toBe(true);
    expect(imported.remoteUpdatedAt).toBe(null);
  });

  it('imports BOLT11 accounting without state and derives its compatibility state', async () => {
    const imported = await quoteLifecycle.importMintQuote(mintUrl, 'bolt11', {
      quote: 'quote-accounting-only',
      request: 'lnbc1accounting',
      amount: Amount.from(12),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      amount_paid: Amount.from(12),
      amount_issued: Amount.from(12),
      updated_at: 1_721_234_568,
    } as MintMethodQuoteImportSnapshot<'bolt11'>);

    expect(imported.state).toBe('ISSUED');
    expect(imported.amountPaid.equals(Amount.from(12))).toBe(true);
    expect(imported.amountIssued.equals(Amount.from(12))).toBe(true);
    expect(imported.remoteUpdatedAt).toBe(1_721_234_568);
  });

  it('rejects an imported snapshot whose method conflicts with the route', async () => {
    const conflicting = {
      quote: 'quote-conflicting-method',
      request: 'lnbc1conflict',
      method: 'onchain',
      amount: Amount.from(12),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
    } as unknown as MintMethodQuoteImportSnapshot<'bolt11'>;

    await expect(quoteLifecycle.importMintQuote(mintUrl, 'bolt11', conflicting)).rejects.toThrow(
      'reports method onchain instead of bolt11',
    );
    await expect(
      quoteRepo.getMintQuoteById({ mintUrl, quoteId: conflicting.quote }),
    ).resolves.toBeNull();
  });

  it('rejects BOLT11 imports whose Remote Quote Update Time is not a safe integer', async () => {
    const invalidTimestamps: unknown[] = ['1721234567', Number.NaN, Number.MAX_SAFE_INTEGER + 1];

    for (const [index, updatedAt] of invalidTimestamps.entries()) {
      const invalid = {
        quote: `quote-invalid-updated-at-${index}`,
        request: 'lnbc1invalidtimestamp',
        amount: Amount.from(12),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
        updated_at: updatedAt,
      } as unknown as MintMethodQuoteImportSnapshot<'bolt11'>;

      await expect(quoteLifecycle.importMintQuote(mintUrl, 'bolt11', invalid)).rejects.toThrow(
        'has invalid updated_at',
      );
      await expect(
        quoteLifecycle.getMintQuoteById({ mintUrl, quoteId: invalid.quote }),
      ).resolves.toBeNull();
    }
  });

  it('rejects a reusable import with a fractional Remote Quote Update Time', async () => {
    const invalid = {
      quote: 'onchain-invalid-updated-at',
      request: 'bc1qinvalidtimestamp',
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      pubkey: '02'.padEnd(66, '1'),
      amount_paid: Amount.from(5),
      amount_issued: Amount.zero(),
      updated_at: 1_721_234_567.5,
    } as MintMethodQuoteImportSnapshot<'onchain'>;

    await expect(quoteLifecycle.importMintQuote(mintUrl, 'onchain', invalid)).rejects.toThrow(
      'has invalid updated_at',
    );
    await expect(
      quoteLifecycle.getMintQuoteById({ mintUrl, quoteId: invalid.quote }),
    ).resolves.toBeNull();
  });

  it('rejects imported Mint Quote Accounting where issued exceeds paid', async () => {
    const invalid = {
      quote: 'quote-invalid-accounting',
      request: 'lnbc1invalid',
      amount: Amount.from(12),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      amount_paid: Amount.from(5),
      amount_issued: Amount.from(6),
      updated_at: null,
    } as MintMethodQuoteImportSnapshot<'bolt11'>;

    await expect(quoteLifecycle.importMintQuote(mintUrl, 'bolt11', invalid)).rejects.toThrow(
      'amount_issued greater than amount_paid',
    );
    await expect(
      quoteRepo.getMintQuoteById({ mintUrl, quoteId: invalid.quote }),
    ).resolves.toBeNull();
  });

  it('rejects over-issued reusable quote imports', async () => {
    const invalid = {
      quote: 'onchain-invalid-accounting',
      request: 'bc1qinvalid',
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      pubkey: '02'.padEnd(66, '1'),
      amount_paid: Amount.from(5),
      amount_issued: Amount.from(6),
      updated_at: null,
    } as MintMethodQuoteImportSnapshot<'onchain'>;

    await expect(quoteLifecycle.importMintQuote(mintUrl, 'onchain', invalid)).rejects.toThrow(
      'amount_issued greater than amount_paid',
    );
    await expect(
      quoteRepo.getMintQuoteById({ mintUrl, quoteId: invalid.quote }),
    ).resolves.toBeNull();
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

    const staleQuote: MintMethodQuoteImportSnapshot<'bolt11'> = {
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
        importedQuote: MintMethodQuoteSnapshot<'bolt11'>;
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
    const importedQuote: MintMethodQuoteImportSnapshot<'bolt11'> = {
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

  it('prepare + finalize issues a paid BOLT11 quote after expiry', async () => {
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    const finalizedEvents: Array<CoreEvents['mint-op:finalized']> = [];
    const failedEvents: Array<CoreEvents['mint-op:failed']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });
    eventBus.on('mint-op:finalized', (event) => {
      finalizedEvents.push(event);
    });
    eventBus.on('mint-op:failed', (event) => {
      failedEvents.push(event);
    });

    const expiry = Math.floor(Date.now() / 1000) - 1;
    await persistQuote(quoteId, expiry);

    const pending = await service.prepare({ mintUrl, method: 'bolt11', quoteId }, Amount.from(10));
    const finalized = await service.finalize(pending.id);

    expect(finalized?.state).toBe('finalized');
    expect(handler.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ importedQuote: expect.objectContaining({ expiry }) }),
    );

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
    expect(failedEvents).toHaveLength(0);
  });

  it('claimMintQuote issues atomic accounting even when compatibility state is stale', async () => {
    await persistQuote();
    const canonical = await quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId);
    if (!canonical || canonical.method !== 'bolt11') {
      throw new Error('Expected canonical BOLT11 quote');
    }
    await quoteRepo.upsertMintQuote({ ...canonical, state: 'UNPAID' });
    const operation = await service.prepare(canonical, canonical.amount);

    const claimed = await service.claimMintQuote(mintUrl, 'bolt11', quoteId, {
      autoClaimRemaining: false,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(operation.id);
    expect(claimed[0]?.state).toBe('finalized');
  });

  it('claimMintQuote advances a pending atomic operation from complete accounting', async () => {
    await persistQuote();
    const operation = await service.prepare(
      { mintUrl, method: 'bolt11', quoteId },
      Amount.from(10),
    );
    const canonical = await quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId);
    if (!canonical || canonical.method !== 'bolt11') {
      throw new Error('Expected canonical BOLT11 quote');
    }
    await quoteRepo.upsertMintQuote({
      ...canonical,
      state: 'UNPAID',
      amountIssued: canonical.amount,
    });
    (handler.execute as Mock<typeof handler.execute>).mockResolvedValueOnce({
      status: 'ALREADY_ISSUED',
    });

    const claimed = await service.claimMintQuote(mintUrl, 'bolt11', quoteId);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(operation.id);
    expect(claimed[0]?.state).toBe('finalized');
  });

  it('does not reclaim an overpaid atomic quote after local finalization', async () => {
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1overpaid',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
        amount_paid: Amount.from(11),
        amount_issued: Amount.zero(),
      }),
    );
    const operation = await service.prepare(
      { mintUrl, method: 'bolt11', quoteId },
      Amount.from(10),
    );

    const firstClaim = await service.claimMintQuote(mintUrl, 'bolt11', quoteId);
    const repeatedClaim = await service.claimMintQuote(mintUrl, 'bolt11', quoteId);
    const startupClaims = await service.claimPendingMintQuotes();

    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]?.id).toBe(operation.id);
    expect(firstClaim[0]?.state).toBe('finalized');
    expect(repeatedClaim).toEqual([]);
    expect(startupClaims).toEqual([]);
    expect(handler.execute).toHaveBeenCalledTimes(1);
  });

  it('does not automatically or explicitly claim a pending quote after its mint is untrusted', async () => {
    await persistQuote();
    const operation = await service.prepare(
      { mintUrl, method: 'bolt11', quoteId },
      Amount.from(10),
    );
    (mintService.isTrustedMint as Mock<any>).mockResolvedValue(false);

    const automaticClaims = await service.claimPendingMintQuotes();

    expect(automaticClaims).toEqual([]);
    await expect(service.claimMintQuote(mintUrl, 'bolt11', quoteId)).rejects.toThrow(
      `Mint ${mintUrl} is not trusted`,
    );
    expect(handler.execute).not.toHaveBeenCalled();
    expect((await operationRepo.getById(operation.id))?.state).toBe('pending');
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

  it('public execute joins a background claim that already moved the operation to executing', async () => {
    await persistQuote();
    const pending = await service.prepare({ mintUrl, method: 'bolt11', quoteId }, Amount.from(10));
    const api = new MintOpsApi(service);
    const executionStarted = createDeferred();
    const releaseExecution = createDeferred();
    (handler.execute as Mock<any>).mockImplementationOnce(async () => {
      executionStarted.resolve();
      await releaseExecution.promise;
      return { status: 'ISSUED', proofs: [makeProof('out-1')] };
    });

    const backgroundClaim = service.claimMintQuote(mintUrl, 'bolt11', quoteId, {
      autoClaimRemaining: false,
    });
    await executionStarted.promise;
    const explicitExecution = api.execute(pending.id);
    releaseExecution.resolve();

    const [claimed, executed] = await Promise.all([backgroundClaim, explicitExecution]);

    expect(claimed).toHaveLength(1);
    const claimedOperation = claimed[0];
    if (!claimedOperation) {
      throw new Error('Expected background claim to return the mint operation');
    }
    expect(claimedOperation.state).toBe('finalized');
    expect(executed.state).toBe('finalized');
    expect(executed.id).toBe(pending.id);
    expect(executed).toEqual(claimedOperation);
    expect(handler.execute).toHaveBeenCalledTimes(1);
  });

  it('execute recovers an orphaned executing operation', async () => {
    await persistQuote();
    const executing = makeExecutingOp('orphaned-executing');
    await operationRepo.create(executing);
    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({ status: 'FINALIZED' });

    const result = await service.execute(executing.id);

    expect(result.state).toBe('finalized');
    expect(handler.recoverExecuting).toHaveBeenCalledTimes(1);
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it('execute rejects missing and init operations', async () => {
    const init = makeInitOp('init-operation');
    await operationRepo.create(init);

    await expect(service.execute('missing-operation')).rejects.toThrow(
      'Operation missing-operation not found',
    );
    await expect(service.execute(init.id)).rejects.toThrow(
      "expected state 'pending' but found 'init'",
    );

    expect(handler.execute).not.toHaveBeenCalled();
    expect(handler.recoverExecuting).not.toHaveBeenCalled();
  });

  it('execute returns persisted terminal outcomes without invoking the handler', async () => {
    const finalized: FinalizedMintOperation = {
      ...makePendingOp('finalized-operation'),
      state: 'finalized',
    };
    const failed: FailedMintOperation = {
      ...makePendingOp('failed-operation'),
      state: 'failed',
      error: 'terminal failure',
      terminalFailure: {
        reason: 'terminal failure',
        observedAt: Date.now(),
      },
    };
    await operationRepo.create(finalized);
    await operationRepo.create(failed);

    expect(await service.execute(finalized.id)).toEqual(finalized);
    expect(await service.execute(failed.id)).toEqual(failed);
    expect(handler.execute).not.toHaveBeenCalled();
    expect(handler.recoverExecuting).not.toHaveBeenCalled();
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
    expect(quote.amountIssued.equals(Amount.zero())).toBe(true);
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

    const assessment = await service.getMintQuoteClaimability(mintUrl, 'onchain', onchainQuoteId);
    const claimed = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(assessment?.status).toBe('claimable');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.state).toBe('finalized');
  });

  it('keeps reusable onchain and BOLT12 quote balances claimable after expiry', async () => {
    const onchainQuoteId = 'onchain-quote-expired';
    const bolt12QuoteId = 'bolt12-quote-expired';
    const expiry = Math.floor(Date.now() / 1000) - 1;
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.zero(),
      expiry,
    });
    await persistBolt12Quote(bolt12QuoteId, {
      paid: Amount.from(10),
      issued: Amount.zero(),
      expiry,
    });

    const onchainAssessment = await service.getMintQuoteClaimability(
      mintUrl,
      'onchain',
      onchainQuoteId,
    );
    const bolt12Assessment = await service.getMintQuoteClaimability(
      mintUrl,
      'bolt12',
      bolt12QuoteId,
    );

    expect(onchainAssessment?.status).toBe('claimable');
    expect(bolt12Assessment?.status).toBe('claimable');
  });

  it('claimMintQuote prepares and issues reusable balance after expiry', async () => {
    const onchainQuoteId = 'onchain-quote-issue-after-expiry';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.zero(),
      expiry: Math.floor(Date.now() / 1000) - 1,
    });
    const { onchainHandler } = useAutoClaimOnchainHandler(Amount.from(10));

    const claimed = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.state).toBe('finalized');
    expect(onchainHandler.prepare).toHaveBeenCalled();
    expect(onchainHandler.execute).toHaveBeenCalled();
  });

  it('preserves finalized and reserved reusable accounting after expiry', async () => {
    const onchainQuoteId = 'onchain-quote-local-accounting-after-expiry';
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(20),
      issued: Amount.zero(),
      expiry: Math.floor(Date.now() / 1000) - 1,
    });
    const finalized: FinalizedMintOperation<'onchain'> = {
      ...makePendingOp('onchain-expired-finalized'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(7),
      pubkey: '02'.padEnd(66, '1'),
      state: 'finalized',
    };
    const reserved: ExecutingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-expired-reserved'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(5),
      pubkey: '02'.padEnd(66, '1'),
      state: 'executing',
    };
    const pending: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-expired-pending'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      amount: Amount.from(8),
      pubkey: '02'.padEnd(66, '1'),
    };
    await operationRepo.create(finalized);
    await operationRepo.create(reserved);
    await operationRepo.create(pending);
    useAutoClaimOnchainHandler(Amount.from(20));

    const claimed = await service.claimMintQuote(mintUrl, 'onchain', onchainQuoteId, {
      autoClaimRemaining: false,
    });

    expect(claimed.map((operation) => operation.id)).toEqual([pending.id]);
    expect((await operationRepo.getById(finalized.id))?.state).toBe('finalized');
    expect((await operationRepo.getById(reserved.id))?.state).toBe('executing');
    expect((await operationRepo.getById(pending.id))?.state).toBe('finalized');
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

  it('recoverExecutingOperation returns to pending when proofs are not recoverable', async () => {
    const op = makeExecutingOp('exec-3');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({ status: 'FINALIZED' });
    (proofService.recoverProofsFromOutputData as Mock<any>).mockResolvedValueOnce([]);

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);
    expect(stored?.state).toBe('pending');
  });

  it('recoverExecutingOperation fails expired attempts without re-emitting pending', async () => {
    const op = makeExecutingOp('exec-invalid');
    const finalizedEvents: Array<CoreEvents['mint-op:finalized']> = [];
    const failedEvents: Array<CoreEvents['mint-op:failed']> = [];
    const pendingEvents: Array<CoreEvents['mint-op:pending']> = [];
    await operationRepo.create(op);
    eventBus.on('mint-op:finalized', (event) => {
      finalizedEvents.push(event);
    });
    eventBus.on('mint-op:failed', (event) => {
      failedEvents.push(event);
    });
    eventBus.on('mint-op:pending', (event) => {
      pendingEvents.push(event);
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
    expect(pendingEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.operationId).toBe(op.id);
    expect(failedEvents[0]?.operation.state).toBe('failed');
    expect(failedEvents[0]?.operation.terminalFailure?.reason).toBe(
      `Recovered: quote ${quoteId} expired while executing mint`,
    );
  });

  it('finalize returns a failed operation when recovery finds invalid quote data', async () => {
    const op = makeExecutingOp('exec-invalid-redeem');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({
      status: 'TERMINAL',
      error: `Recovered: quote ${quoteId} has invalid accounting`,
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
      observedAt: Date.now(),
      quoteSnapshot: cashuNormalizedBolt11Fixture({
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: pendingOp.expiry,
        state: 'PAID',
        amount_paid: Amount.from(10),
        amount_issued: Amount.zero(),
        updated_at: null,
      }),
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
    expect(result.observedRemoteState).toBeUndefined();
    expect((result.quoteSnapshot as MintQuoteBolt11Response | undefined)?.state).toBe('UNPAID');
    expect(stored?.state).toBe('pending');
    if (!stored || stored.state !== 'pending') {
      throw new Error('Expected pending operation to remain pending after unpaid check');
    }
  });

  it('classifies a fully issued canonical quote as completed', async () => {
    await persistQuote();
    const pendingOp = await service.prepare(
      { mintUrl, method: 'bolt11', quoteId },
      Amount.from(10),
    );
    (handler.checkPending as Mock<any>).mockResolvedValueOnce({
      observedAt: Date.now(),
      quoteSnapshot: cashuNormalizedBolt11Fixture({
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: pendingOp.expiry,
        state: 'ISSUED',
        amount_paid: Amount.from(10),
        amount_issued: Amount.from(10),
        updated_at: 10,
      }),
    });

    const result = await service.checkPendingOperation(pendingOp.id);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(result.category).toBe('completed');
    expect(stored?.state).toBe('finalized');
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
      observedAt,
      quoteSnapshot: cashuNormalizedBolt11Fixture({
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: pendingOp.expiry,
        state: 'PAID',
        amount_paid: Amount.from(10),
        amount_issued: Amount.zero(),
        updated_at: 10,
      }),
      validationFailure: {
        reason: 'Mint operation is missing NUT-20 quote pubkey',
        code: 'missing_quote_pubkey',
        retryable: false,
        observedAt,
      },
    });

    const result = await service.checkPendingOperation(pendingOp.id);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(result.category).toBe('terminal');
    expect(stored?.state).toBe('failed');
    expect(stored?.error).toBe('Mint operation is missing NUT-20 quote pubkey');
    expect(stored?.terminalFailure).toMatchObject({
      reason: 'Mint operation is missing NUT-20 quote pubkey',
      code: 'missing_quote_pubkey',
      retryable: false,
      observedAt,
    });
    expect(finalizedEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.operationId).toBe(pendingOp.id);
    expect(failedEvents[0]?.operation.state).toBe('failed');
    expect(failedEvents[0]?.operation.terminalFailure?.reason).toBe(
      'Mint operation is missing NUT-20 quote pubkey',
    );
  });

  it('does not persist an unattributable snapshot for a validation failure', async () => {
    await persistQuote();
    const pendingOp = await service.prepare(
      { mintUrl, method: 'bolt11', quoteId },
      Amount.from(10),
    );
    const observedAt = Date.now();
    (handler.checkPending as Mock<any>).mockResolvedValueOnce({
      observedAt,
      validationFailure: {
        reason: `Polled BOLT11 mint quote other-quote conflicts with pending operation identity`,
        code: 'invalid_quote',
        retryable: false,
        observedAt,
      },
    });

    const result = await service.checkPendingOperation(pendingOp.id);
    const storedOperation = await operationRepo.getById(pendingOp.id);
    const storedQuote = await quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId);

    expect(result.category).toBe('terminal');
    expect(result.quoteSnapshot).toBeUndefined();
    expect(storedOperation?.state).toBe('failed');
    expect(storedOperation?.terminalFailure?.code).toBe('invalid_quote');
    expect(storedQuote?.request).toBe('lnbc1test');
  });

  it('classifies pending work from the resolved quote after ignoring invalid accounting', async () => {
    await persistQuote();
    const pendingOp = await service.prepare(
      { mintUrl, method: 'bolt11', quoteId },
      Amount.from(10),
    );
    const observedAt = Date.now();
    const paidAmountsDuringFinalization: string[] = [];
    eventBus.on('mint-op:finalized', async () => {
      const quote = await quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId);
      paidAmountsDuringFinalization.push(quote?.amountPaid.toString() ?? 'missing');
    });
    (handler.checkPending as Mock<any>).mockResolvedValueOnce({
      observedAt,
      quoteSnapshot: cashuNormalizedBolt11Fixture({
        quote: quoteId,
        request: 'lnbc1contradictory',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: pendingOp.expiry,
        state: 'ISSUED',
        amount_paid: Amount.from(9),
        amount_issued: Amount.from(10),
        updated_at: 20,
      }),
    });

    const result = await service.checkPendingOperation(pendingOp.id);
    const storedOperation = await operationRepo.getById(pendingOp.id);
    const storedQuote = await quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId);

    expect(result.category).toBe('ready');
    expect(result.observedRemoteStateAt).toBe(observedAt);
    expect(storedOperation?.state).toBe('finalized');
    expect(storedQuote?.amountPaid.equals(Amount.from(10))).toBe(true);
    expect(storedQuote?.request).not.toBe('lnbc1contradictory');
    expect(paidAmountsDuringFinalization).toEqual(['10']);
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

    usePendingOnchainHandler(
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(7),
        amount_issued: Amount.zero(),
      }),
    );

    const result = await service.checkPendingOperation(pendingOp.id);

    const stored = await operationRepo.getById(pendingOp.id);
    const quote = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(stored?.state).toBe('pending');
    expect(quote?.method).toBe('onchain');
    if (quote?.method !== 'onchain') throw new Error('Expected onchain quote');
    expect(result.category).toBe('waiting');
    expect(quote.amountPaid.equals(Amount.from(7))).toBe(true);
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

    usePendingOnchainHandler(
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        pubkey: '02'.padEnd(66, '1'),
        amount_paid: Amount.from(7),
        amount_issued: Amount.from(5),
      }),
    );

    const result = await service.checkPendingOperation(pendingOp.id);

    const quote = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(quote?.method).toBe('onchain');
    if (quote?.method !== 'onchain') throw new Error('Expected onchain quote');
    expect(result.category).toBe('waiting');
    expect(quote.amountPaid.equals(Amount.from(10))).toBe(true);
    expect(quote.amountIssued.equals(Amount.from(8))).toBe(true);
  });

  it('classifies conflicting reusable accounting from the canonical quote', async () => {
    const onchainQuoteId = 'onchain-quote-conflicting-check';
    const pubkey = '02'.padEnd(66, '1');
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.zero(),
      remoteUpdatedAt: 20,
    });
    const pendingOp: PendingMintOperation<'onchain'> = {
      ...makePendingOp('onchain-conflicting-check'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      request: 'bc1qtest',
      pubkey,
    };
    await operationRepo.create(pendingOp);
    usePendingOnchainHandler(
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry: pendingOp.expiry,
        pubkey,
        amount_paid: Amount.from(8),
        amount_issued: Amount.zero(),
        updated_at: 20,
      }),
    );

    const result = await service.observePendingOperation(pendingOp.id);
    const quote = await quoteRepo.getMintQuote(mintUrl, 'onchain', onchainQuoteId);

    expect(result.category).toBe('ready');
    expect(quote?.amountPaid.equals(Amount.from(10))).toBe(true);
  });

  it.each([
    ['zero-expiry sentinel', 0],
    ['null expiry', null],
    ['elapsed expiry', Math.floor(Date.now() / 1000) - 1],
  ] as const)('classifies a funded reusable quote with %s as ready', async (label, expiry) => {
    const onchainQuoteId = `onchain-quote-${label.replaceAll(' ', '-')}`;
    const pubkey = '02'.padEnd(66, '1');
    await persistOnchainQuote(onchainQuoteId, {
      paid: Amount.from(10),
      issued: Amount.zero(),
      expiry,
    });
    const pendingOp: PendingMintOperation<'onchain'> = {
      ...makePendingOp(`onchain-operation-${label.replaceAll(' ', '-')}`),
      method: 'onchain',
      quoteId: onchainQuoteId,
      request: 'bc1qtest',
      expiry,
      pubkey,
    };
    await operationRepo.create(pendingOp);
    usePendingOnchainHandler(
      cashuNormalizedOnchainFixture({
        quote: onchainQuoteId,
        request: 'bc1qtest',
        unit: 'sat',
        expiry,
        pubkey,
        amount_paid: Amount.from(10),
        amount_issued: Amount.zero(),
      }),
    );

    const result = await service.observePendingOperation(pendingOp.id);

    expect(result.category).toBe('ready');
  });

  it.each([
    ['subtracting executing sibling reservations', 'executing', 6, 5, 'waiting'],
    ['accounting for finalized siblings', 'finalized', 4, 6, 'ready'],
  ] as const)(
    'classifies reusable pending work after %s',
    async (label, siblingState, targetAmount, siblingAmount, expectedCategory) => {
      const scenario = label.replaceAll(' ', '-');
      const onchainQuoteId = `onchain-quote-${scenario}`;
      const pubkey = '02'.padEnd(66, '1');
      await persistOnchainQuote(onchainQuoteId, {
        paid: Amount.from(10),
        issued: Amount.zero(),
      });
      const pendingOp: PendingMintOperation<'onchain'> = {
        ...makePendingOp(`onchain-target-${scenario}`),
        method: 'onchain',
        quoteId: onchainQuoteId,
        request: 'bc1qtest',
        pubkey,
        amount: Amount.from(targetAmount),
      };
      const sibling =
        siblingState === 'executing'
          ? ({
              ...pendingOp,
              id: `onchain-sibling-${scenario}`,
              state: 'executing',
              amount: Amount.from(siblingAmount),
            } satisfies ExecutingMintOperation<'onchain'>)
          : ({
              ...pendingOp,
              id: `onchain-sibling-${scenario}`,
              state: 'finalized',
              amount: Amount.from(siblingAmount),
            } satisfies FinalizedMintOperation<'onchain'>);
      await operationRepo.create(pendingOp);
      await operationRepo.create(sibling);
      usePendingOnchainHandler(
        cashuNormalizedOnchainFixture({
          quote: onchainQuoteId,
          request: 'bc1qtest',
          unit: 'sat',
          expiry: pendingOp.expiry,
          pubkey,
          amount_paid: Amount.from(10),
          amount_issued: Amount.zero(),
        }),
      );

      const result = await service.observePendingOperation(pendingOp.id);

      expect(result.category).toBe(expectedCategory);
    },
  );

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

  it('recordQuoteObservation rejects legacy state for reusable quotes with a domain error', async () => {
    const onchainQuoteId = 'onchain-legacy-state';
    await persistOnchainQuote(onchainQuoteId);
    const pendingOp: PendingMintOperation<'onchain'> = {
      ...makePendingOp('pending-onchain-legacy-state'),
      method: 'onchain',
      quoteId: onchainQuoteId,
      request: 'bc1qtest',
      pubkey: '02'.padEnd(66, '1'),
    };

    const error = await quoteLifecycle
      .recordMintQuoteObservation(pendingOp, 'PAID')
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(MintQuoteValidationError);
    expect(error.message).toContain('Cannot record legacy quote state for onchain mint quote');
  });

  it('recordQuoteObservation cannot override newer ordered accounting', async () => {
    const initialExpiry = Math.floor(Date.now() / 1000) + 3600;
    const newerExpiry = initialExpiry + 3600;
    await quoteRepo.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1old',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: initialExpiry,
        state: 'PAID',
        updated_at: 20,
      }),
    );
    const pendingOp = {
      ...makePendingOp('pending-concurrent-compatibility-observation'),
      request: 'lnbc1old',
      expiry: initialExpiry,
    };
    const newerAtPersist = createDeferred();
    const releaseNewerPersist = createDeferred();
    const originalUpsert = quoteRepo.upsertMintQuote.bind(quoteRepo);
    let delayedNewerSnapshot = false;
    quoteRepo.upsertMintQuote = mock(async (quote) => {
      if (!delayedNewerSnapshot && quote.remoteUpdatedAt === 21) {
        delayedNewerSnapshot = true;
        newerAtPersist.resolve();
        await releaseNewerPersist.promise;
      }
      return originalUpsert(quote);
    }) as typeof quoteRepo.upsertMintQuote;

    const newerSnapshot = quoteLifecycle.recordMintQuoteSnapshot(
      mintUrl,
      'bolt11',
      cashuNormalizedBolt11Fixture({
        quote: quoteId,
        request: 'lnbc1newer',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: newerExpiry,
        state: 'PAID',
        updated_at: 21,
      }),
    );
    await newerAtPersist.promise;

    const compatibilityObservation = quoteLifecycle.recordMintQuoteObservation(pendingOp, 'ISSUED');
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    releaseNewerPersist.resolve();

    await Promise.all([newerSnapshot, compatibilityObservation]);
    const stored = await quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId);

    expect(stored?.state).toBe('PAID');
    expect(stored?.amountIssued.toString()).toBe('0');
    expect(stored?.request).toBe('lnbc1newer');
    expect(stored?.expiry).toBe(newerExpiry);
    expect(stored?.remoteUpdatedAt).toBe(21);
  });

  it('recordQuoteObservation ignores stale compatibility-state accounting', async () => {
    await persistQuote();
    const pendingOp = makePendingOp('pending-stale-state-observation');
    await operationRepo.create(pendingOp);
    const before = await quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId);
    const quoteUpdatedEvents: Array<CoreEvents['mint-quote:updated']> = [];
    eventBus.on('mint-quote:updated', (event) => {
      quoteUpdatedEvents.push(event);
    });

    const quote = await quoteLifecycle.recordMintQuoteObservation(
      pendingOp,
      'UNPAID',
      Date.now() + 1,
    );
    const stored = await quoteRepo.getMintQuote(mintUrl, 'bolt11', quoteId);

    expect(quote.state).toBe('PAID');
    expect(stored?.state).toBe('PAID');
    expect(stored?.updatedAt).toBe(before?.updatedAt);
    expect(quoteUpdatedEvents).toHaveLength(0);
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
        amountPaid: pendingOp.amount,
        amountIssued: Amount.zero(),
        remoteUpdatedAt: null,
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
