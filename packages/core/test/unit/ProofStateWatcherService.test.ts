import { Amount } from '@cashu/cashu-ts';
import { describe, it, expect, beforeEach, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { ProofStateWatcherService } from '../../services/watchers/ProofStateWatcherService.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { ProofRepository } from '../../repositories/index.ts';
import type { CoreProof } from '../../types.ts';
import type { SendOperationService } from '../../operations/send/SendOperationService.ts';
import { NullLogger } from '../../logging/NullLogger.ts';
import { buildYHexMapsForSecrets } from '../../utils.ts';

describe('ProofStateWatcherService', () => {
  const mintUrlA = 'https://mint-a.test';
  const mintUrlB = 'https://mint-b.test';

  let bus: EventBus<CoreEvents>;

  const makeProof = (overrides: Partial<CoreProof>): CoreProof =>
    ({
      id: 'keyset-1',
      amount: Amount.from(1),
      secret: 'secret',
      C: 'C' as unknown as CoreProof['C'],
      mintUrl: mintUrlA,
      unit: 'sat',
      state: 'inflight',
      ...overrides,
    }) as CoreProof;

  beforeEach(() => {
    bus = new EventBus<CoreEvents>();
  });

  it('drains acquisition and unsubscribes a late subscription before stopping', async () => {
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
    const watcher = new ProofStateWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: async () => true } as unknown as MintService,
      {} as ProofService,
      {} as ProofRepository,
      bus,
      undefined,
      { watchExistingInflightOnStart: false },
    );
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
    let notify!: (payload: { Y: string; state: 'SPENT' }) => Promise<void>;
    const unsubscribe = mock(async () => {});
    const subscribe = mock(async (_mintUrl, _kind, _filters, callback) => {
      notify = callback;
      return { subId: 'stop-from-listener', unsubscribe };
    });
    const setProofState = mock(async (mintUrl: string, secrets: string[], state: 'spent') => {
      await bus.emit('proofs:state-changed', { mintUrl, secrets, state });
    });
    const watcher = new ProofStateWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: async () => true } as unknown as MintService,
      { setProofState } as unknown as ProofService,
      {} as ProofRepository,
      bus,
      undefined,
      { watchExistingInflightOnStart: false },
    );
    await watcher.start();
    await watcher.watchProof(mintUrlA, [secret]);
    const stoppedInListener = mock(async () => {
      await watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });
    bus.on('proofs:state-changed', stoppedInListener);

    const Y = buildYHexMapsForSecrets([secret]).yHexBySecret.get(secret)!;
    await notify({ Y, state: 'SPENT' });

    expect(stoppedInListener).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await notify({ Y, state: 'SPENT' });
    expect(setProofState).toHaveBeenCalledTimes(1);
  });

  it('waits for subscription cleanup already started by a notification', async () => {
    const secret = 'cleanup-in-progress';
    let notify!: (payload: { Y: string; state: 'SPENT' }) => Promise<void>;
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
    const watcher = new ProofStateWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: async () => true } as unknown as MintService,
      { setProofState: async () => {} } as unknown as ProofService,
      {} as ProofRepository,
      bus,
      undefined,
      { watchExistingInflightOnStart: false },
    );
    await watcher.start();
    await watcher.watchProof(mintUrlA, [secret]);
    const notification = notify({
      Y: buildYHexMapsForSecrets([secret]).yHexBySecret.get(secret)!,
      state: 'SPENT',
    });
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
    const callbacks: ((payload: { Y: string; state: 'SPENT' }) => Promise<void>)[] = [];
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
    let didFinish = false;
    const setProofState = mock(async () => {
      enteredProcessing();
      await processing;
      didFinish = true;
    });
    const watcher = new ProofStateWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: async () => true } as unknown as MintService,
      { setProofState } as unknown as ProofService,
      {} as ProofRepository,
      bus,
      undefined,
      { watchExistingInflightOnStart: false },
    );
    await watcher.start();
    await watcher.watchProof(mintUrlA, [secret]);
    const payload = {
      Y: buildYHexMapsForSecrets([secret]).yHexBySecret.get(secret)!,
      state: 'SPENT' as const,
    };
    const notification = callbacks[0]!(payload);
    await entered;
    await watcher.stop();
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(didFinish).toBe(false);

    await watcher.start();
    await watcher.watchProof(mintUrlA, [secret]);
    await callbacks[0]!(payload);
    expect(setProofState).toHaveBeenCalledTimes(1);

    releaseProcessing();
    await notification;
    expect(didFinish).toBe(true);
    expect(unsubscribes[1]).not.toHaveBeenCalled();
    await callbacks[1]!(payload);
    expect(setProofState).toHaveBeenCalledTimes(2);
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
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
    const checkInflightProofs = mock(async () => checkedInflight());
    const getOperation = mock(async () => undefined);
    const watcher = new ProofStateWatcherService(
      {} as SubscriptionManager,
      {} as MintService,
      { checkInflightProofs } as unknown as ProofService,
      { getInflightProofs: async () => [] } as unknown as ProofRepository,
      bus,
    );
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
    expect(checkInflightProofs).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it('bootstraps inflight proofs on start by default', async () => {
    const checkInflightProofs = mock(async () => {});
    const inflightProofs = [
      makeProof({ mintUrl: mintUrlA, secret: 'a1' }),
      makeProof({ mintUrl: mintUrlA, secret: 'a2' }),
      makeProof({ mintUrl: mintUrlB, secret: 'b1' }),
      makeProof({ mintUrl: '', secret: 'invalid' }),
      makeProof({ mintUrl: mintUrlA, secret: '' }),
    ];
    const getInflightProofs = mock(async () => inflightProofs);
    const watchProof: Mock<ProofStateWatcherService['watchProof']> = mock(
      async (_mintUrl: string, _secrets: string[]) => {},
    );

    const proofService = {
      checkInflightProofs,
    } as unknown as ProofService;
    const proofRepository = {
      getInflightProofs,
    } as unknown as ProofRepository;
    const subs = {} as SubscriptionManager;
    const mintService = {
      isTrustedMint: mock(async () => true),
    } as unknown as MintService;

    const watcher = new ProofStateWatcherService(
      subs,
      mintService,
      proofService,
      proofRepository,
      bus,
      new NullLogger(),
    );
    watcher.watchProof = watchProof;

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(checkInflightProofs).toHaveBeenCalledTimes(1);
    expect(getInflightProofs).toHaveBeenCalledTimes(1);
    expect(watchProof).toHaveBeenCalledTimes(2);
    expect(watchProof.mock.calls[0]).toEqual([mintUrlA, ['a1', 'a2']]);
    expect(watchProof.mock.calls[1]).toEqual([mintUrlB, ['b1']]);

    await watcher.stop();
  });

  it('skips bootstrapping inflight proofs when disabled', async () => {
    const checkInflightProofs = mock(async () => {});
    const getInflightProofs = mock(async () => []);
    const watchProof: Mock<ProofStateWatcherService['watchProof']> = mock(
      async (_mintUrl: string, _secrets: string[]) => {},
    );

    const proofService = {
      checkInflightProofs,
    } as unknown as ProofService;
    const proofRepository = {
      getInflightProofs,
    } as unknown as ProofRepository;
    const subs = {} as SubscriptionManager;
    const mintService = {
      isTrustedMint: mock(async () => true),
    } as unknown as MintService;

    const watcher = new ProofStateWatcherService(
      subs,
      mintService,
      proofService,
      proofRepository,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: false },
    );
    watcher.watchProof = watchProof;

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(checkInflightProofs).not.toHaveBeenCalled();
    expect(getInflightProofs).not.toHaveBeenCalled();
    expect(watchProof).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('finalizes a pending send operation when the batched send proofs are all spent', async () => {
    const getProofBySecret = mock(async () =>
      makeProof({ secret: 'spent-1', state: 'spent', usedByOperationId: 'send-op-1' }),
    );
    const getProofsBySecrets = mock(async () => [
      makeProof({ secret: 'spent-1', state: 'spent' }),
      makeProof({ secret: 'spent-2', state: 'spent' }),
    ]);
    const finalize = mock(async () => {});
    const getOperation = mock(async () => ({
      id: 'send-op-1',
      state: 'pending',
      mintUrl: mintUrlA,
      amount: Amount.from(2),
      method: 'default',
      methodData: {},
      needsSwap: false,
      fee: Amount.from(0),
      inputAmount: Amount.from(2),
      inputProofSecrets: ['spent-1', 'spent-2'],
      createdAt: 0,
      updatedAt: 0,
    }));

    const watcher = new ProofStateWatcherService(
      {} as SubscriptionManager,
      {} as MintService,
      {} as ProofService,
      {
        getProofBySecret,
        getProofsBySecrets,
      } as unknown as ProofRepository,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: false },
    );
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
    const getOperation = mock(async () => ({
      id: 'send-op-1',
      state: 'pending',
      mintUrl: mintUrlA,
      amount: Amount.from(2),
      method: 'default',
      methodData: {},
      needsSwap: false,
      fee: Amount.from(0),
      inputAmount: Amount.from(2),
      inputProofSecrets: ['spent-1', 'spent-2'],
      createdAt: 0,
      updatedAt: 0,
    }));

    const watcher = new ProofStateWatcherService(
      {} as SubscriptionManager,
      {} as MintService,
      {} as ProofService,
      {
        getProofBySecret,
        getProofsBySecrets,
      } as unknown as ProofRepository,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: false },
    );
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
    const getOperation = mock(async (operationId: string) => ({
      id: operationId,
      state: 'pending',
      mintUrl: mintUrlA,
      amount: Amount.from(1),
      method: 'default',
      methodData: {},
      needsSwap: false,
      fee: Amount.from(0),
      inputAmount: Amount.from(1),
      inputProofSecrets: operationId === 'send-op-1' ? ['spent-1'] : ['spent-2'],
      createdAt: 0,
      updatedAt: 0,
    }));

    const watcher = new ProofStateWatcherService(
      {} as SubscriptionManager,
      {} as MintService,
      {} as ProofService,
      {
        getProofBySecret,
        getProofsBySecrets,
      } as unknown as ProofRepository,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: false },
    );
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
    const getOperation = mock(async () => ({
      id: 'send-op-1',
      state: 'pending',
      mintUrl: mintUrlA,
      amount: Amount.from(2),
      method: 'default',
      methodData: {},
      needsSwap: false,
      fee: Amount.from(0),
      inputAmount: Amount.from(2),
      inputProofSecrets: ['spent-1', 'spent-2'],
      createdAt: 0,
      updatedAt: 0,
    }));

    const watcher = new ProofStateWatcherService(
      {} as SubscriptionManager,
      {} as MintService,
      {} as ProofService,
      {
        getProofBySecret,
        getProofsBySecrets,
      } as unknown as ProofRepository,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: false },
    );
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

  it('finalizes once for a spent subscription notification emitted through proof state events', async () => {
    const secret = 'spent-1';
    const { yHexBySecret } = buildYHexMapsForSecrets([secret]);
    let subscriptionCallback:
      | ((payload: { Y: string; state: 'SPENT'; witness?: unknown }) => Promise<void> | void)
      | undefined;
    const unsubscribe = mock(async () => {});
    const subscribe = mock(async (_mintUrl, _kind, _filters, callback) => {
      subscriptionCallback = callback;
      return { subId: 'sub-1', unsubscribe };
    });
    const setProofState = mock(
      async (mintUrl: string, secrets: string[], state: 'inflight' | 'ready' | 'spent') => {
        await bus.emit('proofs:state-changed', { mintUrl, secrets, state });
      },
    );
    const getProofBySecret = mock(async () =>
      makeProof({ secret, state: 'spent', usedByOperationId: 'send-op-1' }),
    );
    const getProofsBySecrets = mock(async () => [makeProof({ secret, state: 'spent' })]);
    const finalize = mock(async () => {});
    const recordProofSpent = mock(async (operationId: string, observedSecret: string) => {
      await bus.emit('proofs:state-changed', {
        mintUrl: mintUrlA,
        secrets: [observedSecret],
        state: 'spent',
      });
      return operationId === 'send-op-1';
    });
    const getOperation = mock(async () => ({
      id: 'send-op-1',
      state: 'pending',
      mintUrl: mintUrlA,
      amount: Amount.from(1),
      unit: 'sat',
      method: 'default',
      methodData: {},
      needsSwap: false,
      fee: Amount.from(0),
      inputAmount: Amount.from(1),
      inputProofSecrets: [secret],
      createdAt: 0,
      updatedAt: 0,
    }));

    const watcher = new ProofStateWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      {
        isTrustedMint: mock(async () => true),
      } as unknown as MintService,
      {
        setProofState,
      } as unknown as ProofService,
      {
        getProofBySecret,
        getProofsBySecrets,
      } as unknown as ProofRepository,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: false },
    );
    watcher.setSendOperationService({
      getOperation,
      finalize,
      recordProofSpent,
    } as unknown as SendOperationService);

    await watcher.start();
    await watcher.watchProof(mintUrlA, [secret]);
    expect(subscriptionCallback).toBeDefined();

    await subscriptionCallback!({ Y: yHexBySecret.get(secret)!, state: 'SPENT' });

    expect(setProofState).not.toHaveBeenCalled();
    expect(recordProofSpent).toHaveBeenCalledTimes(1);
    expect(recordProofSpent).toHaveBeenCalledWith('send-op-1', secret);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    // Once for subscription routing and once for the post-commit event listener.
    expect(getProofBySecret).toHaveBeenCalledTimes(2);
    expect(getProofBySecret).toHaveBeenCalledWith(mintUrlA, secret);
    expect(getProofsBySecrets).toHaveBeenCalledTimes(1);
    expect(getProofsBySecrets).toHaveBeenCalledWith(mintUrlA, [secret]);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith('send-op-1');

    await watcher.stop();
  });
});
