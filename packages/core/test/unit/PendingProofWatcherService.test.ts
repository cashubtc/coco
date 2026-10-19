import { Amount } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { Repositories } from '../../repositories';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { PendingProofWatcherService } from '../../services/watchers/PendingProofWatcherService.ts';
import { ProofStateWatcherService } from '../../services/watchers/ProofStateWatcherService.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import {
  RepositoryCoreTransactionRunner,
  type CoreTransactionRunner,
} from '../../transactions/CoreTransaction.ts';
import type { CoreProof } from '../../types.ts';
import { buildYHexMapsForSecrets } from '../../utils.ts';

const mintUrl = 'https://mint.test';
const proof: CoreProof = {
  mintUrl,
  secret: 'restored',
  id: 'keyset',
  C: 'signature',
  amount: Amount.from(2),
  unit: 'sat',
  state: 'pending',
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Notification = { Y: string; state: string };
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(options: { sqlite?: boolean; proofs?: CoreProof[] } = {}) {
  let repos: Repositories;
  if (options.sqlite) {
    const database = new Database(':memory:');
    repos = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    cleanup.push(() => database.close());
  } else repos = new MemoryRepositories();
  await repos.init();
  await repos.proofRepository.saveProofs(mintUrl, options.proofs ?? [proof]);
  const bus = new EventBus<CoreEvents>();
  const subscriptions: {
    callback: (payload: Notification) => void | Promise<void>;
    unsubscribe: ReturnType<typeof mock>;
    removeFilters: ReturnType<typeof mock>;
    filters: string[];
  }[] = [];
  const subscribe = mock(
    async (
      _mint: string,
      filters: string[],
      callback: (payload: Notification) => void | Promise<void>,
    ) => {
      const unsubscribe = mock(async () => {});
      const removeFilters = mock(async () => {});
      subscriptions.push({ callback, unsubscribe, removeFilters, filters });
      return {
        subId: String(subscriptions.length),
        unsubscribe,
        removeFilters,
      };
    },
  );
  const subs = {
    subscribeProofStates: subscribe,
    subscribe: (
      _mint: string,
      _kind: string,
      filters: string[],
      callback: (payload: Notification) => void | Promise<void>,
    ) => subscribe(_mint, filters, callback),
  } as unknown as SubscriptionManager;
  const mint = { isTrustedMint: mock(async () => true) };
  const runner: CoreTransactionRunner = new RepositoryCoreTransactionRunner(repos);
  const watcher = new PendingProofWatcherService(subs, mint, repos.proofRepository, runner, bus);
  cleanup.push(() => watcher.stop());
  const notify = (state: string, index = 0, secret = proof.secret) =>
    subscriptions[index]!.callback({
      Y: buildYHexMapsForSecrets([secret]).yHexBySecret.get(secret)!,
      state,
    });
  const stored = () => repos.proofRepository.getProofBySecret(mintUrl, proof.secret);
  return { repos, bus, subscriptions, subscribe, subs, mint, runner, watcher, notify, stored };
}

describe('restored pending proof watcher', () => {
  for (const sqlite of [false, true]) {
    it.each(['UNSPENT', 'SPENT'] as const)(
      `commits %s once and publishes after commit (${sqlite ? 'sqlite' : 'memory'})`,
      async (state) => {
        const f = await fixture({ sqlite });
        const events: string[] = [];
        f.bus.on('proofs:state-changed', async ({ state }) => {
          expect((await f.stored())?.state).toBe(state);
          expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
          events.push(state);
        });
        await f.watcher.start();
        await f.notify('PENDING');
        expect((await f.stored())?.state).toBe('pending');
        await Promise.all([f.notify(state), f.notify(state)]);
        expect(events).toEqual([state === 'UNSPENT' ? 'ready' : 'spent']);
      },
    );
  }

  for (const removal of ['deleted', 'wiped'] as const) {
    it.each([false, true])(
      `releases ${removal} proofs (subscription acquisition pending: %s)`,
      async (acquiring) => {
        const f = await fixture();
        const entered = deferred(),
          release = deferred();
        if (acquiring) {
          const subscribe = f.subscribe.getMockImplementation()!;
          f.subscribe.mockImplementation(async (...args) => {
            const subscription = await subscribe(...args);
            entered.resolve();
            await release.promise;
            return subscription;
          });
        }
        const starting = f.watcher.start();
        if (acquiring) await entered.promise;
        else await starting;
        try {
          if (removal === 'deleted') {
            await f.repos.proofRepository.deleteProofs(mintUrl, [proof.secret]);
            await f.bus.emit('proofs:deleted', { mintUrl, secrets: [proof.secret] });
          } else {
            await f.repos.proofRepository.wipeProofsByKeysetId(mintUrl, proof.id);
            await f.bus.emit('proofs:wiped', { mintUrl, keysetId: proof.id });
          }
        } finally {
          release.resolve();
          await starting;
        }
        expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
        const run = f.runner.run.bind(f.runner);
        let attempts = 0;
        f.runner.run = async (work) => {
          attempts++;
          return run(work);
        };
        await f.notify('PENDING');
        await f.notify('UNSPENT');
        expect(attempts).toBe(0);
        expect(await f.stored()).toBeNull();
      },
    );
  }

  it('keeps other keysets watched after a wipe', async () => {
    const other = { ...proof, id: 'other-keyset', secret: 'other' };
    const f = await fixture({ proofs: [proof, other] });
    await f.watcher.start();
    await f.repos.proofRepository.wipeProofsByKeysetId(mintUrl, proof.id);
    await f.bus.emit('proofs:wiped', { mintUrl, keysetId: proof.id });
    expect(f.subscriptions[0]!.unsubscribe).not.toHaveBeenCalled();
    await f.notify('UNSPENT', 0, other.secret);
    expect((await f.repos.proofRepository.getProofBySecret(mintUrl, other.secret))?.state).toBe(
      'ready',
    );
    expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not start work when stopped immediately after start', async () => {
    const f = await fixture();
    await Promise.all([f.watcher.start(), f.watcher.stop()]);
    expect(f.subscribe).not.toHaveBeenCalled();
    await f.bus.emit('proofs:saved', { mintUrl, keysetId: proof.id, proofs: [proof] });
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it('watches newly saved pending proofs and restarts from storage', async () => {
    const f = await fixture({ proofs: [] });
    await f.watcher.start();
    expect(f.subscribe).not.toHaveBeenCalled();
    await f.repos.proofRepository.saveProofs(mintUrl, [proof]);
    await f.bus.emit('proofs:saved', { mintUrl, keysetId: proof.id, proofs: [proof] });
    await f.watcher.stop();
    await f.watcher.start();
    expect(f.subscribe).toHaveBeenCalledTimes(2);
    await f.notify('UNSPENT', 0); // stale transport callback from the previous session
    expect((await f.stored())?.state).toBe('pending');
    await f.notify('SPENT', 1);
    expect((await f.stored())?.state).toBe('spent');
  });

  it('skips owned pending and inflight proofs, including different units', async () => {
    const f = await fixture({
      proofs: [
        proof,
        { ...proof, secret: 'usd', unit: 'usd' },
        { ...proof, secret: 'used', usedByOperationId: 'send' },
        { ...proof, secret: 'created', createdByOperationId: 'melt' },
        { ...proof, secret: 'send', state: 'inflight' },
      ],
    });
    await f.watcher.start();
    expect(f.subscriptions[0]!.filters).toHaveLength(2);
    await f.notify('UNSPENT');
    expect(f.subscriptions[0]!.unsubscribe).not.toHaveBeenCalled();
    await f.notify('SPENT', 0, 'usd');
    expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rechecks ownership inside the applying transaction', async () => {
    const f = await fixture();
    await f.watcher.start();
    await f.repos.proofRepository.setCreatedByOperation(mintUrl, [proof.secret], 'melt');
    await f.notify('UNSPENT');
    expect((await f.stored())?.state).toBe('pending');
    expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('publishes a committed change even if partial subscription cleanup fails', async () => {
    const f = await fixture({ proofs: [proof, { ...proof, secret: 'remaining' }] });
    const published = mock(() => {});
    f.bus.on('proofs:state-changed', published);
    await f.watcher.start();
    f.subscriptions[0]!.removeFilters.mockRejectedValueOnce(new Error('transport cleanup failed'));
    await f.notify('UNSPENT');
    expect((await f.stored())?.state).toBe('ready');
    expect(published).toHaveBeenCalledTimes(1);
    await f.watcher.stop();
    expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each(['ready', 'spent'] as const)(
    'removes a stale acquisition after the proof becomes %s without an event',
    async (state) => {
      const f = await fixture();
      const entered = deferred(),
        release = deferred();
      f.mint.isTrustedMint.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return true;
      });
      const starting = f.watcher.start();
      await entered.promise;
      await f.repos.proofRepository.setProofState(mintUrl, [proof.secret], state);
      release.resolve();
      await starting;
      expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
      await f.notify('UNSPENT');
      expect((await f.stored())?.state).toBe(state);
    },
  );

  it('drains and releases a subscription acquired during stop', async () => {
    const f = await fixture();
    const entered = deferred(),
      release = deferred();
    const original = f.subscribe.getMockImplementation()!;
    f.subscribe.mockImplementation(async (...args) => {
      const subscription = await original(...args);
      entered.resolve();
      await release.promise;
      return subscription;
    });
    const starting = f.watcher.start();
    await entered.promise;
    let stopped = false;
    const stopping = f.watcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await Promise.all([starting, stopping]);
    expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    await f.notify('SPENT');
    expect((await f.stored())?.state).toBe('pending');
  });

  it('invalidates an acquisition on untrust, then scans again on trust', async () => {
    const f = await fixture();
    const entered = deferred(),
      release = deferred();
    f.mint.isTrustedMint.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return true;
    });
    const starting = f.watcher.start();
    await entered.promise;
    await f.bus.emit('mint:untrusted', { mintUrl });
    release.resolve();
    await starting;
    expect(f.subscribe).not.toHaveBeenCalled();
    await f.bus.emit('mint:trusted', { mintUrl });
    expect(f.subscribe).toHaveBeenCalledTimes(1);
  });

  it('releases a subscription invalidated by an event during acquisition', async () => {
    const f = await fixture();
    const entered = deferred(),
      release = deferred();
    const original = f.subscribe.getMockImplementation()!;
    f.subscribe.mockImplementation(async (...args) => {
      const subscription = await original(...args);
      entered.resolve();
      await release.promise;
      return subscription;
    });
    const starting = f.watcher.start();
    await entered.promise;
    await f.repos.proofRepository.setProofState(mintUrl, [proof.secret], 'ready');
    await f.bus.emit('proofs:state-changed', { mintUrl, secrets: [proof.secret], state: 'ready' });
    release.resolve();
    await starting;
    expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('drains an applying transaction and suppresses publication during stop', async () => {
    const f = await fixture();
    const entered = deferred(),
      release = deferred();
    const run = f.runner.run.bind(f.runner);
    f.runner.run = async (work) => {
      entered.resolve();
      await release.promise;
      return run(work);
    };
    const events = mock(() => {});
    f.bus.on('proofs:state-changed', events);
    await f.watcher.start();
    const notification = f.notify('UNSPENT');
    await entered.promise;
    let stopped = false;
    const stopping = f.watcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await Promise.all([notification, stopping]);
    expect((await f.stored())?.state).toBe('ready');
    expect(events).not.toHaveBeenCalled();
  });

  it('allows a listener to await stop without delivering later callbacks', async () => {
    const f = await fixture();
    const later = mock(() => {});
    f.bus.on('proofs:state-changed', async () => {
      await f.watcher.stop();
    });
    f.bus.on('proofs:state-changed', later);
    await f.watcher.start();
    await f.notify('UNSPENT');
    expect(later).not.toHaveBeenCalled();
    expect((await f.stored())?.state).toBe('ready');
  });

  it.each([true, false])(
    'preserves the Send watch created by a ready listener (registered first: %s)',
    async (before) => {
      const f = await fixture();
      const inflight = new ProofStateWatcherService(
        f.subs,
        f.mint as unknown as MintService,
        {} as ProofService,
        f.repos.proofRepository,
        f.bus,
        undefined,
        { watchExistingInflightOnStart: false },
      );
      cleanup.push(() => inflight.stop());
      const onReady = async ({ state }: CoreEvents['proofs:state-changed']) => {
        if (state !== 'ready') return;
        await f.repos.proofRepository.reserveProofs(mintUrl, [proof.secret], 'send');
        await f.repos.proofRepository.setProofState(mintUrl, [proof.secret], 'inflight');
        await f.bus.emit('proofs:state-changed', {
          mintUrl,
          secrets: [proof.secret],
          state: 'inflight',
        });
      };
      if (before) f.bus.on('proofs:state-changed', onReady);
      await inflight.start();
      await f.watcher.start();
      if (!before) f.bus.on('proofs:state-changed', onReady);
      await f.notify('UNSPENT');
      expect(f.subscribe).toHaveBeenCalledTimes(2);
      expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
      expect(f.subscriptions[1]!.unsubscribe).not.toHaveBeenCalled();
      expect((await f.stored())?.state).toBe('inflight');
    },
  );

  it('retries a queued observation after an applying transaction fails', async () => {
    const f = await fixture();
    const run = f.runner.run.bind(f.runner);
    let failed = false;
    f.runner.run = async (work) => {
      if (!failed) {
        failed = true;
        throw new Error('temporary failure');
      }
      return run(work);
    };
    await f.watcher.start();
    await Promise.all([f.notify('UNSPENT'), f.notify('SPENT')]);
    expect((await f.stored())?.state).toBe('spent');
  });
});
