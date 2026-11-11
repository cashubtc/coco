import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Amount, RateLimitError, Wallet, type MintQuoteBolt11Response } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { MintSwapChildOperationError } from '../../operations/mintSwap/MintSwapErrors.ts';
import { MintSwapInvariantError } from '../../operations/mintSwap/MintSwapErrors.ts';
import { flagMintSwapAttention } from '../../operations/mintSwap/MintSwapTransitions.ts';
import { MintService } from '../../services/MintService.ts';
import { MintOperationService } from '../../operations/mint/MintOperationService.ts';
import { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import { initializeCoco, Manager, type CocoConfig } from '../../Manager.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { meltQuoteFromBolt11Response } from '../../models/MeltQuote.ts';
import { MintAdapter } from '../../infra/MintAdapter.ts';
import { PollingTransport } from '../../infra/PollingTransport.ts';
import { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import type { MintSwapOperation } from '../../operations/mintSwap/MintSwapOperation.ts';
import type { MintSwapOperationService } from '../../operations/mintSwap/MintSwapOperationService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import type { Logger } from '../../logging/Logger.ts';
import { deferred, mintSwapRuntimeConfig } from '../fixtures/MintSwapRuntime.ts';
import {
  mintSwapFixture,
  outputProofs,
  pubkey,
  invoice,
} from '../../../adapter-tests/src/internal/mintSwap/fixture.ts';

// Exercise the real Manager, workflows, handlers, wallets and watchers. Only protocol I/O is stubbed.
type Runtime = {
  meltOperationService: MeltOperationService;
  mintOperationService: MintOperationService;
  mintAdapter: MintAdapter;
  quoteLifecycle: QuoteLifecycle;
  walletService: WalletService;
  mintSwapOperationService: MintSwapOperationService;
  createSubscriptionManager(): SubscriptionManager;
};

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Runtime did not settle')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Counts ordinary background work that skipped a matching target because its parent was active.
 * The returned function resolves once that many skips have happened.
 */
function observeSkips<T>(
  service: { canResolve(target: T): Promise<boolean> },
  matches: (target: T) => boolean,
): (count: number) => Promise<void> {
  let skips = 0;
  const waiters: { count: number; resolve: () => void }[] = [];
  const canResolve = service.canResolve;
  spyOn(service, 'canResolve').mockImplementation(async function (this: unknown, target: T) {
    const allowed = await canResolve.call(this, target);
    if (!allowed && matches(target)) {
      skips++;
      for (const waiter of waiters) if (waiter.count <= skips) waiter.resolve();
    }
    return allowed;
  });
  return (count) => {
    const reached = deferred();
    waiters.push({ count, resolve: reached.resolve });
    if (skips >= count) reached.resolve();
    return reached.promise;
  };
}

describe('Mint Swap real runtime boundaries', () => {
  const managers: Manager[] = [];
  beforeEach(() => {
    spyOn(Date, 'now').mockReturnValue(10_000);
  });
  afterEach(async () => {
    for (const manager of managers.splice(0)) await within(manager.dispose());
    mock.restore();
  });

  async function setup({
    logger,
    prepared = true,
    repo = new MemoryRepositories(),
    initialize = true,
    ...selection
  }: Pick<CocoConfig, 'watchers' | 'processors' | 'subscriptions'> & {
    logger?: Logger;
    prepared?: boolean;
    repo?: Repositories;
    initialize?: boolean;
  } = {}) {
    const fixture = await mintSwapFixture(repo, { initialize });
    fixture.preparation.seed = new Uint8Array(64).fill(2);
    const prepareAfterInitialization =
      prepared &&
      !!selection.processors?.mintSwapOperationProcessor &&
      !selection.processors.mintSwapOperationProcessor.disabled;
    if (prepared && !prepareAfterInitialization) {
      await fixture.create();
      await fixture.prepare();
    }
    let sourceState: 'PENDING' | 'PAID' | 'UNPAID' = 'UNPAID';
    let destinationState: 'UNPAID' | 'PAID' | 'ISSUED' = 'UNPAID';
    const sourceResponse = (quoteId = 'source-quote') => ({
      quote: quoteId,
      method: 'bolt11' as const,
      request: invoice,
      amount: Amount.from(8),
      unit: 'sat',
      fee_reserve: Amount.zero(),
      expiry: 100_000,
      state: sourceState,
      change: [],
      payment_preimage: null,
    });
    const destinationResponse = (quoteId = 'destination-quote'): MintQuoteBolt11Response => ({
      quote: quoteId,
      request: invoice,
      amount: Amount.from(8),
      unit: 'sat',
      expiry: 100_000,
      pubkey,
      method: 'bolt11',
      state: destinationState,
      amount_paid: Amount.from(destinationState === 'UNPAID' ? 0 : 8),
      amount_issued: Amount.from(destinationState === 'ISSUED' ? 8 : 0),
      updated_at: null,
    });
    const sourceCheck = spyOn(MintAdapter.prototype, 'checkMeltQuote').mockImplementation(
      async (_mintUrl, quoteId) => sourceResponse(quoteId),
    );
    const destinationCheck = spyOn(MintAdapter.prototype, 'checkMintQuote').mockImplementation(
      (async (_mintUrl: string, _method: string, quoteId: string) =>
        destinationResponse(quoteId)) as MintAdapter['checkMintQuote'],
    );
    const melt = spyOn(MintAdapter.prototype, 'customMeltBolt11').mockImplementation(
      async (_mintUrl, _proofs, _outputs, quoteId) => sourceResponse(quoteId),
    );
    const issuance = spyOn(Wallet.prototype, 'mintProofsBolt11').mockImplementation(
      async (_amount, quoteId) => {
        const children = await repo.mintOperationRepository.getByQuoteId(
          fixture.parent.destinationMintUrl,
          'bolt11',
          String(quoteId),
        );
        const child = children.find((candidate) => candidate.state === 'executing');
        if (!child) throw new Error('Missing executing child');
        destinationState = 'ISSUED';
        return outputProofs(child.outputData);
      },
    );
    spyOn(Manager.prototype as unknown as Runtime, 'createSubscriptionManager').mockImplementation(
      function (this: Runtime) {
        return new SubscriptionManager(
          new PollingTransport(
            this.mintAdapter,
            { intervalMs: selection.subscriptions?.fastPollingIntervalMs ?? 60_000 },
            undefined,
            this.quoteLifecycle,
          ),
          this.mintAdapter,
        );
      },
    );
    if (!initialize) {
      sourceState = 'PAID';
      destinationState = 'PAID';
    }
    sourceCheck.mockClear();
    destinationCheck.mockClear();
    melt.mockClear();
    issuance.mockClear();
    let events!: import('../../events/EventBus.ts').EventBus<
      import('../../events/types.ts').CoreEvents
    >;
    const manager = await initializeCoco({
      repo,
      seedGetter: async () => new Uint8Array(64).fill(2),
      logger,
      plugins: [
        {
          name: 'fixture-events',
          required: ['eventBus'],
          onReady: ({ services }) => {
            events = services.eventBus;
          },
        },
      ],
      ...mintSwapRuntimeConfig,
      processors: {
        ...mintSwapRuntimeConfig.processors,
        mintSwapOperationProcessor: { disabled: true },
        ...selection.processors,
      },
      watchers: {
        ...mintSwapRuntimeConfig.watchers,
        ...(selection.watchers?.mintOperationWatcher
          ? {
              mintOperationWatcher: {
                watchExistingPendingOnStart: false,
                watchExistingPendingQuotesOnStart: false,
                ...selection.watchers.mintOperationWatcher,
              },
            }
          : {}),
        ...(selection.watchers?.meltQuoteWatcher
          ? {
              meltQuoteWatcher: {
                watchExistingPendingQuotesOnStart: false,
                ...selection.watchers.meltQuoteWatcher,
              },
            }
          : {}),
      },
    });
    sourceState = 'PAID';
    destinationState = 'PAID';
    if (prepareAfterInitialization) {
      await fixture.create();
      await fixture.prepare();
    }
    managers.push(manager);
    return {
      manager,
      async publishQuotes(kind?: 'mint' | 'melt') {
        if (!kind || kind === 'mint') {
          const quote = await manager.quotes.mint.get({
            mintUrl: fixture.parent.destinationMintUrl,
            quoteId: 'destination-quote',
          });
          if (quote)
            await events.emit('mint-quote:updated', {
              mintUrl: quote.mintUrl,
              method: quote.method,
              quoteId: quote.quoteId,
              quote,
            });
        }
        if (!kind || kind === 'melt') {
          const quote = await manager.quotes.melt.get({
            mintUrl: fixture.parent.sourceMintUrl,
            quoteId: 'source-quote',
          });
          if (quote)
            await events.emit('melt-quote:updated', {
              mintUrl: quote.mintUrl,
              method: quote.method,
              quoteId: quote.quoteId,
              quote,
            });
        }
      },
      runtime: manager as unknown as Runtime,
      repo,
      fixture,
      issuance,
      melt,
      sourceCheck,
      destinationCheck,
      sourceResponse,
      destinationResponse,
      setSourceState: (state: typeof sourceState) => {
        sourceState = state;
      },
      setDestinationState: (state: typeof destinationState) => {
        destinationState = state;
      },
    };
  }

  for (const phase of ['startup', 'runtime'] as const) {
    for (const setupOutcome of ['blocked', 'failed'] as const) {
      it(`advances cached parent evidence at ${phase} while destination observation setup is ${setupOutcome}`, async () => {
        const env = await setup();
        let { manager, runtime } = env;
        const { fixture, repo, sourceCheck, destinationCheck, issuance } = env;
        env.setSourceState('PENDING');
        await manager.ops.mintSwap.execute('swap');
        await runtime.mintSwapOperationService.reconcileInBackground('swap');
        const pending = (await manager.ops.mintSwap.get('swap'))!;
        expect(pending.state).toBe('source_pending');
        expect(pending.retry.nextAttemptAt).toBeGreaterThan(Date.now());
        env.setSourceState('PAID');
        await runtime.quoteLifecycle.recordMeltQuoteObservation(
          meltQuoteFromBolt11Response(fixture.parent.sourceMintUrl, env.sourceResponse()),
        );
        await runtime.quoteLifecycle.recordMintQuoteSnapshot(
          fixture.parent.destinationMintUrl,
          'bolt11',
          env.destinationResponse(),
        );
        const entered = deferred();
        const release = deferred();
        const unsubscribe = mock(async () => {});
        const progressed = deferred();
        const subscribe = mock(async () => {
          entered.resolve();
          await release.promise;
          if (setupOutcome === 'failed') throw new Error('Observation setup unavailable');
          return { subId: 'delayed-parent', unsubscribe };
        });
        try {
          await manager.dispose();
          sourceCheck.mockClear();
          destinationCheck.mockClear();
          if (phase === 'startup') spyOn(Date, 'now').mockReturnValue(30_000);
          manager = await within(
            initializeCoco({
              repo,
              seedGetter: async () => new Uint8Array(64).fill(2),
              ...mintSwapRuntimeConfig,
              watchers: {
                ...mintSwapRuntimeConfig.watchers,
                mintOperationWatcher: {
                  watchExistingPendingOnStart: false,
                  watchExistingPendingQuotesOnStart: false,
                },
              },
              processors: {
                ...mintSwapRuntimeConfig.processors,
                mintSwapOperationProcessor: { processIntervalMs: 5 },
              },
              plugins: [
                {
                  name: 'observe-startup',
                  required: ['eventBus', 'subscriptions'],
                  onReady: ({ services }) => {
                    services.subscriptions.subscribe = subscribe;
                    services.eventBus.on('mint-swap:updated', ({ state }) => {
                      if (state === 'destination_pending') progressed.resolve();
                    });
                  },
                },
              ],
            }),
          );
          managers.push(manager);
          runtime = manager as unknown as Runtime;
          await within(entered.promise);
          if (phase === 'runtime') expect(await manager.ops.mintSwap.get('swap')).toEqual(pending);
          if (setupOutcome === 'failed') {
            release.resolve();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          spyOn(Date, 'now').mockReturnValue(30_000);
          await within(progressed.promise);
          expect((await repo.meltOperationRepository.getById('source-child'))?.state).toBe(
            'finalized',
          );
          expect((await repo.mintOperationRepository.getById('destination-child'))?.state).toBe(
            'finalized',
          );
          expect(issuance).toHaveBeenCalledTimes(1);
          expect(sourceCheck).not.toHaveBeenCalled();
          expect(destinationCheck).not.toHaveBeenCalled();
          expect(subscribe).toHaveBeenCalled();
          let stopped = false;
          const stopping = manager.dispose().then(() => {
            stopped = true;
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (setupOutcome === 'blocked') expect(stopped).toBe(false);
          release.resolve();
          await within(stopping);
          if (setupOutcome === 'blocked') expect(unsubscribe).toHaveBeenCalledTimes(1);
        } finally {
          release.resolve();
          await manager.dispose();
        }
      });
    }
  }

  it('advances a parent past another parent whose destination observation setup is blocked', async () => {
    const env = await setup({
      watchers: {
        mintOperationWatcher: {
          watchExistingPendingOnStart: false,
          watchExistingPendingQuotesOnStart: false,
        },
      },
      processors: { mintSwapOperationProcessor: { processIntervalMs: 5 } },
    });
    const { manager, repo } = env;
    // 'swap' sorts first, so a scan that awaited its setup would never reach 'swap-b'.
    const other = await mintSwapFixture(repo, { suffix: '-b' });
    other.preparation.seed = new Uint8Array(64).fill(2);
    await other.create();
    await other.prepare();
    env.setSourceState('PENDING');
    await manager.ops.mintSwap.execute('swap');
    await manager.ops.mintSwap.execute('swap-b');
    env.setSourceState('PAID');
    await manager.quotes.melt.refresh({
      mintUrl: other.parent.sourceMintUrl,
      quoteId: 'source-quote-b',
    });
    await manager.quotes.mint.refresh({
      mintUrl: other.parent.destinationMintUrl,
      quoteId: 'destination-quote-b',
    });
    env.sourceCheck.mockClear();

    // SubscriptionManager.subscribe resolves without a mint acknowledgement, so no transport fake
    // can hold acquisition open. Only the blocked quote is gated; every other call stays real.
    const entered = deferred();
    const release = deferred();
    const subscribe = manager.subscriptions.subscribe.bind(manager.subscriptions);
    spyOn(manager.subscriptions, 'subscribe').mockImplementation((async (
      ...args: Parameters<typeof subscribe>
    ) => {
      if (args[2].includes('destination-quote')) {
        entered.resolve();
        await release.promise;
      }
      return subscribe(...args);
    }) as typeof subscribe);
    const progressed = deferred();
    manager.on('mint-swap:updated', ({ operationId, state }) => {
      if (operationId === 'swap-b' && state === 'destination_pending') progressed.resolve();
    });
    try {
      spyOn(Date, 'now').mockReturnValue(30_000);
      await within(entered.promise);
      await within(progressed.promise);
      expect((await repo.meltOperationRepository.getById('source-child-b'))?.state).toBe(
        'finalized',
      );
      // 'swap' has no cached settlement yet, so only it may observe its source at startup.
      expect(env.sourceCheck.mock.calls.map(([, quoteId]) => quoteId)).not.toContain(
        'source-quote-b',
      );
    } finally {
      release.resolve();
      await manager.dispose();
    }
  });

  describe('startup across a persistent store reopen', () => {
    const directories: string[] = [];
    const databases: Database[] = [];

    afterEach(() => {
      for (const database of databases.splice(0)) database.close();
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    function openStore(path: string) {
      const database = new Database(path);
      databases.push(database);
      return new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    }

    /** Persist one parent state, then scan it from a new Session over the reopened database. */
    async function restartAndScan(
      persist: (env: Awaited<ReturnType<typeof setup>>) => Promise<void>,
      expectedState: MintSwapOperation['state'],
    ) {
      const directory = mkdtempSync(join(tmpdir(), 'mint-swap-startup-'));
      directories.push(directory);
      const path = join(directory, 'wallet.sqlite');
      const before = await setup({ prepared: true, repo: openStore(path) });
      await persist(before);
      expect((await before.manager.ops.mintSwap.get('swap'))?.state).toBe(expectedState);
      await within(before.manager.dispose());
      databases.pop()!.close();

      spyOn(Date, 'now').mockReturnValue(30_000);
      const after = await setup({
        prepared: false,
        repo: openStore(path),
        initialize: false,
        processors: { mintSwapOperationProcessor: { processIntervalMs: 60_000 } },
      });
      // The parent completes on a later scan, once it observes the issued destination accounting.
      expect((await after.manager.ops.mintSwap.get('swap'))?.state).toBe('destination_pending');
      expect((await after.manager.ops.melt.get('source-child'))?.state).toBe('finalized');
      expect((await after.manager.ops.mint.get('destination-child'))?.state).toBe('finalized');
      expect(after.melt).not.toHaveBeenCalled();
      await within(after.manager.dispose());
      return after;
    }

    it('settles the source from cached PAID evidence without another source check', async () => {
      const { sourceCheck, destinationCheck, issuance } = await restartAndScan(async (env) => {
        env.setSourceState('PENDING');
        await env.manager.ops.mintSwap.execute('swap');
        env.setSourceState('PAID');
        await env.manager.quotes.melt.refresh({
          mintUrl: env.fixture.parent.sourceMintUrl,
          quoteId: 'source-quote',
        });
      }, 'source_pending');
      expect(sourceCheck).not.toHaveBeenCalled();
      // Nothing cached says the destination is funded yet, so startup observes it once.
      expect(destinationCheck).toHaveBeenCalledTimes(1);
      expect(issuance).toHaveBeenCalledTimes(1);
    });

    it('issues a funded destination from cached accounting without another quote check', async () => {
      const { sourceCheck, destinationCheck, issuance } = await restartAndScan(async (env) => {
        env.setDestinationState('UNPAID');
        await env.manager.ops.mintSwap.execute('swap');
        env.setDestinationState('PAID');
        await env.manager.quotes.mint.refresh({
          mintUrl: env.fixture.parent.destinationMintUrl,
          quoteId: 'destination-quote',
        });
      }, 'destination_funded');
      expect(sourceCheck).not.toHaveBeenCalled();
      expect(destinationCheck).not.toHaveBeenCalled();
      expect(issuance).toHaveBeenCalledTimes(1);
    });

    it('refreshes an authorized destination once after a lost issuance result', async () => {
      const { sourceCheck, destinationCheck, issuance } = await restartAndScan(async (env) => {
        env.issuance.mockImplementationOnce(async () => {
          throw new Error('Issuance result lost');
        });
        await env.manager.ops.mintSwap.execute('swap');
      }, 'destination_pending');
      expect(sourceCheck).not.toHaveBeenCalled();
      expect(destinationCheck).toHaveBeenCalledTimes(1);
      expect(issuance).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects ordinary child commands and quote claims while preserving reads and parent commands', async () => {
    const { manager, runtime, fixture, issuance, sourceCheck, destinationCheck } = await setup();
    const commands = [
      () => manager.ops.melt.execute('source-child'),
      () => manager.ops.melt.cancel('source-child'),
      () => manager.ops.melt.finalize('source-child'),
      () => runtime.meltOperationService.advancePendingOperation('source-child'),
      () => manager.ops.melt.prepare({ quote: fixture.parent.sourceQuote }),
      () => manager.ops.mint.execute('destination-child'),
      () => manager.ops.mint.finalize('destination-child'),
      () => manager.ops.mint.refresh('destination-child'),
      () => manager.ops.mint.checkPayment('destination-child'),
      () => manager.ops.mint.prepare({ quote: fixture.parent.destinationQuote, amount: 8 }),
      () =>
        runtime.mintOperationService.claimMintQuote(
          'https://destination.test/',
          'bolt11',
          'destination-quote',
        ),
    ];
    for (const command of commands) {
      await expect(command()).rejects.toMatchObject({
        name: 'MintSwapChildOperationError',
        parentOperationId: 'swap',
      });
    }
    // Refreshing a prepared Melt has nothing to resolve, so it reads the child unchanged.
    expect((await manager.ops.melt.refresh('source-child')).state).toBe('prepared');
    expect((await manager.ops.melt.get('source-child'))?.state).toBe('prepared');
    expect((await manager.ops.mint.listPending()).map((op) => op.id)).toContain(
      'destination-child',
    );
    expect(issuance).not.toHaveBeenCalled();
    expect(sourceCheck).not.toHaveBeenCalled();
    expect(destinationCheck).not.toHaveBeenCalled();
    await manager.ops.mintSwap.execute('swap');
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('completed');
    // A stopped parent releases resolution, but never authorizes another source payment.
    await expect(
      manager.ops.melt.prepare({ quote: fixture.parent.sourceQuote }),
    ).rejects.toMatchObject({ parentOperationId: 'swap', parentStopped: true });
    expect((await manager.ops.melt.refresh('source-child')).state).toBe('finalized');
    expect((await manager.ops.mint.refresh('destination-child')).state).toBe('finalized');
    expect(
      await runtime.mintOperationService.claimMintQuote(
        'https://destination.test/',
        'bolt11',
        'destination-quote',
      ),
    ).toEqual([]);
    expect(issuance).toHaveBeenCalledTimes(1);
  });

  it('releases reserved source proofs of a stopped parent without authorizing payment', async () => {
    const { manager, repo, fixture, melt } = await setup();
    const reserved = await repo.proofRepository.getProofBySecret('https://source.test', 'original');
    expect(reserved?.usedByOperationId).toBe('source-child');
    // Contradictory canonical evidence stops the parent before source authorization.
    const quote = await repo.meltQuoteRepository.getMeltQuote(
      'https://source.test',
      'bolt11',
      'source-quote',
    );
    await repo.meltQuoteRepository.upsertMeltQuote({ ...quote!, request: 'lnbc1contradiction' });
    expect((await manager.ops.mintSwap.execute('swap')).state).toBe('needs_attention');
    expect((await manager.ops.melt.get('source-child'))?.state).toBe('prepared');
    for (const command of [
      () => manager.ops.melt.execute('source-child'),
      () => manager.ops.melt.prepare({ quote: fixture.parent.sourceQuote }),
    ]) {
      await expect(command()).rejects.toMatchObject({
        name: 'MintSwapChildOperationError',
        parentOperationId: 'swap',
        parentStopped: true,
      });
    }
    expect(melt).not.toHaveBeenCalled();
    await manager.ops.melt.cancel('source-child');
    expect((await manager.ops.melt.get('source-child'))?.state).toBe('rolled_back');
    const released = await repo.proofRepository.getProofBySecret('https://source.test', 'original');
    expect(released?.state).toBe('ready');
    expect(released?.usedByOperationId).toBeUndefined();
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('needs_attention');
    expect(melt).not.toHaveBeenCalled();
  });

  it('settles in-flight children of a stopped parent through ordinary recovery and claiming', async () => {
    const { manager, runtime, fixture, setSourceState, issuance, destinationResponse } =
      await setup();
    setSourceState('PENDING');
    await manager.ops.mintSwap.execute('swap');
    expect((await manager.ops.melt.get('source-child'))?.state).toBe('pending');
    // Commit the stop exactly as the coordinator's attention handler does.
    await fixture.runner.run((tx) =>
      tx.perform(flagMintSwapAttention, {
        id: 'swap',
        now: 20_000,
        error: new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source'),
      }),
    );
    expect((await manager.ops.mintSwap.get('swap'))?.state).toBe('needs_attention');
    setSourceState('PAID');
    await manager.ops.melt.recovery.run();
    expect((await manager.ops.melt.get('source-child'))?.state).toBe('finalized');
    await runtime.quoteLifecycle.recordMintQuoteSnapshot(
      'https://destination.test',
      'bolt11',
      destinationResponse(),
    );
    expect(
      (await runtime.mintOperationService.claimPendingMintQuotes()).map((op) => op.id),
    ).toEqual(['destination-child']);
    expect((await manager.ops.mint.get('destination-child'))?.state).toBe('finalized');
    expect(issuance).toHaveBeenCalledTimes(1);
    // The parent record keeps its diagnosis; it never resumes.
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('needs_attention');
  });

  it('keeps pending children unchanged under ordinary processors, auto claiming and generic recovery', async () => {
    const {
      manager,
      runtime,
      fixture,
      repo,
      setSourceState,
      sourceCheck,
      destinationCheck,
      issuance,
      destinationResponse,
    } = await setup({
      processors: {
        mintOperationProcessor: { initialEnqueueDelayMs: 0 },
        meltSettlementProcessor: {},
      },
    });
    setSourceState('PENDING');
    await manager.ops.mintSwap.execute('swap');
    const parent = await manager.ops.mintSwap.get('swap');
    const source = await manager.ops.melt.get('source-child');
    const destination = await manager.ops.mint.get('destination-child');
    const proof = await repo.proofRepository.getProofBySecret('https://source.test', 'original');
    sourceCheck.mockClear();
    destinationCheck.mockClear();
    setSourceState('PAID');
    // The canonical quote can still be observed while ordinary advancement is excluded.
    await runtime.quoteLifecycle.recordMintQuoteSnapshot(
      'https://destination.test',
      'bolt11',
      destinationResponse(),
    );
    await manager.ops.mint.recovery.run();
    await manager.ops.melt.recovery.run();
    expect(await runtime.mintOperationService.claimPendingMintQuotes()).toEqual([]);
    expect(await manager.ops.mintSwap.get('swap')).toEqual(parent);
    expect(await manager.ops.melt.get('source-child')).toEqual(source);
    expect(await manager.ops.mint.get('destination-child')).toEqual(destination);
    expect(await repo.proofRepository.getProofBySecret('https://source.test', 'original')).toEqual(
      proof,
    );
    expect(sourceCheck).not.toHaveBeenCalled();
    expect(destinationCheck).not.toHaveBeenCalled();
    expect(issuance).not.toHaveBeenCalled();
    expect(await manager.ops.mint.listByQuote(fixture.parent.destinationQuote)).toHaveLength(1);
    await manager.ops.mintSwap.refresh('swap');
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('completed');
  });

  it('resumes a settlement check skipped while the parent was active when it stops', async () => {
    const { manager, runtime, repo, setSourceState, sourceCheck } = await setup({
      processors: { meltSettlementProcessor: {} },
    });
    const skips = observeSkips(MeltOperationService.prototype, (id) => id === 'source-child');
    setSourceState('PENDING');
    await manager.ops.mintSwap.execute('swap');
    expect((await manager.ops.melt.get('source-child'))?.state).toBe('pending');
    // The pending child's initial check runs on a timer; let it skip so it cannot settle the child
    // after the parent stops.
    await within(skips(1));
    setSourceState('PAID');
    // PAID is observed while the parent is active, so the processor leaves the child alone.
    await runtime.quoteLifecycle.refreshMeltQuoteById({
      mintUrl: 'https://source.test',
      quoteId: 'source-quote',
    });
    await within(skips(2));
    expect((await manager.ops.melt.get('source-child'))?.state).toBe('pending');
    const finalized = deferred();
    manager.on('melt-op:finalized', ({ operationId }) => {
      if (operationId === 'source-child') finalized.resolve();
    });
    // The parent then stops on contradictory evidence; no later quote event reaches the processor.
    const destination = await repo.mintQuoteRepository.getMintQuote(
      'https://destination.test',
      'bolt11',
      'destination-quote',
    );
    if (destination?.method !== 'bolt11') throw new Error('Missing destination quote');
    await repo.mintQuoteRepository.upsertMintQuote({ ...destination, amount: Amount.from(9) });
    sourceCheck.mockClear();
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('needs_attention');
    expect(sourceCheck).not.toHaveBeenCalled();
    await within(finalized.promise);
    expect((await manager.ops.melt.get('source-child'))?.state).toBe('finalized');
  });

  it('resumes a skipped destination claim when the parent stops', async () => {
    const { manager, runtime, repo, setDestinationState, issuance, destinationResponse } =
      await setup({
        processors: {
          mintOperationProcessor: { initialEnqueueDelayMs: 0, processIntervalMs: 20 },
        },
      });
    setDestinationState('UNPAID');
    await manager.ops.mintSwap.execute('swap');
    expect((await manager.ops.mint.get('destination-child'))?.state).toBe('pending');
    setDestinationState('PAID');
    // The processor sees the paid quote while the parent is active and must leave it alone.
    const skips = observeSkips(
      MintOperationService.prototype,
      (target) => typeof target !== 'string' && target.quoteId === 'destination-quote',
    );
    await runtime.quoteLifecycle.recordMintQuoteSnapshot(
      'https://destination.test',
      'bolt11',
      destinationResponse(),
    );
    await within(skips(1));
    expect(issuance).not.toHaveBeenCalled();
    const finalized = deferred();
    manager.on('mint-op:finalized', ({ operationId }) => {
      if (operationId === 'destination-child') finalized.resolve();
    });
    const source = await repo.meltQuoteRepository.getMeltQuote(
      'https://source.test',
      'bolt11',
      'source-quote',
    );
    await repo.meltQuoteRepository.upsertMeltQuote({ ...source!, amount: Amount.from(9) });
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('needs_attention');
    await within(finalized.promise);
    expect(issuance).toHaveBeenCalledTimes(1);
  });

  it('resumes a destination quote skipped by the startup claim sweep when the parent stops', async () => {
    const { manager, runtime, repo, setDestinationState, issuance, destinationResponse } =
      await setup({
        processors: {
          mintOperationProcessor: { initialEnqueueDelayMs: 0, processIntervalMs: 20 },
        },
      });
    setDestinationState('UNPAID');
    await manager.ops.mintSwap.execute('swap');
    setDestinationState('PAID');
    await runtime.quoteLifecycle.recordMintQuoteSnapshot(
      'https://destination.test',
      'bolt11',
      destinationResponse(),
    );
    expect((await manager.ops.mint.get('destination-child'))?.state).toBe('pending');
    const skips = observeSkips(
      MintOperationService.prototype,
      (target) => typeof target !== 'string' && target.quoteId === 'destination-quote',
    );
    // Startup discovery schedules the processor's quote claim, which skips the active parent's quote.
    await within(skips(1));
    expect(issuance).not.toHaveBeenCalled();
    const finalized = deferred();
    manager.on('mint-op:finalized', ({ operationId }) => {
      if (operationId === 'destination-child') finalized.resolve();
    });
    const source = await repo.meltQuoteRepository.getMeltQuote(
      'https://source.test',
      'bolt11',
      'source-quote',
    );
    await repo.meltQuoteRepository.upsertMeltQuote({ ...source!, amount: Amount.from(9) });
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('needs_attention');
    await within(finalized.promise);
    expect(issuance).toHaveBeenCalledTimes(1);
  });

  for (const kind of ['mint', 'melt'] as const) {
    it(`rechecks the ${kind} quote's parent after preparation preflight`, async () => {
      const { manager, fixture } = await setup({ prepared: false });
      const entered = deferred();
      const release = deferred();
      const metadata = await fixture.dependencies.mintService.refreshAndCommitIfStale(
        kind === 'mint' ? fixture.parent.destinationMintUrl : fixture.parent.sourceMintUrl,
      );
      spyOn(MintService.prototype, 'refreshAndCommitIfStale').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return metadata;
      });
      const preparing =
        kind === 'mint'
          ? manager.ops.mint.prepare({ quote: fixture.parent.destinationQuote, amount: 8 })
          : manager.ops.melt.prepare({ quote: fixture.parent.sourceQuote });
      const outcome = preparing.then(
        () => null,
        (error: unknown) => error,
      );
      await within(entered.promise);
      await fixture.create();
      release.resolve();
      expect(await outcome).toBeInstanceOf(MintSwapChildOperationError);
      expect(await manager.ops.mint.listByQuote(fixture.parent.destinationQuote)).toEqual([]);
      expect(await manager.ops.melt.listByQuote(fixture.parent.sourceQuote)).toEqual([]);
    });

    it(`refuses a parent claim after an ordinary ${kind} plan commits`, async () => {
      const { manager, fixture } = await setup({ prepared: false });
      spyOn(MintService.prototype, 'refreshAndCommitIfStale').mockImplementation(
        fixture.dependencies.mintService.refreshAndCommitIfStale,
      );
      if (kind === 'mint')
        await manager.ops.mint.prepare({ quote: fixture.parent.destinationQuote, amount: 8 });
      else await manager.ops.melt.prepare({ quote: fixture.parent.sourceQuote });
      await expect(fixture.create()).rejects.toThrow('child_conflict');
      expect(await manager.ops.mintSwap.get('swap')).toBeNull();
    });
  }

  for (const kind of ['mint', 'melt'] as const) {
    it(`drains ${kind} watcher cleanup for overlapping Manager disposal calls`, async () => {
      const env = await setup({
        watchers: { [kind === 'mint' ? 'mintOperationWatcher' : 'meltQuoteWatcher']: {} },
      });
      const { manager } = env;
      const entered = deferred();
      const release = deferred();
      const subscribe = manager.subscriptions.subscribe.bind(manager.subscriptions);
      spyOn(manager.subscriptions, 'subscribe').mockImplementation(async (...args) => {
        const subscription = await subscribe(...args);
        return {
          ...subscription,
          unsubscribe: async () => {
            entered.resolve();
            await release.promise;
            await subscription.unsubscribe();
          },
        };
      });
      await env.publishQuotes(kind);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const firstDisposal = manager.dispose();
      await within(entered.promise);
      let disposed = false;
      const disposal = manager.dispose().then(() => {
        disposed = true;
      });
      // Allow queued lifecycle microtasks to finish while unsubscribe is held at the boundary.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const completedBeforeCleanup = disposed;
      release.resolve();
      await within(Promise.all([firstDisposal, disposal]));
      expect(completedBeforeCleanup).toBe(false);
    });
  }

  it('rebuilds exact parent observations after Manager closes an untrusted mint', async () => {
    const env = await setup();
    let { manager, runtime } = env;
    const { repo, fixture } = env;
    env.setSourceState('PENDING');
    await manager.ops.mintSwap.execute('swap');
    await runtime.mintSwapOperationService.reconcileInBackground('swap');
    const before = await manager.ops.mintSwap.get('swap');
    await manager.dispose();
    manager = await initializeCoco({
      repo,
      seedGetter: async () => new Uint8Array(64).fill(2),
      ...mintSwapRuntimeConfig,
      watchers: {
        ...mintSwapRuntimeConfig.watchers,
        mintOperationWatcher: {},
        meltQuoteWatcher: {},
      },
      processors: {
        ...mintSwapRuntimeConfig.processors,
        mintSwapOperationProcessor: { processIntervalMs: 60_000 },
      },
    });
    managers.push(manager);
    runtime = manager as unknown as Runtime;
    expect(await manager.ops.mintSwap.get('swap')).toEqual(before);
    await manager.mint.untrustMint(fixture.parent.sourceMintUrl);
    await manager.mint.untrustMint(fixture.parent.destinationMintUrl);
    const subscriptions = manager.subscriptions as unknown as {
      subscriptions: Map<string, { mintUrl: string; filters: string[] }>;
    };
    const active = [...subscriptions.subscriptions.values()];
    expect(
      active.some(
        (sub) =>
          sub.mintUrl === fixture.parent.sourceMintUrl && sub.filters.includes('source-quote'),
      ),
    ).toBe(true);
    expect(
      active.some(
        (sub) =>
          sub.mintUrl === fixture.parent.destinationMintUrl &&
          sub.filters.includes('destination-quote'),
      ),
    ).toBe(true);
    const observed = await runtime.quoteLifecycle.checkMintQuotesForPolling('bolt11', [
      { mintUrl: fixture.parent.destinationMintUrl, quoteId: 'destination-quote' },
      { mintUrl: fixture.parent.destinationMintUrl, quoteId: 'unrelated' },
    ]);
    expect(
      observed.outcomes.find((value) => value.identity.quoteId === 'destination-quote')?.status,
    ).toBe('updated');
    expect(observed.outcomes.find((value) => value.identity.quoteId === 'unrelated')?.status).toBe(
      'failed',
    );
    expect(
      (await repo.mintRepository.getMintByUrl(fixture.parent.destinationMintUrl))?.trusted,
    ).toBe(false);
    await manager.dispose();
    await expect(
      runtime.quoteLifecycle.checkMintQuotesForPolling('bolt11', [
        { mintUrl: fixture.parent.destinationMintUrl, quoteId: 'destination-quote' },
      ]),
    ).rejects.toThrow('not trusted');
  });

  it('advances from watcher-committed destination accounting without another parent quote check', async () => {
    const env = await setup();
    let { manager, runtime } = env;
    const { sourceCheck, destinationCheck, repo } = env;
    await manager.ops.mintSwap.execute('swap');
    expect((await manager.ops.mintSwap.get('swap'))?.state).toBe('destination_pending');
    await runtime.mintSwapOperationService.reconcileInBackground('swap');
    const observed = deferred();
    await manager.dispose();
    manager = await initializeCoco({
      repo,
      seedGetter: async () => new Uint8Array(64).fill(2),
      ...mintSwapRuntimeConfig,
      watchers: { ...mintSwapRuntimeConfig.watchers, mintOperationWatcher: {} },
      processors: {
        ...mintSwapRuntimeConfig.processors,
        mintSwapOperationProcessor: { processIntervalMs: 5 },
      },
      plugins: [
        {
          name: 'observe-issuance',
          required: ['eventBus'],
          onReady: ({ services }) => {
            services.eventBus.on('mint-quote:updated', ({ quote }) => {
              if (quote.quoteId === 'destination-quote' && quote.amountIssued.equals(8))
                observed.resolve();
            });
          },
        },
      ],
    });
    managers.push(manager);
    await within(observed.promise);
    sourceCheck.mockClear();
    destinationCheck.mockClear();
    const completed = deferred();
    manager.on('mint-swap:updated', ({ state }) => {
      if (state === 'completed') completed.resolve();
    });
    spyOn(Date, 'now').mockReturnValue(30_000);
    await within(completed.promise);
    expect((await repo.mintSwap.operationRepository.getById('swap'))?.state).toBe('completed');
    expect(sourceCheck).not.toHaveBeenCalled();
    expect(destinationCheck).not.toHaveBeenCalled();
  });

  for (const event of [
    'melt-quote:updated',
    'mint-quote:updated',
    'mint:metadata-refreshed',
    'mint:updated',
  ] as const) {
    it(`allows ${event} listeners to refresh the same swap`, async () => {
      const { manager, repo } = await setup();
      if (event.startsWith('mint:')) {
        spyOn(MintAdapter.prototype, 'fetchMintMetadata').mockImplementation(async (mintUrl) => ({
          mintUrl,
          mintInfo: (await repo.mintRepository.getMintByUrl(mintUrl))!.mintInfo,
          keysets: await repo.keysetRepository.getKeysetsByMintUrl(mintUrl),
          observedAt: 10_000,
        }));
        spyOn(Date, 'now').mockReturnValue(1_000_000);
      }
      let called = false;
      const unblock = deferred();
      const off = manager.on(event, async () => {
        if (called) return;
        called = true;
        await Promise.race([manager.ops.mintSwap.refresh('swap'), unblock.promise]);
      });
      try {
        await within(manager.ops.mintSwap.execute('swap'));
        expect((await within(manager.ops.mintSwap.refresh('swap'))).state).toBe('completed');
        expect(called).toBe(true);
      } finally {
        off();
        unblock.resolve();
      }
    });
  }

  it('publishes created quotes after the prepared parent is committed and unlocked', async () => {
    const { manager, fixture, sourceResponse, destinationResponse } = await setup({
      prepared: false,
    });
    spyOn(Wallet.prototype, 'createLockedMintQuote').mockImplementation(
      async (_amount, ownedPubkey) => ({
        ...destinationResponse(),
        quote: 'created-destination',
        pubkey: ownedPubkey,
        state: 'UNPAID',
        amount_paid: Amount.zero(),
        amount_issued: Amount.zero(),
      }),
    );
    spyOn(Wallet.prototype, 'createMeltQuoteBolt11').mockImplementation(async () => ({
      ...sourceResponse(),
      quote: 'created-source',
      state: 'UNPAID',
    }));
    const events: string[] = [];
    const unblock = deferred();
    const off = (['mint-quote:updated', 'melt-quote:updated'] as const).map((event) =>
      manager.on(event, async () => {
        events.push(event);
        await Promise.race([manager.ops.mintSwap.refresh('created-swap'), unblock.promise]);
      }),
    );
    try {
      expect(
        (await within(manager.ops.mintSwap.prepare({ ...fixture.parent, id: 'created-swap' })))
          .state,
      ).toBe('prepared');
      expect(events).toEqual(['mint-quote:updated', 'melt-quote:updated']);
    } finally {
      off.forEach((unsubscribe) => unsubscribe());
      unblock.resolve();
    }
  });

  it('settles a shared wallet build before publishing its metadata events', async () => {
    const { manager, runtime, repo, fixture } = await setup();
    spyOn(Date, 'now').mockReturnValue(1_000_000);
    spyOn(MintAdapter.prototype, 'fetchMintMetadata').mockImplementation(async (mintUrl) => ({
      mintUrl,
      mintInfo: (await repo.mintRepository.getMintByUrl(mintUrl))!.mintInfo,
      keysets: await repo.keysetRepository.getKeysetsByMintUrl(mintUrl),
      observedAt: 10_000,
    }));
    let called = false;
    const unblock = deferred();
    const off = manager.on('mint:metadata-refreshed', async ({ mintUrl }) => {
      called = true;
      await Promise.race([runtime.walletService.getWallet(mintUrl, 'sat'), unblock.promise]);
    });
    try {
      await within(runtime.walletService.getWallet(fixture.parent.destinationMintUrl, 'sat'));
      expect(called).toBe(true);
    } finally {
      off();
      unblock.resolve();
    }
  });

  it('does not log listener errors or quote/proof event payloads', async () => {
    const logs: unknown[] = [];
    const log = (...args: unknown[]) => {
      logs.push(args);
    };
    const logger: Logger = { debug: log, info: log, warn: log, error: log, child: () => logger };
    const { manager } = await setup({ logger });
    const marker = 'private-listener-error-marker';
    manager.on('melt-quote:updated', () => {
      throw new Error(marker);
    });
    manager.on('mint-op:finalized', () => {
      throw new Error(marker);
    });
    await manager.ops.mintSwap.execute('swap');
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('completed');
    expect(JSON.stringify(logs)).not.toContain(marker);
    expect(JSON.stringify(logs)).not.toContain(invoice);
    expect(JSON.stringify(logs)).not.toContain('"secret"');
    expect(JSON.stringify(logs)).toContain('Event handler failed');
  });

  it('persists Retry-After from real locked issuance and recovery', async () => {
    const { manager, issuance } = await setup();
    issuance.mockRejectedValue(new RateLimitError('rate limited', 120_000));
    let parent = await manager.ops.mintSwap.execute('swap');
    expect(parent.state).toBe('destination_pending');
    expect(parent.retry.nextAttemptAt).toBeGreaterThanOrEqual(130_000);
    spyOn(Date, 'now').mockReturnValue(150_000);
    parent = await manager.ops.mintSwap.refresh('swap');
    expect(parent.state).toBe('destination_pending');
    expect(parent.retry.nextAttemptAt).toBeGreaterThanOrEqual(270_000);
    expect(issuance).toHaveBeenCalledTimes(2);
  });

  it('allows quote reentrancy with ordinary watchers and processors enabled', async () => {
    const env = await setup({
      watchers: { mintOperationWatcher: {}, meltQuoteWatcher: {} },
      processors: { mintOperationProcessor: {}, meltSettlementProcessor: {} },
    });
    const { manager } = env;
    env.setSourceState('UNPAID');
    env.setDestinationState('UNPAID');
    const payment = spyOn(MintAdapter.prototype, 'customMeltBolt11').mockImplementation(
      async () => {
        env.setSourceState('PAID');
        env.setDestinationState('PAID');
        return env.sourceResponse();
      },
    );
    let called = false;
    const unblock = deferred();
    const off = manager.on('melt-quote:updated', async () => {
      if (called) return;
      called = true;
      await Promise.race([manager.ops.mintSwap.refresh('swap'), unblock.promise]);
    });
    try {
      await within(manager.ops.mintSwap.execute('swap'));
      expect((await within(manager.ops.mintSwap.refresh('swap'))).state).toBe('completed');
      expect(called).toBe(true);
      expect(payment).toHaveBeenCalledTimes(1);
    } finally {
      off();
      unblock.resolve();
    }
  });

  for (const leg of ['source', 'destination'] as const) {
    it(`uses the active ${leg} watcher observation without a duplicate request`, async () => {
      const env = await setup({
        subscriptions: { fastPollingIntervalMs: 20 },
        watchers: { meltQuoteWatcher: {}, mintOperationWatcher: {} },
      });
      const { manager, runtime, issuance, sourceCheck, destinationCheck } = env;
      if (leg === 'source') env.setSourceState('PENDING');
      else issuance.mockRejectedValue(new Error('response lost'));
      const initial = await manager.ops.mintSwap.execute('swap');
      expect(initial.state).toBe(leg === 'source' ? 'source_pending' : 'destination_pending');
      spyOn(Date, 'now').mockReturnValue(30_000);
      const entered = deferred();
      const response = deferred<ReturnType<typeof env.sourceResponse> | MintQuoteBolt11Response>();
      const check = leg === 'source' ? sourceCheck : destinationCheck;
      check.mockClear();
      check.mockImplementation(async () => {
        entered.resolve();
        return response.promise as never;
      });
      try {
        await env.publishQuotes(leg === 'source' ? 'melt' : 'mint');
        await manager.ensureSubscriptions();
        await within(entered.promise);
        await within(runtime.mintSwapOperationService.reconcileInBackground('swap'));
        expect(check).toHaveBeenCalledTimes(1);
      } finally {
        response.resolve(leg === 'source' ? env.sourceResponse() : env.destinationResponse());
        await manager.dispose();
      }
    });
  }

  it('does not replace disabled watchers with periodic quote checks', async () => {
    const { manager, runtime, setSourceState, sourceCheck, destinationCheck } = await setup();
    setSourceState('PENDING');
    await manager.ops.mintSwap.execute('swap');
    setSourceState('PAID');
    sourceCheck.mockClear();
    destinationCheck.mockClear();
    for (const now of [30_000, 90_000, 300_000]) {
      spyOn(Date, 'now').mockReturnValue(now);
      await runtime.mintSwapOperationService.reconcileInBackground('swap');
      expect((await manager.ops.mintSwap.get('swap'))?.state).toBe('source_pending');
    }
    expect(sourceCheck).not.toHaveBeenCalled();
    expect(destinationCheck).not.toHaveBeenCalled();
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('destination_pending');
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('completed');
    expect(sourceCheck).toHaveBeenCalled();
  });

  for (const parentEnabled of [false, true]) {
    for (const remoteState of ['PAID', 'PENDING', 'UNPAID', 'UNAVAILABLE'] as const) {
      it(`confirms pending source release through ordinary Melt processing once the parent stops (parent=${parentEnabled}, remote=${remoteState})`, async () => {
        const env = await setup({
          processors: {
            mintSwapOperationProcessor: { disabled: !parentEnabled, processIntervalMs: 60_000 },
            meltSettlementProcessor: {},
          },
        });
        const { manager, runtime, repo, fixture, sourceCheck } = env;
        env.setSourceState('UNPAID');
        const earlierResponse = env.sourceResponse();
        env.setSourceState('PENDING');
        await manager.ops.mintSwap.execute('swap');
        expect((await repo.meltOperationRepository.getById('source-child'))?.state).toBe('pending');
        spyOn(Date, 'now').mockReturnValue(11_000);
        await runtime.quoteLifecycle.recordMeltQuoteObservation(
          meltQuoteFromBolt11Response(fixture.parent.sourceMintUrl, earlierResponse),
        );
        const before = await repo.proofRepository.getProofsBySecrets(fixture.parent.sourceMintUrl, [
          'original',
        ]);
        const confirmation = deferred();
        sourceCheck.mockClear();
        sourceCheck.mockImplementation(async () => {
          confirmation.resolve();
          if (remoteState === 'UNAVAILABLE') throw new Error('Confirmation unavailable');
          env.setSourceState(remoteState);
          return env.sourceResponse();
        });
        // The active parent coordinates its source child, so ordinary processing skips it.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(sourceCheck).not.toHaveBeenCalled();
        expect((await repo.meltOperationRepository.getById('source-child'))?.state).toBe('pending');
        // Stopping the parent releases the child to ordinary resolution, which rechecks it.
        const source = await repo.meltQuoteRepository.getMeltQuote(
          fixture.parent.sourceMintUrl,
          'bolt11',
          'source-quote',
        );
        await repo.meltQuoteRepository.upsertMeltQuote({ ...source!, amount: Amount.from(9) });
        expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('needs_attention');
        await within(confirmation.promise);
        // The public stop drains the admitted check, including canonical commit and settlement.
        await manager.dispose();
        expect(sourceCheck).toHaveBeenCalledTimes(1);
        const child = await repo.meltOperationRepository.getById('source-child');
        const proofs = await repo.proofRepository.getProofsBySecrets(fixture.parent.sourceMintUrl, [
          'original',
        ]);
        if (remoteState === 'PAID') {
          expect(child?.state).toBe('finalized');
          expect(proofs[0]?.state).toBe('spent');
        } else if (remoteState === 'UNPAID') {
          expect(child?.state).toBe('rolled_back');
          expect(proofs[0]?.state).toBe('ready');
          expect(proofs[0]?.usedByOperationId).toBeUndefined();
        } else {
          expect(child?.state).toBe('pending');
          expect(proofs).toEqual(before);
        }
      });
    }
  }

  for (const observationTiming of ['during payment', 'after payment'] as const) {
    for (const remoteState of ['PAID', 'UNPAID', 'UNAVAILABLE'] as const) {
      it(`confirms source non-payment when a watcher response arrives ${observationTiming} and the source is ${remoteState}`, async () => {
        const env = await setup({ watchers: { meltQuoteWatcher: {} } });
        const { manager, runtime, repo, fixture, sourceCheck } = env;
        env.setSourceState('UNPAID');
        const oldResponse = env.sourceResponse();
        const pollEntered = deferred();
        const pollResponse = deferred<ReturnType<typeof env.sourceResponse>>();
        const observationCommitted = deferred();
        const record = runtime.quoteLifecycle.recordMeltQuoteObservation.bind(
          runtime.quoteLifecycle,
        );
        spyOn(runtime.quoteLifecycle, 'recordMeltQuoteObservation').mockImplementation(
          async (...args) => {
            const quote = await record(...args);
            if (quote.lastObservedRemoteStateAt === 11_000) observationCommitted.resolve();
            return quote;
          },
        );
        sourceCheck.mockImplementationOnce(async () => {
          pollEntered.resolve();
          return pollResponse.promise;
        });
        const publishObservation = async () => {
          spyOn(Date, 'now').mockReturnValue(11_000);
          pollResponse.resolve(oldResponse);
          await within(observationCommitted.promise);
        };
        spyOn(MintAdapter.prototype, 'customMeltBolt11').mockImplementation(async () => {
          if (observationTiming === 'during payment') await publishObservation();
          env.setSourceState(remoteState === 'UNAVAILABLE' ? 'PAID' : remoteState);
          throw new Error('Source response unavailable');
        });
        try {
          await env.publishQuotes('melt');
          await within(pollEntered.promise);
          const executed = await within(manager.ops.mintSwap.execute('swap'));
          expect(executed.state).toBe('source_pending');
          expect(executed.sourceStartedAt).toBe(10_000);
          if (observationTiming === 'after payment') await publishObservation();
          const quote = await runtime.quoteLifecycle.getMeltQuote(
            fixture.parent.sourceMintUrl,
            'bolt11',
            'source-quote',
          );
          expect(quote?.state).toBe('UNPAID');
          expect(quote?.lastObservedRemoteStateAt).toBe(11_000);
          const originalProofs = await repo.proofRepository.getProofsBySecrets(
            fixture.parent.sourceMintUrl,
            ['original'],
          );

          spyOn(Date, 'now').mockReturnValue(30_000);
          sourceCheck.mockClear();
          if (remoteState === 'UNAVAILABLE')
            sourceCheck.mockRejectedValueOnce(new RateLimitError('rate limited', 120_000));
          await within(runtime.mintSwapOperationService.reconcileInBackground('swap'));
          expect(sourceCheck).toHaveBeenCalledTimes(1);
          if (remoteState === 'UNAVAILABLE') {
            const parent = await manager.ops.mintSwap.get('swap');
            expect(parent?.state).toBe('source_pending');
            expect(parent?.retry.nextAttemptAt).toBeGreaterThanOrEqual(150_000);
            expect((await repo.meltOperationRepository.getById('source-child'))?.state).toBe(
              'executing',
            );
            expect(
              await repo.proofRepository.getProofsBySecrets(fixture.parent.sourceMintUrl, [
                'original',
              ]),
            ).toEqual(originalProofs);
            return;
          }
          expect((await manager.ops.mintSwap.get('swap'))?.state).toBe(
            remoteState === 'PAID' ? 'destination_funded' : 'failed',
          );
          expect((await repo.meltOperationRepository.getById('source-child'))?.state).toBe(
            remoteState === 'PAID' ? 'finalized' : 'rolled_back',
          );
          const [proof] = await repo.proofRepository.getProofsBySecrets(
            fixture.parent.sourceMintUrl,
            ['original'],
          );
          expect(proof?.state).toBe(remoteState === 'PAID' ? 'spent' : 'ready');
          if (remoteState === 'PAID') {
            expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('destination_pending');
            expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('completed');
          }
        } finally {
          pollResponse.resolve(oldResponse);
          await manager.dispose();
        }
      });
    }
  }
});
