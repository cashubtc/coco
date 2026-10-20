import { Amount } from '@cashu/cashu-ts';
import { expect, it } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { HybridTransport } from '../../infra/HybridTransport.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { WsRequest } from '../../infra/SubscriptionProtocol.ts';
import type { WebSocketLike } from '../../infra/WsConnectionManager.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import { PendingProofWatcherService } from '../../services/watchers/PendingProofWatcherService.ts';
import { ProofStateWatcherService } from '../../services/watchers/ProofStateWatcherService.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
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
async function transportFixture(proofs: CoreProof[] = []) {
  const repos = new MemoryRepositories();
  await repos.init();
  await repos.proofRepository.saveProofs(mintUrl, [proof, ...proofs]);
  const f = {
    repos,
    bus: new EventBus<CoreEvents>(),
    runner: new RepositoryCoreTransactionRunner(repos),
    mint: { isTrustedMint: async () => true },
  };
  const handlers = new Map<string, Set<(event: { data?: string }) => void>>();
  const active = new Map<string, string[]>();
  let peak = 0;
  const socket: WebSocketLike = {
    send(data) {
      const request = JSON.parse(data) as WsRequest;
      if (request.method === 'subscribe' && 'filters' in request.params) {
        active.set(request.params.subId, request.params.filters);
        peak = Math.max(peak, active.size);
      } else active.delete(request.params.subId);
    },
    close() {},
    addEventListener(type, listener) {
      const listeners = handlers.get(type) ?? new Set();
      listeners.add(listener);
      handlers.set(type, listeners);
    },
    removeEventListener(type, listener) {
      handlers.get(type)?.delete(listener);
    },
  };
  let onPoll = (_filters: string[]) => {};
  const adapter = {
    checkProofStates: async (_mint: string, filters: string[]) => {
      onPoll(filters);
      return filters.map((Y) => ({ Y, state: 'PENDING' }));
    },
  } as unknown as MintAdapter;
  const hybrid = new HybridTransport(() => socket, adapter, {
    slowPollingIntervalMs: 1,
    fastPollingIntervalMs: 1,
  });
  const subs = new SubscriptionManager(hybrid, adapter);
  const watcher = new PendingProofWatcherService(
    subs,
    f.mint,
    f.repos.proofRepository,
    f.runner,
    f.bus,
  );
  const open = () => {
    for (const handler of handlers.get('open') ?? []) handler({});
  };
  const notify = (secret: string, state: string) => {
    const Y = buildYHexMapsForSecrets([secret]).yHexBySecret.get(secret)!;
    for (const [subId, filters] of [...active]) {
      if (!filters.includes(Y)) continue;
      const data = JSON.stringify({
        method: 'subscribe',
        params: { subId, payload: { Y, state } },
      });
      for (const handler of handlers.get('message') ?? []) handler({ data });
    }
  };
  return {
    ...f,
    watcher,
    subs,
    active,
    adapter,
    open,
    notify,
    peak: () => peak,
    onPoll: (callback: typeof onPoll) => {
      onPoll = callback;
    },
  };
}

for (const source of ['restore event', 'mint observation'] as const) {
  it.each([true, false])(
    `keeps the Send proof watch after ${source} (ready listener first: %s)`,
    async (first) => {
      const f = await transportFixture();
      const delivered = deferred(),
        spent = deferred();
      const inflight = new ProofStateWatcherService(
        f.subs,
        f.mint as unknown as MintService,
        {
          setProofState: async (mint, secrets, state) => {
            await f.repos.proofRepository.setProofState(mint, secrets, state);
            await f.bus.emit('proofs:state-changed', { mintUrl: mint, secrets, state });
          },
        } as ProofService,
        f.repos.proofRepository,
        f.bus,
        undefined,
        { watchExistingInflightOnStart: false },
      );
      const sendOnReady = async ({ state }: CoreEvents['proofs:state-changed']) => {
        if (state !== 'ready') return;
        await f.repos.proofRepository.reserveProofs(mintUrl, [proof.secret], 'send');
        await f.repos.proofRepository.setProofState(mintUrl, [proof.secret], 'inflight');
        await f.bus.emit('proofs:state-changed', {
          mintUrl,
          secrets: [proof.secret],
          state: 'inflight',
        });
      };
      try {
        if (first) f.bus.on('proofs:state-changed', sendOnReady);
        await inflight.start();
        await f.watcher.start();
        if (!first) f.bus.on('proofs:state-changed', sendOnReady);
        f.bus.on('proofs:state-changed', ({ state }) => {
          if (state === 'ready') delivered.resolve();
          if (state === 'spent') spent.resolve();
        });
        f.open();
        if (source === 'restore event') {
          await f.repos.proofRepository.setProofState(mintUrl, [proof.secret], 'ready');
          await f.bus.emit('proofs:state-changed', {
            mintUrl,
            secrets: [proof.secret],
            state: 'ready',
          });
        } else f.notify(proof.secret, 'UNSPENT');
        await delivered.promise;
        expect((await f.repos.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state).toBe(
          'inflight',
        );
        expect([...f.active.values()]).toEqual([
          [buildYHexMapsForSecrets([proof.secret]).yHexBySecret.get(proof.secret)!],
        ]);
        f.notify(proof.secret, 'SPENT');
        await spent.promise;
        expect((await f.repos.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state).toBe(
          'spent',
        );
      } finally {
        await f.watcher.stop();
        await inflight.stop();
        f.subs.closeAll();
      }
    },
  );
}

it('retries a rolled-back proof write from an identical later polling observation', async () => {
  const f = await transportFixture();
  const failed = deferred(),
    retry = deferred(),
    committed = deferred();
  let polls = 0,
    attempts = 0;
  f.adapter.checkProofStates = async (_mint, filters) => {
    if (++polls > 1) await retry.promise;
    return filters.map((Y) => ({ Y, state: 'UNSPENT' as const, witness: null }));
  };
  const run = f.runner.run.bind(f.runner);
  f.runner.run = async (work) => {
    const attempt = ++attempts;
    try {
      return await run(async (tx) => {
        const result = await work(tx);
        if (attempt === 1) throw new Error('database failure after applying proof change');
        return result;
      });
    } catch (error) {
      failed.resolve();
      throw error;
    }
  };
  f.bus.on('proofs:state-changed', () => committed.resolve());
  try {
    await f.watcher.start();
    f.open();
    await failed.promise;
    expect((await f.repos.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state).toBe(
      'pending',
    );
    retry.resolve();
    await committed.promise;
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(attempts).toBe(2);
    expect((await f.repos.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state).toBe(
      'ready',
    );
    expect(f.active.size).toBe(0);
  } finally {
    retry.resolve();
    await f.watcher.stop();
    f.subs.closeAll();
  }
});

it('uses one WebSocket subscription for 101 restored proofs and releases it on stop', async () => {
  const f = await transportFixture(
    Array.from({ length: 100 }, (_, i) => ({ ...proof, secret: `pending-${i}` })),
  );
  try {
    await f.watcher.start();
    f.open();
    expect(f.active.size).toBe(1);
    expect([...f.active.values()][0]).toHaveLength(101);
    await f.watcher.stop();
    expect(f.active.size).toBe(0);
    expect(f.peak()).toBe(1);
  } finally {
    await f.watcher.stop();
    f.subs.closeAll();
  }
});

for (const removal of ['resolved', 'deleted', 'wiped'] as const) {
  it.each([false, true])(
    `removes ${removal} proof filters from WebSocket and polling during a partial group (acquiring: %s)`,
    async (acquiring) => {
      const other = { ...proof, secret: 'remaining', id: 'other-keyset' };
      const f = await transportFixture([other]);
      const entered = deferred(),
        release = deferred(),
        committed = deferred(),
        polled = deferred();
      const remainingY = buildYHexMapsForSecrets([other.secret]).yHexBySecret.get(other.secret)!;
      if (acquiring) {
        const subscribe = f.subs.subscribeProofStates.bind(f.subs);
        f.subs.subscribeProofStates = async (...args) => {
          const handle = await subscribe(...args);
          entered.resolve();
          await release.promise;
          return handle;
        };
      }
      const starting = f.watcher.start();
      try {
        if (acquiring) await entered.promise;
        else await starting;
        f.open();
        f.onPoll((filters) => {
          if (filters.length === 1 && filters[0] === remainingY) polled.resolve();
        });
        if (removal === 'resolved') {
          f.bus.on('proofs:state-changed', ({ secrets }) => {
            if (secrets.includes(proof.secret)) committed.resolve();
          });
          f.notify(proof.secret, 'UNSPENT');
          await committed.promise;
        } else if (removal === 'deleted') {
          await f.repos.proofRepository.deleteProofs(mintUrl, [proof.secret]);
          await f.bus.emit('proofs:deleted', { mintUrl, secrets: [proof.secret] });
        } else {
          await f.repos.proofRepository.wipeProofsByKeysetId(mintUrl, proof.id);
          await f.bus.emit('proofs:wiped', { mintUrl, keysetId: proof.id });
        }
        release.resolve();
        await starting;
        expect([...f.active.values()]).toEqual([[remainingY]]);
        await polled.promise;
        expect(f.peak()).toBe(1);
        const settled = deferred();
        f.bus.on('proofs:state-changed', ({ secrets }) => {
          if (secrets.includes(other.secret)) settled.resolve();
        });
        f.notify(other.secret, 'SPENT');
        await settled.promise;
        expect((await f.repos.proofRepository.getProofBySecret(mintUrl, other.secret))?.state).toBe(
          'spent',
        );
        expect(f.active.size).toBe(0);
      } finally {
        release.resolve();
        await starting;
        await f.watcher.stop();
        f.subs.closeAll();
      }
    },
  );
}
