import { Amount, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { initializeCoco, type Manager } from '@cashu/coco-core';
import type { ServiceMap } from '@cashu/coco-core/plugin';
import type { IntegrationTestOptions, IntegrationTestRunner } from './integration.ts';

type TransportHandler = Parameters<
  ServiceMap['paymentRequestReceiveService']['registerTransportHandler']
>[0];

export function runPaymentRequestReceiveLifecycleTests(
  options: IntegrationTestOptions,
  runner: IntegrationTestRunner,
  mintAmount: (manager: Manager, mintUrl: string, amount: number, unit: string) => Promise<unknown>,
): void {
  const { describe, it, afterEach, expect } = runner;
  const { mintUrl, createRepositories, logger } = options;
  const unit = options.customUnit ?? 'sat';
  const post = { type: PaymentRequestTransportType.POST, target: 'https://receiver.test/pay' };
  const sessions = new Set<Manager>();
  const stores: (() => Promise<void>)[] = [];

  async function createWallet(beforeSeedRead?: () => Promise<void>) {
    const { repositories, dispose } = await createRepositories();
    stores.push(dispose);
    const seed = crypto.getRandomValues(new Uint8Array(64));
    const open = async (handler?: TransportHandler) => {
      const manager = await initializeCoco({
        repo: repositories,
        seedGetter: async () => {
          await beforeSeedRead?.();
          return seed;
        },
        logger,
        plugins: handler
          ? [
              {
                name: 'incoming-post-transport',
                required: ['paymentRequestReceiveService'],
                onInit: ({ services }) =>
                  services.paymentRequestReceiveService.registerTransportHandler(handler),
              },
            ]
          : [],
        watchers: {
          mintOperationWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
          mintSwapOperationProcessor: { disabled: true },
        },
      });
      sessions.add(manager);
      return manager;
    };
    return { open, repositories };
  }

  async function fundedPayload() {
    const { open: openPayer } = await createWallet();
    const payer = await openPayer();
    await payer.mint.addMint(mintUrl, { trusted: true });
    await mintAmount(payer, mintUrl, 32, unit);
    const prepared = await payer.ops.send.prepare({
      mintUrl,
      amount: 7,
      unit,
      coverReceiverFees: true,
    });
    const { token } = await payer.ops.send.execute(prepared);
    return { id: 'during-activation', mint: mintUrl, unit, proofs: token.proofs };
  }

  describe('Incoming payment request lifecycle', () => {
    afterEach(async () => {
      for (const session of sessions) await session.dispose();
      sessions.clear();
      for (const dispose of stores.splice(0)) await dispose();
    });

    it('creates only one active request when two sessions compete for the same ID', async () => {
      const { open } = await createWallet();
      const other = await open();
      const request = { requestId: 'shared-id', amount: 7, unit };
      let activations = 0;
      const first = await open({
        type: 'post',
        async createRequestTransport() {
          // The first session passed preflight. Commit the competing request before it can insert.
          await other.paymentRequests.incoming.create(request);
          return post;
        },
        activate() {
          activations++;
        },
        deactivate() {},
      });
      await expect(
        first.paymentRequests.incoming.create({ ...request, transport: 'post' }),
      ).rejects.toThrow('An active payment request already exists for request id shared-id');
      const active = await first.paymentRequests.incoming.list({ state: 'active' });
      expect(active).toHaveLength(1);
      expect(active[0]?.transport).toBe('inband');
      expect(activations).toBe(0);
    });

    it('persists cancellation across restart and allows the request ID to be reused', async () => {
      const { open } = await createWallet();
      const request = { requestId: 'reusable-id', amount: 7, unit, transport: post };
      const activated: string[] = [];
      let deactivatedState: string | undefined;
      const manager = await open({
        type: 'post',
        activate(operation) {
          activated.push(operation.id);
        },
        async deactivate(operation) {
          deactivatedState = (await manager.paymentRequests.incoming.get(operation.id))?.state;
          throw new Error('Transport offline');
        },
      });
      const incoming = manager.paymentRequests.incoming;
      const original = await incoming.create(request);
      const cancelled = await incoming.cancel(original.id, 'Order withdrawn');
      expect(cancelled.state).toBe('cancelled');
      expect(deactivatedState).toBe('cancelled');
      const replacement = await incoming.create(request);
      await manager.dispose();
      sessions.delete(manager);

      const reopened = await open({
        type: 'post',
        activate(operation) {
          activated.push(operation.id);
          throw new Error('Transport still offline');
        },
        deactivate() {},
      });
      const stored = await reopened.paymentRequests.incoming.get(original.id);
      expect(stored?.state).toBe('cancelled');
      expect(stored?.error).toBe('Order withdrawn');
      const active = await reopened.paymentRequests.incoming.list({ state: 'active' });
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(replacement.id);
      expect(activated.join(',')).toBe([original.id, replacement.id, replacement.id].join(','));
    });

    it('cancels an unpaid request when activation fails', async () => {
      const { open } = await createWallet();
      const manager = await open({
        type: 'post',
        activate() {
          throw new Error('Activation failed');
        },
        deactivate() {},
      });
      const incoming = manager.paymentRequests.incoming;
      await expect(incoming.create({ amount: 7, unit, transport: post })).rejects.toThrow(
        'Activation failed',
      );
      const requests = await incoming.list();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.state).toBe('cancelled');
      expect(requests[0]?.error).toBe('Activation failed');
    });

    for (const singleUse of [true, false]) {
      it(`preserves payment received during failed activation (singleUse=${singleUse})`, async () => {
        const payload = await fundedPayload();
        const { open: openReceiver } = await createWallet();
        const receiver = await openReceiver({
          type: 'post',
          async activate() {
            await receiver.paymentRequests.incoming.ingestPayload(payload, { transport: 'post' });
            throw new Error('Activation failed after delivery');
          },
          deactivate() {},
        });
        await receiver.mint.addMint(mintUrl, { trusted: true });
        const incoming = receiver.paymentRequests.incoming;
        await expect(
          incoming.create({
            requestId: payload.id,
            amount: 7,
            unit,
            mints: [mintUrl],
            singleUse,
            transport: post,
          }),
        ).rejects.toThrow('Activation failed after delivery');
        const requests = await incoming.list();
        expect(requests).toHaveLength(1);
        expect(requests[0]?.state).toBe(singleUse ? 'completed' : 'active');
        const replay = await incoming.ingestPayload(payload, { transport: 'post' });
        expect(replay.attempt.state).toBe('finalized');
        expect(replay.receiveOperation?.state).toBe('finalized');
        expect(
          (await receiver.wallet.balances.total({ units: [unit] })).spendable.equals(
            Amount.from(7),
          ),
        ).toBe(true);
      }, 30000);
    }

    it('accepts a delivery when activation throws immediately after ingestion starts', async () => {
      const payload = await fundedPayload();
      const { open, repositories } = await createWallet();
      const delivery =
        Promise.withResolvers<
          Awaited<ReturnType<Manager['paymentRequests']['incoming']['ingestPayload']>>
        >();
      let originalId = '';
      const receiver = await open({
        type: 'post',
        activate(operation) {
          originalId = operation.id;
          delivery.resolve(incoming.ingestPayload(payload));
          throw new Error('Activation interrupted');
        },
        deactivate() {},
      });
      await receiver.mint.addMint(mintUrl, { trusted: true });
      const incoming = receiver.paymentRequests.incoming;
      const [paid] = await Promise.all([
        delivery.promise,
        expect(
          incoming.create({ requestId: payload.id, amount: 7, unit, transport: post }),
        ).rejects.toThrow('Activation interrupted'),
      ]);
      const replay = await incoming.ingestPayload(payload);
      expect(replay.operation.id).toBe(originalId);
      expect(replay.attempt.id).toBe(paid.attempt.id);
      const attempts =
        await repositories.paymentRequestReceiveAttemptRepository.getByRequestOperationId(
          originalId,
        );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.state).toBe('finalized');
      expect(
        (await receiver.wallet.balances.total({ units: [unit] })).spendable.equals(Amount.from(7)),
      ).toBe(true);
    }, 30000);

    for (const singleUse of [true, false]) {
      it(`handles simultaneous claims from separate sessions (singleUse=${singleUse})`, async () => {
        const firstPayload = await fundedPayload();
        const secondPayload = await fundedPayload();
        const { open, repositories } = await createWallet();
        const first = await open();
        const second = await open();
        await first.mint.addMint(mintUrl, { trusted: true });
        const request = await first.paymentRequests.incoming.create({
          requestId: firstPayload.id,
          amount: 7,
          unit,
          singleUse,
        });
        const claims = await Promise.all([
          first.paymentRequests.incoming.claimPayload(request.id, firstPayload),
          second.paymentRequests.incoming.claimPayload(request.id, secondPayload),
        ]);
        expect(claims.filter((claim) => claim.attempt.state === 'finalized')).toHaveLength(
          singleUse ? 1 : 2,
        );
        expect(claims.filter((claim) => claim.attempt.state === 'rejected')).toHaveLength(
          singleUse ? 1 : 0,
        );
        const attempts =
          await repositories.paymentRequestReceiveAttemptRepository.getByRequestOperationId(
            request.id,
          );
        expect(attempts.filter((attempt) => attempt.receiveOperationId)).toHaveLength(
          singleUse ? 1 : 2,
        );
        const balance = await first.wallet.balances.total({ units: [unit] });
        expect(balance.spendable.equals(Amount.from(singleUse ? 7 : 14))).toBe(true);
      }, 30000);
    }

    it('recovers another request while a live claim holds its request lock', async () => {
      const firstPayload = await fundedPayload();
      const secondPayload = { ...(await fundedPayload()), id: 'busy-request' };
      const paused = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let pauseNext = false;
      const { open, repositories } = await createWallet(async () => {
        if (!pauseNext) return;
        pauseNext = false;
        paused.resolve();
        await resume.promise;
      });
      const manager = await open();
      await manager.mint.addMint(mintUrl, { trusted: true });
      const incoming = manager.paymentRequests.incoming;
      const first = await incoming.create({ requestId: firstPayload.id, amount: 7, unit });
      const paid = await incoming.claimPayload(first, firstPayload);
      const second = await incoming.create({ requestId: secondPayload.id, amount: 7, unit });
      const attempts = repositories.paymentRequestReceiveAttemptRepository;
      // Reproduce the old split commit: the first child finished, but its request and attempt did not.
      await repositories.paymentRequestReceiveOperationRepository.update(first);
      await attempts.update({ ...paid.attempt, state: 'receiving' });
      pauseNext = true;
      const claim = incoming.claimPayload(second, secondPayload);
      try {
        await Promise.race([paused.promise, claim]);
        await incoming.recovery.run();
        expect((await attempts.getByRequestOperationId(second.id))[0]?.state).toBe('validating');
        expect((await attempts.getById(paid.attempt.id))?.state).toBe('finalized');
        expect((await incoming.get(first.id))?.state).toBe('completed');
        expect((await manager.wallet.balances.total({ units: [unit] })).spendable.toString()).toBe(
          '7',
        );
      } finally {
        resume.resolve();
        await claim;
      }
      expect((await claim).attempt.state).toBe('finalized');
      expect((await manager.wallet.balances.total({ units: [unit] })).spendable.toString()).toBe(
        '14',
      );
    }, 30000);

    it('preserves a cancellation committed by another session before legacy settlement repair', async () => {
      const payload = await fundedPayload();
      const { open, repositories } = await createWallet();
      const deactivated: string[] = [];
      const handler: TransportHandler = {
        type: 'post',
        activate() {},
        deactivate(operation) {
          deactivated.push(operation.state);
        },
      };
      const receiver = await open(handler);
      const other = await open(handler);
      await receiver.mint.addMint(mintUrl, { trusted: true });
      const incoming = receiver.paymentRequests.incoming;
      const request = await incoming.create({
        requestId: payload.id,
        amount: 7,
        unit,
        transport: post,
      });
      const paid = await incoming.claimPayload(request, payload);
      // Older wallets could finalize the child and attempt while leaving the parent active.
      await repositories.paymentRequestReceiveOperationRepository.update(request);

      // With only a finalized attempt, recovery's first transaction repairs the selected parent.
      // Let the other session commit after selection, just before the adapter opens that transaction.
      const transact = repositories.withTransaction.bind(repositories);
      repositories.withTransaction = async (work) => {
        repositories.withTransaction = transact;
        const cancelled = await other.paymentRequests.incoming.cancel(
          request.id,
          'Order withdrawn',
        );
        expect(cancelled.state).toBe('cancelled');
        return transact(work);
      };
      try {
        await incoming.recovery.run();
      } finally {
        repositories.withTransaction = transact;
      }
      const stored = await incoming.get(request.id);
      expect(stored?.state).toBe('cancelled');
      expect(stored?.error).toBe('Order withdrawn');
      expect(stored?.completedAt).toBe(undefined);
      const replay = await incoming.claimPayload(request, payload);
      expect(replay.attempt.id).toBe(paid.attempt.id);
      expect(replay.attempt.state).toBe('finalized');
      expect(replay.receiveOperation?.state).toBe('finalized');
      expect((await receiver.wallet.balances.total({ units: [unit] })).spendable.toString()).toBe(
        '7',
      );
      expect(deactivated.join(',')).toBe('completed,cancelled');
    }, 30000);

    it('publishes settlement and cleans up the transport after the payment commits', async () => {
      const payload = await fundedPayload();
      const { open, repositories } = await createWallet();
      const observations: string[] = [];
      async function observe(caller: 'transport' | 'event', requestId: string) {
        const parent =
          await repositories.paymentRequestReceiveOperationRepository.getById(requestId);
        const [attempt] =
          await repositories.paymentRequestReceiveAttemptRepository.getByRequestOperationId(
            requestId,
          );
        const balance = await receiver.wallet.balances.total({ units: [unit] });
        observations.push(
          [caller, parent?.state, attempt?.state, balance.spendable.toString()].join('/'),
        );
      }
      const receiver: Manager = await open({
        type: 'post',
        activate() {},
        async deactivate(operation) {
          await observe('transport', operation.id);
          throw new Error('Transport temporarily unavailable');
        },
      });
      await receiver.mint.addMint(mintUrl, { trusted: true });
      const incoming = receiver.paymentRequests.incoming;
      const request = await incoming.create({
        requestId: payload.id,
        amount: 7,
        unit,
        transport: post,
      });
      const off = receiver.on('receive-op:finalized', () => observe('event', request.id));
      try {
        const paid = await incoming.ingestPayload(payload);
        expect(paid.attempt.state).toBe('finalized');
        await incoming.recovery.run();
        expect((await incoming.ingestPayload(payload)).attempt.id).toBe(paid.attempt.id);
        expect(observations.sort().join(',')).toBe(
          'event/completed/finalized/7,transport/completed/finalized/7',
        );
      } finally {
        off();
      }
    }, 30000);

    for (const seedOutcome of ['available', 'unavailable'] as const) {
      it(`returns the payment settled by another session when the original seed becomes ${seedOutcome}`, async () => {
        const payload = await fundedPayload();
        const paused = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        let pauseNextRead = false;
        const { open, repositories } = await createWallet(async () => {
          if (!pauseNextRead) return;
          pauseNextRead = false;
          paused.resolve();
          await resume.promise;
          if (seedOutcome === 'unavailable') throw new Error('Seed temporarily unavailable');
        });
        const first = await open();
        const second = await open();
        await first.mint.addMint(mintUrl, { trusted: true });
        const request = await first.paymentRequests.incoming.create({
          requestId: payload.id,
          amount: 7,
          unit,
        });
        pauseNextRead = true;
        const claim = first.paymentRequests.incoming.claimPayload(request, payload);
        try {
          await Promise.race([paused.promise, claim]);
          await second.paymentRequests.incoming.recovery.run();
        } finally {
          resume.resolve();
        }
        const result = await claim;
        expect(result.attempt.state).toBe('finalized');
        expect(result.attempt.receiveOperationId).toBe(result.receiveOperation?.id);
        expect(await repositories.receiveOperationRepository.getByMintUrl(mintUrl)).toHaveLength(1);
        expect(
          await repositories.paymentRequestReceiveAttemptRepository.getByRequestOperationId(
            request.id,
          ),
        ).toHaveLength(1);
        expect((await first.wallet.balances.total({ units: [unit] })).spendable.toString()).toBe(
          '7',
        );
      }, 30000);
    }

    it('deduplicates in-flight and settled deliveries and detects message ID conflicts', async () => {
      const firstPayload = await fundedPayload();
      const otherPayload = await fundedPayload();
      const { open, repositories } = await createWallet();
      const first = await open();
      const other = await open();
      await first.mint.addMint(mintUrl, { trusted: true });
      const incoming = other.paymentRequests.incoming;
      const request = await incoming.create({ requestId: firstPayload.id, amount: 7, unit });
      const source = { transport: 'post' as const, transportMessageId: 'first-payment' };
      const prepared = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      first.on('receive-op:prepared', async () => {
        prepared.resolve();
        await resume.promise;
      });
      let submissions = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
        if (String(args[0]) === `${mintUrl}/v1/swap`) submissions++;
        return originalFetch(...args);
      }, originalFetch);
      try {
        const claim = first.paymentRequests.incoming.claimPayload(request.id, firstPayload, source);
        try {
          await Promise.race([prepared.promise, claim]);
          await expect(incoming.ingestPayload(firstPayload)).rejects.toThrow('already in progress');
          await expect(incoming.ingestPayload(otherPayload, source)).rejects.toThrow(
            'belongs to a different payload',
          );
          const blocked = await incoming.ingestPayload(otherPayload);
          expect(blocked.attempt.state).toBe('rejected');
          expect(blocked.attempt.error).toContain('in-flight claim');
        } finally {
          resume.resolve();
          await claim;
        }
        const paid = await claim;
        const replacement = await incoming.create({ requestId: firstPayload.id, amount: 7, unit });
        const replay = await incoming.ingestPayload({
          ...firstPayload,
          proofs: [...firstPayload.proofs].reverse(),
        });
        expect(replay.attempt.id).toBe(paid.attempt.id);
        expect(replay.operation.id).toBe(request.id);
        expect((await incoming.ingestPayload(firstPayload, source)).attempt.id).toBe(
          paid.attempt.id,
        );
        await expect(incoming.claimPayload(replacement.id, firstPayload, source)).rejects.toThrow(
          'belongs to another',
        );
        expect((await incoming.get(replacement.id))?.state).toBe('active');
        const attempts =
          await repositories.paymentRequestReceiveAttemptRepository.getByRequestOperationId(
            request.id,
          );
        expect(attempts).toHaveLength(2);
        expect(attempts.filter((attempt) => attempt.state === 'finalized')).toHaveLength(1);
        expect(submissions).toBe(1);
        expect(
          (await other.wallet.balances.total({ units: [unit] })).spendable.equals(Amount.from(7)),
        ).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }, 30000);

    it('returns a permanent rejection and accepts the payload after the request ID is reused', async () => {
      const payload = await fundedPayload();
      const { open } = await createWallet();
      const receiver = await open();
      await receiver.mint.addMint(mintUrl, { trusted: true });
      const incoming = receiver.paymentRequests.incoming;
      const original = await incoming.create({ requestId: payload.id, amount: 32, unit });
      const rejected = await incoming.claimPayload(original, payload);
      expect(rejected.attempt.state).toBe('rejected');
      expect(rejected.receiveOperation).toBe(undefined);
      expect(rejected.operation.state).toBe('active');
      await incoming.cancel(original.id);
      const replacement = await incoming.create({ requestId: payload.id, amount: 7, unit });
      const accepted = await incoming.ingestPayload(payload);
      expect(accepted.operation.id).toBe(replacement.id);
      expect(accepted.attempt.state).toBe('finalized');
    }, 30000);

    for (const retry of ['redelivery', 'restart'] as const) {
      it(`retries a temporary pre-child failure on ${retry}`, async () => {
        const payload = await fundedPayload();
        let readSeed: (() => Promise<void>) | undefined;
        const { open, repositories } = await createWallet(async () => {
          await readSeed?.();
        });
        const receiver = await open();
        await receiver.mint.addMint(mintUrl, { trusted: true });
        const incoming = receiver.paymentRequests.incoming;
        const request = await incoming.create({ requestId: payload.id, amount: 7, unit });
        const attempts = repositories.paymentRequestReceiveAttemptRepository;
        let checkpoint: Awaited<ReturnType<typeof attempts.getById>> = null;
        let failedReads = 0;
        readSeed = async () => {
          failedReads++;
          [checkpoint = null] = await attempts.getByRequestOperationId(request.id);
          throw new Error('Wallet seed temporarily unavailable');
        };
        await expect(incoming.claimPayload(request.id, payload)).rejects.toThrow(
          'Wallet seed temporarily unavailable',
        );
        expect(await attempts.getByRequestOperationId(request.id)).toHaveLength(0);
        if (retry === 'redelivery') {
          readSeed = undefined;
          expect((await incoming.ingestPayload(payload)).attempt.state).toBe('finalized');
          return;
        }

        // Reopen at the real checkpoint a process exit would leave before claim cleans up.
        await receiver.dispose();
        sessions.delete(receiver);
        if (!checkpoint) throw new Error('Missing pre-child checkpoint');
        await attempts.create(checkpoint);
        const readsBeforeRestart = failedReads;
        const reopened = await open();
        expect(failedReads).toBeGreaterThan(readsBeforeRestart);
        const [retained] = await attempts.getByRequestOperationId(request.id);
        expect(retained?.state).toBe('validating');
        expect(retained?.payload?.proofs.length).toBe(payload.proofs.length);
        expect(retained?.receiveOperationId).toBe(undefined);
        readSeed = undefined;
        await reopened.paymentRequests.incoming.recovery.run();
        const replay = await reopened.paymentRequests.incoming.ingestPayload(payload);
        expect(replay.attempt.id).toBe(retained?.id);
        expect(replay.attempt.state).toBe('finalized');
        expect(
          (await reopened.wallet.balances.total({ units: [unit] })).spendable.equals(
            Amount.from(7),
          ),
        ).toBe(true);
      }, 30000);
    }

    it('keeps an in-flight payment claim alive when activation fails', async () => {
      const payload = await fundedPayload();
      const { open } = await createWallet();
      const prepared = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let claim: ReturnType<Manager['paymentRequests']['incoming']['ingestPayload']> | undefined;
      const receiver = await open({
        type: 'post',
        async activate() {
          claim = receiver.paymentRequests.incoming.ingestPayload(payload, { transport: 'post' });
          await Promise.race([prepared.promise, claim]);
          throw new Error('Activation interrupted');
        },
        deactivate() {},
      });
      await receiver.mint.addMint(mintUrl, { trusted: true });
      const unsubscribe = receiver.on('receive-op:prepared', async () => {
        prepared.resolve();
        await resume.promise;
      });
      const incoming = receiver.paymentRequests.incoming;
      try {
        await expect(
          incoming.create({
            requestId: payload.id,
            amount: 7,
            unit,
            transport: post,
          }),
        ).rejects.toThrow('Activation interrupted');
        const [request] = await incoming.list();
        expect(request?.state).toBe('active');
        expect((await receiver.wallet.balances.total({ units: [unit] })).spendable.isZero()).toBe(
          true,
        );
      } finally {
        resume.resolve();
        unsubscribe();
        await claim;
      }
      const [request] = await incoming.list();
      expect(request?.state).toBe('completed');
      expect(
        (await receiver.wallet.balances.total({ units: [unit] })).spendable.equals(Amount.from(7)),
      ).toBe(true);
    }, 30000);
  });
}
