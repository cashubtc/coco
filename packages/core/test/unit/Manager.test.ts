import { Amount, type SerializedBlindedSignature } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock } from 'bun:test';

import { initializeCoco, type CocoConfig, Manager } from '../../Manager';
import { PaymentRequestsApi } from '../../api/PaymentRequestsApi';
import { QuoteApi } from '../../api/QuoteApi';
import type { CoreEvents } from '../../events/types';
import { meltQuoteFromBolt11Response } from '../../models/MeltQuote';
import { mintQuoteFromBolt11Response } from '../../models/MintQuote';
import type { PendingMeltOperation } from '../../operations/melt';
import type { PendingMintOperation } from '../../operations/mint';
import { MemoryRepositories } from '../../repositories/memory';
import { NullLogger } from '../../logging';
import type { FinalizedReceiveOperation } from '../../operations/receive/ReceiveOperation';
import type { CoreProof } from '../../types';

describe('initializeCoco', () => {
  let repositories: MemoryRepositories;
  let seedGetter: () => Promise<Uint8Array>;
  let baseConfig: Pick<CocoConfig, 'repo' | 'seedGetter'>;

  beforeEach(() => {
    repositories = new MemoryRepositories();
    seedGetter = async () => new Uint8Array(32);
    baseConfig = {
      repo: repositories,
      seedGetter,
    };
  });

  describe('default behavior', () => {
    it('should enable all watchers and processors by default', async () => {
      const manager = await initializeCoco(baseConfig);

      // Check that manager is created
      expect(manager).toBeInstanceOf(Manager);

      // Verify watchers are running (they have isRunning methods)
      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);

      // Verify processors are running
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMeltQuoteWatcher();
      await manager.disableMintOperationProcessor();
      await manager.disableMeltSettlementProcessor();
    });

    it('should initialize repositories', async () => {
      const initSpy = mock(() => Promise.resolve());
      const mockRepo = Object.assign(Object.create(repositories), {
        init: initSpy,
      });

      await initializeCoco({
        ...baseConfig,
        repo: mockRepo,
      });

      expect(initSpy).toHaveBeenCalled();
    });

    it('should expose the dedicated payment requests api', async () => {
      const manager = await initializeCoco(baseConfig);

      expect(manager.paymentRequests).toBeInstanceOf(PaymentRequestsApi);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should expose the dedicated quotes api', async () => {
      const manager = await initializeCoco(baseConfig);

      expect(manager.quotes).toBeInstanceOf(QuoteApi);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('does not reconcile canonical quote-only rows into mint operations on startup', async () => {
      await repositories.mintQuoteRepository.upsertMintQuote(
        mintQuoteFromBolt11Response('https://mint.test', {
          quote: 'quote-only-restart',
          request: 'lnbc1quoteonlyrestart',
          amount: Amount.from(10),
          unit: 'sat',
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'UNPAID',
        }),
      );

      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });

      const operations =
        await repositories.mintOperationRepository.getByMintUrl('https://mint.test');
      const pendingQuotes = await manager.quotes.mint.listPending();

      expect(operations).toHaveLength(0);
      expect(pendingQuotes.map((quote) => quote.quoteId)).toEqual(['quote-only-restart']);
    });

    it('projects mint history remote state from canonical quotes', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });
      const operation = makePendingMintOperation('mint-op-1', 'quote-1');
      await repositories.mintOperationRepository.create(operation);

      const observedRepositoryEntries: Array<CoreEvents['history:updated']['entry'] | null> = [];
      manager['eventBus'].on('history:updated', async ({ entry }) => {
        observedRepositoryEntries.push(
          await repositories.historyRepository.getHistoryEntryById(entry.id),
        );
      });

      const observedAt = 3_000;
      await repositories.mintQuoteRepository.upsertMintQuote(
        mintQuoteFromBolt11Response(operation.mintUrl, {
          quote: operation.quoteId,
          request: operation.request,
          amount: operation.amount,
          unit: operation.unit,
          expiry: operation.expiry,
          state: 'PAID',
        }),
      );

      await manager['eventBus'].emit('mint-op:pending', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: {
          ...operation,
          updatedAt: observedAt,
        },
      });

      expect(observedRepositoryEntries).toHaveLength(1);
      expect(observedRepositoryEntries[0]).toMatchObject({
        id: `mint:${operation.id}`,
        type: 'mint',
        operationId: operation.id,
        state: 'pending',
        remoteState: 'PAID',
      });
    });

    it('does not project history for quote-only updates', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });

      const observedRepositoryEntries: Array<CoreEvents['history:updated']['entry']> = [];
      manager['eventBus'].on('history:updated', ({ entry }) => {
        observedRepositoryEntries.push(entry);
      });

      const observedAt = 3_000;
      await manager['eventBus'].emit('mint-quote:updated', {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'quote-only',
        quote: {
          mintUrl: 'https://mint.test',
          method: 'bolt11',
          quoteId: 'quote-only',
          quote: 'quote-only',
          request: 'lnbc1quoteonly',
          amount: Amount.from(10),
          unit: 'sat',
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'PAID',
          lastObservedRemoteState: 'PAID',
          lastObservedRemoteStateAt: observedAt,
          reusable: false,
          quoteData: {
            amount: Amount.from(10),
          },
          createdAt: observedAt,
          updatedAt: observedAt,
        },
      });

      expect(observedRepositoryEntries).toHaveLength(0);
    });

    it('should use NullLogger by default', async () => {
      const manager = await initializeCoco(baseConfig);

      expect(manager['logger']).toBeInstanceOf(NullLogger);
      expect(manager.ops.send).toBeDefined();
      expect(manager.ops.receive).toBeDefined();
      expect(manager.ops.mint).toBeDefined();
      expect(manager.ops.melt).toBeDefined();

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should accept custom logger', async () => {
      const customLogger = new NullLogger();
      const manager = await initializeCoco({
        ...baseConfig,
        logger: customLogger,
      });

      expect(manager['logger']).toBe(customLogger);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should initialize plugins once before returning', async () => {
      const counters = { init: 0, ready: 0 };
      const extension = { ok: true };

      const manager = await initializeCoco({
        ...baseConfig,
        plugins: [
          {
            name: 'plugin-init',
            required: [],
            onInit: (ctx) => {
              counters.init += 1;
              ctx.registerExtension('pluginInit', extension);
            },
            onReady: () => {
              counters.ready += 1;
            },
          },
        ],
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });

      expect(counters).toEqual({ init: 1, ready: 1 });
      expect((manager.ext as Record<string, unknown>).pluginInit).toBe(extension);
    });

    it('should recover payment-request receive attempts during startup', async () => {
      const now = Date.now();
      await repositories.paymentRequestReceiveOperationRepository.create({
        id: 'payment-request-receive-1',
        requestId: 'request-id',
        encodedRequest: 'CREQB-test',
        state: 'active',
        transport: 'inband',
        amount: Amount.from(100),
        unit: 'sat',
        mints: ['https://mint.test'],
        singleUse: true,
        createdAt: now,
        updatedAt: now,
      });
      await repositories.paymentRequestReceiveAttemptRepository.create({
        id: 'attempt-1',
        requestOperationId: 'payment-request-receive-1',
        requestId: 'request-id',
        transport: 'inband',
        payloadHash: 'payload-hash-1',
        mintUrl: 'https://mint.test',
        unit: 'sat',
        grossAmount: Amount.from(100),
        receiveOperationId: 'receive-op-1',
        state: 'receiving',
        createdAt: now,
        updatedAt: now,
      });
      await repositories.receiveOperationRepository.create({
        id: 'receive-op-1',
        state: 'finalized',
        mintUrl: 'https://mint.test',
        unit: 'sat',
        amount: Amount.from(100),
        fee: Amount.from(1),
        inputProofs: [],
        outputData: { keep: [], send: [] },
        source: {
          type: 'payment-request',
          requestOperationId: 'payment-request-receive-1',
          requestId: 'request-id',
          attemptId: 'attempt-1',
          transport: 'inband',
        },
        createdAt: now,
        updatedAt: now,
      } satisfies FinalizedReceiveOperation);

      await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });

      const attempt =
        await repositories.paymentRequestReceiveAttemptRepository.getById('attempt-1');
      const operation = await repositories.paymentRequestReceiveOperationRepository.getById(
        'payment-request-receive-1',
      );

      expect(attempt?.state).toBe('finalized');
      expect(attempt?.fee?.equals(Amount.from(1))).toBe(true);
      expect(attempt?.netAmount?.equals(Amount.from(99))).toBe(true);
      expect(operation?.state).toBe('completed');
    });
  });

  function makePendingMintOperation(id: string, quoteId: string): PendingMintOperation {
    return {
      id,
      state: 'pending',
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(100),
      unit: 'sat',
      quoteId,
      request: 'lnbc100',
      expiry: null,
      outputData: { keep: [], send: [] },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
  }

  function makePendingMeltOperation(
    id: string,
    quoteId: string,
    overrides: Partial<PendingMeltOperation> = {},
  ): PendingMeltOperation {
    return {
      id,
      state: 'pending',
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      methodData: { invoice: 'lnbc100' },
      amount: Amount.from(100),
      quoteId,
      fee_reserve: Amount.from(1),
      swap_fee: Amount.from(0),
      needsSwap: false,
      inputAmount: Amount.from(101),
      inputProofSecrets: [`input-${id}`],
      changeOutputData: { keep: [], send: [] },
      createdAt: 1_000,
      updatedAt: 2_000,
      ...overrides,
      unit: overrides.unit ?? 'sat',
    };
  }

  function makeInputProof(secret: string, operationId: string): CoreProof {
    return {
      amount: Amount.from(101),
      C: `C_${secret}`,
      id: 'keyset-1',
      secret,
      mintUrl: 'https://mint.test',
      unit: 'sat',
      state: 'ready',
      usedByOperationId: operationId,
    };
  }

  function makeMeltQuote(
    quoteId: string,
    state: 'UNPAID' | 'PENDING' | 'PAID',
    options: { expired?: boolean; change?: SerializedBlindedSignature[] } = {},
  ) {
    return meltQuoteFromBolt11Response('https://mint.test', {
      quote: quoteId,
      request: 'lnbc100',
      amount: Amount.from(100),
      unit: 'sat',
      fee_reserve: Amount.from(1),
      expiry: Math.floor(Date.now() / 1000) + (options.expired ? -60 : 3600),
      state,
      payment_preimage: state === 'PAID' ? 'preimage-123' : null,
      change: options.change,
    });
  }

  const flushDeferredInitialChecks = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  };

  describe('melt watcher and settlement lifecycle', () => {
    it('starts melt quote watching and settlement processing by default', async () => {
      const manager = await initializeCoco(baseConfig);

      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('resumes pending canonical melt quote watches and pending operation interest on startup', async () => {
      await repositories.init();
      const canonicalQuote = makeMeltQuote('melt-canonical-startup', 'PENDING');
      const expiredOperationQuote = makeMeltQuote('melt-expired-operation-startup', 'PENDING', {
        expired: true,
      });
      const expiredOperation = makePendingMeltOperation(
        'melt-op-expired-startup',
        expiredOperationQuote.quoteId,
      );

      await repositories.meltQuoteRepository.upsertMeltQuote(canonicalQuote);
      await repositories.meltQuoteRepository.upsertMeltQuote(expiredOperationQuote);
      await repositories.meltOperationRepository.create(expiredOperation);

      const manager = new Manager(repositories, seedGetter, new NullLogger());
      await manager.initPlugins();
      manager.subscriptions.pause();
      manager['mintService'].isTrustedMint = mock(async () => true);
      const checkPendingOperation = mock(async () => 'stay_pending' as const);
      manager['meltOperationService'].checkPendingOperation = checkPendingOperation;

      await manager.enableMeltQuoteWatcher();
      await manager.enableMeltSettlementProcessor();
      await flushDeferredInitialChecks();

      const subscriptionInternals = manager.subscriptions as unknown as {
        subscriptions: Map<string, { kind: string; filters: string[] }>;
      };
      const subscriptions = Array.from(subscriptionInternals.subscriptions.values());

      expect(subscriptions).toHaveLength(2);
      expect(subscriptions.map((subscription) => subscription.kind).sort()).toEqual([
        'bolt11_melt_quote',
        'bolt11_melt_quote',
      ]);
      expect(subscriptions.map((subscription) => subscription.filters[0]).sort()).toEqual([
        'melt-canonical-startup',
        'melt-expired-operation-startup',
      ]);
      expect(checkPendingOperation).toHaveBeenCalledWith(expiredOperation.id);

      await manager.dispose();
    });

    it('attaches melt quote watching when settlement processing starts first', async () => {
      await repositories.init();
      const expiredOperationQuote = makeMeltQuote('melt-expired-operation-first', 'PENDING', {
        expired: true,
      });
      const expiredOperation = makePendingMeltOperation(
        'melt-op-expired-first',
        expiredOperationQuote.quoteId,
      );

      await repositories.meltQuoteRepository.upsertMeltQuote(expiredOperationQuote);
      await repositories.meltOperationRepository.create(expiredOperation);

      const manager = new Manager(repositories, seedGetter, new NullLogger());
      await manager.initPlugins();
      manager.subscriptions.pause();
      manager['mintService'].isTrustedMint = mock(async () => true);
      const checkPendingOperation = mock(async () => 'stay_pending' as const);
      manager['meltOperationService'].checkPendingOperation = checkPendingOperation;

      await manager.enableMeltSettlementProcessor();
      await manager.enableMeltQuoteWatcher();
      await flushDeferredInitialChecks();

      const subscriptionInternals = manager.subscriptions as unknown as {
        subscriptions: Map<string, { kind: string; filters: string[] }>;
      };
      const subscriptions = Array.from(subscriptionInternals.subscriptions.values());

      expect(subscriptions).toHaveLength(1);
      expect(subscriptions.map((subscription) => subscription.kind)).toEqual(['bolt11_melt_quote']);
      expect(subscriptions.map((subscription) => subscription.filters[0])).toEqual([
        'melt-expired-operation-first',
      ]);
      expect(checkPendingOperation).toHaveBeenCalledWith(expiredOperation.id);

      await manager.dispose();
    });

    it('settles a pending melt operation from a canonical melt quote update', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });
      manager.subscriptions.pause();
      manager['mintService'].isTrustedMint = mock(async () => true);

      const operation = makePendingMeltOperation('melt-op-settle', 'melt-quote-settle');
      await repositories.proofRepository.saveProofs('https://mint.test', [
        makeInputProof(operation.inputProofSecrets[0]!, operation.id),
      ]);
      await repositories.meltOperationRepository.create(operation);
      await repositories.meltQuoteRepository.upsertMeltQuote(
        makeMeltQuote(operation.quoteId, 'PENDING'),
      );

      await manager['eventBus'].emit('melt-op:pending', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });

      const paidQuote = makeMeltQuote(operation.quoteId, 'PAID', { change: [] });
      await repositories.meltQuoteRepository.upsertMeltQuote(paidQuote);
      await manager['eventBus'].emit('melt-quote:updated', {
        mintUrl: paidQuote.mintUrl,
        method: paidQuote.method,
        quoteId: paidQuote.quoteId,
        quote: paidQuote,
      });
      await flushDeferredInitialChecks();

      await expect(
        repositories.meltOperationRepository.getById(operation.id),
      ).resolves.toMatchObject({
        state: 'finalized',
        finalizedData: { preimage: 'preimage-123' },
      });
      await expect(
        repositories.proofRepository.getProofBySecret(
          operation.mintUrl,
          operation.inputProofSecrets[0]!,
        ),
      ).resolves.toMatchObject({ state: 'spent' });

      await manager.dispose();
    });
  });

  describe('watchers configuration', () => {
    it('should disable mintOperationWatcher when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
        },
      });

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should disable proofStateWatcher when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          proofStateWatcher: { disabled: true },
        },
      });

      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should disable meltQuoteWatcher when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          meltQuoteWatcher: { disabled: true },
        },
      });

      expect(manager['meltQuoteWatcher']).toBeUndefined();
      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should disable all watchers when all are explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
        },
      });

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['meltQuoteWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should pass options to mintOperationWatcher when not disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: {
            watchExistingPendingOnStart: false,
          },
        },
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should enable with options even when disabled is explicitly false', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: {
            disabled: false,
            watchExistingPendingOnStart: true,
          },
        },
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should pass options to meltQuoteWatcher when not disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          meltQuoteWatcher: {
            watchExistingPendingQuotesOnStart: false,
          },
        },
      });

      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);

      await manager.dispose();
    });
  });

  describe('processors configuration', () => {
    it('should disable mintOperationProcessor when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });

      expect(manager['mintOperationProcessor']).toBeUndefined();
      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
    });

    it('should disable meltSettlementProcessor when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          meltSettlementProcessor: { disabled: true },
        },
      });

      expect(manager['meltSettlementProcessor']).toBeUndefined();
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should pass options to mintOperationProcessor when not disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          mintOperationProcessor: {
            processIntervalMs: 5000,
            maxRetries: 3,
          },
        },
      });

      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should enable with options even when disabled is explicitly false', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          mintOperationProcessor: {
            disabled: false,
            processIntervalMs: 1000,
          },
        },
      });

      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should pass options to meltSettlementProcessor when not disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          meltSettlementProcessor: {
            initializeExistingPendingOperationsOnStart: false,
          },
        },
      });

      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });
  });

  describe('mixed configuration', () => {
    it('should handle mixed enabled/disabled watchers and processors', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: false },
        },
        processors: {
          mintOperationProcessor: { disabled: false },
        },
      });

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should support options with mixed configuration', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: {
            watchExistingPendingOnStart: false,
          },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: {
            processIntervalMs: 10000,
            maxRetries: 5,
          },
        },
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });
  });

  describe('plugins', () => {
    it('should initialize with plugins', async () => {
      const pluginInitMock = mock(() => {});
      const plugin = {
        name: 'test-plugin',
        required: [] as const,
        onInit: pluginInitMock,
      };

      const manager = await initializeCoco({
        ...baseConfig,
        plugins: [plugin],
      });

      // Wait a bit for async plugin initialization
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(pluginInitMock).toHaveBeenCalled();

      await manager.dispose();
    });

    it('should reject duplicate plugin instance registration', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });
      const plugin = {
        name: 'duplicate-plugin',
        required: [] as const,
      };

      manager.use(plugin);

      expect(() => manager.use(plugin)).toThrow('Plugin "duplicate-plugin" is already registered');
    });
  });

  describe('dispose', () => {
    it('should stop owned watchers, processors, and active subscriptions', async () => {
      const manager = await initializeCoco(baseConfig);
      const subscriptionInternals = manager.subscriptions as unknown as {
        subscriptions: Map<string, unknown>;
        activeByMint: Map<string, Set<string>>;
        transportByMint: Map<string, unknown>;
      };

      manager.subscriptions.pause();
      await manager.subscriptions.subscribe('https://mint.test', 'bolt11_mint_quote', ['quote-1']);

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);
      expect(subscriptionInternals.subscriptions.size).toBe(1);
      expect(subscriptionInternals.activeByMint.size).toBe(1);
      expect(subscriptionInternals.transportByMint.size).toBe(1);

      await manager.dispose();

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['meltQuoteWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']).toBeUndefined();
      expect(manager['meltSettlementProcessor']).toBeUndefined();
      expect(subscriptionInternals.subscriptions.size).toBe(0);
      expect(subscriptionInternals.activeByMint.size).toBe(0);
      expect(subscriptionInternals.transportByMint.size).toBe(0);
    });

    it('should run plugin disposal and cleanup only once', async () => {
      const onDispose = mock(() => {});
      const cleanup = mock(() => {});

      const manager = await initializeCoco({
        ...baseConfig,
        plugins: [
          {
            name: 'dispose-plugin',
            required: [] as const,
            onInit: () => cleanup,
            onDispose,
          },
        ],
      });

      await manager.dispose();
      await manager.dispose();

      expect(onDispose).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('should not recreate subscription transports during plugin cleanup', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        plugins: [
          {
            name: 'subscription-cleanup-plugin',
            required: ['subscriptions'] as const,
            onInit: async ({ services }) => {
              services.subscriptions.pause();
              const subscription = await services.subscriptions.subscribe(
                'https://mint.test',
                'bolt11_mint_quote',
                ['quote-plugin'],
              );
              return () => subscription.unsubscribe();
            },
          },
        ],
      });
      const subscriptionInternals = manager.subscriptions as unknown as {
        subscriptions: Map<string, unknown>;
        activeByMint: Map<string, Set<string>>;
        transportByMint: Map<string, unknown>;
      };

      expect(subscriptionInternals.subscriptions.size).toBe(1);
      expect(subscriptionInternals.activeByMint.size).toBe(1);
      expect(subscriptionInternals.transportByMint.size).toBe(1);

      await manager.dispose();

      expect(subscriptionInternals.subscriptions.size).toBe(0);
      expect(subscriptionInternals.activeByMint.size).toBe(0);
      expect(subscriptionInternals.transportByMint.size).toBe(0);
    });

    it('should not restart background work after disposal', async () => {
      const manager = await initializeCoco(baseConfig);

      await manager.dispose();
      await manager.resumeSubscriptions();
      await manager.enableMintOperationWatcher();
      await manager.enableProofStateWatcher();
      await manager.enableMintOperationProcessor();
      await manager.enableMeltQuoteWatcher();
      await manager.enableMeltSettlementProcessor();

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['meltQuoteWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']).toBeUndefined();
      expect(manager['meltSettlementProcessor']).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty watchers config object', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {},
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should handle empty processors config object', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {},
      });

      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should handle empty config objects for both watchers and processors', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {},
        processors: {},
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should handle all features disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
        },
      });

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['meltQuoteWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']).toBeUndefined();
      expect(manager['meltSettlementProcessor']).toBeUndefined();

      // Should still have API access
      expect(manager.mint).toBeDefined();
      expect(manager.wallet).toBeDefined();
    });
  });

  describe('API availability', () => {
    it('should expose all public APIs regardless of watcher/processor config', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
        },
      });

      expect(manager.mint).toBeDefined();
      expect(manager.wallet).toBeDefined();
      expect(manager.history).toBeDefined();
      expect(manager.subscriptions).toBeDefined();
    });

    it('exposes typed event subscription helpers and manager-owned event side effects', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
        },
      });

      const observedCounters: number[] = [];
      const onCounter = ({ counter }: CoreEvents['counter:updated']) => {
        observedCounters.push(counter);
      };
      manager.on('counter:updated', onCounter);
      await manager['eventBus'].emit('counter:updated', {
        counter: 1,
        keysetId: 'keyset-1',
        mintUrl: 'https://mint.test',
      });
      manager.off('counter:updated', onCounter);
      await manager['eventBus'].emit('counter:updated', {
        counter: 2,
        keysetId: 'keyset-1',
        mintUrl: 'https://mint.test',
      });

      const onceCounters: number[] = [];
      manager.once('counter:updated', ({ counter }) => {
        onceCounters.push(counter);
      });
      await manager['eventBus'].emit('counter:updated', {
        counter: 3,
        keysetId: 'keyset-1',
        mintUrl: 'https://mint.test',
      });
      await manager['eventBus'].emit('counter:updated', {
        counter: 4,
        keysetId: 'keyset-1',
        mintUrl: 'https://mint.test',
      });

      const closeMint = mock(() => undefined);
      manager.subscriptions.closeMint = closeMint;
      const clearCache = mock(() => undefined);
      manager['walletService'].clearCache = clearCache;

      await manager['eventBus'].emit('mint:untrusted', { mintUrl: 'https://mint.test' });
      await manager['eventBus'].emit('auth-session:updated', { mintUrl: 'https://mint.test' });
      await manager['eventBus'].emit('auth-session:deleted', { mintUrl: 'https://mint.test' });

      expect(observedCounters).toEqual([1]);
      expect(onceCounters).toEqual([3]);
      expect(closeMint).toHaveBeenCalledWith('https://mint.test');
      expect(clearCache).toHaveBeenCalledTimes(2);
      expect(clearCache).toHaveBeenCalledWith('https://mint.test');
    });

    it('requeues pending mint operations backed by paid canonical quotes', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
        },
      });
      const operation = makePendingMintOperation('mint-op-paid', 'quote-paid');
      await repositories.mintOperationRepository.create(operation);
      await repositories.mintQuoteRepository.upsertMintQuote(
        mintQuoteFromBolt11Response(operation.mintUrl, {
          quote: operation.quoteId,
          request: operation.request,
          amount: operation.amount,
          unit: operation.unit,
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'PAID',
        }),
      );

      manager['mintService'].isTrustedMint = mock(async () => true);
      const requeuedOperationIds: string[] = [];
      manager.on('mint-op:requeue', ({ operationId }) => {
        requeuedOperationIds.push(operationId);
      });

      const result = await manager.requeuePaidMintQuotes();

      expect(result.requeued).toEqual([operation.quoteId]);
      expect(requeuedOperationIds).toEqual([operation.id]);
    });
  });

  describe('pause and resume subscriptions', () => {
    it('should pause and stop all watchers and processors', async () => {
      const manager = await initializeCoco(baseConfig);

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.pauseSubscriptions();

      // After pause, watchers and processor are disabled (set to undefined)
      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['meltQuoteWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']).toBeUndefined();
      expect(manager['meltSettlementProcessor']).toBeUndefined();
    });

    it('should resume and restart all watchers and processors', async () => {
      const manager = await initializeCoco(baseConfig);

      await manager.pauseSubscriptions();
      await manager.resumeSubscriptions();

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should be idempotent - multiple pause calls should not error', async () => {
      const manager = await initializeCoco(baseConfig);

      await manager.pauseSubscriptions();
      await manager.pauseSubscriptions();
      await manager.pauseSubscriptions();

      // After pause, watchers and processor are disabled (set to undefined)
      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['meltQuoteWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']).toBeUndefined();
      expect(manager['meltSettlementProcessor']).toBeUndefined();
    });

    it('should be idempotent - multiple resume calls should not error', async () => {
      const manager = await initializeCoco(baseConfig);

      await manager.pauseSubscriptions();
      await manager.resumeSubscriptions();
      await manager.resumeSubscriptions();
      await manager.resumeSubscriptions();

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should handle resume without prior pause (OS connection teardown scenario)', async () => {
      const manager = await initializeCoco(baseConfig);

      // Simulate OS killing connections - just call resume without pause
      await manager.resumeSubscriptions();

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should respect original configuration - disabled watchers stay disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: false },
          meltQuoteWatcher: { disabled: false },
        },
        processors: {
          mintOperationProcessor: { disabled: false },
          meltSettlementProcessor: { disabled: false },
        },
      });

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.pauseSubscriptions();
      await manager.resumeSubscriptions();

      // mintOperationWatcher should remain undefined (was disabled)
      expect(manager['mintOperationWatcher']).toBeUndefined();
      // Others should be running again
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
      expect(manager['meltSettlementProcessor']?.isRunning()).toBe(true);

      await manager.dispose();
    });

    it('should respect original configuration - disabled processor stays disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: false },
          proofStateWatcher: { disabled: false },
          meltQuoteWatcher: { disabled: false },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
        },
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']).toBeUndefined();
      expect(manager['meltSettlementProcessor']).toBeUndefined();

      await manager.pauseSubscriptions();
      await manager.resumeSubscriptions();

      // Watchers should be running again
      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['meltQuoteWatcher']?.isRunning()).toBe(true);
      // Processor should remain undefined (was disabled)
      expect(manager['mintOperationProcessor']).toBeUndefined();
      expect(manager['meltSettlementProcessor']).toBeUndefined();

      await manager.dispose();
    });

    it('should handle all features disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
        },
      });

      await manager.pauseSubscriptions();
      await manager.resumeSubscriptions();

      // All should remain undefined
      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['meltQuoteWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']).toBeUndefined();
      expect(manager['meltSettlementProcessor']).toBeUndefined();
    });
  });
});
