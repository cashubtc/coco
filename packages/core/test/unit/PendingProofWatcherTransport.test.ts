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
