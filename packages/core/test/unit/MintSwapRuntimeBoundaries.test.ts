import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Amount, RateLimitError, Wallet, type MintQuoteBolt11Response } from '@cashu/cashu-ts';
import { initializeCoco, Manager } from '../../Manager.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { meltQuoteFromBolt11Response } from '../../models/MeltQuote.ts';
import { MintAdapter } from '../../infra/MintAdapter.ts';
import { PollingTransport } from '../../infra/PollingTransport.ts';
import { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
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

describe('Mint Swap real runtime boundaries', () => {
  const managers: Manager[] = [];
  beforeEach(() => {
    spyOn(Date, 'now').mockReturnValue(10_000);
  });
  afterEach(async () => {
    for (const manager of managers.splice(0)) await within(manager.dispose());
    mock.restore();
  });

  async function setup(logger?: Logger, prepared = true) {
    const repo = new MemoryRepositories();
    const fixture = await mintSwapFixture(repo);
    fixture.preparation.seed = new Uint8Array(64).fill(2);
    if (prepared) {
      await fixture.create();
      await fixture.prepare();
    }
    let sourceState: 'PENDING' | 'PAID' | 'UNPAID' = 'PAID';
    let destinationState: 'UNPAID' | 'PAID' | 'ISSUED' = 'UNPAID';
    const sourceResponse = () => ({
      quote: 'source-quote',
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
    const destinationResponse = (): MintQuoteBolt11Response => ({
      quote: 'destination-quote',
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
      async () => sourceResponse(),
    );
    const destinationCheck = spyOn(MintAdapter.prototype, 'checkMintQuote').mockImplementation(
      (async () => destinationResponse()) as MintAdapter['checkMintQuote'],
    );
    spyOn(MintAdapter.prototype, 'customMeltBolt11').mockImplementation(async () =>
      sourceResponse(),
    );
    const issuance = spyOn(Wallet.prototype, 'mintProofsBolt11').mockImplementation(async () => {
      const child = await repo.mintOperationRepository.getById('destination-child');
      if (!child || child.state !== 'executing') throw new Error('Missing executing child');
      destinationState = 'ISSUED';
      return outputProofs(child.outputData);
    });
    spyOn(Manager.prototype as unknown as Runtime, 'createSubscriptionManager').mockImplementation(
      function (this: Runtime) {
        return new SubscriptionManager(
          new PollingTransport(
            this.mintAdapter,
            { intervalMs: 60_000 },
            undefined,
            this.quoteLifecycle,
          ),
          this.mintAdapter,
        );
      },
    );
    const manager = await initializeCoco({
      repo,
      seedGetter: async () => new Uint8Array(64).fill(2),
      logger,
      ...mintSwapRuntimeConfig,
      processors: {
        ...mintSwapRuntimeConfig.processors,
        mintSwapOperationProcessor: { disabled: true },
      },
    });
    destinationState = 'PAID';
    managers.push(manager);
    return {
      manager,
      runtime: manager as unknown as Runtime,
      repo,
      fixture,
      issuance,
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
        const { manager, runtime, fixture, repo, sourceCheck, destinationCheck, issuance } = env;
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
        const subscribe = spyOn(manager.subscriptions, 'subscribe').mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          if (setupOutcome === 'failed') throw new Error('Observation setup unavailable');
          return { subId: 'delayed-parent', unsubscribe };
        });
        const progressed = deferred();
        manager.on('mint-swap:updated', ({ state }) => {
          if (state === 'destination_pending') progressed.resolve();
        });
        try {
          await manager.enableMintOperationWatcher({
            watchExistingPendingOnStart: false,
            watchExistingPendingQuotesOnStart: false,
          });
          sourceCheck.mockClear();
          destinationCheck.mockClear();
          if (phase === 'startup') spyOn(Date, 'now').mockReturnValue(30_000);
          await within(manager.enableMintSwapOperationProcessor({ processIntervalMs: 5 }));
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
          const stopping = manager.disableMintSwapOperationProcessor().then(() => {
            stopped = true;
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (setupOutcome === 'blocked') expect(stopped).toBe(false);
          release.resolve();
          await within(stopping);
          if (setupOutcome === 'blocked') expect(unsubscribe).toHaveBeenCalledTimes(1);
        } finally {
          release.resolve();
          await manager.disableMintSwapOperationProcessor();
          await manager.disableMintOperationWatcher();
        }
      });
    }
  }

  for (const kind of ['mint', 'melt'] as const) {
    it(`drains an already-disabling ${kind} watcher before Manager disposal completes`, async () => {
      const { manager } = await setup();
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
      if (kind === 'mint') await manager.enableMintOperationWatcher();
      else await manager.enableMeltQuoteWatcher();
      const disabling =
        kind === 'mint' ? manager.disableMintOperationWatcher() : manager.disableMeltQuoteWatcher();
      await within(entered.promise);
      let disposed = false;
      const disposal = manager.dispose().then(() => {
        disposed = true;
      });
      // Allow queued lifecycle microtasks to finish while unsubscribe is held at the boundary.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const completedBeforeCleanup = disposed;
      release.resolve();
      await within(Promise.all([disabling, disposal]));
      expect(completedBeforeCleanup).toBe(false);
    });
  }

  it('rebuilds exact parent observations after Manager closes an untrusted mint', async () => {
    const env = await setup();
    const { manager, runtime, repo, fixture } = env;
    env.setSourceState('PENDING');
    await manager.ops.mintSwap.execute('swap');
    await runtime.mintSwapOperationService.reconcileInBackground('swap');
    const before = await manager.ops.mintSwap.get('swap');
    await manager.enableMintOperationWatcher();
    await manager.enableMeltQuoteWatcher();
    await manager.enableMintSwapOperationProcessor({ processIntervalMs: 60_000 });
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
    await manager.disableMintSwapOperationProcessor();
    await expect(
      runtime.quoteLifecycle.checkMintQuotesForPolling('bolt11', [
        { mintUrl: fixture.parent.destinationMintUrl, quoteId: 'destination-quote' },
      ]),
    ).rejects.toThrow('not trusted');
  });

  it('advances from watcher-committed destination accounting without another parent quote check', async () => {
    const env = await setup();
    const { manager, runtime, sourceCheck, destinationCheck, repo } = env;
    await manager.ops.mintSwap.execute('swap');
    expect((await manager.ops.mintSwap.get('swap'))?.state).toBe('destination_pending');
    await runtime.mintSwapOperationService.reconcileInBackground('swap');
    const observed = deferred();
    manager.on('mint-quote:updated', ({ quote }) => {
      if (quote.quoteId === 'destination-quote' && quote.amountIssued.equals(8)) observed.resolve();
    });
    await manager.enableMintOperationWatcher();
    await manager.enableMintSwapOperationProcessor({ processIntervalMs: 5 });
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
    const { manager, fixture, sourceResponse, destinationResponse } = await setup(undefined, false);
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
    const { manager } = await setup(logger);
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
    const env = await setup();
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
    await manager.enableMintOperationWatcher();
    await manager.enableMeltQuoteWatcher();
    await manager.enableMintOperationProcessor();
    await manager.enableMeltSettlementProcessor();
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
      const env = await setup();
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
        if (leg === 'source') await manager.enableMeltQuoteWatcher();
        else await manager.enableMintOperationWatcher();
        await within(entered.promise);
        await within(runtime.mintSwapOperationService.reconcileInBackground('swap'));
        expect(check).toHaveBeenCalledTimes(1);
      } finally {
        response.resolve(leg === 'source' ? env.sourceResponse() : env.destinationResponse());
        await manager.disableMeltQuoteWatcher();
        await manager.disableMintOperationWatcher();
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
      it(`confirms pending source release through ordinary Melt processing (parent=${parentEnabled}, remote=${remoteState})`, async () => {
        const env = await setup();
        const { manager, runtime, repo, fixture, sourceCheck } = env;
        env.setSourceState('UNPAID');
        const earlierResponse = env.sourceResponse();
        env.setSourceState('PENDING');
        await manager.ops.mintSwap.execute('swap');
        expect((await repo.meltOperationRepository.getById('source-child'))?.state).toBe('pending');
        if (parentEnabled)
          await manager.enableMintSwapOperationProcessor({ processIntervalMs: 60_000 });
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
        await manager.enableMeltSettlementProcessor();
        await within(confirmation.promise);
        // The public stop drains the admitted check, including canonical commit and settlement.
        await manager.disableMeltSettlementProcessor();
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
        const env = await setup();
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
          await manager.enableMeltQuoteWatcher();
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
          await manager.disableMeltQuoteWatcher();
        }
      });
    }
  }
});
