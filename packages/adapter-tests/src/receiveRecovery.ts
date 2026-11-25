import { JSONInt } from '@cashu/cashu-ts';
import { initializeCoco, normalizeUnit, type Manager } from '@cashu/coco-core';
import type { Repositories } from '@cashu/coco-core/adapter';
import type { IntegrationTestOptions, IntegrationTestRunner } from './integration.ts';

type Interruption = 'before swap' | 'after swap';

// Observe the receiver's wire requests. While disconnected, even immediate recovery
// cannot tell whether the mint spent the inputs.
function observeMint(mintUrl: string, interruption?: Interruption) {
  const original = globalThis.fetch;
  const swaps: string[] = [];
  let committed = 0;
  let restored = 0;
  let offline = interruption !== undefined;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    if (args[0] === `${mintUrl}/v1/swap`) {
      swaps.push(String(args[1]?.body));
      if (offline && interruption === 'before swap') throw new Error('Swap did not reach the mint');
      const response = await original(...args);
      if (response.ok) committed++;
      if (offline) {
        await response.arrayBuffer();
        throw new Error('Mint response lost');
      }
      return response;
    }
    if (args[0] === `${mintUrl}/v1/checkstate` || args[0] === `${mintUrl}/v1/restore`) {
      if (offline) throw new Error('Mint unreachable');
      if (args[0] === `${mintUrl}/v1/restore`) restored++;
    }
    return original(...args);
  }, original);
  return {
    swaps,
    get committed() {
      return committed;
    },
    get restored() {
      return restored;
    },
    reconnect() {
      offline = false;
    },
    dispose() {
      globalThis.fetch = original;
    },
  };
}

export function runReceiveRecoveryTests(
  options: IntegrationTestOptions,
  runner: IntegrationTestRunner,
  mintAmount: (wallet: Manager, mintUrl: string, amount: number, unit: string) => Promise<unknown>,
) {
  const { describe, it, afterEach, expect } = runner;
  const { createRepositories, mintUrl, logger } = options;
  const unit = normalizeUnit(options.customUnit ?? 'sat');
  const cleanup: (() => Promise<void>)[] = [];

  async function wallet(onConnect?: (repositories: Repositories) => void) {
    const storage = await createRepositories();
    let repositories = storage.repositories;
    onConnect?.(repositories);
    const seed = crypto.getRandomValues(new Uint8Array(64));
    const open = () =>
      initializeCoco({
        repo: repositories,
        seedGetter: async () => seed,
        logger,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          mintSwapOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
        },
        requestRateLimit: { disabled: true },
      });
    let manager: Manager | undefined;
    cleanup.push(async () => {
      try {
        await manager?.dispose();
      } finally {
        await storage.dispose();
      }
    });
    manager = await open();
    await manager.mint.addMint(mintUrl, { trusted: true });
    return {
      manager,
      repositories,
      async restart() {
        await manager!.dispose();
        manager = undefined;
        if (storage.reopen) {
          repositories = await storage.reopen();
          onConnect?.(repositories);
        }
        manager = await open();
        return { manager, repositories };
      },
    };
  }

  async function payment() {
    const { manager: payer } = await wallet();
    await mintAmount(payer, mintUrl, 32, unit);
    const send = await payer.ops.send.prepare({
      mintUrl,
      amount: { amount: 7, unit },
      coverReceiverFees: true,
    });
    return (await payer.ops.send.execute(send.id)).token;
  }

  async function spendable(manager: Manager) {
    return (await manager.wallet.balances.total({ units: [unit] })).spendable.toString();
  }

  describe('Shared Receive recovery', () => {
    afterEach(async () => {
      for (const dispose of cleanup.splice(0)) await dispose();
    });
    for (const entry of ['standalone', 'payment request'] as const) {
      for (const interruption of ['before swap', 'after swap'] as const) {
        it(`recovers the same ${entry} Receive after a disconnect ${interruption}`, async () => {
          const token = await payment();
          const receiver = await wallet();
          const { manager, repositories } = receiver;
          const incoming = manager.paymentRequests.incoming;
          const request =
            entry === 'payment request'
              ? await incoming.create({ amount: { amount: 7, unit }, mints: [mintUrl] })
              : undefined;
          const attempts = repositories.paymentRequestReceiveAttemptRepository;
          const wire = observeMint(mintUrl, interruption);
          try {
            if (request) {
              await expect(
                incoming.claimPayload(request, { ...token, unit, id: request.requestId }),
              ).rejects.toThrow();
            } else {
              await expect(manager.wallet.receive(token)).rejects.toThrow();
            }
            const operations = repositories.receiveOperationRepository;
            const pending = await operations.getByMintUrl(mintUrl);
            expect(pending).toHaveLength(1);
            const child = pending[0]!;
            expect(child.state).toBe('executing');
            if (child.state !== 'executing') throw new Error('Expected an unresolved swap');
            expect(wire.swaps).toHaveLength(1);
            const originalSwap = JSONInt.parse(wire.swaps[0]!) as {
              inputs: unknown[];
              outputs: unknown[];
            };
            expect(originalSwap.inputs.length).toBe(token.proofs.length);
            expect(originalSwap.outputs.length).toBeGreaterThan(0);
            expect(wire.committed).toBe(interruption === 'after swap' ? 1 : 0);
            expect(await spendable(manager)).toBe('0');
            if (request) {
              const attempt = await attempts.getByReceiveOperationId(child.id);
              expect(attempt?.state).toBe('receiving');
              expect(attempt?.requestOperationId).toBe(request.id);
              expect((await incoming.get(request.id))?.state).toBe('active');
            }

            if (interruption === 'after swap') wire.reconnect();
            const { manager: reopened, repositories: persisted } = await receiver.restart();
            if (interruption === 'before swap') {
              // An offline restart still has no evidence about the first submission.
              expect((await reopened.ops.receive.get(child.id))?.state).toBe('executing');
              expect(wire.swaps).toHaveLength(1);
              expect(await spendable(reopened)).toBe('0');
              if (request) {
                expect(
                  (
                    await persisted.paymentRequestReceiveAttemptRepository.getByReceiveOperationId(
                      child.id,
                    )
                  )?.state,
                ).toBe('receiving');
              }
              wire.reconnect();
              await reopened.ops.receive.recovery.run();
              expect((await reopened.ops.receive.get(child.id))?.state).toBe('finalized');
              if (request) await reopened.paymentRequests.incoming.recovery.run();
            }
            const final = await reopened.ops.receive.get(child.id);
            expect(final?.state).toBe('finalized');
            if (final?.state !== 'finalized') throw new Error('Expected a recovered Receive');
            expect(JSONInt.stringify(final.outputData)).toBe(JSONInt.stringify(child.outputData));
            expect(JSONInt.stringify(final.inputProofs)).toBe(JSONInt.stringify(child.inputProofs));
            if (request) {
              const [attempt] =
                await persisted.paymentRequestReceiveAttemptRepository.getByRequestOperationId(
                  request.id,
                );
              expect(attempt?.receiveOperationId).toBe(final.id);
              expect(attempt?.state).toBe('finalized');
              expect(attempt?.netAmount?.toString()).toBe('7');
              expect(attempt?.fee?.toString()).toBe(final.fee.toString());
              expect((await reopened.paymentRequests.incoming.get(request.id))?.state).toBe(
                'completed',
              );
            }
            await reopened.paymentRequests.incoming.recovery.run();
            expect(await persisted.receiveOperationRepository.getByMintUrl(mintUrl)).toHaveLength(
              1,
            );
            expect(wire.committed).toBe(1);
            expect(await spendable(reopened)).toBe('7');
            if (interruption === 'before swap') {
              expect(wire.swaps).toHaveLength(2);
              expect(wire.swaps[1]).toBe(wire.swaps[0]);
            } else {
              expect(wire.swaps).toHaveLength(1);
              expect(wire.restored).toBeGreaterThan(0);
            }
          } finally {
            wire.dispose();
          }
        }, 30000);
      }
    }

    for (const blockedOnRestart of [false, true]) {
      const name = blockedOnRestart
        ? 'keeps the payment request child prepared when the execution write fails again on restart'
        : 'resumes a prepared payment request child on restart before its first submission';
      it(
        name,
        async () => {
          const token = await payment();
          let blockedChildId: string | undefined;
          let failedCommits = 0;
          const receiver = await wallet((repo) => {
            const transact = repo.withTransaction.bind(repo);
            repo.withTransaction = (work) =>
              transact(async (scope) => {
                const result = await work(scope);
                // Fail the real commit after the child becomes executing in this transaction.
                if (
                  blockedChildId &&
                  (await scope.receiveOperationRepository.getById(blockedChildId))?.state ===
                    'executing'
                ) {
                  failedCommits++;
                  throw new Error('Cannot persist Receive execution');
                }
                return result;
              });
          });
          const { manager, repositories } = receiver;
          const incoming = manager.paymentRequests.incoming;
          const request = await incoming.create({ amount: { amount: 7, unit }, mints: [mintUrl] });
          const attempts = repositories.paymentRequestReceiveAttemptRepository;
          const unsubscribe = manager.once('receive-op:prepared', ({ operationId }) => {
            blockedChildId = operationId;
          });
          const wire = observeMint(mintUrl);
          try {
            await expect(
              incoming.claimPayload(request, { ...token, unit, id: request.requestId }),
            ).rejects.toThrow();
            expect(failedCommits).toBeGreaterThan(0);
            const [attempt] = await attempts.getByRequestOperationId(request.id);
            expect(attempt?.state).toBe('receiving');
            const child = await manager.ops.receive.get(attempt!.receiveOperationId!);
            expect(child?.state).toBe('prepared');
            if (child?.state !== 'prepared') throw new Error('Expected a prepared child');
            await manager.ops.receive.recovery.run();
            expect((await manager.ops.receive.get(child.id))?.state).toBe('prepared');
            expect(wire.swaps).toHaveLength(0);
            expect(await spendable(manager)).toBe('0');

            const failuresBeforeRestart = failedCommits;
            if (!blockedOnRestart) blockedChildId = undefined;
            const { manager: reopened, repositories: persisted } = await receiver.restart();
            if (blockedOnRestart) {
              expect(failedCommits).toBeGreaterThan(failuresBeforeRestart);
              expect((await reopened.paymentRequests.incoming.get(request.id))?.state).toBe(
                'active',
              );
              const pending = await persisted.paymentRequestReceiveAttemptRepository.getById(
                attempt!.id,
              );
              expect(pending?.state).toBe('receiving');
              expect(pending?.receiveOperationId).toBe(child.id);
              expect((await reopened.ops.receive.get(child.id))?.state).toBe('prepared');
              expect(wire.swaps).toHaveLength(0);
              expect(await spendable(reopened)).toBe('0');

              blockedChildId = undefined;
              await reopened.paymentRequests.incoming.recovery.run();
            }
            expect((await reopened.paymentRequests.incoming.get(request.id))?.state).toBe(
              'completed',
            );
            const finalized = await persisted.paymentRequestReceiveAttemptRepository.getById(
              attempt!.id,
            );
            expect(finalized?.state).toBe('finalized');
            expect(finalized?.netAmount?.toString()).toBe('7');
            expect(finalized?.receiveOperationId).toBe(child.id);
            const received = await reopened.ops.receive.get(child.id);
            if (received?.state !== 'finalized')
              throw new Error('Expected the original child to finalize');
            expect(JSONInt.stringify(received.outputData)).toBe(
              JSONInt.stringify(child.outputData),
            );
            await reopened.paymentRequests.incoming.recovery.run();
            expect(wire.swaps).toHaveLength(1);
            expect(wire.committed).toBe(1);
            expect(await spendable(reopened)).toBe('7');
          } finally {
            unsubscribe();
            wire.dispose();
          }
        },
        30000,
      );
    }
  });
}
