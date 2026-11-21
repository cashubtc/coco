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

  async function createWallet() {
    const { repositories, dispose } = await createRepositories();
    stores.push(dispose);
    const seed = crypto.getRandomValues(new Uint8Array(64));
    return async (handler?: TransportHandler) => {
      const manager = await initializeCoco({
        repo: repositories,
        seedGetter: async () => seed,
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
  }

  async function fundedPayload() {
    const openPayer = await createWallet();
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
      const open = await createWallet();
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
      const open = await createWallet();
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
      const open = await createWallet();
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
        const openReceiver = await createWallet();
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

    it('keeps an in-flight payment claim alive when activation fails', async () => {
      const payload = await fundedPayload();
      const open = await createWallet();
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
