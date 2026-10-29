import { Database } from 'bun:sqlite';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { Amount, type ProofState } from '@cashu/cashu-ts';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import {
  ProofStateWatcherService,
  type ProofStateRemote,
  type ProofStateWatcherOptions,
} from '../../services/watchers/ProofStateWatcherService.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofRepository, Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import {
  RepositoryCoreTransactionRunner,
  type CoreTransactionRunner,
} from '../../transactions/CoreTransaction.ts';
import type { CoreProof } from '../../types.ts';
import type { SendOperationService } from '../../operations/send/SendOperationService.ts';
import { NullLogger } from '../../logging/NullLogger.ts';
import { buildYHexMapsForSecrets } from '../../utils.ts';

type Notify = (payload: { Y: string; state: ProofState['state'] }) => Promise<void>;

const mintUrlA = 'https://mint-a.test';
const mintUrlB = 'https://mint-b.test';

const makeProof = (overrides: Partial<CoreProof>): CoreProof =>
  ({
    id: 'keyset-1',
    amount: Amount.from(1),
    secret: 'secret',
    C: 'C',
    mintUrl: mintUrlA,
    unit: 'sat',
    state: 'inflight',
    ...overrides,
  }) as CoreProof;

const yOf = (secret: string) => buildYHexMapsForSecrets([secret]).yHexBySecret.get(secret)!;

const pendingSend = (id: string, secrets: string[]) => ({
  id,
  state: 'pending',
  mintUrl: mintUrlA,
  unit: 'sat',
  amount: Amount.from(secrets.length),
  method: 'default',
  methodData: {},
  needsSwap: false,
  fee: Amount.from(0),
  inputAmount: Amount.from(secrets.length),
  inputProofSecrets: secrets,
  createdAt: 0,
  updatedAt: 0,
});

const trustedMints = () =>
  ({ isTrustedMint: mock(async () => true) }) as unknown as MintService & {
    isTrustedMint: Mock<() => Promise<boolean>>;
  };

/** Records one notification callback per watched proof Y. */
function recordingSubscriptions() {
  const notifyByY = new Map<string, Notify>();
  const watched: string[][] = [];
  const unsubscribe = mock(async () => {});
  const subscribe = mock(async (_mintUrl: string, _kind: string, filters: string[], cb: Notify) => {
    watched.push(filters);
    for (const y of filters) notifyByY.set(y, cb);
    return { subId: `sub-${watched.length}`, unsubscribe };
  });
  return {
    subs: { subscribe } as unknown as SubscriptionManager,
    subscribe,
    unsubscribe,
    isWatched: (secret: string) => watched.some((ys) => ys.includes(yOf(secret))),
    notify: (secret: string, state: ProofState['state']) =>
      notifyByY.get(yOf(secret))!({ Y: yOf(secret), state }),
  };
}

function stateRemote(states: Record<string, ProofState['state']> = {}) {
  const checkProofStates = mock(async (_mintUrl: string, _unit: string, proofs: CoreProof[]) =>
    proofs.map((proof) => ({
      Y: yOf(proof.secret),
      state: states[proof.secret] ?? 'UNSPENT',
      witness: null,
    })),
  );
  return { remote: { checkProofStates } as ProofStateRemote, checkProofStates };
}

function countingRunner(inner: CoreTransactionRunner, before?: () => Promise<void>) {
  const run = mock(async <T>(work: Parameters<CoreTransactionRunner['run']>[0]) => {
    await before?.();
    return inner.run(work) as Promise<T>;
  });
  return { runner: { run } as unknown as CoreTransactionRunner, run };
}

describe('ProofStateWatcherService lifecycle', () => {
  let bus: EventBus<CoreEvents>;
  let repositories: MemoryRepositories;

  beforeEach(async () => {
    bus = new EventBus<CoreEvents>();
    repositories = new MemoryRepositories();
    await repositories.init();
  });

  const createWatcher = (
    subs: SubscriptionManager,
    overrides: {
      runner?: CoreTransactionRunner;
      remote?: ProofStateRemote;
      proofRepository?: ProofRepository;
      options?: ProofStateWatcherOptions;
      mintService?: MintService;
    } = {},
  ) =>
    new ProofStateWatcherService(
      subs,
      overrides.mintService ?? trustedMints(),
      overrides.proofRepository ?? repositories.proofRepository,
      overrides.runner ?? new RepositoryCoreTransactionRunner(repositories),
      overrides.remote ?? stateRemote().remote,
      bus,
      undefined,
      overrides.options ?? { watchExistingInflightOnStart: false },
    );

  it('drains acquisition and unsubscribes a late subscription before stopping', async () => {
    await repositories.proofRepository.saveProofs(mintUrlA, [
      makeProof({ secret: 'late-proof' }),
      makeProof({ secret: 'after-stop' }),
    ]);
    let releaseSubscription!: (subscription: {
      subId: string;
      unsubscribe: () => Promise<void>;
    }) => void;
    let enteredSubscription!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredSubscription = resolve;
    });
    const unsubscribe = mock(async () => {});
    const subscribe = mock(
      () =>
        new Promise<{ subId: string; unsubscribe: () => Promise<void> }>((resolve) => {
          releaseSubscription = resolve;
          enteredSubscription();
        }),
    );
    const watcher = createWatcher({ subscribe } as unknown as SubscriptionManager);
    await watcher.start();
    const watching = watcher.watchProof(mintUrlA, ['late-proof']);
    await entered;
    // Overlapping discovery must not acquire another subscription for the same proof.
    await watcher.watchProof(mintUrlA, ['late-proof']);
    expect(subscribe).toHaveBeenCalledTimes(1);
    let didStop = false;
    const stopping = watcher.stop();
    expect(watcher.stop()).toBe(stopping);
    const stopped = stopping.then(() => {
      didStop = true;
    });
    await Promise.resolve();
    expect(didStop).toBe(false);
    releaseSubscription({ subId: 'late-subscription', unsubscribe });
    await Promise.all([watching, stopped]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await watcher.watchProof(mintUrlA, ['after-stop']);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('allows an awaited proof-state listener to stop the watcher', async () => {
    const secret = 'stop-from-listener';
    await repositories.proofRepository.saveProofs(mintUrlA, [makeProof({ secret })]);
    const subscriptions = recordingSubscriptions();
    const { runner, run } = countingRunner(new RepositoryCoreTransactionRunner(repositories));
    const watcher = createWatcher(subscriptions.subs, { runner });
    await watcher.start();
    await watcher.watchProof(mintUrlA, [secret]);
    const stoppedInListener = mock(async () => {
      await watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });
    bus.on('proofs:state-changed', stoppedInListener);

    await subscriptions.notify(secret, 'SPENT');

    expect(stoppedInListener).toHaveBeenCalledTimes(1);
    expect(subscriptions.unsubscribe).toHaveBeenCalledTimes(1);
    await subscriptions.notify(secret, 'SPENT');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('waits for subscription cleanup already started by a notification', async () => {
    const secret = 'cleanup-in-progress';
    await repositories.proofRepository.saveProofs(mintUrlA, [makeProof({ secret })]);
    let notify!: Notify;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let enteredCleanup!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredCleanup = resolve;
    });
    const unsubscribe = mock(async () => {
      enteredCleanup();
      await cleanup;
    });
    const subscribe = mock(async (_mintUrl, _kind, _filters, callback) => {
      notify = callback;
      return { subId: 'cleanup-in-progress', unsubscribe };
    });
    const watcher = createWatcher({ subscribe } as unknown as SubscriptionManager);
    await watcher.start();
    await watcher.watchProof(mintUrlA, [secret]);
    const notification = notify({ Y: yOf(secret), state: 'SPENT' });
    await entered;
    let didStop = false;
    const stopping = watcher.stop().then(() => {
      didStop = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(didStop).toBe(false);

    releaseCleanup();
    await Promise.all([notification, stopping]);
    expect(didStop).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('lets started processing finish without affecting a restarted watcher', async () => {
    const secret = 'finish-after-stop';
    await repositories.proofRepository.saveProofs(mintUrlA, [makeProof({ secret })]);
    const callbacks: Notify[] = [];
    const unsubscribes: Mock<() => Promise<void>>[] = [];
    const subscribe = mock(async (_mintUrl, _kind, _filters, callback) => {
      callbacks.push(callback);
      const unsubscribe = mock(async () => {});
      unsubscribes.push(unsubscribe);
      return { subId: `sub-${callbacks.length}`, unsubscribe };
    });
    let releaseProcessing!: () => void;
    const processing = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });
    let enteredProcessing!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredProcessing = resolve;
    });
    let blocked = true;
    const { runner, run } = countingRunner(
      new RepositoryCoreTransactionRunner(repositories),
      async () => {
        if (!blocked) return;
        blocked = false;
        enteredProcessing();
        await processing;
      },
    );
    const watcher = createWatcher({ subscribe } as unknown as SubscriptionManager, { runner });
    await watcher.start();
    await watcher.watchProof(mintUrlA, [secret]);
    const payload = { Y: yOf(secret), state: 'SPENT' as const };
    const notification = callbacks[0]!(payload);
    await entered;
    await watcher.stop();
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);

    await watcher.start();
    await watcher.watchProof(mintUrlA, [secret]);
    await callbacks[0]!(payload);
    expect(run).toHaveBeenCalledTimes(1);

    releaseProcessing();
    await notification;
    expect((await repositories.proofRepository.getProofBySecret(mintUrlA, secret))?.state).toBe(
      'spent',
    );
    // The committed reconciliation publishes the spent state, which releases the restarted watch.
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    await watcher.stop();
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
  });

  it('does not resume an old startup scan after a restart', async () => {
    let releaseScan!: (operations: { id: string; state: 'pending' }[]) => void;
    let enteredScan!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredScan = resolve;
    });
    const firstScan = new Promise<{ id: string; state: 'pending' }[]>((resolve) => {
      releaseScan = resolve;
    });
    const getPendingOperations = mock(() => {
      enteredScan();
      return firstScan;
    });
    let checkedInflight!: () => void;
    const checked = new Promise<void>((resolve) => {
      checkedInflight = resolve;
    });
    const getInflightProofs = mock(async () => {
      checkedInflight();
      return [];
    });
    const getOperation = mock(async () => undefined);
    const watcher = createWatcher({} as SubscriptionManager, {
      proofRepository: { getInflightProofs } as unknown as ProofRepository,
      options: { watchExistingInflightOnStart: true },
    });
    watcher.setSendOperationService({
      getPendingOperations,
      getOperation,
    } as unknown as SendOperationService);
    await watcher.start();
    await entered;
    await watcher.stop();
    getPendingOperations.mockImplementation(async () => []);
    await watcher.start();
    await checked;
    // Starting a new scan must not make the original scan eligible to continue.
    releaseScan([{ id: 'old-send', state: 'pending' }]);
    await firstScan;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getOperation).not.toHaveBeenCalled();
    // Each start scans inflight proofs once; Send discovery does not delay that scan.
    expect(getInflightProofs).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it('bootstraps inflight proofs on start by default', async () => {
    await repositories.proofRepository.saveProofs(mintUrlA, [
      makeProof({ mintUrl: mintUrlA, secret: 'a1' }),
      makeProof({ mintUrl: mintUrlA, secret: 'a2' }),
    ]);
    await repositories.proofRepository.saveProofs(mintUrlB, [
      makeProof({ mintUrl: mintUrlB, secret: 'b1' }),
    ]);
    const subscriptions = recordingSubscriptions();
    let scanned!: () => void;
    const done = new Promise<void>((resolve) => (scanned = resolve));
    const subscribe = subscriptions.subscribe.getMockImplementation()!;
    subscriptions.subscribe.mockImplementation(async (...args) => {
      const result = await subscribe(...args);
      if (args[0] === mintUrlB) scanned();
      return result;
    });
    const { remote, checkProofStates } = stateRemote();
    const watcher = createWatcher(subscriptions.subs, {
      remote,
      options: { watchExistingInflightOnStart: true },
    });

    await watcher.start();
    await done;

    expect(checkProofStates).toHaveBeenCalledTimes(2);
    expect(
      subscriptions.subscribe.mock.calls.map(([mintUrl, , filters]) => [mintUrl, filters]),
    ).toEqual([
      [mintUrlA, [yOf('a1'), yOf('a2')]],
      [mintUrlB, [yOf('b1')]],
    ]);

    await watcher.stop();
  });

  it('checks legacy unit-less inflight proofs as sat during the startup scan', async () => {
    await repositories.proofRepository.saveProofs(mintUrlA, [makeProof({ secret: 'legacy' })]);
    // Older records may have no unit when a repository returns them unnormalized.
    const proofRepository = Object.create(repositories.proofRepository) as ProofRepository;
    proofRepository.getInflightProofs = async () =>
      (await repositories.proofRepository.getInflightProofs()).map(
        ({ unit: _unit, ...proof }) => proof as CoreProof,
      );
    let reconciled!: () => void;
    const done = new Promise<void>((resolve) => (reconciled = resolve));
    bus.on('proofs:state-changed', async () => reconciled());
    const { remote, checkProofStates } = stateRemote({ legacy: 'SPENT' });
    const watcher = createWatcher({} as SubscriptionManager, {
      remote,
      proofRepository,
      options: { watchExistingInflightOnStart: true },
    });

    await watcher.start();
    await done;

    expect(checkProofStates).toHaveBeenCalledTimes(1);
    expect(checkProofStates.mock.calls[0]![1]).toBe('sat');
    expect((await repositories.proofRepository.getProofBySecret(mintUrlA, 'legacy'))?.state).toBe(
      'spent',
    );

    await watcher.stop();
  });

  it('skips bootstrapping inflight proofs when disabled', async () => {
    const getInflightProofs = mock(async () => []);
    const watchProof: Mock<ProofStateWatcherService['watchProof']> = mock(
      async (_mintUrl: string, _secrets: string[]) => {},
    );
    const { remote, checkProofStates } = stateRemote();
    const watcher = createWatcher({} as SubscriptionManager, {
      remote,
      proofRepository: { getInflightProofs } as unknown as ProofRepository,
    });
    watcher.watchProof = watchProof;

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(checkProofStates).not.toHaveBeenCalled();
    expect(getInflightProofs).not.toHaveBeenCalled();
    expect(watchProof).not.toHaveBeenCalled();

    await watcher.stop();
  });
});

describe('ProofStateWatcherService Send finalization', () => {
  let bus: EventBus<CoreEvents>;

  beforeEach(() => {
    bus = new EventBus<CoreEvents>();
  });

  const createWatcher = (proofRepository: ProofRepository) =>
    new ProofStateWatcherService(
      {} as SubscriptionManager,
      {} as MintService,
      proofRepository,
      {} as CoreTransactionRunner,
      {} as ProofStateRemote,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: false },
    );

  it('finalizes a pending send operation when the batched send proofs are all spent', async () => {
    const getProofBySecret = mock(async () =>
      makeProof({ secret: 'spent-1', state: 'spent', usedByOperationId: 'send-op-1' }),
    );
    const getProofsBySecrets = mock(async () => [
      makeProof({ secret: 'spent-1', state: 'spent' }),
      makeProof({ secret: 'spent-2', state: 'spent' }),
    ]);
    const finalize = mock(async () => {});
    const getOperation = mock(async () => pendingSend('send-op-1', ['spent-1', 'spent-2']));

    const watcher = createWatcher({
      getProofBySecret,
      getProofsBySecrets,
    } as unknown as ProofRepository);
    watcher.setSendOperationService({ getOperation, finalize } as unknown as SendOperationService);

    await watcher.start();
    await bus.emit('proofs:state-changed', {
      mintUrl: mintUrlA,
      secrets: ['spent-1'],
      state: 'spent',
    });

    expect(getProofBySecret).toHaveBeenCalledTimes(1);
    expect(getProofBySecret).toHaveBeenCalledWith(mintUrlA, 'spent-1');
    expect(getProofsBySecrets).toHaveBeenCalledTimes(1);
    expect(getProofsBySecrets).toHaveBeenCalledWith(mintUrlA, ['spent-1', 'spent-2']);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith('send-op-1');

    await watcher.stop();
  });

  it('checks finalization once for a batched spent event from the same send operation', async () => {
    const getProofBySecret = mock(async (_mintUrl: string, secret: string) =>
      makeProof({ secret, state: 'spent', usedByOperationId: 'send-op-1' }),
    );
    const getProofsBySecrets = mock(async () => [
      makeProof({ secret: 'spent-1', state: 'spent' }),
      makeProof({ secret: 'spent-2', state: 'spent' }),
    ]);
    const finalize = mock(async () => {});
    const getOperation = mock(async () => pendingSend('send-op-1', ['spent-1', 'spent-2']));

    const watcher = createWatcher({
      getProofBySecret,
      getProofsBySecrets,
    } as unknown as ProofRepository);
    watcher.setSendOperationService({ getOperation, finalize } as unknown as SendOperationService);

    await watcher.start();
    await bus.emit('proofs:state-changed', {
      mintUrl: mintUrlA,
      secrets: ['spent-1', 'spent-2'],
      state: 'spent',
    });

    expect(getProofBySecret).toHaveBeenCalledTimes(2);
    expect(getProofBySecret).toHaveBeenCalledWith(mintUrlA, 'spent-1');
    expect(getProofBySecret).toHaveBeenCalledWith(mintUrlA, 'spent-2');
    expect(getOperation).toHaveBeenCalledTimes(1);
    expect(getOperation).toHaveBeenCalledWith('send-op-1');
    expect(getProofsBySecrets).toHaveBeenCalledTimes(1);
    expect(getProofsBySecrets).toHaveBeenCalledWith(mintUrlA, ['spent-1', 'spent-2']);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith('send-op-1');

    await watcher.stop();
  });

  it('checks each operation once for a batched spent event from different send operations', async () => {
    const operationBySecret = new Map([
      ['spent-1', 'send-op-1'],
      ['spent-2', 'send-op-2'],
    ]);
    const getProofBySecret = mock(async (_mintUrl: string, secret: string) =>
      makeProof({
        secret,
        state: 'spent',
        usedByOperationId: operationBySecret.get(secret),
      }),
    );
    const getProofsBySecrets = mock(async (_mintUrl: string, secrets: string[]) =>
      secrets.map((secret) => makeProof({ secret, state: 'spent' })),
    );
    const finalize = mock(async () => {});
    const getOperation = mock(async (operationId: string) =>
      pendingSend(operationId, operationId === 'send-op-1' ? ['spent-1'] : ['spent-2']),
    );

    const watcher = createWatcher({
      getProofBySecret,
      getProofsBySecrets,
    } as unknown as ProofRepository);
    watcher.setSendOperationService({ getOperation, finalize } as unknown as SendOperationService);

    await watcher.start();
    await bus.emit('proofs:state-changed', {
      mintUrl: mintUrlA,
      secrets: ['spent-1', 'spent-2'],
      state: 'spent',
    });

    expect(getProofBySecret).toHaveBeenCalledTimes(2);
    expect(getOperation).toHaveBeenCalledTimes(2);
    expect(getOperation).toHaveBeenCalledWith('send-op-1');
    expect(getOperation).toHaveBeenCalledWith('send-op-2');
    expect(getProofsBySecrets).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledWith('send-op-1');
    expect(finalize).toHaveBeenCalledWith('send-op-2');

    await watcher.stop();
  });

  it('does not finalize a pending send operation when the batched lookup is missing a proof', async () => {
    const getProofBySecret = mock(async () =>
      makeProof({ secret: 'spent-1', state: 'spent', usedByOperationId: 'send-op-1' }),
    );
    const getProofsBySecrets = mock(async () => [makeProof({ secret: 'spent-1', state: 'spent' })]);
    const finalize = mock(async () => {});
    const getOperation = mock(async () => pendingSend('send-op-1', ['spent-1', 'spent-2']));

    const watcher = createWatcher({
      getProofBySecret,
      getProofsBySecrets,
    } as unknown as ProofRepository);
    watcher.setSendOperationService({ getOperation, finalize } as unknown as SendOperationService);

    await watcher.start();
    await bus.emit('proofs:state-changed', {
      mintUrl: mintUrlA,
      secrets: ['spent-1'],
      state: 'spent',
    });

    expect(getProofsBySecrets).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();

    await watcher.stop();
  });
});

describe.each(['memory', 'sqlite'] as const)(
  'ProofStateWatcherService Owning Operation routing (%s)',
  (adapter) => {
    let bus: EventBus<CoreEvents>;
    let repositories: Repositories;
    let database: Database | undefined;
    let stateChanges: CoreEvents['proofs:state-changed'][];

    beforeEach(async () => {
      bus = new EventBus<CoreEvents>();
      if (adapter === 'sqlite') {
        database = new Database(':memory:');
        repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
      } else repositories = new MemoryRepositories();
      await repositories.init();
      stateChanges = [];
      bus.on('proofs:state-changed', async (event) => {
        // Publication follows commit: the persisted state already matches the event.
        const stored = await repositories.proofRepository.getProofsBySecrets(
          event.mintUrl,
          event.secrets,
        );
        expect(stored.map((proof) => proof.state)).toEqual(event.secrets.map(() => event.state));
        stateChanges.push(event);
      });
    });
    afterEach(() => database?.close());

    const stateOf = async (secret: string) =>
      (await repositories.proofRepository.getProofBySecret(mintUrlA, secret))?.state;

    const sendService = (
      sends: Record<string, string[]>,
      recordProofSpent: (operationId: string, secret: string) => Promise<boolean>,
    ) => {
      const service = {
        getOperation: mock(async (id: string) => (sends[id] ? pendingSend(id, sends[id]!) : null)),
        getPendingOperations: mock(async () => []),
        finalize: mock(async () => {}),
        recordProofSpent: mock(recordProofSpent),
      };
      return service;
    };

    const createWatcher = (input: {
      subs: SubscriptionManager;
      runner?: CoreTransactionRunner;
      remote?: ProofStateRemote;
      send?: ReturnType<typeof sendService>;
      watchExistingInflightOnStart?: boolean;
    }) => {
      const watcher = new ProofStateWatcherService(
        input.subs,
        trustedMints(),
        repositories.proofRepository,
        input.runner ?? new RepositoryCoreTransactionRunner(repositories),
        input.remote ?? stateRemote().remote,
        bus,
        new NullLogger(),
        { watchExistingInflightOnStart: input.watchExistingInflightOnStart ?? false },
      );
      watcher.setSendOperationService(
        (input.send ?? sendService({}, async () => false)) as unknown as SendOperationService,
      );
      return watcher;
    };

    it.each(['usedByOperationId', 'createdByOperationId'] as const)(
      'completes SPENT evidence for a Send-owned proof (%s) only through the Send',
      async (ownership) => {
        const secret = 'send-owned';
        await repositories.proofRepository.saveProofs(mintUrlA, [
          makeProof({ secret, [ownership]: 'send-op' }),
        ]);
        const subscriptions = recordingSubscriptions();
        const { runner, run } = countingRunner(new RepositoryCoreTransactionRunner(repositories));
        const send = sendService({ 'send-op': [secret] }, async () => true);
        const watcher = createWatcher({ subs: subscriptions.subs, runner, send });
        await watcher.start();
        await watcher.watchProof(mintUrlA, [secret]);

        await subscriptions.notify(secret, 'SPENT');

        expect(send.recordProofSpent).toHaveBeenCalledTimes(1);
        expect(send.recordProofSpent).toHaveBeenCalledWith('send-op', secret);
        expect(run).not.toHaveBeenCalled();
        expect(await stateOf(secret)).toBe('inflight');
        expect(subscriptions.unsubscribe).toHaveBeenCalledTimes(1);
        await watcher.stop();
      },
    );

    it.each([
      ['declines', async (): Promise<boolean> => false],
      [
        'fails',
        async (): Promise<boolean> => {
          throw new Error('Send could not apply evidence');
        },
      ],
    ] as const)('makes no direct write when the Send %s', async (_label, recordProofSpent) => {
      const secret = 'send-declined';
      await repositories.proofRepository.saveProofs(mintUrlA, [
        makeProof({ secret, usedByOperationId: 'send-op' }),
      ]);
      const subscriptions = recordingSubscriptions();
      const { runner, run } = countingRunner(new RepositoryCoreTransactionRunner(repositories));
      const send = sendService({ 'send-op': [secret] }, recordProofSpent);
      const watcher = createWatcher({ subs: subscriptions.subs, runner, send });
      await watcher.start();
      await watcher.watchProof(mintUrlA, [secret]);

      await subscriptions.notify(secret, 'SPENT');

      expect(send.recordProofSpent).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      expect(await stateOf(secret)).toBe('inflight');
      expect(stateChanges).toEqual([]);
      await watcher.stop();
    });

    it('routes startup SPENT evidence for a Send-owned proof to the Send', async () => {
      const secret = 'send-startup';
      await repositories.proofRepository.saveProofs(mintUrlA, [
        makeProof({ secret, usedByOperationId: 'send-op' }),
      ]);
      const subscriptions = recordingSubscriptions();
      const { remote } = stateRemote({ [secret]: 'SPENT' });
      let routed!: () => void;
      const done = new Promise<void>((resolve) => (routed = resolve));
      const send = sendService({ 'send-op': [secret] }, async () => {
        routed();
        return false;
      });
      const { runner, run } = countingRunner(new RepositoryCoreTransactionRunner(repositories));
      const watcher = createWatcher({
        subs: subscriptions.subs,
        remote,
        runner,
        send,
        watchExistingInflightOnStart: true,
      });
      await watcher.start();
      await done;

      expect(send.recordProofSpent).toHaveBeenCalledWith('send-op', secret);
      expect(run).not.toHaveBeenCalled();
      expect(await stateOf(secret)).toBe('inflight');
      await watcher.stop();
    });

    it('does not subscribe, state-check or write Melt-owned inflight proofs', async () => {
      const used = makeProof({ secret: 'melt-input', usedByOperationId: 'melt-op' });
      const created = makeProof({ secret: 'melt-send', createdByOperationId: 'melt-op' });
      const unowned = makeProof({ secret: 'unowned' });
      await repositories.proofRepository.saveProofs(mintUrlA, [used, created, unowned]);
      const subscriptions = recordingSubscriptions();
      let scanned!: () => void;
      const done = new Promise<void>((resolve) => (scanned = resolve));
      subscriptions.subscribe.mockImplementationOnce(async () => {
        scanned();
        return { subId: 'startup', unsubscribe: subscriptions.unsubscribe };
      });
      const { remote, checkProofStates } = stateRemote({
        'melt-input': 'SPENT',
        'melt-send': 'SPENT',
      });
      const { runner, run } = countingRunner(new RepositoryCoreTransactionRunner(repositories));
      const send = sendService({}, async () => true);
      const watcher = createWatcher({
        subs: subscriptions.subs,
        remote,
        runner,
        send,
        watchExistingInflightOnStart: true,
      });
      await watcher.start();
      await done;

      const checked = checkProofStates.mock.calls.flatMap(([, , proofs]) =>
        proofs.map((p) => p.secret),
      );
      expect(checked).toEqual(['unowned']);
      expect(subscriptions.subscribe.mock.calls[0]![2]).toEqual([yOf('unowned')]);

      await bus.emit('proofs:state-changed', {
        mintUrl: mintUrlA,
        secrets: [used.secret],
        state: 'inflight',
      });
      await bus.emit('proofs:saved', {
        mintUrl: mintUrlA,
        keysetId: created.id,
        proofs: [created],
      });
      await watcher.watchProof(mintUrlA, [used.secret, created.secret]);

      expect(subscriptions.subscribe).toHaveBeenCalledTimes(1);
      expect(send.recordProofSpent).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(await stateOf(used.secret)).toBe('inflight');
      expect(await stateOf(created.secret)).toBe('inflight');
      await watcher.stop();
    });

    it('reconciles an unowned inflight proof on SPENT notification and publishes after commit', async () => {
      const secret = 'unowned-spent';
      await repositories.proofRepository.saveProofs(mintUrlA, [makeProof({ secret })]);
      const subscriptions = recordingSubscriptions();
      const send = sendService({}, async () => true);
      const watcher = createWatcher({ subs: subscriptions.subs, send });
      await watcher.start();
      await watcher.watchProof(mintUrlA, [secret]);

      await subscriptions.notify(secret, 'SPENT');

      expect(await stateOf(secret)).toBe('spent');
      expect(stateChanges).toEqual([{ mintUrl: mintUrlA, secrets: [secret], state: 'spent' }]);
      expect(send.recordProofSpent).not.toHaveBeenCalled();
      await watcher.stop();
    });

    it('reconciles unowned SPENT proofs at startup and leaves UNSPENT and PENDING unchanged', async () => {
      await repositories.proofRepository.saveProofs(mintUrlA, [
        makeProof({ secret: 'spent' }),
        makeProof({ secret: 'unspent' }),
        makeProof({ secret: 'pending' }),
      ]);
      const subscriptions = recordingSubscriptions();
      let scanned!: () => void;
      const done = new Promise<void>((resolve) => (scanned = resolve));
      const subscribe = subscriptions.subscribe.getMockImplementation()!;
      subscriptions.subscribe.mockImplementationOnce(async (...args) => {
        const result = await subscribe(...args);
        scanned();
        return result;
      });
      const { remote } = stateRemote({ spent: 'SPENT', pending: 'PENDING' });
      const watcher = createWatcher({
        subs: subscriptions.subs,
        remote,
        watchExistingInflightOnStart: true,
      });
      await watcher.start();
      await done;

      expect(await stateOf('spent')).toBe('spent');
      expect(await stateOf('unspent')).toBe('inflight');
      expect(await stateOf('pending')).toBe('inflight');
      expect(stateChanges).toEqual([{ mintUrl: mintUrlA, secrets: ['spent'], state: 'spent' }]);
      expect(subscriptions.isWatched('spent')).toBe(false);
      expect(subscriptions.isWatched('unspent')).toBe(true);
      expect(subscriptions.isWatched('pending')).toBe(true);

      await subscriptions.notify('unspent', 'UNSPENT');
      await subscriptions.notify('pending', 'PENDING');
      expect(await stateOf('unspent')).toBe('inflight');
      expect(await stateOf('pending')).toBe('inflight');
      expect(stateChanges).toHaveLength(1);
      await watcher.stop();
    });

    it.each([
      [
        'becomes owned',
        async (secret: string) => {
          await repositories.proofRepository.setProofState(mintUrlA, [secret], 'ready');
          await repositories.proofRepository.reserveProofs(mintUrlA, [secret], 'send-op');
          await repositories.proofRepository.setProofState(mintUrlA, [secret], 'inflight');
        },
        'inflight',
      ],
      [
        'changes state',
        async (secret: string) => {
          await repositories.proofRepository.setProofState(mintUrlA, [secret], 'ready');
        },
        'ready',
      ],
    ] as const)(
      'leaves an unowned proof that %s before commit untouched',
      async (_label, change, expectedState) => {
        const secret = 'raced';
        await repositories.proofRepository.saveProofs(mintUrlA, [makeProof({ secret })]);
        const subscriptions = recordingSubscriptions();
        const { runner, run } = countingRunner(
          new RepositoryCoreTransactionRunner(repositories),
          () => change(secret),
        );
        const watcher = createWatcher({ subs: subscriptions.subs, runner });
        await watcher.start();
        await watcher.watchProof(mintUrlA, [secret]);

        await subscriptions.notify(secret, 'SPENT');

        expect(run).toHaveBeenCalledTimes(1);
        expect(await stateOf(secret)).toBe(expectedState);
        expect(stateChanges).toEqual([]);
        await watcher.stop();
      },
    );
  },
);
