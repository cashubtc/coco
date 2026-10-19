import { Amount } from '@cashu/cashu-ts';
import { expect, it } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { HybridTransport } from '../../infra/HybridTransport.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { RealTimeTransport } from '../../infra/RealTimeTransport.ts';
import { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { WsRequest } from '../../infra/SubscriptionProtocol.ts';
import type { WebSocketLike } from '../../infra/WsConnectionManager.ts';
import { NullLogger } from '../../logging/NullLogger.ts';
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
async function fixture() {
  const repos = new MemoryRepositories();
  await repos.init();
  await repos.proofRepository.saveProofs(mintUrl, [proof]);
  return {
    repos,
    bus: new EventBus<CoreEvents>(),
    runner: new RepositoryCoreTransactionRunner(repos),
    mint: { isTrustedMint: async () => true },
  };
}

it('keeps Send subscribed when a repeated Restore readiness listener sends the released proof', async () => {
  const f = await fixture();
  const sent: WsRequest[] = [];
  const transport: RealTimeTransport = {
    on() {},
    send(_mint, request) {
      sent.push(request);
    },
    closeAll() {},
    closeMint() {},
    pause() {},
    resume() {},
  };
  const subs = new SubscriptionManager(transport, {} as MintAdapter);
  const pending = new PendingProofWatcherService(
    subs,
    f.mint,
    f.repos.proofRepository,
    f.runner,
    f.bus,
  );
  const inflight = new ProofStateWatcherService(
    subs,
    f.mint as unknown as MintService,
    {} as ProofService,
    f.repos.proofRepository,
    f.bus,
    undefined,
    { watchExistingInflightOnStart: false },
  );
  try {
    f.bus.on('proofs:state-changed', async ({ state }) => {
      if (state !== 'ready') return;
      await f.repos.proofRepository.reserveProofs(mintUrl, [proof.secret], 'send');
      await f.repos.proofRepository.setProofState(mintUrl, [proof.secret], 'inflight');
      await f.bus.emit('proofs:state-changed', {
        mintUrl,
        secrets: [proof.secret],
        state: 'inflight',
      });
    });
    await inflight.start();
    await pending.start();
    await f.repos.proofRepository.setProofState(mintUrl, [proof.secret], 'ready');
    await f.bus.emit('proofs:state-changed', { mintUrl, secrets: [proof.secret], state: 'ready' });
    expect(sent.filter((request) => request.method === 'subscribe')).toHaveLength(1);
    expect(sent.filter((request) => request.method === 'unsubscribe')).toHaveLength(0);
    await inflight.stop();
    expect(sent.filter((request) => request.method === 'unsubscribe')).toHaveLength(1);
  } finally {
    await pending.stop();
    await inflight.stop();
    subs.closeAll();
  }
});

it('retries a failed local write when HybridTransport observes the same terminal proof state again', async () => {
  const f = await fixture();
  const messageHandlers = new Set<(event: { data: string }) => void>();
  let subId = '';
  const socket: WebSocketLike = {
    send(data) {
      const request = JSON.parse(data) as WsRequest;
      if (request.method === 'subscribe') subId = request.params.subId;
    },
    close() {},
    addEventListener(type, listener) {
      if (type === 'message') messageHandlers.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') messageHandlers.delete(listener);
    },
  };
  const mintAdapter = { checkProofStates: async () => [] } as unknown as MintAdapter;
  const hybrid = new HybridTransport(() => socket, mintAdapter);
  const subs = new SubscriptionManager(hybrid, mintAdapter);
  const failed = deferred(),
    committed = deferred();
  const run = f.runner.run.bind(f.runner);
  let attempts = 0;
  f.runner.run = async (work) => {
    attempts++;
    if (attempts === 1) throw new Error('temporary database failure');
    return run(work);
  };
  const logger = new NullLogger();
  logger.warn = () => failed.resolve();
  const watcher = new PendingProofWatcherService(
    subs,
    f.mint,
    f.repos.proofRepository,
    f.runner,
    f.bus,
    logger,
  );
  f.bus.on('proofs:state-changed', () => committed.resolve());
  try {
    await watcher.start();
    // A socket send can wait for open. The subscription id is also present on the polling request.
    if (!subId) {
      // The manager's public return value supplies the shared id without a second transport request.
      const shared = await subs.subscribe(mintUrl, 'proof_state', [
        buildYHexMapsForSecrets([proof.secret]).yHexBySecret.get(proof.secret)!,
      ]);
      subId = shared.subId;
    }
    const data = JSON.stringify({
      jsonrpc: '2.0',
      method: 'subscribe',
      params: {
        subId,
        payload: {
          Y: buildYHexMapsForSecrets([proof.secret]).yHexBySecret.get(proof.secret)!,
          state: 'UNSPENT',
        },
      },
    });
    for (const handler of messageHandlers) handler({ data });
    await failed.promise;
    expect((await f.repos.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state).toBe(
      'pending',
    );
    for (const handler of messageHandlers) handler({ data });
    await committed.promise;
    expect(attempts).toBe(2);
    expect((await f.repos.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state).toBe(
      'ready',
    );
  } finally {
    await watcher.stop();
    subs.closeAll();
  }
});

async function groupedTransportFixture(proofs: CoreProof[]) {
  const f = await fixture();
  await f.repos.proofRepository.saveProofs(mintUrl, proofs);
  const handlers = new Map<string, Set<(event: { data?: string }) => void>>();
  const active = new Map<string, string[]>();
  const requests: WsRequest[] = [];
  let peak = 0;
  const socket: WebSocketLike = {
    send(data) {
      const request = JSON.parse(data) as WsRequest;
      requests.push(request);
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
    requests,
    open,
    notify,
    peak: () => peak,
    onPoll: (callback: typeof onPoll) => {
      onPoll = callback;
    },
  };
}

it('uses one WebSocket subscription for 101 restored proofs and releases it on stop', async () => {
  const f = await groupedTransportFixture(
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
      const f = await groupedTransportFixture([other]);
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
