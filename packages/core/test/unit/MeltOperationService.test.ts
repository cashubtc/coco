import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import { MemoryMeltOperationRepository } from '../../repositories/memory/MemoryMeltOperationRepository.ts';
import { MemoryMeltQuoteRepository } from '../../repositories/memory/MemoryMeltQuoteRepository.ts';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { MintService } from '../../services/MintService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { MeltHandlerProvider } from '../../infra/handlers/melt/index.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { CoreProof } from '../../types.ts';
import type { MeltOperationRepository } from '../../repositories/index.ts';
import { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import type {
  InitMeltOperation,
  PreparedMeltOperation,
  ExecutingMeltOperation,
  PendingMeltOperation,
  FinalizedMeltOperation,
  RolledBackMeltOperation,
} from '../../operations/melt/MeltOperation.ts';
import type {
  MeltMethodHandler,
  PendingCheckResult,
  FinalizeResult,
} from '../../operations/melt/MeltMethodHandler.ts';
import { meltQuoteFromBolt11Response, type MeltQuote } from '../../models/MeltQuote.ts';
import {
  UnknownMintError,
  ProofValidationError,
  OperationInProgressError,
  QuoteIdentityConflictError,
} from '../../models/Error.ts';

describe('MeltOperationService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const invoice = 'lnbc1000n1...';

  let meltOperationRepository: MemoryMeltOperationRepository;
  let meltQuoteRepository: MemoryMeltQuoteRepository;
  let proofRepository: MemoryProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let mintAdapter: MintAdapter;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let handlerProvider: MeltHandlerProvider;
  let handler: MeltMethodHandler;
  let quoteLifecycle: QuoteLifecycle;
  let service: MeltOperationService;

  const makeProof = (secret: string, overrides?: Partial<CoreProof>): CoreProof =>
    ({
      amount: Amount.from(10),
      C: `C_${secret}` as unknown as any,
      id: keysetId,
      secret,
      mintUrl,
      unit: 'sat',
      state: 'ready',
      ...overrides,
    }) as CoreProof;

  const makeInitOp = (id: string, overrides?: Partial<InitMeltOperation>): InitMeltOperation => ({
    id,
    state: 'init',
    mintUrl,
    method: 'bolt11',
    methodData: { invoice },
    quoteId: 'quote-1',
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const persistMeltQuote = async (
    quote = 'quote-1',
    state: 'UNPAID' | 'PENDING' | 'PAID' = 'UNPAID',
    unit = 'sat',
  ) => {
    await meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromBolt11Response(mintUrl, {
        quote,
        request: invoice,
        amount: Amount.from(100),
        unit,
        fee_reserve: Amount.from(1),
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state,
        payment_preimage: state === 'PAID' ? 'preimage-123' : null,
      }),
    );
  };

  const persistOnchainMeltQuote = async (
    quoteId = 'onchain-quote',
    feeOptions = [
      { fee_index: 1, fee_reserve: Amount.from(1), estimated_blocks: 12 },
      { fee_index: 7, fee_reserve: Amount.from(2), estimated_blocks: 3 },
    ],
  ) => {
    await meltQuoteRepository.upsertMeltQuote({
      mintUrl,
      method: 'onchain',
      quoteId,
      quote: quoteId,
      state: 'UNPAID',
      request: 'bc1ptest',
      amount: Amount.from(21),
      unit: 'sat',
      fee_options: feeOptions,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  const makePreparedOp = (
    id: string,
    overrides?: Partial<PreparedMeltOperation>,
  ): PreparedMeltOperation => ({
    ...makeInitOp(id),
    state: 'prepared',
    quoteId: 'quote-1',
    amount: Amount.from(100),
    fee_reserve: Amount.from(1),
    swap_fee: Amount.from(0),
    needsSwap: false,
    inputAmount: Amount.from(101),
    inputProofSecrets: ['proof-1'],
    changeOutputData: { keep: [], send: [] },
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const makeExecutingOp = (
    id: string,
    overrides?: Partial<ExecutingMeltOperation>,
  ): ExecutingMeltOperation => ({
    ...makePreparedOp(id),
    state: 'executing',
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const makePendingOp = (
    id: string,
    overrides?: Partial<PendingMeltOperation>,
  ): PendingMeltOperation => ({
    ...makePreparedOp(id),
    state: 'pending',
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const makeFinalizedOp = (
    id: string,
    overrides?: Partial<FinalizedMeltOperation>,
  ): FinalizedMeltOperation => ({
    ...makePreparedOp(id),
    state: 'finalized',
    changeAmount: Amount.from(0),
    effectiveFee: Amount.from(1),
    finalizedData: { preimage: 'preimage-123' },
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const makeLegacyFinalizedOp = (id: string): FinalizedMeltOperation => ({
    ...makePreparedOp(id),
    state: 'finalized',
  });

  const makeRolledBackOp = (
    id: string,
    overrides?: Partial<RolledBackMeltOperation>,
  ): RolledBackMeltOperation => ({
    ...makePreparedOp(id),
    state: 'rolled_back',
    error: 'Rolled back',
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  beforeEach(async () => {
    meltOperationRepository = new MemoryMeltOperationRepository();
    meltQuoteRepository = new MemoryMeltQuoteRepository();
    proofRepository = new MemoryProofRepository();
    eventBus = new EventBus<CoreEvents>();

    handler = {
      createQuote: mock(async ({ mintUrl: quoteMintUrl, methodData, unit }) =>
        meltQuoteFromBolt11Response(quoteMintUrl, {
          quote: 'quote-created',
          request: methodData.invoice,
          amount: Amount.from(100),
          unit,
          fee_reserve: Amount.from(1),
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'UNPAID',
          payment_preimage: null,
        }),
      ),
      fetchRemoteQuote: mock(async ({ quote }) =>
        meltQuoteFromBolt11Response(quote.mintUrl, {
          quote: quote.quoteId,
          request: quote.request,
          amount: quote.amount,
          unit: quote.unit,
          fee_reserve: quote.fee_reserve,
          expiry: quote.expiry,
          state: 'PENDING',
          payment_preimage: null,
        }),
      ),
      prepare: mock(async ({ operation }) =>
        makePreparedOp(operation.id, {
          mintUrl: operation.mintUrl,
          unit: operation.unit,
          method: operation.method,
          methodData: operation.methodData,
          quoteId: operation.quoteId,
        }),
      ),
      execute: mock(async ({ operation }) => ({
        status: 'PAID',
        finalized: makeFinalizedOp(operation.id, {
          mintUrl: operation.mintUrl,
          unit: operation.unit,
          method: operation.method,
          methodData: operation.methodData,
        }),
      })),
      finalize: mock(
        async () =>
          ({
            changeAmount: Amount.from(0),
            effectiveFee: Amount.from(1),
            finalizedData: { preimage: 'preimage-123' },
          }) as FinalizeResult,
      ),
      rollback: mock(async () => {}),
      checkPending: mock(async () => 'stay_pending' as PendingCheckResult),
      recoverExecuting: mock(async ({ operation }) => ({
        status: 'PENDING',
        pending: {
          ...operation,
          state: 'pending',
        } as PendingMeltOperation,
      })),
    } as MeltMethodHandler;

    handlerProvider = {
      get: mock(() => handler),
    } as unknown as MeltHandlerProvider;

    proofService = {
      releaseProofs: mock(async () => {}),
    } as unknown as ProofService;

    mintService = {
      isTrustedMint: mock(async () => true),
      assertMethodUnitSupported: mock(async () => {}),
    } as unknown as MintService;

    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({ wallet: {} })),
    } as unknown as WalletService;

    mintAdapter = {} as MintAdapter;

    logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    } as Logger;

    quoteLifecycle = new QuoteLifecycle({
      mintHandlerProvider: {} as any,
      meltHandlerProvider: handlerProvider,
      mintQuoteRepository: {} as any,
      meltQuoteRepository,
      proofRepository,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
      logger,
    });

    service = new MeltOperationService(
      handlerProvider,
      meltOperationRepository,
      quoteLifecycle,
      proofRepository,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
      logger,
    );
    await persistMeltQuote();
  });

  describe('init', () => {
    it('creates an init operation for trusted mint', async () => {
      const operation = await service.init(mintUrl, 'bolt11', { invoice });

      expect(operation.state).toBe('init');
      const stored = await meltOperationRepository.getById(operation.id);
      expect(stored?.mintUrl).toBe(mintUrl);
    });

    it('normalizes and persists custom-unit init operations', async () => {
      const operation = await service.init(mintUrl, 'bolt11', { invoice }, 'USD');

      expect(operation.unit).toBe('usd');
      const stored = await meltOperationRepository.getById(operation.id);
      expect(stored?.unit).toBe('usd');
    });

    it('normalizes AmountLike amountSats before storing the operation', async () => {
      const operation = await service.init(mintUrl, 'bolt11', { invoice, amountSats: 1n });

      expect(operation.methodData.amountSats?.toString()).toBe('1');
      const stored = await meltOperationRepository.getById(operation.id);
      expect(stored?.methodData.amountSats?.toString()).toBe('1');
    });

    it('rejects duplicate quote-bound operations', async () => {
      const first = await service.init('https://MINT.test/', 'bolt11', { invoice }, 'sat', {
        quoteId: 'quote-1',
      });

      await expect(
        service.init(mintUrl, 'bolt11', { invoice }, 'sat', { quoteId: 'quote-1' }),
      ).rejects.toThrow(
        `Melt quote quote-1 is already tracked by operation ${first.id} in state init`,
      );

      const operations = await meltOperationRepository.getByQuoteId(mintUrl, 'quote-1');
      expect(first.mintUrl).toBe(mintUrl);
      expect(operations).toHaveLength(1);
    });

    it('throws when mint is untrusted', async () => {
      (mintService.isTrustedMint as Mock<any>).mockResolvedValue(false);

      expect(service.init(mintUrl, 'bolt11', { invoice })).rejects.toThrow(UnknownMintError);
    });

    it('throws for invalid amount', async () => {
      expect(service.init(mintUrl, 'bolt11', { invoice, amountSats: -1 })).rejects.toThrow(
        ProofValidationError,
      );
    });
  });

  describe('quotes', () => {
    it('creates and persists a canonical melt quote without creating an operation', async () => {
      const events: Array<CoreEvents['melt-quote:updated']> = [];
      const persistedDuringEvent: Array<string | undefined> = [];
      eventBus.on('melt-quote:updated', async (event) => {
        events.push(event);
        const storedQuote = await meltQuoteRepository.getMeltQuote(
          event.mintUrl,
          event.method,
          event.quoteId,
        );
        persistedDuringEvent.push(storedQuote?.quoteId);
      });

      const quote = await quoteLifecycle.createMeltQuote(mintUrl, 'bolt11', { invoice });

      expect(quote.quoteId).toBe('quote-created');
      expect(handler.createQuote).toHaveBeenCalled();
      expect(await quoteLifecycle.getMeltQuote(mintUrl, 'bolt11', 'quote-created')).toBeDefined();
      expect(events).toEqual([
        {
          mintUrl,
          method: 'bolt11',
          quoteId: 'quote-created',
          quote,
        },
      ]);
      expect(persistedDuringEvent).toEqual(['quote-created']);
      expect(await meltOperationRepository.getAll()).toHaveLength(0);
    });

    it('normalizes amountSats before passing method data to the handler', async () => {
      await quoteLifecycle.createMeltQuote(mintUrl, 'bolt11', {
        invoice,
        amountSats: Amount.from(1000),
      });

      const ctx = (handler.createQuote as Mock<any>).mock.calls.at(-1)?.[0] as any;
      expect(ctx.methodData.amountSats?.toString()).toBe('1000');
    });

    it('lists active canonical melt quotes', async () => {
      await persistMeltQuote('quote-pending', 'PENDING');
      await persistMeltQuote('quote-paid', 'PAID');

      const quotes = await quoteLifecycle.getPendingMeltQuotes('bolt11');

      expect(quotes.map((quote) => quote.quoteId).sort()).toEqual(['quote-1', 'quote-pending']);
    });

    it('gets canonical melt quotes by quote identity', async () => {
      const quote = await quoteLifecycle.getMeltQuoteById({ mintUrl, quoteId: 'quote-1' });
      const missing = await quoteLifecycle.getMeltQuoteById({ mintUrl, quoteId: 'missing' });

      expect(quote?.quoteId).toBe('quote-1');
      expect(missing).toBeNull();
    });

    it('refreshMeltQuoteById resolves the stored method before fetching remote state', async () => {
      const quote = await quoteLifecycle.refreshMeltQuoteById({ mintUrl, quoteId: 'quote-1' });

      expect(handlerProvider.get).toHaveBeenCalledWith('bolt11');
      expect(handler.fetchRemoteQuote).toHaveBeenCalled();
      expect(quote.state).toBe('PENDING');
      expect(await quoteLifecycle.getMeltQuote(mintUrl, 'bolt11', 'quote-1')).toEqual(quote);
    });

    it('refreshMeltQuote keeps the method-aware exact refresh path for internal callers', async () => {
      const quote = await quoteLifecycle.refreshMeltQuote(mintUrl, 'bolt11', 'quote-1');

      expect(handlerProvider.get).toHaveBeenCalledWith('bolt11');
      expect(handler.fetchRemoteQuote).toHaveBeenCalled();
      expect(quote.state).toBe('PENDING');
      expect(await quoteLifecycle.getMeltQuote(mintUrl, 'bolt11', 'quote-1')).toEqual(quote);
    });

    it('refreshMeltQuote persists the canonical quote before emitting melt-quote:updated', async () => {
      (handler.fetchRemoteQuote as Mock<any>).mockImplementationOnce(
        async ({ quote }: { quote: MeltQuote<'bolt11'> }) =>
          meltQuoteFromBolt11Response(quote.mintUrl, {
            quote: quote.quoteId,
            request: quote.request,
            amount: quote.amount,
            unit: quote.unit,
            fee_reserve: quote.fee_reserve,
            expiry: quote.expiry,
            state: 'PAID',
            payment_preimage: 'preimage-paid',
          }),
      );

      const events: Array<CoreEvents['melt-quote:updated']> = [];
      const persistedDuringEvent: Array<string | undefined> = [];
      eventBus.on('melt-quote:updated', async (event) => {
        events.push(event);
        const storedQuote = await meltQuoteRepository.getMeltQuote(
          event.mintUrl,
          event.method,
          event.quoteId,
        );
        persistedDuringEvent.push(storedQuote?.state);
      });

      const refreshed = await quoteLifecycle.refreshMeltQuoteById({ mintUrl, quoteId: 'quote-1' });

      expect(refreshed.state).toBe('PAID');
      if (refreshed.method === 'onchain') throw new Error('Expected BOLT melt quote');
      expect(refreshed.payment_preimage).toBe('preimage-paid');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        mintUrl,
        method: 'bolt11',
        quoteId: 'quote-1',
        quote: refreshed,
      });
      expect(persistedDuringEvent).toEqual(['PAID']);
    });

    it('suppresses duplicate melt quote observations without meaningful stored changes', async () => {
      const events: Array<CoreEvents['melt-quote:updated']> = [];
      eventBus.on('melt-quote:updated', (event) => {
        events.push(event);
      });

      await quoteLifecycle.refreshMeltQuoteById({ mintUrl, quoteId: 'quote-1' });
      await quoteLifecycle.refreshMeltQuoteById({ mintUrl, quoteId: 'quote-1' });

      expect(events.map((event) => event.quote.state)).toEqual(['PENDING']);
    });

    it('persists PENDING to UNPAID melt quote observations', async () => {
      await persistMeltQuote('quote-pending-to-unpaid', 'PENDING');
      (handler.fetchRemoteQuote as Mock<any>).mockImplementationOnce(
        async ({ quote }: { quote: MeltQuote<'bolt11'> }) =>
          meltQuoteFromBolt11Response(quote.mintUrl, {
            quote: quote.quoteId,
            request: quote.request,
            amount: quote.amount,
            unit: quote.unit,
            fee_reserve: quote.fee_reserve,
            expiry: quote.expiry,
            state: 'UNPAID',
            payment_preimage: null,
          }),
      );

      const events: Array<CoreEvents['melt-quote:updated']> = [];
      eventBus.on('melt-quote:updated', (event) => {
        events.push(event);
      });

      const refreshed = await quoteLifecycle.refreshMeltQuoteById({
        mintUrl,
        quoteId: 'quote-pending-to-unpaid',
      });

      expect(refreshed.state).toBe('UNPAID');
      expect(events.map((event) => event.quote.state)).toEqual(['UNPAID']);
      await expect(
        quoteLifecycle.getMeltQuote(mintUrl, 'bolt11', 'quote-pending-to-unpaid'),
      ).resolves.toMatchObject({ state: 'UNPAID' });
    });

    it('does not downgrade terminal PAID melt quotes from stale observations', async () => {
      await persistMeltQuote('quote-terminal-paid', 'PAID');
      (handler.fetchRemoteQuote as Mock<any>).mockImplementationOnce(
        async ({ quote }: { quote: MeltQuote<'bolt11'> }) =>
          meltQuoteFromBolt11Response(quote.mintUrl, {
            quote: quote.quoteId,
            request: quote.request,
            amount: quote.amount,
            unit: quote.unit,
            fee_reserve: quote.fee_reserve,
            expiry: quote.expiry,
            state: 'UNPAID',
            payment_preimage: null,
          }),
      );

      const events: Array<CoreEvents['melt-quote:updated']> = [];
      eventBus.on('melt-quote:updated', (event) => {
        events.push(event);
      });

      const refreshed = await quoteLifecycle.refreshMeltQuoteById({
        mintUrl,
        quoteId: 'quote-terminal-paid',
      });

      expect(refreshed.state).toBe('PAID');
      expect(events).toHaveLength(0);
      await expect(
        quoteLifecycle.getMeltQuote(mintUrl, 'bolt11', 'quote-terminal-paid'),
      ).resolves.toMatchObject({ state: 'PAID', payment_preimage: 'preimage-123' });
    });

    it('ignores later PAID melt quote observations after terminal settlement', async () => {
      await persistMeltQuote('quote-terminal-paid-repeat', 'PAID');
      (handler.fetchRemoteQuote as Mock<any>).mockImplementationOnce(
        async ({ quote }: { quote: MeltQuote<'bolt11'> }) =>
          meltQuoteFromBolt11Response(quote.mintUrl, {
            quote: quote.quoteId,
            request: quote.request,
            amount: quote.amount,
            unit: quote.unit,
            fee_reserve: quote.fee_reserve,
            expiry: quote.expiry,
            state: 'PAID',
            payment_preimage: null,
          }),
      );

      const events: Array<CoreEvents['melt-quote:updated']> = [];
      eventBus.on('melt-quote:updated', (event) => {
        events.push(event);
      });

      const refreshed = await quoteLifecycle.refreshMeltQuoteById({
        mintUrl,
        quoteId: 'quote-terminal-paid-repeat',
      });

      expect(refreshed.state).toBe('PAID');
      if (refreshed.method === 'onchain') throw new Error('Expected BOLT melt quote');
      expect(refreshed.payment_preimage).toBe('preimage-123');
      expect(events).toHaveLength(0);
      await expect(
        quoteLifecycle.getMeltQuote(mintUrl, 'bolt11', 'quote-terminal-paid-repeat'),
      ).resolves.toMatchObject({ state: 'PAID', payment_preimage: 'preimage-123' });
    });
  });

  describe('prepare', () => {
    it('prepares existing quotes using the canonical quote mint URL', async () => {
      const prepared = await service.prepareExistingQuote({
        mintUrl: 'https://MINT.test/',
        method: 'bolt11',
        quoteId: 'quote-1',
      });

      const stored = await meltOperationRepository.getById(prepared.id);
      const byQuote = await service.getOperationByQuote(mintUrl, 'bolt11', 'quote-1');

      expect(prepared.mintUrl).toBe(mintUrl);
      expect(stored?.mintUrl).toBe(mintUrl);
      expect(byQuote?.id).toBe(prepared.id);
    });

    it('prepares BOLT12 melt quotes using offer method data from the canonical quote', async () => {
      await meltQuoteRepository.upsertMeltQuote({
        mintUrl,
        method: 'bolt12',
        quoteId: 'quote-bolt12',
        quote: 'quote-bolt12',
        request: 'lno1offer',
        amount: Amount.from(100),
        unit: 'sat',
        fee_reserve: Amount.from(1),
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'UNPAID',
        payment_preimage: null,
        lastObservedRemoteState: 'UNPAID',
        lastObservedRemoteStateAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const prepared = await service.prepareExistingQuote({
        mintUrl,
        method: 'bolt12',
        quoteId: 'quote-bolt12',
      });

      expect(prepared.method).toBe('bolt12');
      expect(prepared.methodData).toEqual({ offer: 'lno1offer' });
    });

    it('prepares onchain melt quotes with the selected fee index in operation data', async () => {
      await persistOnchainMeltQuote();

      const prepared = await service.prepareExistingQuote(
        {
          mintUrl,
          method: 'onchain',
          quoteId: 'onchain-quote',
        },
        { feeIndex: 7 },
      );

      expect(prepared.method).toBe('onchain');
      expect(prepared.methodData).toEqual({
        address: 'bc1ptest',
        amountSats: Amount.from(21),
        feeIndex: 7,
      });
    });

    it('rejects missing onchain fee index even when the quote has one fee option', async () => {
      await persistOnchainMeltQuote('single-option-onchain-quote', [
        { fee_index: 3, fee_reserve: Amount.from(4), estimated_blocks: 6 },
      ]);

      await expect(
        service.prepareExistingQuote({
          mintUrl,
          method: 'onchain',
          quoteId: 'single-option-onchain-quote',
        }),
      ).rejects.toThrow('requires an explicit feeIndex');

      expect(
        await service.getOperationByQuote(mintUrl, 'onchain', 'single-option-onchain-quote'),
      ).toBeNull();
    });

    it('rejects missing onchain fee index for multi-option quotes before creating operations', async () => {
      await persistOnchainMeltQuote();

      await expect(
        service.prepareExistingQuote({
          mintUrl,
          method: 'onchain',
          quoteId: 'onchain-quote',
        }),
      ).rejects.toThrow('requires an explicit feeIndex');

      expect(await service.getOperationByQuote(mintUrl, 'onchain', 'onchain-quote')).toBeNull();
    });

    it('rejects invalid onchain fee index before creating operations', async () => {
      await persistOnchainMeltQuote();

      await expect(
        service.prepareExistingQuote(
          {
            mintUrl,
            method: 'onchain',
            quoteId: 'onchain-quote',
          },
          { feeIndex: 99 },
        ),
      ).rejects.toThrow('does not include onchain fee option 99');

      expect(await service.getOperationByQuote(mintUrl, 'onchain', 'onchain-quote')).toBeNull();
    });

    it('throws quote identity conflict when the input ref method differs from storage', async () => {
      await expect(
        service.prepareExistingQuote({
          mintUrl,
          method: 'bolt12',
          quoteId: 'quote-1',
        }),
      ).rejects.toThrow(QuoteIdentityConflictError);

      expect(await service.getOperationByQuote(mintUrl, 'bolt11', 'quote-1')).toBeNull();
    });

    it('accepts full canonical melt quotes as quote refs', async () => {
      const quote = await quoteLifecycle.getMeltQuoteById({ mintUrl, quoteId: 'quote-1' });
      if (!quote) {
        throw new Error('Expected test quote to exist');
      }

      const prepared = await service.prepareExistingQuote(quote);

      expect(prepared.quoteId).toBe(quote.quoteId);
      expect(prepared.method).toBe(quote.method);
      expect(prepared.methodData).toEqual({ invoice: quote.request });
    });

    it('rejects duplicate prepares for the same canonical quote', async () => {
      const first = await service.prepareExistingQuote({
        mintUrl: 'https://MINT.test/',
        method: 'bolt11',
        quoteId: 'quote-1',
      });

      await expect(
        service.prepareExistingQuote({ mintUrl, method: 'bolt11', quoteId: 'quote-1' }),
      ).rejects.toThrow(
        `Melt quote quote-1 is already tracked by operation ${first.id} in state prepared`,
      );

      const operations = await meltOperationRepository.getByQuoteId(mintUrl, 'quote-1');
      expect(operations).toHaveLength(1);
      expect(handler.prepare).toHaveBeenCalledTimes(1);
    });

    it('prepares operation and emits event', async () => {
      const initOp = makeInitOp('op-1');
      await meltOperationRepository.create(initOp);

      const events: any[] = [];
      eventBus.on('melt-op:prepared', (payload) => void events.push(payload));

      const prepared = await service.prepare('op-1');

      expect(prepared.state).toBe('prepared');
      expect(events.length).toBe(1);
      const stored = await meltOperationRepository.getById('op-1');
      expect(stored?.state).toBe('prepared');
    });

    it('validates NUT-05 support and uses the operation unit wallet', async () => {
      const initOp = makeInitOp('op-usd', { unit: 'usd' });
      await persistMeltQuote('quote-1', 'UNPAID', 'usd');
      await meltOperationRepository.create(initOp);

      const prepared = await service.prepare('op-usd');

      expect(prepared.unit).toBe('usd');
      expect(mintService.assertMethodUnitSupported).toHaveBeenCalledWith(
        mintUrl,
        5,
        'bolt11',
        'usd',
      );
      expect(walletService.getWalletWithActiveKeysetId).toHaveBeenCalledWith(mintUrl, 'usd');
    });

    it('rejects non-sat melts when NUT-05 capability validation rejects the unit', async () => {
      const initOp = makeInitOp('op-usd-rejected', { unit: 'usd' });
      await meltOperationRepository.create(initOp);
      (mintService.assertMethodUnitSupported as Mock<any>).mockRejectedValueOnce(
        new ProofValidationError('Mint does not advertise NUT-05 support for bolt11/usd'),
      );

      await expect(service.prepare('op-usd-rejected')).rejects.toThrow(ProofValidationError);
      expect(handler.prepare).not.toHaveBeenCalled();
      expect(await meltOperationRepository.getById('op-usd-rejected')).toBeNull();
    });

    it('recovers init operation when handler fails', async () => {
      const initOp = makeInitOp('op-2');
      await meltOperationRepository.create(initOp);
      await proofRepository.saveProofs(mintUrl, [
        makeProof('reserved', { usedByOperationId: 'op-2' }),
      ]);

      (handler.prepare as Mock<any>).mockRejectedValue(new Error('prepare failed'));

      expect(service.prepare('op-2')).rejects.toThrow('prepare failed');
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['reserved']);
      expect(await meltOperationRepository.getById('op-2')).toBeNull();
    });

    it('throws when operation already in progress', async () => {
      const initOp = makeInitOp('op-3');
      await meltOperationRepository.create(initOp);

      let releasePrepare: () => void;
      (handler.prepare as Mock<any>).mockImplementation(
        () => new Promise((resolve) => (releasePrepare = () => resolve(makePreparedOp('op-3')))),
      );

      const first = service.prepare('op-3');
      await Promise.resolve();

      expect(service.prepare('op-3')).rejects.toThrow(OperationInProgressError);

      releasePrepare!();
      await first;
    });

    it('serializes prepare calls for the same mint', async () => {
      const firstOp = makeInitOp('op-12');
      const secondOp = makeInitOp('op-13', { quoteId: 'quote-2' });
      await persistMeltQuote('quote-2');
      await meltOperationRepository.create(firstOp);
      await meltOperationRepository.create(secondOp);

      let releaseFirstPrepare: () => void;
      const firstPrepareBlocked = new Promise<void>((resolve) => {
        releaseFirstPrepare = resolve;
      });
      (handler.prepare as Mock<any>).mockImplementation(
        async ({ operation }: { operation: any }) => {
          if (operation.id === 'op-12') {
            await firstPrepareBlocked;
          }
          return makePreparedOp(operation.id, {
            mintUrl: operation.mintUrl,
            method: operation.method,
            methodData: operation.methodData,
            quoteId: operation.quoteId,
          });
        },
      );

      const first = service.prepare('op-12');
      await Promise.resolve();

      let secondResolved = false;
      const second = service.prepare('op-13').then((operation) => {
        secondResolved = true;
        return operation;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(secondResolved).toBe(false);

      releaseFirstPrepare!();

      const [firstPrepared, secondPrepared] = await Promise.all([first, second]);
      expect(firstPrepared.state).toBe('prepared');
      expect(secondPrepared.state).toBe('prepared');
      expect(secondResolved).toBe(true);
    });
  });

  describe('execute', () => {
    it('finalizes immediately on PAID response', async () => {
      const prepared = makePreparedOp('op-4');
      await meltOperationRepository.create(prepared);
      await proofRepository.saveProofs(mintUrl, [
        makeProof('proof-1', { usedByOperationId: 'op-4' }),
      ]);

      const events: any[] = [];
      eventBus.on('melt-op:finalized', (payload) => void events.push(payload));

      const result = await service.execute('op-4');

      expect(result.state).toBe('finalized');
      if (result.state === 'finalized') {
        expect(result.changeAmount).toEqual(Amount.from(0));
        expect(result.effectiveFee).toEqual(Amount.from(1));
        expect(result.finalizedData?.preimage).toBe('preimage-123');
      }
      expect(events.length).toBe(1);
      const stored = await meltOperationRepository.getById('op-4');
      expect(stored?.state).toBe('finalized');
      const finalizedOp = stored as FinalizedMeltOperation;
      expect(finalizedOp.changeAmount).toEqual(Amount.from(0));
      expect(finalizedOp.effectiveFee).toEqual(Amount.from(1));
      expect(finalizedOp.finalizedData?.preimage).toBe('preimage-123');
    });

    it('moves to pending on PENDING response', async () => {
      const prepared = makePreparedOp('op-5');
      await meltOperationRepository.create(prepared);

      (handler.execute as Mock<any>).mockResolvedValue({
        status: 'PENDING',
        pending: makePendingOp('op-5'),
      });

      const events: any[] = [];
      eventBus.on('melt-op:pending', (payload) => void events.push(payload));

      const result = await service.execute('op-5');

      expect(result.state).toBe('pending');
      expect(events.length).toBe(1);
      const stored = await meltOperationRepository.getById('op-5');
      expect(stored?.state).toBe('pending');
    });

    it('recovers executing operation on handler failure', async () => {
      const prepared = makePreparedOp('op-6');
      await meltOperationRepository.create(prepared);

      (handler.execute as Mock<any>).mockResolvedValue({
        status: 'FAILED',
        failed: { error: 'nope' },
      });

      await expect(service.execute('op-6')).rejects.toThrow('nope');
      expect(handler.recoverExecuting).toHaveBeenCalled();
    });
  });

  describe('finalize', () => {
    it('finalizes pending operation and emits event with settlement amounts', async () => {
      const pending = makePendingOp('op-7');
      await meltOperationRepository.create(pending);

      const events: any[] = [];
      eventBus.on('melt-op:finalized', (payload) => void events.push(payload));

      const result = await service.finalize('op-7');

      expect(handler.finalize).toHaveBeenCalled();
      expect(result).toEqual({
        changeAmount: Amount.from(0),
        effectiveFee: Amount.from(1),
        finalizedData: { preimage: 'preimage-123' },
      });
      expect(events.length).toBe(1);
      const stored = await meltOperationRepository.getById('op-7');
      expect(stored?.state).toBe('finalized');
      // Verify the finalized operation has the settlement amounts
      const finalizedOp = stored as FinalizedMeltOperation;
      expect(finalizedOp.changeAmount).toEqual(Amount.from(0));
      expect(finalizedOp.effectiveFee).toEqual(Amount.from(1));
      expect(finalizedOp.finalizedData?.preimage).toBe('preimage-123');
    });

    it('returns early if already finalized', async () => {
      const finalized = makeFinalizedOp('op-8');
      await meltOperationRepository.create(finalized);

      const result = await service.finalize('op-8');

      expect(handler.finalize).not.toHaveBeenCalled();
      expect(result).toEqual({
        changeAmount: Amount.from(0),
        effectiveFee: Amount.from(1),
        finalizedData: { preimage: 'preimage-123' },
      });
    });

    it('returns undefined settlement amounts for legacy finalized operations', async () => {
      await meltOperationRepository.create(makeLegacyFinalizedOp('op-legacy'));

      const result = await service.finalize('op-legacy');

      expect(handler.finalize).not.toHaveBeenCalled();
      expect(result).toEqual({
        changeAmount: undefined,
        effectiveFee: undefined,
        finalizedData: undefined,
      });
    });

    it('returns undefined settlement amounts for rolled back operations', async () => {
      await meltOperationRepository.create(makeRolledBackOp('op-rolled-back'));

      const result = await service.finalize('op-rolled-back');

      expect(handler.finalize).not.toHaveBeenCalled();
      expect(result).toEqual({
        changeAmount: undefined,
        effectiveFee: undefined,
        finalizedData: undefined,
      });
    });
  });

  describe('rollback', () => {
    it('rolls back prepared operation and emits event', async () => {
      const prepared = makePreparedOp('op-9');
      await meltOperationRepository.create(prepared);

      const events: any[] = [];
      eventBus.on('melt-op:rolled-back', (payload) => void events.push(payload));

      await service.rollback('op-9');

      expect(handler.rollback).toHaveBeenCalled();
      expect(events.length).toBe(1);
      const stored = await meltOperationRepository.getById('op-9');
      expect(stored?.state).toBe('rolled_back');
    });

    it('throws when pending quote is not UNPAID', async () => {
      const pending = makePendingOp('op-10');
      await meltOperationRepository.create(pending);

      (handler.checkPending as Mock<any>).mockResolvedValue('stay_pending');

      expect(service.rollback('op-10')).rejects.toThrow(
        'Cannot rollback pending operation: quote state is not UNPAID',
      );
    });
  });

  describe('checkPendingOperation', () => {
    it('records the remote quote observation before finalizing the operation', async () => {
      const pending = makePendingOp('op-observed-finalize');
      await meltOperationRepository.create(pending);

      const order: string[] = [];
      (handler.fetchRemoteQuote as Mock<any>).mockImplementationOnce(
        async ({ quote }: { quote: MeltQuote<'bolt11'> }) =>
          meltQuoteFromBolt11Response(quote.mintUrl, {
            quote: quote.quoteId,
            request: quote.request,
            amount: quote.amount,
            unit: quote.unit,
            fee_reserve: quote.fee_reserve,
            expiry: quote.expiry,
            state: 'PAID',
            payment_preimage: 'preimage-observed',
            change: [],
          }),
      );
      (handler.checkPending as Mock<any>).mockImplementationOnce(
        async ({ canonicalQuote }: { canonicalQuote?: MeltQuote }) => {
          order.push(`decision:${canonicalQuote?.state ?? 'missing'}`);
          return canonicalQuote?.state === 'PAID' ? 'finalize' : 'stay_pending';
        },
      );

      eventBus.on('melt-quote:updated', async () => {
        const stored = await meltOperationRepository.getById(pending.id);
        order.push(`quote-updated:${stored?.state ?? 'missing'}`);
      });
      eventBus.on('melt-op:finalized', () => {
        order.push('operation-finalized');
      });

      const result = await service.checkPendingOperation(pending.id);

      expect(result).toBe('finalize');
      expect(order).toEqual(['quote-updated:pending', 'decision:PAID', 'operation-finalized']);
      await expect(
        meltQuoteRepository.getMeltQuote(mintUrl, 'bolt11', pending.quoteId),
      ).resolves.toMatchObject({
        state: 'PAID',
        payment_preimage: 'preimage-observed',
      });
      await expect(meltOperationRepository.getById(pending.id)).resolves.toMatchObject({
        state: 'finalized',
      });
    });

    it('records the remote quote observation before leaving the operation pending', async () => {
      const pending = makePendingOp('op-observed-pending');
      await meltOperationRepository.create(pending);

      const order: string[] = [];
      (handler.fetchRemoteQuote as Mock<any>).mockImplementationOnce(
        async ({ quote }: { quote: MeltQuote<'bolt11'> }) =>
          meltQuoteFromBolt11Response(quote.mintUrl, {
            quote: quote.quoteId,
            request: quote.request,
            amount: quote.amount,
            unit: quote.unit,
            fee_reserve: quote.fee_reserve,
            expiry: quote.expiry,
            state: 'PENDING',
            payment_preimage: null,
          }),
      );
      (handler.checkPending as Mock<any>).mockImplementationOnce(
        async ({ canonicalQuote }: { canonicalQuote?: MeltQuote }) => {
          order.push(`decision:${canonicalQuote?.state ?? 'missing'}`);
          return 'stay_pending';
        },
      );

      eventBus.on('melt-quote:updated', async () => {
        const stored = await meltOperationRepository.getById(pending.id);
        order.push(`quote-updated:${stored?.state ?? 'missing'}`);
      });

      const result = await service.checkPendingOperation(pending.id);

      expect(result).toBe('stay_pending');
      expect(order).toEqual(['quote-updated:pending', 'decision:PENDING']);
      await expect(
        meltQuoteRepository.getMeltQuote(mintUrl, 'bolt11', pending.quoteId),
      ).resolves.toMatchObject({
        state: 'PENDING',
      });
      await expect(meltOperationRepository.getById(pending.id)).resolves.toMatchObject({
        state: 'pending',
      });
    });

    it('records the remote quote observation before rolling back the operation', async () => {
      await persistMeltQuote('quote-observed-rollback', 'PENDING');
      const pending = makePendingOp('op-observed-rollback', {
        quoteId: 'quote-observed-rollback',
      });
      await meltOperationRepository.create(pending);

      const order: string[] = [];
      (handler.fetchRemoteQuote as Mock<any>).mockImplementationOnce(
        async ({ quote }: { quote: MeltQuote<'bolt11'> }) =>
          meltQuoteFromBolt11Response(quote.mintUrl, {
            quote: quote.quoteId,
            request: quote.request,
            amount: quote.amount,
            unit: quote.unit,
            fee_reserve: quote.fee_reserve,
            expiry: quote.expiry,
            state: 'UNPAID',
            payment_preimage: null,
          }),
      );
      (handler.checkPending as Mock<any>).mockImplementation(
        async ({ canonicalQuote }: { canonicalQuote?: MeltQuote }) => {
          order.push(
            `decision:${canonicalQuote?.quoteId ?? 'missing'}:${canonicalQuote?.state ?? 'missing'}`,
          );
          return 'rollback';
        },
      );

      eventBus.on('melt-quote:updated', async () => {
        const stored = await meltOperationRepository.getById(pending.id);
        order.push(`quote-updated:${stored?.state ?? 'missing'}`);
      });
      eventBus.on('melt-op:rolled-back', () => {
        order.push('operation-rolled-back');
      });

      const result = await service.checkPendingOperation(pending.id);

      expect(result).toBe('rollback');
      expect(order).toEqual([
        'quote-updated:pending',
        'decision:quote-observed-rollback:UNPAID',
        'decision:quote-observed-rollback:UNPAID',
        'operation-rolled-back',
      ]);
      expect(handler.checkPending).toHaveBeenCalledTimes(2);
      await expect(
        meltQuoteRepository.getMeltQuote(mintUrl, 'bolt11', pending.quoteId),
      ).resolves.toMatchObject({
        state: 'UNPAID',
      });
      await expect(meltOperationRepository.getById(pending.id)).resolves.toMatchObject({
        state: 'rolled_back',
      });
    });

    it('delegates to finalize when handler returns finalize', async () => {
      const pending = makePendingOp('op-11');
      await meltOperationRepository.create(pending);

      (handler.checkPending as Mock<any>).mockResolvedValue('finalize');
      (service as any).finalize = mock(async () => {});

      const result = await service.checkPendingOperation('op-11');

      expect(result).toBe('finalize');
      expect((service as any).finalize).toHaveBeenCalledWith('op-11', {
        canonicalQuote: expect.objectContaining({ quoteId: 'quote-1', state: 'PENDING' }),
      });
    });
  });

  describe('recoverExecutingOperation', () => {
    it('finalizes when handler reports PAID', async () => {
      const executing = makeExecutingOp('recover-paid');
      await meltOperationRepository.create(executing);
      (handler.recoverExecuting as Mock<any>).mockResolvedValue({
        status: 'PAID',
        finalized: makeFinalizedOp('recover-paid'),
      });

      const events: any[] = [];
      eventBus.on('melt-op:finalized', (payload) => void events.push(payload));

      await service.recoverExecutingOperation(executing);

      const stored = await meltOperationRepository.getById('recover-paid');
      expect(stored?.state).toBe('finalized');
      expect(events.length).toBe(1);
    });

    it('moves to pending when handler reports PENDING', async () => {
      const executing = makeExecutingOp('recover-pending');
      await meltOperationRepository.create(executing);
      (handler.recoverExecuting as Mock<any>).mockResolvedValue({
        status: 'PENDING',
        pending: makePendingOp('recover-pending'),
      });

      const events: any[] = [];
      eventBus.on('melt-op:pending', (payload) => void events.push(payload));

      await service.recoverExecutingOperation(executing);

      const stored = await meltOperationRepository.getById('recover-pending');
      expect(stored?.state).toBe('pending');
      expect(events.length).toBe(1);
    });

    it('rolls back when handler reports FAILED', async () => {
      const executing = makeExecutingOp('recover-failed');
      await meltOperationRepository.create(executing);
      (handler.recoverExecuting as Mock<any>).mockResolvedValue({
        status: 'FAILED',
        failed: { error: 'quote unpaid' },
      });

      const events: any[] = [];
      eventBus.on('melt-op:rolled-back', (payload) => void events.push(payload));

      await service.recoverExecutingOperation(executing);

      const stored = await meltOperationRepository.getById('recover-failed');
      expect(stored?.state).toBe('rolled_back');
      expect((stored as RolledBackMeltOperation).error).toBe('quote unpaid');
      expect(events.length).toBe(1);
    });

    it('ignores operations that are no longer executing', async () => {
      const staleExecuting = makeExecutingOp('recover-stale');
      await meltOperationRepository.create(makePendingOp('recover-stale'));

      await service.recoverExecutingOperation(staleExecuting);

      expect(handler.recoverExecuting).not.toHaveBeenCalled();
      const stored = await meltOperationRepository.getById('recover-stale');
      expect(stored?.state).toBe('pending');
    });

    it('throws when recovery is already in progress for the operation', async () => {
      const executing = makeExecutingOp('recover-locked');
      await meltOperationRepository.create(executing);

      let releaseRecovery: () => void;
      const recoveryBlocked = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      let recoveryStarted: () => void;
      const recoveryStartedPromise = new Promise<void>((resolve) => {
        recoveryStarted = resolve;
      });
      (handler.recoverExecuting as Mock<any>).mockImplementation(
        async ({ operation }: { operation: ExecutingMeltOperation }) => {
          recoveryStarted();
          await recoveryBlocked;
          return {
            status: 'PENDING',
            pending: makePendingOp(operation.id),
          };
        },
      );

      const first = service.recoverExecutingOperation(executing);
      await recoveryStartedPromise;

      await expect(service.recoverExecutingOperation(executing)).rejects.toThrow(
        OperationInProgressError,
      );

      releaseRecovery!();
      await first;
    });
  });

  describe('recoverPendingOperations', () => {
    it('cleans up init operations and releases proofs', async () => {
      await meltOperationRepository.create(makeInitOp('init-op'));
      await proofRepository.saveProofs(mintUrl, [
        makeProof('reserved', { usedByOperationId: 'init-op' }),
      ]);

      await service.recoverPendingOperations();

      expect(await meltOperationRepository.getById('init-op')).toBeNull();
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['reserved']);
    });

    it('recovers executing operations via handler', async () => {
      await meltOperationRepository.create(makeExecutingOp('exec-op'));

      const events: any[] = [];
      eventBus.on('melt-op:pending', (payload) => void events.push(payload));

      await service.recoverPendingOperations();

      expect(handler.recoverExecuting).toHaveBeenCalled();
      expect(events.length).toBe(1);
    });

    it('leaves stale prepared operations untouched during recovery', async () => {
      const prepared = makePreparedOp('prepared-op');
      await meltOperationRepository.create(prepared);

      await service.recoverPendingOperations();

      expect(await meltOperationRepository.getById(prepared.id)).toMatchObject({
        id: prepared.id,
        state: 'prepared',
      });
      expect(handler.execute).not.toHaveBeenCalled();
      expect(handler.checkPending).not.toHaveBeenCalled();
      expect(handler.finalize).not.toHaveBeenCalled();
      expect(handler.recoverExecuting).not.toHaveBeenCalled();
    });
  });

  describe('queries', () => {
    it('returns pending operations', async () => {
      await meltOperationRepository.create(makeExecutingOp('pending-1'));
      await meltOperationRepository.create(makePendingOp('pending-2', { quoteId: 'quote-2' }));

      const pending = await service.getPendingOperations();

      expect(pending.map((op) => op.id).sort()).toEqual(['pending-1', 'pending-2']);
    });

    it('returns operation by quote id when present', async () => {
      const prepared = makePreparedOp('op-quote', { quoteId: 'quote-123' });
      await meltOperationRepository.create(prepared);

      const operation = await service.getOperationByQuote(mintUrl, 'bolt11', 'quote-123');

      expect(operation?.id).toBe('op-quote');
    });

    it('returns null when quote id is not found', async () => {
      await meltOperationRepository.create(makePreparedOp('op-quote', { quoteId: 'quote-456' }));

      const operation = await service.getOperationByQuote(mintUrl, 'bolt11', 'missing-quote');

      expect(operation).toBeNull();
    });

    it('returns tracked init operations by canonical quote identity', async () => {
      const init = makeInitOp('op-init-query');
      await meltOperationRepository.create(init);

      const operation = await service.getOperationByQuoteIdentity({
        mintUrl,
        quoteId: init.quoteId!,
      });

      expect(operation?.id).toBe(init.id);
      expect(operation?.state).toBe('init');
    });

    it('returns tracked early-failed init operations by canonical quote identity', async () => {
      const init = makeInitOp('op-init-failed-query', { error: 'prepare failed' });
      await meltOperationRepository.create(init);

      const operation = await service.getOperationByQuoteIdentity({
        mintUrl,
        quoteId: init.quoteId!,
      });

      expect(operation?.id).toBe(init.id);
      expect(operation?.state).toBe('init');
      expect(operation?.error).toBe('prepare failed');
    });

    it('returns null by quote identity when no canonical quote exists', async () => {
      const operation = await service.getOperationByQuoteIdentity({
        mintUrl,
        quoteId: 'missing-quote',
      });

      expect(operation).toBeNull();
    });

    it('returns null by quote identity when no operation is tracked', async () => {
      await persistMeltQuote('untracked-quote');

      const operation = await service.getOperationByQuoteIdentity({
        mintUrl,
        quoteId: 'untracked-quote',
      });

      expect(operation).toBeNull();
    });

    it('throws by quote identity when multiple operations are tracked', async () => {
      const mockedRepository = {
        getByQuoteId: mock(async () => [makeInitOp('op-dupe-1'), makeInitOp('op-dupe-2')]),
      } as unknown as MeltOperationRepository;
      const duplicateService = new MeltOperationService(
        handlerProvider,
        mockedRepository,
        quoteLifecycle,
        proofRepository,
        proofService,
        mintService,
        walletService,
        mintAdapter,
        eventBus,
        logger,
      );

      await expect(
        duplicateService.getOperationByQuoteIdentity({ mintUrl, quoteId: 'quote-1' }),
      ).rejects.toThrow('Found 2 melt operations');
    });

    it('rejects repository writes when multiple operations share a quote id', async () => {
      await meltOperationRepository.create(makePreparedOp('op-quote-1', { quoteId: 'quote-dupe' }));

      await expect(
        meltOperationRepository.create(makePreparedOp('op-quote-2', { quoteId: 'quote-dupe' })),
      ).rejects.toThrow('MeltOperation already exists');
    });
  });
});
