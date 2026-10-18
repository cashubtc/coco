import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import { ProofStateWatcherService } from '../../services/watchers/ProofStateWatcherService.ts';
import { buildYHexMapsForSecrets } from '../../utils.ts';

const mintUrl = 'https://mint.test';
const proof = {
  mintUrl,
  id: 'old',
  secret: 'pending-secret',
  C: 'signature',
  amount: Amount.from(8),
  unit: 'sat',
  state: 'pending' as const,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function fixture(pauseAcquisition = false) {
  const repositories = new MemoryRepositories();
  await repositories.init();
  const runner = new RepositoryCoreTransactionRunner(repositories);
  const bus = new EventBus<CoreEvents>();
  const subscribed = deferred<void>();
  const acquired = deferred<void>();
  const unsubscribe = mock(async () => {});
  let notify!: (payload: { Y: string; state: string }) => Promise<void>;
  const activeCallbacks = new Set<typeof notify>();
  const subs = {
    subscribe: async (_mint: string, _kind: string, _filters: string[], cb: typeof notify) => {
      notify = cb;
      activeCallbacks.add(cb);
      subscribed.resolve();
      if (pauseAcquisition) await acquired.promise;
      return {
        subId: 'test',
        unsubscribe: async () => {
          activeCallbacks.delete(cb);
          await unsubscribe();
        },
      };
    },
  } as unknown as SubscriptionManager;
  const watcher = new ProofStateWatcherService(
    runner,
    subs,
    { isTrustedMint: async () => true } as unknown as MintService,
    {
      checkInflightProofs: async () => {},
      setProofState: async (url, secrets, state) => {
        await repositories.proofRepository.setProofState(url, secrets, state);
        await bus.emit('proofs:state-changed', { mintUrl: url, secrets, state });
      },
    } as Pick<ProofService, 'checkInflightProofs' | 'setProofState'> as ProofService,
    repositories.proofRepository,
    bus,
  );
  return {
    repositories,
    runner,
    bus,
    watcher,
    subscribed,
    acquired,
    unsubscribe,
    notify: (state: string) =>
      notify({ Y: buildYHexMapsForSecrets([proof.secret]).yHexBySecret.get(proof.secret)!, state }),
    notifyActive: (state: string) =>
      Promise.all(
        [...activeCallbacks].map((cb) =>
          cb({ Y: buildYHexMapsForSecrets([proof.secret]).yHexBySecret.get(proof.secret)!, state }),
        ),
      ),
  };
}

describe('Restored pending proof watcher', () => {
  it.each(['before', 'after'])(
    'keeps watching when the readiness listener is registered %s the watcher',
    async (order) => {
      const f = await fixture();
      await f.repositories.proofRepository.saveProofs(mintUrl, [proof]);
      const listen = () =>
        f.bus.on('proofs:state-changed', async ({ state }) => {
          if (state !== 'ready') return;
          await f.repositories.proofRepository.setProofState(mintUrl, [proof.secret], 'inflight');
          await f.bus.emit('proofs:state-changed', {
            mintUrl,
            secrets: [proof.secret],
            state: 'inflight',
          });
        });
      if (order === 'before') listen();
      await f.watcher.start();
      await f.subscribed.promise;
      await f.watcher.watchProof(mintUrl, [proof.secret]);
      if (order === 'after') listen();

      try {
        await f.notify('UNSPENT');
        expect(f.unsubscribe).toHaveBeenCalledTimes(1);
        await f.notifyActive('SPENT');
        expect(
          (await f.repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
        ).toBe('spent');
        expect(f.unsubscribe).toHaveBeenCalledTimes(2);
      } finally {
        await f.watcher.stop();
      }
    },
  );

  it.each(['UNSPENT', 'SPENT'])(
    'allows a %s reconciliation listener to await shutdown without delivering later callbacks',
    async (state) => {
      const f = await fixture();
      await f.repositories.proofRepository.saveProofs(mintUrl, [proof]);
      await f.watcher.start();
      await f.subscribed.promise;
      const stopped = deferred<void>();
      f.bus.on('proofs:state-changed', async () => {
        await f.watcher.stop();
        stopped.resolve();
      });
      const later = mock(() => {});
      f.bus.on('proofs:state-changed', later);

      await f.notify(state);
      await stopped.promise;
      expect(f.watcher.isRunning()).toBe(false);
      expect(f.unsubscribe).toHaveBeenCalledTimes(1);
      expect(later).not.toHaveBeenCalled();
      await f.notify('SPENT');
      expect(
        (await f.repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
      ).toBe(state === 'UNSPENT' ? 'ready' : 'spent');
    },
    1000,
  );

  it('drains subscription acquisition when a reconciliation listener requests shutdown', async () => {
    const f = await fixture(true);
    await f.repositories.proofRepository.saveProofs(mintUrl, [proof]);
    await f.watcher.start();
    await f.subscribed.promise;
    const entered = deferred<void>();
    const finished = deferred<void>();
    let stopped = false;
    f.bus.on('proofs:state-changed', async () => {
      const stop = f.watcher.stop();
      entered.resolve();
      await stop;
      stopped = true;
      finished.resolve();
    });

    const notification = f.notify('UNSPENT');
    await entered.promise;
    await notification;
    expect(stopped).toBe(false);
    f.acquired.resolve();
    await finished.promise;
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('starts fresh event delivery after the watcher restarts', async () => {
    const f = await fixture();
    await f.repositories.proofRepository.saveProofs(mintUrl, [proof]);
    await f.watcher.start();
    await f.subscribed.promise;
    await f.watcher.stop();
    const changed = mock(() => {});
    f.bus.on('proofs:state-changed', changed);

    await f.watcher.start();
    await f.watcher.watchProof(mintUrl, [proof.secret]);
    await f.notify('UNSPENT');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(
      (await f.repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
    ).toBe('ready');
    await f.watcher.stop();
  });

  it('preserves a watch reused by an inflight event while an older ready read is pending', async () => {
    const f = await fixture();
    await f.repositories.proofRepository.saveProofs(mintUrl, [proof]);
    await f.watcher.start();
    await f.subscribed.promise;
    await f.watcher.watchProof(mintUrl, [proof.secret]);
    const entered = deferred<void>();
    const release = deferred<void>();
    const repository = f.repositories.proofRepository;
    const read = repository.getProofBySecret.bind(repository);
    let pause = true;
    repository.getProofBySecret = async (url, secret) => {
      const stored = await read(url, secret);
      if (pause) {
        pause = false;
        entered.resolve();
        await release.promise;
      }
      return stored;
    };
    await repository.setProofState(mintUrl, [proof.secret], 'ready');
    const ready = f.bus.emit('proofs:state-changed', {
      mintUrl,
      secrets: [proof.secret],
      state: 'ready',
    });
    await entered.promise;
    await repository.setProofState(mintUrl, [proof.secret], 'inflight');
    await f.bus.emit('proofs:state-changed', {
      mintUrl,
      secrets: [proof.secret],
      state: 'inflight',
    });
    release.resolve();
    await ready;
    try {
      expect(f.unsubscribe).not.toHaveBeenCalled();
      await f.notifyActive('SPENT');
      expect((await read(mintUrl, proof.secret))?.state).toBe('spent');
    } finally {
      await f.watcher.stop();
    }
  });

  it.each(['UNSPENT', 'SPENT'])(
    'reconciles %s after restart and ignores late callbacks after stop',
    async (state) => {
      const f = await fixture();
      await f.repositories.proofRepository.saveProofs(mintUrl, [proof]);
      await f.watcher.start();
      await f.subscribed.promise;
      await f.notify('PENDING');
      expect(await f.repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
      await f.notify(state);
      expect(
        (await f.repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
      ).toBe(state === 'UNSPENT' ? 'ready' : 'spent');
      await f.watcher.stop();
      expect(f.unsubscribe).toHaveBeenCalledTimes(1);
      await f.notify('SPENT');
      expect(
        (await f.repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
      ).toBe(state === 'UNSPENT' ? 'ready' : 'spent');
    },
  );

  it('starts watching a newly restored pending proof and preserves ownership acquired before a notification', async () => {
    const f = await fixture();
    await f.watcher.start();
    await f.repositories.proofRepository.saveProofs(mintUrl, [
      { ...proof, usedByOperationId: 'operation' },
    ]);
    await f.bus.emit('proofs:saved', { mintUrl, keysetId: proof.id, proofs: [proof] });
    await f.subscribed.promise;
    await f.notify('UNSPENT');
    expect(
      (await f.repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
    ).toBe('pending');
    await f.watcher.stop();
  });
  it('drains a subscription acquired during shutdown and leaves no callback able to mutate', async () => {
    const f = await fixture(true);
    await f.repositories.proofRepository.saveProofs(mintUrl, [proof]);
    await f.watcher.start();
    await f.subscribed.promise;
    let stopped = false;
    const stop = f.watcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    f.acquired.resolve();
    await stop;
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    await f.notify('UNSPENT');
    expect(
      (await f.repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
    ).toBe('pending');
  });

  it('drains an active reconciliation while cancelling event delivery on shutdown', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const run = f.runner.run.bind(f.runner);
    f.runner.run = async (work) => {
      entered.resolve();
      await release.promise;
      return run(work);
    };
    const changed = mock(async () => {});
    f.bus.on('proofs:state-changed', changed);
    await f.repositories.proofRepository.saveProofs(mintUrl, [proof]);
    await f.watcher.start();
    await f.subscribed.promise;
    const notification = f.notify('UNSPENT');
    await entered.promise;
    let stopped = false;
    const stop = f.watcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await Promise.all([notification, stop]);
    expect(changed).not.toHaveBeenCalled();
    expect(
      (await f.repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
    ).toBe('ready');
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it.each(['UNSPENT', 'SPENT'])(
    'retains %s received while a PENDING observation is being applied',
    async (state) => {
      const f = await fixture();
      const entered = deferred<void>();
      const release = deferred<void>();
      const run = f.runner.run.bind(f.runner);
      f.runner.run = async (work) => {
        entered.resolve();
        await release.promise;
        return run(work);
      };
      await f.repositories.proofRepository.saveProofs(mintUrl, [proof]);
      await f.watcher.start();
      await f.subscribed.promise;
      const pending = f.notify('PENDING');
      await entered.promise;
      const ready = f.notify(state);
      release.resolve();
      await Promise.all([pending, ready]);
      expect(
        (await f.repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
      ).toBe(state === 'UNSPENT' ? 'ready' : 'spent');
      await f.watcher.stop();
    },
  );
});
