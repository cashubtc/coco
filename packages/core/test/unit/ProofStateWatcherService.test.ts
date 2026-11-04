import { Amount, type ProofState } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { ProofStateWatcherService } from '../../services/watchers/ProofStateWatcherService.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { CoreProof } from '../../types.ts';
import { buildYHexMapsForSecrets } from '../../utils.ts';
import { createSendEnvironment } from '../fixtures/SendEnvironment.ts';
import { pendingSend } from '../fixtures/SendOperation.ts';
import { testMintKeysetId } from '../fixtures/MintMetadata.ts';

type Notify = (payload: { Y: string; state: ProofState['state'] }) => Promise<void>;
const mintUrl = 'https://mint.test';
const yOf = (secret: string) => buildYHexMapsForSecrets([secret]).yHexBySecret.get(secret)!;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Real Send persistence, transitions and events. Only subscription transport and remote state are fake.
async function harness(startup = false) {
  const env = await createSendEnvironment();
  const callbacks = new Map<string, Notify>();
  const subscribed = deferred();
  const unsubscribe = mock(async () => {});
  let acquire: (() => Promise<void>) | undefined;
  const subscribe = mock(async (_url: string, _kind: string, filters: string[], cb: Notify) => {
    for (const y of filters) callbacks.set(y, cb);
    subscribed.resolve();
    await acquire?.();
    return { subId: 'proofs', unsubscribe };
  });
  const watcher = new ProofStateWatcherService(
    { subscribe } as unknown as SubscriptionManager,
    env.repositories.mintRepository,
    env.service,
    env.eventBus,
    env.logger,
    { watchExistingInflightOnStart: startup },
  );
  const seed = async (id: string, secrets = [id], state: CoreProof['state'] = 'inflight') => {
    const proofs: CoreProof[] = secrets.map((secret) => ({
      id: testMintKeysetId(),
      mintUrl,
      unit: 'sat',
      amount: Amount.from(1),
      secret,
      C: `C-${secret}`,
      state,
      usedByOperationId: id,
    }));
    await env.repositories.proofRepository.saveProofs(mintUrl, proofs);
    await env.repositories.sendOperationRepository.create(pendingSend(id, proofs));
    return proofs;
  };
  return {
    ...env,
    watcher,
    subscribe,
    unsubscribe,
    subscribed,
    seed,
    blockAcquisition: (run: () => Promise<void>) => {
      acquire = run;
    },
    notify: (secret: string) => callbacks.get(yOf(secret))!({ Y: yOf(secret), state: 'SPENT' }),
    stateOf: async (secret: string) =>
      (await env.repositories.proofRepository.getProofBySecret(mintUrl, secret))?.state,
  };
}

describe('Proof watcher with real Send coordination', () => {
  const watchers: ProofStateWatcherService[] = [];
  const setup = async (startup = false) => {
    const h = await harness(startup);
    watchers.push(h.watcher);
    return h;
  };
  afterEach(async () => {
    for (const watcher of watchers.splice(0)) await watcher.stop();
  });

  it('commits the last spent proof and Send completion before publishing, including duplicate observations', async () => {
    const h = await setup();
    await h.seed('send', ['first', 'last']);
    await h.watcher.start();
    await h.watcher.watchProof(mintUrl, ['first', 'last']);
    const finalized: string[] = [];
    h.eventBus.on('send:finalized', ({ operationId }) => {
      finalized.push(operationId);
    });
    h.eventBus.on('proofs:state-changed', async ({ secrets }) => {
      if (secrets.includes('last')) {
        expect(await h.stateOf('last')).toBe('spent');
        expect((await h.service.getOperation('send'))?.state).toBe('finalized');
      }
    });
    await h.notify('first');
    expect(await h.stateOf('first')).toBe('spent');
    expect((await h.service.getOperation('send'))?.state).toBe('pending');
    await h.notify('last');
    await h.service.applyProofStateObservation('send', ['first', 'last']);
    expect(finalized).toEqual(['send']);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('applies evidence without a watcher and rolls back proof writes when completion cannot commit', async () => {
    const h = await setup();
    await h.seed('send', ['first', 'last']);
    await h.service.applyProofStateObservation('send', ['first', 'first']);
    const original = h.repositories.withTransaction.bind(h.repositories);
    h.repositories.withTransaction = (work) =>
      original((scope) =>
        work({
          ...scope,
          sendOperationRepository: new Proxy(scope.sendOperationRepository, {
            get(target, key) {
              if (key === 'transition')
                return async () => {
                  throw new Error('storage commit rejected');
                };
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        }),
      );
    await expect(h.service.applyProofStateObservation('send', ['last'])).rejects.toThrow(
      'storage commit rejected',
    );
    expect(await h.stateOf('last')).toBe('inflight');
    expect((await h.service.getOperation('send'))?.state).toBe('pending');
    h.repositories.withTransaction = original;
    await h.service.applyProofStateObservation('send', ['last']);
    expect((await h.service.getOperation('send'))?.state).toBe('finalized');
  });

  it('reassesses persisted spent proofs without a remote request or a watcher', async () => {
    const h = await setup();
    await h.seed('completed-locally', ['spent'], 'spent');
    await h.seed('waiting');
    await h.service.advancePendingOperation('completed-locally');
    await h.service.advancePendingOperation('waiting');
    expect((await h.service.getOperation('completed-locally'))?.state).toBe('finalized');
    expect((await h.service.getOperation('waiting'))?.state).toBe('pending');
    expect(h.remote.checkProofStates).not.toHaveBeenCalled();
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'rejects stale observations of foreign reservations (swapped: %s)',
    async (swapped) => {
      const h = await setup();
      const proofs = await h.seed('send');
      const secret = swapped ? 'output' : 'send';
      if (swapped) {
        const outputs = [
          { ...proofs[0]!, secret, usedByOperationId: undefined, createdByOperationId: 'send' },
        ];
        await h.repositories.proofRepository.setProofState(mintUrl, ['send'], 'spent');
        await h.repositories.proofRepository.saveProofs(mintUrl, outputs);
        await h.repositories.sendOperationRepository.update(pendingSend('send', proofs, outputs));
      }
      await h.watcher.start();
      await h.watcher.watchProof(mintUrl, [secret]);
      await h.repositories.proofRepository.releaseProofs(mintUrl, [secret]);
      await h.repositories.proofRepository.setProofState(mintUrl, [secret], 'ready');
      await h.repositories.proofRepository.reserveProofs(mintUrl, [secret], 'other-operation');
      await h.repositories.proofRepository.setProofState(mintUrl, [secret], 'inflight');
      await h.notify(secret);
      expect(await h.stateOf(secret)).toBe('inflight');
      expect((await h.service.getOperation('send'))?.state).toBe('pending');
      expect(await h.service.getProofObservationTargets('send')).toEqual([]);
    },
  );

  it('ignores unowned proofs and proofs referencing missing, terminal, or non-Send operations', async () => {
    const h = await setup();
    const proofs = await h.seed('finished', ['terminal']);
    await h.repositories.sendOperationRepository.update({
      ...pendingSend('finished', proofs),
      state: 'finalized',
    });
    await h.repositories.proofRepository.saveProofs(mintUrl, [
      { ...proofs[0]!, secret: 'unowned', usedByOperationId: undefined },
      { ...proofs[0]!, secret: 'missing', usedByOperationId: 'missing-operation' },
      { ...proofs[0]!, secret: 'other', usedByOperationId: 'melt-operation' },
    ]);
    await h.watcher.start();
    await h.watcher.watchProof(mintUrl, ['terminal', 'unowned', 'missing', 'other']);
    expect(h.subscribe).not.toHaveBeenCalled();
    for (const secret of ['terminal', 'unowned', 'missing', 'other'])
      expect(await h.stateOf(secret)).toBe('inflight');
  });

  it('discovers pending subscriptions and locally completed Sends without polling', async () => {
    const h = await setup(true);
    await h.seed('completed-locally', ['spent'], 'spent');
    await h.seed('send', ['first', 'last']);
    await h.watcher.start();
    await h.subscribed.promise;
    expect(h.remote.checkProofStates).not.toHaveBeenCalled();
    expect((await h.service.getOperation('completed-locally'))?.state).toBe('finalized');
    expect((await h.service.getOperation('send'))?.state).toBe('pending');
    expect(h.subscribe.mock.calls[0]![2]).toEqual([yOf('first'), yOf('last')]);
  });

  it('keeps startup discovery disabled while observing new pending Sends', async () => {
    const h = await setup();
    await h.seed('existing');
    await h.watcher.start();
    expect(h.subscribe).not.toHaveBeenCalled();
    const proofs = await h.seed('new');
    await h.eventBus.emit('send:pending', {
      mintUrl,
      operationId: 'new',
      operation: pendingSend('new', proofs),
      token: pendingSend('new', proofs).token!,
    });
    await h.subscribed.promise;
    expect(h.subscribe.mock.calls[0]![2]).toEqual([yOf('new')]);
  });

  it('waits for late subscription acquisition and releases it during shutdown', async () => {
    const h = await setup();
    await h.seed('send');
    const acquired = deferred();
    h.blockAcquisition(() => acquired.promise);
    await h.watcher.start();
    const watching = h.watcher.watchProof(mintUrl, ['send']);
    await h.subscribed.promise;
    let stopped = false;
    const stopping = h.watcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    acquired.resolve();
    await Promise.all([watching, stopping]);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    await h.notify('send');
    expect(await h.stateOf('send')).toBe('inflight');
  });

  it('allows a completion listener to stop the watcher without waiting on its own processing', async () => {
    const h = await setup();
    await h.seed('send');
    await h.watcher.start();
    await h.watcher.watchProof(mintUrl, ['send']);
    h.eventBus.on('send:finalized', () => h.watcher.stop());
    await h.notify('send');
    expect(h.watcher.isRunning()).toBe(false);
    expect((await h.service.getOperation('send'))?.state).toBe('finalized');
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('releases a late subscription when its Send completed during acquisition', async () => {
    const h = await setup();
    await h.seed('send');
    const acquired = deferred();
    h.blockAcquisition(() => acquired.promise);
    await h.watcher.start();
    const watching = h.watcher.watchProof(mintUrl, ['send']);
    await h.subscribed.promise;
    await h.service.applyProofStateObservation('send', ['send']);
    acquired.resolve();
    await watching;
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    await h.watcher.stop();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('releases a late subscription to a spent proof even while its Send remains pending', async () => {
    const h = await setup();
    await h.seed('send', ['first', 'last']);
    const acquired = deferred();
    h.blockAcquisition(() => acquired.promise);
    await h.watcher.start();
    const watching = h.watcher.watchProof(mintUrl, ['first']);
    await h.subscribed.promise;
    await h.notify('first');
    acquired.resolve();
    await watching;
    expect((await h.service.getOperation('send'))?.state).toBe('pending');
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    await h.watcher.stop();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('waits for subscription cleanup already started by a notification', async () => {
    const h = await setup();
    await h.seed('send');
    const cleaning = deferred();
    const cleaned = deferred();
    h.unsubscribe.mockImplementation(async () => {
      cleaning.resolve();
      await cleaned.promise;
    });
    await h.watcher.start();
    await h.watcher.watchProof(mintUrl, ['send']);
    const notified = h.notify('send');
    await cleaning.promise;
    let stopped = false;
    const stopping = h.watcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    cleaned.resolve();
    await Promise.all([notified, stopping]);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('lets started proof application finish after stop without admitting another notification', async () => {
    const h = await setup();
    await h.seed('send', ['first', 'last']);
    await h.watcher.start();
    await h.watcher.watchProof(mintUrl, ['first', 'last']);
    const applying = deferred();
    const resume = deferred();
    const original = h.repositories.withTransaction.bind(h.repositories);
    h.repositories.withTransaction = async (work) => {
      applying.resolve();
      await resume.promise;
      return original(work);
    };
    const notified = h.notify('first');
    await applying.promise;
    await h.watcher.stop();
    await h.notify('last');
    expect(await h.stateOf('first')).toBe('inflight');
    resume.resolve();
    await notified;
    expect(await h.stateOf('first')).toBe('spent');
    expect(await h.stateOf('last')).toBe('inflight');
    expect((await h.service.getOperation('send'))?.state).toBe('pending');
  });
});
