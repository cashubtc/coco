import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { MintSwapChildOperationError } from '../../operations/mintSwap/MintSwapErrors.ts';
import { initializeCoco, Manager, type CocoConfig } from '../../Manager.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { MemoryMintSwapOperationRepository } from '../../repositories/memory/MemoryMintSwapOperationRepository.ts';
import { MintSwapIntentConflictError } from '../../operations/mintSwap/MintSwapErrors.ts';
import { MeltBolt11Handler } from '../../infra/handlers/melt/MeltBolt11Handler.ts';
import { MintBolt11Handler } from '../../infra/handlers/mint/MintBolt11Handler.ts';
import type { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import type { MintOperationService } from '../../operations/mint/MintOperationService.ts';
import { MintService } from '../../services/MintService.ts';
import { beginMintSwapSource } from '../../operations/mintSwap/MintSwapTransitions.ts';
import { mintSwapFixture } from '../../../adapter-tests/src/internal/mintSwap/fixture.ts';
import {
  deferred,
  installMintSwapProtocol,
  mintSwapRuntimeConfig,
} from '../fixtures/MintSwapRuntime.ts';
import { mintSwapFixtures } from '../fixtures/MintSwap.ts';

describe('Mint Swap Manager runtime', () => {
  const managers: Manager[] = [];
  beforeEach(() => {
    spyOn(Date, 'now').mockReturnValue(10_000);
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
    mock.restore();
  });
  async function setup(
    options: {
      automatic?: boolean;
      prepare?: boolean;
      plugins?: CocoConfig['plugins'];
      logger?: CocoConfig['logger'];
    } = {},
  ) {
    const repo = new MemoryRepositories();
    const fixture = await mintSwapFixture(repo);
    installMintSwapProtocol(fixture);
    if (options.prepare) {
      await fixture.create();
      await fixture.prepare();
    }
    const manager = await initializeCoco({
      repo,
      seedGetter: fixture.dependencies.loadSeed,
      ...mintSwapRuntimeConfig,
      plugins: options.plugins,
      logger: options.logger,
      processors: {
        ...mintSwapRuntimeConfig.processors,
        ...(options.automatic === false ? { mintSwapOperationProcessor: { disabled: true } } : {}),
      },
    });
    managers.push(manager);
    return { repo, fixture, manager };
  }

  it('observes prepared swaps on startup and resume without authorizing payment', async () => {
    const { manager, fixture } = await setup({ prepare: true });
    expect((await manager.ops.mintSwap.get('swap'))?.state).toBe('prepared');
    await manager.pauseSubscriptions();
    await manager.resumeSubscriptions();
    expect((await manager.ops.mintSwap.get('swap'))?.state).toBe('prepared');
    expect(fixture.requests).not.toContain('melt');
    expect((await manager.ops.mintSwap.cancel('swap')).state).toBe('cancelled');
  });

  it('recovers persisted preparation explicitly with automatic work disabled', async () => {
    const { repo, manager, fixture } = await setup({ automatic: false });
    await fixture.create();
    await manager.pauseSubscriptions();
    await manager.resumeSubscriptions();
    expect((await repo.mintSwap.operationRepository.getById('swap'))?.state).toBe('preparing');
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('prepared');
    expect(fixture.requests).not.toContain('melt');
    await manager.ops.mintSwap.recovery.run();
    expect((await manager.ops.mintSwap.get('swap'))?.state).toBe('prepared');
  });

  for (const automatic of [undefined, false]) {
    it(`prepares and executes with ${automatic === false ? 'background processing disabled' : 'default configuration'}`, async () => {
      const { manager, fixture } = await setup({ automatic });
      const hints: Array<{ revision: number; state: string }> = [];
      manager.on('mint-swap:updated', async (hint) => {
        expect((await manager.ops.mintSwap.get(hint.operationId))!.revision).toBeGreaterThanOrEqual(
          hint.revision,
        );
        hints.push(hint);
      });
      const prepared = await manager.ops.mintSwap.prepare({
        ...fixture.parent,
        destinationAmount: { amount: '8', unit: 'sat' },
      });
      expect(prepared.state).toBe('prepared');
      expect(hints.map((hint) => hint.revision)).toEqual([0, 1]);
      expect((await manager.ops.mintSwap.prepare(fixture.parent)).id).toBe('swap');
      await expect(
        manager.ops.mintSwap.prepare({ ...fixture.parent, destinationAmount: 7 }),
      ).rejects.toBeInstanceOf(MintSwapIntentConflictError);
      await expect(
        manager.ops.mintSwap.prepare({
          ...fixture.parent,
          destinationAmount: { amount: 8, unit: 'usd' },
        }),
      ).rejects.toThrow('Unit mismatch');
      fixture.setDestinationState('ISSUED');
      expect((await manager.ops.mintSwap.execute('swap')).state).toBe('completed');
      expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
      expect((await manager.ops.mintSwap.waitForOutcome('swap')).status).toBe('completed');
    });
  }

  for (const paid of [true, false]) {
    it(`recovers PENDING to ${paid ? 'PAID' : 'UNPAID'} on restart with default processing`, async () => {
      const { repo, fixture, manager } = await setup({
        automatic: false,
        prepare: true,
      });
      fixture.setSourceState('PENDING');
      expect((await manager.ops.mintSwap.execute('swap')).state).toBe('source_pending');
      await manager.ops.mintSwap.cancel('swap');
      await manager.dispose();
      spyOn(Date, 'now').mockReturnValue(30_000);
      fixture.setTime(30_000);
      fixture.setSourceState(paid ? 'PAID' : 'UNPAID');
      fixture.setDestinationState('ISSUED');
      const reopened = await initializeCoco({
        repo,
        seedGetter: fixture.dependencies.loadSeed,
        ...mintSwapRuntimeConfig,
      });
      managers.push(reopened);
      expect((await reopened.ops.mintSwap.get('swap'))?.state).toBe(
        paid ? 'completed' : 'cancelled',
      );
      expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
    });
  }

  it('retains future retry deadlines on startup, resume and parent hints', async () => {
    const { repo, fixture, manager } = await setup({
      automatic: false,
      prepare: true,
    });
    await manager.dispose();
    await fixture.runner.run((tx) =>
      tx.perform(beginMintSwapSource, { ...fixture.preparation, now: Date.now() + 60_000 }),
    );
    const before = await repo.mintSwap.operationRepository.getById('swap');
    const background = await initializeCoco({
      repo,
      seedGetter: fixture.dependencies.loadSeed,
      ...mintSwapRuntimeConfig,
    });
    managers.push(background);
    // Parent scheduling must retain the deadline even if a child recovery has advanced.
    expect((await background.ops.mintSwap.get('swap'))?.retry).toEqual(before!.retry);
    await background.pauseSubscriptions();
    await background.resumeSubscriptions();
    expect((await background.ops.mintSwap.get('swap'))?.retry).toEqual(before!.retry);
  });

  it('applies and validates new recovery options after stopping the processor', async () => {
    const { manager } = await setup({ automatic: false });
    let elapsed = 0;
    spyOn(performance, 'now').mockImplementation(() => elapsed);
    let tick = () => {};
    const schedule = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      tick = callback;
      return 123;
    }) as unknown as typeof setTimeout);
    spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    const active = spyOn(MemoryMintSwapOperationRepository.prototype, 'listActive');
    const due = spyOn(MemoryMintSwapOperationRepository.prototype, 'listDue');

    await manager.enableMintSwapOperationProcessor({
      processIntervalMs: 100_000,
      sweepIntervalMs: 90_000,
      batchSize: 25,
    });
    await manager.disableMintSwapOperationProcessor();
    const scansBeforeInvalidOptions = active.mock.calls.length;
    for (const options of [
      { processIntervalMs: 0 },
      { sweepIntervalMs: Infinity },
      { batchSize: 0 },
    ]) {
      await expect(manager.enableMintSwapOperationProcessor(options)).rejects.toBeInstanceOf(
        TypeError,
      );
    }
    expect(active).toHaveBeenCalledTimes(scansBeforeInvalidOptions);

    const options = { processIntervalMs: 5, sweepIntervalMs: 20, batchSize: 7 };
    expect(await manager.enableMintSwapOperationProcessor(options)).toBe(true);
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 5);
    elapsed = 5;
    tick();
    await manager.disableMintSwapOperationProcessor();
    expect(due).toHaveBeenLastCalledWith(Date.now(), 7);

    await manager.enableMintSwapOperationProcessor(options);
    const scansBeforeSweep = active.mock.calls.length;
    elapsed = 25;
    tick();
    await manager.disableMintSwapOperationProcessor();
    expect(active).toHaveBeenCalledTimes(scansBeforeSweep + 1);
  });

  it('drains a stopping processor before allowing a newly configured restart', async () => {
    const { manager, repo } = await setup({ automatic: false });
    const entered = deferred();
    const release = deferred();
    const queries = repo.mintSwap.operationRepository;
    const listActive = queries.listActive.bind(queries);
    const active = spyOn(
      MemoryMintSwapOperationRepository.prototype,
      'listActive',
    ).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return listActive();
    });
    const starting = manager.enableMintSwapOperationProcessor({ processIntervalMs: 100_000 });
    await entered.promise;
    let stopped = false;
    const stopping = manager.disableMintSwapOperationProcessor().then(() => {
      stopped = true;
    });
    const overlapping = manager.enableMintSwapOperationProcessor({ processIntervalMs: 5 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const stoppedBeforeDrain = stopped;
    const scansBeforeDrain = active.mock.calls.length;
    release.resolve();
    const [started, , restarted] = await Promise.all([starting, stopping, overlapping]);
    expect(stoppedBeforeDrain).toBe(false);
    expect(scansBeforeDrain).toBe(1);
    expect(started).toBe(false);
    expect(restarted).toBe(false);
    expect(await manager.enableMintSwapOperationProcessor({ processIntervalMs: 5 })).toBe(true);
    expect(active).toHaveBeenCalledTimes(2);
  });

  it('rejects ordinary Melt execution while the parent holds the source lock', async () => {
    let meltService!: MeltOperationService;
    const { manager, fixture } = await setup({
      automatic: false,
      prepare: true,
      plugins: [
        {
          name: 'capture-child',
          required: ['meltOperationService'],
          onInit: ({ services }) => {
            meltService = services.meltOperationService;
          },
        },
      ],
    });
    const entered = deferred();
    const release = deferred();
    spyOn(MeltBolt11Handler.prototype, 'melt').mockImplementation(async () => {
      fixture.requests.push('melt');
      entered.resolve();
      await release.promise;
      return { status: 'PENDING', change: [] };
    });
    const execution = manager.ops.mintSwap.execute('swap');
    await entered.promise;
    for (const command of [
      () => meltService.execute('source-child'),
      () => meltService.finalize('source-child'),
      () => meltService.rollback('source-child'),
      () => meltService.checkPendingOperation('source-child'),
      () => manager.ops.melt.finalize('source-child'),
    ]) {
      await expect(command()).rejects.toMatchObject({
        name: 'MintSwapChildOperationError',
        parentOperationId: 'swap',
      });
    }
    release.resolve();
    await execution;
    expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
  });

  it('rejects an ordinary Mint command while parent issuance holds the destination lock', async () => {
    let mintService!: MintOperationService;
    const { manager, fixture } = await setup({
      automatic: false,
      prepare: true,
      plugins: [
        {
          name: 'capture-destination',
          required: ['mintOperationService'],
          onInit: ({ services }) => {
            mintService = services.mintOperationService;
          },
        },
      ],
    });
    fixture.setDestinationState('ISSUED');
    const entered = deferred();
    const release = deferred();
    const issue = fixture.dependencies.mintHandlerProvider.get('bolt11').execute;
    const issuance = spyOn(MintBolt11Handler.prototype, 'execute').mockImplementation(
      async (context) => {
        entered.resolve();
        await release.promise;
        return issue(context);
      },
    );
    const execution = manager.ops.mintSwap.execute('swap');
    await entered.promise;
    await expect(mintService.execute('destination-child')).rejects.toBeInstanceOf(
      MintSwapChildOperationError,
    );
    release.resolve();
    const parent = await execution;
    expect(parent.state).toBe('completed');
    expect((await manager.ops.mint.get('destination-child'))?.state).toBe('finalized');
    expect(issuance).toHaveBeenCalledTimes(1);
  });

  it('rechecks trust inside source authorization after stale metadata preflight', async () => {
    const { manager, fixture, repo } = await setup({
      automatic: false,
      prepare: true,
    });
    const entered = deferred();
    const release = deferred();
    const refresh = fixture.dependencies.mintService.refreshAndCommitIfStale;
    spyOn(MintService.prototype, 'refreshAndCommitIfStale').mockImplementationOnce(async (url) => {
      const stale = await refresh(url);
      entered.resolve();
      await release.promise;
      return stale;
    });
    const execution = manager.ops.mintSwap.execute('swap');
    await entered.promise;
    const source = await repo.mintRepository.getMintByUrl(fixture.parent.sourceMintUrl);
    await repo.mintRepository.addOrUpdateMint({ ...source!, trusted: false });
    release.resolve();
    expect((await execution).state).toBe('prepared');
    expect(fixture.requests).not.toContain('melt');
    expect((await repo.meltOperationRepository.getById('source-child'))?.state).toBe('prepared');
  });

  it('drains an admitted command during disposal and rejects later commands', async () => {
    const { manager } = await setup({ automatic: false, prepare: true });
    const entered = deferred();
    const release = deferred();
    spyOn(MeltBolt11Handler.prototype, 'melt').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { status: 'PENDING', change: [] };
    });
    const operation = manager.ops.mintSwap.execute('swap');
    await entered.promise;
    let disposed = false;
    const disposal = manager.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    await expect(manager.ops.mintSwap.refresh('swap')).rejects.toThrow('disposed');
    release.resolve();
    await operation;
    await disposal;
    expect(disposed).toBe(true);
    expect(await manager.enableMintSwapOperationProcessor()).toBe(false);
  });

  it('drains preparation preflight and its committed callbacks before disposal', async () => {
    const { manager, fixture, repo } = await setup({ automatic: false });
    const entered = deferred();
    const release = deferred();
    const refresh = fixture.dependencies.mintService.refreshAndCommitIfStale;
    spyOn(MintService.prototype, 'refreshAndCommitIfStale').mockImplementationOnce(async (url) => {
      entered.resolve();
      await release.promise;
      return refresh(url);
    });
    const hints: number[] = [];
    manager.on('mint-swap:updated', ({ revision }) => {
      hints.push(revision);
    });
    const preparation = manager.ops.mintSwap.prepare(fixture.parent);
    await entered.promise;
    let disposed = false;
    const disposal = manager.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const disposedBeforePreflight = disposed;
    release.resolve();
    await Promise.all([preparation, disposal]);
    expect(disposedBeforePreflight).toBe(false);
    expect(hints).toEqual([0, 1]);
    expect((await repo.mintSwap.operationRepository.getById('swap'))?.state).toBe('prepared');
    await expect(manager.ops.mintSwap.prepare(fixture.parent)).rejects.toThrow('disposed');
    expect(hints).toEqual([0, 1]);
  });

  it('orders an overlapping resume after pause has drained', async () => {
    const { manager } = await setup({ prepare: true });
    const entered = deferred();
    const release = deferred();
    spyOn(manager, 'disableMintOperationWatcher').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const pausing = manager.pauseSubscriptions();
    await entered.promise;
    let resumed = false;
    const resuming = manager.resumeSubscriptions().then(() => {
      resumed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const resumedBeforePause = resumed;
    release.resolve();
    await Promise.all([pausing, resuming]);
    expect(resumedBeforePause).toBe(false);
    // Already running: resume must not finish with recovery silently stopped by the older pause.
    expect(await manager.enableMintSwapOperationProcessor()).toBe(false);
  });

  it('drains an admitted resume before disposal completes', async () => {
    const { manager } = await setup({ prepare: true });
    await manager.pauseSubscriptions();
    const entered = deferred();
    const release = deferred();
    manager.once('subscriptions:resumed', async () => {
      entered.resolve();
      await release.promise;
    });
    const resuming = manager.resumeSubscriptions();
    await entered.promise;
    let disposed = false;
    const disposal = manager.dispose().then(() => {
      disposed = true;
    });
    // Let disposal reach its drain rather than depending on a particular microtask count.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const disposedBeforeResume = disposed;
    release.resolve();
    await Promise.all([resuming, disposal]);
    expect(disposedBeforeResume).toBe(false);
    expect(await manager.enableMintSwapOperationProcessor()).toBe(false);
  });

  it('keeps parent notifications reentrant and excludes handler payloads from diagnostics', async () => {
    const logs: unknown[] = [];
    const logger = {
      info: (...args: unknown[]) => {
        logs.push(args);
      },
      debug: (...args: unknown[]) => {
        logs.push(args);
      },
      warn: (...args: unknown[]) => {
        logs.push(args);
      },
      error: (...args: unknown[]) => {
        logs.push(args);
      },
    };
    const { manager, fixture } = await setup({
      automatic: false,
      prepare: true,
      logger,
    });
    const secret = 'remote-invoice-proof-secret';
    spyOn(MeltBolt11Handler.prototype, 'melt').mockImplementation(
      async ({ logger: handlerLogger }) => {
        handlerLogger?.warn(secret, { secret });
        fixture.requests.push('melt');
        return { status: 'PENDING', change: [] };
      },
    );
    fixture.setSourceState('PENDING');
    manager.once('mint-swap:updated', async () => {
      await manager.ops.mintSwap.refresh('swap');
    });
    manager.on('mint-swap:updated', () => {
      throw new Error(secret);
    });
    expect((await manager.ops.mintSwap.execute('swap')).state).toBe('source_pending');
    expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it('recovers funded value after a lost issuance response and trust revocation', async () => {
    const { manager, fixture, repo } = await setup({
      automatic: false,
      prepare: true,
    });
    spyOn(MintBolt11Handler.prototype, 'execute').mockImplementation(async () => {
      fixture.requests.push('mint');
      throw new Error('issuance response lost');
    });
    expect((await manager.ops.mintSwap.execute('swap')).state).toBe('destination_pending');
    const original = await manager.ops.mintSwap.get('swap');
    await manager.dispose();
    for (const mintUrl of [fixture.parent.sourceMintUrl, fixture.parent.destinationMintUrl]) {
      const mint = await repo.mintRepository.getMintByUrl(mintUrl);
      await repo.mintRepository.addOrUpdateMint({ ...mint!, trusted: false });
    }
    spyOn(Date, 'now').mockReturnValue(30_000);
    fixture.setTime(30_000);
    fixture.setDestinationState('ISSUED');
    const reopened = await initializeCoco({
      repo,
      seedGetter: fixture.dependencies.loadSeed,
      ...mintSwapRuntimeConfig,
    });
    managers.push(reopened);
    const recovered = await reopened.ops.mintSwap.get('swap');
    expect(recovered?.state).toBe('completed');
    expect(recovered?.destinationOperationId).toBe(original?.destinationOperationId);
    expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
    expect(fixture.requests.filter((request) => request === 'mint')).toHaveLength(1);
    expect(fixture.requests).toContain('recover-mint');
    expect(
      (await repo.mintRepository.getMintByUrl(fixture.parent.destinationMintUrl))?.trusted,
    ).toBe(false);
  });

  it('publishes no parent hint when a creation transaction rolls back', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    const original = fixture.dependencies.transactionRunner;
    fixture.dependencies.transactionRunner = {
      run: (work) =>
        original.run(async (tx) => {
          const result = await work(tx);
          if (await tx.mintSwapOperations.getById('swap')) throw new Error('commit failed');
          return result;
        }),
    };
    const hints: unknown[] = [];
    fixture.events.on('mint-swap:updated', (hint) => {
      hints.push(hint);
    });
    await expect(fixture.service().prepare(fixture.parent)).rejects.toThrow('commit failed');
    expect(hints).toEqual([]);
    expect(await fixture.repositories.mintSwap.operationRepository.getById('swap')).toBeNull();
  });

  it('keeps attention queryable and direct constructor recovery compatible', async () => {
    const repo = new MemoryRepositories();
    await repo.init();
    await repo.mintSwap.operationRepository.create(mintSwapFixtures().needs_attention);
    const manager = new Manager(repo, async () => new Uint8Array(32));
    managers.push(manager);
    expect((await manager.ops.mintSwap.listActive())[0]?.state).toBe('needs_attention');
    expect((await manager.ops.mintSwap.refresh('swap')).state).toBe('needs_attention');
    expect((await manager.ops.mintSwap.waitForOutcome('swap')).status).toBe('needs_attention');
  });

  it('rejects malformed processor configuration before seed/quote effects', async () => {
    const seed = mock(async () => new Uint8Array(32));
    await expect(
      initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter: seed,
        processors: {
          mintSwapOperationProcessor: { disabled: 'yes' },
        } as unknown as CocoConfig['processors'],
      }),
    ).rejects.toThrow('must be boolean');
    expect(seed).not.toHaveBeenCalled();
  });
});
