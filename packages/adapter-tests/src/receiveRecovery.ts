import { JSONInt, sumProofs } from '@cashu/cashu-ts';
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

  async function payment(amount = 7, coverReceiverFees = true) {
    const { manager: payer } = await wallet();
    await mintAmount(payer, mintUrl, amount + 25, unit);
    const send = await payer.ops.send.prepare({
      mintUrl,
      amount: { amount, unit },
      coverReceiverFees,
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
    it('rolls back child preparation and output allocation when the attempt link fails', async () => {
      const token = await payment();
      let failLink = true;
      let requestOperationId: string;
      let linkIncludedPreparedChild = false;
      const receiver = await wallet((repo) => {
        const transact = repo.withTransaction.bind(repo);
        repo.withTransaction = (work) =>
          transact(async (scope) => {
            const result = await work(scope);
            if (failLink && requestOperationId) {
              const [attempt] =
                await scope.paymentRequestReceiveAttemptRepository.getByRequestOperationId(
                  requestOperationId,
                );
              if (attempt?.state === 'receiving' && attempt.receiveOperationId) {
                const child = await scope.receiveOperationRepository.getById(
                  attempt.receiveOperationId,
                );
                linkIncludedPreparedChild = !!(
                  child?.state === 'prepared' &&
                  child.source?.type === 'payment-request' &&
                  child.source.attemptId === attempt.id &&
                  child.source.requestOperationId === requestOperationId &&
                  child.outputData.keep.length &&
                  attempt.fee?.equals(child.fee) &&
                  attempt.netAmount?.equals(child.amount.subtract(child.fee))
                );
                throw new Error('Cannot commit child link');
              }
            }
            return result;
          });
      });
      const request = await receiver.manager.paymentRequests.incoming.create({
        amount: { amount: 7, unit },
        mints: [mintUrl],
      });
      requestOperationId = request.id;
      const payload = { ...token, unit, id: request.requestId };
      const counter = (repo: Repositories) =>
        repo.counterRepository.getCounter(mintUrl, token.proofs[0]!.id);
      const before = await counter(receiver.repositories);
      const wire = observeMint(mintUrl);
      let published = 0;
      const off = receiver.manager.on('receive-op:prepared', () => {
        published++;
      });
      try {
        await expect(
          receiver.manager.paymentRequests.incoming.claimPayload(request, payload),
        ).rejects.toThrow('Cannot commit child link');
        expect(linkIncludedPreparedChild).toBe(true);
        expect(published).toBe(0);
        const { manager, repositories } = await receiver.restart();
        expect(await repositories.receiveOperationRepository.getByMintUrl(mintUrl)).toHaveLength(0);
        expect((await counter(repositories))?.counter).toBe(before?.counter);
        const attempts =
          await repositories.paymentRequestReceiveAttemptRepository.getByRequestOperationId(
            request.id,
          );
        expect(attempts).toHaveLength(0);
        expect(wire.swaps).toHaveLength(0);
        expect(await spendable(manager)).toBe('0');
        failLink = false;
        await manager.paymentRequests.incoming.recovery.run();
        const paid = await manager.paymentRequests.incoming.claimPayload(request, payload);
        expect(paid.attempt.state).toBe('finalized');
        expect(paid.attempt.receiveOperationId).toBe(paid.receiveOperation?.id);
        expect(wire.swaps).toHaveLength(1);
        expect(await spendable(manager)).toBe('7');
      } finally {
        off();
        wire.dispose();
      }
    }, 30000);

    for (const failure of ['once', 'until restart'] as const) {
      it(`commits the whole payment once when settlement writes fail ${failure}`, async () => {
        const token = await payment();
        let childId: string | undefined;
        let blocked = true;
        let failedCommits = 0;
        let sawWholePayment = false;
        const receiver = await wallet((repo) => {
          const transact = repo.withTransaction.bind(repo);
          repo.withTransaction = (work) =>
            transact(async (scope) => {
              const result = await work(scope);
              if (!blocked || !childId) return result;
              const child = await scope.receiveOperationRepository.getById(childId);
              if (child?.state !== 'finalized') return result;
              const attempt =
                await scope.paymentRequestReceiveAttemptRepository.getByReceiveOperationId(
                  child.id,
                );
              const parent =
                attempt &&
                (await scope.paymentRequestReceiveOperationRepository.getById(
                  attempt.requestOperationId,
                ));
              const outputs = await scope.proofRepository.getProofsByOperationId(mintUrl, child.id);
              sawWholePayment =
                attempt?.state === 'finalized' &&
                !attempt.payload &&
                attempt.fee?.equals(child.fee) === true &&
                attempt.netAmount?.equals(child.amount.subtract(child.fee)) === true &&
                parent?.state === 'completed' &&
                sumProofs(outputs).toString() === '7';
              failedCommits++;
              if (failure === 'once') blocked = false;
              throw new Error('Cannot commit payment settlement');
            });
        });
        const { manager, repositories } = receiver;
        const incoming = manager.paymentRequests.incoming;
        const request = await incoming.create({ amount: { amount: 7, unit }, mints: [mintUrl] });
        const payload = { ...token, unit, id: request.requestId };
        const off = manager.once('receive-op:prepared', ({ operationId }) => {
          childId = operationId;
        });
        let finalizedEvents = 0;
        const offFinalized = manager.on('receive-op:finalized', () => {
          finalizedEvents++;
        });
        const wire = observeMint(mintUrl);
        try {
          const claim = incoming.claimPayload(request, payload);
          if (failure === 'once') {
            const paid = await claim;
            expect(paid.attempt.state).toBe('finalized');
            expect(paid.operation.state).toBe('completed');
            expect(paid.receiveOperation?.state).toBe('finalized');
            expect(finalizedEvents).toBe(1);
          } else {
            await expect(claim).rejects.toThrow('Cannot commit payment settlement');
            expect((await incoming.get(request.id))?.state).toBe('active');
            expect((await manager.ops.receive.get(childId!))?.state).toBe('executing');
            expect(
              (
                await repositories.paymentRequestReceiveAttemptRepository.getByReceiveOperationId(
                  childId!,
                )
              )?.state,
            ).toBe('receiving');
            expect(await spendable(manager)).toBe('0');
            expect(finalizedEvents).toBe(0);
          }
          expect(sawWholePayment).toBe(true);
          expect(failedCommits).toBeGreaterThan(0);
          expect(wire.committed).toBe(1);
          blocked = false;
          const { manager: reopened } = await receiver.restart();
          const replay = await reopened.paymentRequests.incoming.claimPayload(request.id, payload);
          expect(replay.attempt.state).toBe('finalized');
          expect(replay.attempt.receiveOperationId).toBe(childId);
          expect(replay.operation.state).toBe('completed');
          expect(await spendable(reopened)).toBe('7');
          expect(wire.swaps).toHaveLength(1);
        } finally {
          off();
          offFinalized();
          wire.dispose();
        }
      }, 30000);
    }

    for (const priorState of ['receiving', 'finalized'] as const) {
      it(`repairs an old ${priorState} attempt and active request without resubmitting the child`, async () => {
        const token = await payment();
        const receiver = await wallet();
        const { manager, repositories } = receiver;
        const request = await manager.paymentRequests.incoming.create({
          amount: { amount: 7, unit },
          mints: [mintUrl],
        });
        const payload = { ...token, unit, id: request.requestId };
        const wire = observeMint(mintUrl);
        try {
          const paid = await manager.paymentRequests.incoming.claimPayload(request, payload);
          const childId = paid.attempt.receiveOperationId!;
          await repositories.paymentRequestReceiveOperationRepository.update(request);
          if (priorState === 'receiving') {
            await repositories.paymentRequestReceiveAttemptRepository.update({
              ...paid.attempt,
              state: priorState,
              receiveOperationId: undefined,
              fee: undefined,
              netAmount: undefined,
              payload,
            });
          } else {
            // Old wallets may retain the finalized attempt after pruning its child.
            await repositories.receiveOperationRepository.delete(childId);
          }
          const { manager: reopened, repositories: persisted } = await receiver.restart();
          const repaired = await reopened.paymentRequests.incoming.get(request.id);
          expect(repaired?.state).toBe('completed');
          await reopened.paymentRequests.incoming.recovery.run();
          const attempt = await persisted.paymentRequestReceiveAttemptRepository.getById(
            paid.attempt.id,
          );
          expect(attempt?.state).toBe('finalized');
          expect(attempt?.receiveOperationId).toBe(childId);
          expect(attempt?.fee?.toString()).toBe(paid.attempt.fee?.toString());
          expect(attempt?.netAmount?.toString()).toBe('7');
          expect(attempt?.payload).toBe(undefined);
          expect((await reopened.paymentRequests.incoming.get(request.id))?.completedAt).toBe(
            repaired?.completedAt,
          );
          expect(await spendable(reopened)).toBe('7');
          expect(wire.swaps).toHaveLength(1);
          expect(wire.restored).toBe(0);
        } finally {
          wire.dispose();
        }
      }, 30000);
    }

    it('accepts a second payment on a reusable request after reopening the wallet', async () => {
      const first = await payment();
      const second = await payment();
      const receiver = await wallet();
      const incoming = receiver.manager.paymentRequests.incoming;
      const request = await incoming.create({
        amount: { amount: 7, unit },
        mints: [mintUrl],
        singleUse: false,
      });
      const firstPayload = { ...first, unit, id: request.requestId };
      const wire = observeMint(mintUrl);
      try {
        const paid = await incoming.claimPayload(request, firstPayload);
        const { manager, repositories } = await receiver.restart();
        const reopened = manager.paymentRequests.incoming;
        const next = await reopened.claimPayload(request, {
          ...second,
          unit,
          id: request.requestId,
        });
        expect((await reopened.claimPayload(request, firstPayload)).attempt.id).toBe(
          paid.attempt.id,
        );
        expect(next.operation.state).toBe('active');
        const attempts =
          await repositories.paymentRequestReceiveAttemptRepository.getByRequestOperationId(
            request.id,
          );
        expect(attempts).toHaveLength(2);
        expect(new Set(attempts.map((attempt) => attempt.receiveOperationId)).size).toBe(2);
        expect(
          attempts.every(
            (attempt) => attempt.state === 'finalized' && attempt.netAmount?.toString() === '7',
          ),
        ).toBe(true);
        expect(wire.swaps).toHaveLength(2);
        expect(await spendable(manager)).toBe('14');
      } finally {
        wire.dispose();
      }
    }, 30000);

    for (const command of ['execute', 'cancel'] as const) {
      it(`updates the request attempt during direct child ${command}`, async () => {
        const token = await payment();
        const { manager, repositories } = await wallet();
        const incoming = manager.paymentRequests.incoming;
        const request = await incoming.create({ amount: { amount: 7, unit }, mints: [mintUrl] });
        let observedAttempt: string | undefined;
        let observedParent: string | undefined;
        const off = manager.once('receive-op:prepared', async ({ operationId }) => {
          if (command === 'execute') await manager.ops.receive.execute(operationId);
          else await manager.ops.receive.cancel(operationId, 'Stopped before submission');
          observedAttempt = (
            await repositories.paymentRequestReceiveAttemptRepository.getByReceiveOperationId(
              operationId,
            )
          )?.state;
          observedParent = (await incoming.get(request.id))?.state;
        });
        const wire = observeMint(mintUrl);
        try {
          const result = await incoming.claimPayload(request, {
            ...token,
            unit,
            id: request.requestId,
          });
          expect(observedAttempt).toBe(command === 'execute' ? 'finalized' : 'rejected');
          expect(observedParent).toBe(command === 'execute' ? 'completed' : 'active');
          expect(result.attempt.state).toBe(observedAttempt);
          expect(result.attempt.payload).toBe(undefined);
          if (command === 'cancel') expect(result.attempt.error).toBe('Stopped before submission');
          expect(await spendable(manager)).toBe(command === 'execute' ? '7' : '0');
          expect(wire.swaps).toHaveLength(command === 'execute' ? 1 : 0);
        } finally {
          off();
          wire.dispose();
        }
      }, 30000);
    }

    it('rejects the attempt when direct child refresh confirms its inputs were spent elsewhere', async () => {
      const token = await payment();
      const other = await wallet();
      await other.manager.wallet.receive(token);
      const { manager, repositories } = await wallet();
      const incoming = manager.paymentRequests.incoming;
      const request = await incoming.create({ amount: { amount: 7, unit }, mints: [mintUrl] });
      const payload = { ...token, unit, id: request.requestId };
      const wire = observeMint(mintUrl, 'before swap');
      try {
        await expect(incoming.claimPayload(request, payload)).rejects.toThrow();
        const [pending] = await manager.ops.receive.listInFlight();
        if (!pending) throw new Error('Expected an executing child');
        wire.reconnect();
        const child = await manager.ops.receive.refresh(pending.id);
        expect(child.state).toBe('rolled_back');
        const stored =
          await repositories.paymentRequestReceiveAttemptRepository.getByReceiveOperationId(
            child.id,
          );
        expect(stored?.state).toBe('rejected');
        expect(stored?.error).toContain('input proofs spent');
        expect(stored?.payload).toBe(undefined);
        expect((await incoming.get(request.id))?.state).toBe('active');
        expect((await incoming.claimPayload(request, payload)).attempt.id).toBe(stored?.id);
        expect(await spendable(manager)).toBe('0');
        expect(wire.committed).toBe(0);
      } finally {
        wire.dispose();
      }
    }, 30000);

    for (const gross of [100, 101]) {
      it(`checks the NUT-18 net amount before swapping a ${gross}-unit delivery`, async () => {
        const token = await payment(gross, false);
        const { manager, repositories } = await wallet();
        const request = await manager.paymentRequests.incoming.create({
          amount: { amount: 100, unit },
          mints: [mintUrl],
        });
        const wire = observeMint(mintUrl);
        try {
          const result = await manager.paymentRequests.incoming.claimPayload(request, {
            ...token,
            unit,
            id: request.requestId,
          });
          const fee = options.customUnit ? 0 : 1;
          if (gross - fee < 100) {
            expect(result.attempt.state).toBe('rejected');
            expect(result.operation.state).toBe('active');
            expect(
              await repositories.receiveOperationRepository.getByMintUrl(mintUrl),
            ).toHaveLength(0);
            expect(wire.swaps).toHaveLength(0);
            expect(await spendable(manager)).toBe('0');
          } else {
            expect(result.attempt.state).toBe('finalized');
            expect(result.attempt.fee?.toString()).toBe(String(fee));
            expect(result.attempt.netAmount?.toString()).toBe(String(gross - fee));
            expect(wire.swaps).toHaveLength(1);
            expect(await spendable(manager)).toBe(String(gross - fee));
          }
        } finally {
          wire.dispose();
        }
      }, 30000);
    }
    for (const legacy of ['init', 'prepared', 'short prepared'] as const) {
      it(`reopens a legacy ${legacy} child with only its attempt source`, async () => {
        const token = await payment();
        const receiver = await wallet();
        const { manager, repositories } = receiver;
        const short = legacy === 'short prepared';
        const request = await manager.paymentRequests.incoming.create({
          amount: { amount: short ? 8 : 7, unit },
          mints: [mintUrl],
        });
        const attemptId = 'old-attempt';
        const source = {
          type: 'payment-request' as const,
          requestOperationId: request.id,
          requestId: request.requestId,
          attemptId,
          transport: 'inband' as const,
        };
        const grossAmount = sumProofs(token.proofs);
        // Construct the on-disk layout left by older wallets between preparing and linking.
        let childId: string;
        if (legacy === 'init') {
          childId = 'old-init';
          await repositories.receiveOperationRepository.create({
            id: childId,
            state: 'init',
            mintUrl,
            unit,
            amount: grossAmount,
            inputProofs: token.proofs,
            source,
            createdAt: 1,
            updatedAt: 1,
          });
        } else {
          const prepared = await manager.ops.receive.prepare({ token });
          childId = prepared.id;
          await repositories.receiveOperationRepository.update({ ...prepared, source });
        }
        await repositories.paymentRequestReceiveAttemptRepository.create({
          id: attemptId,
          requestOperationId: request.id,
          requestId: request.requestId,
          transport: 'inband',
          payloadHash: 'legacy-without-payload',
          mintUrl,
          unit,
          grossAmount,
          state: 'validating',
          createdAt: 1,
          updatedAt: 1,
        });
        const wire = observeMint(mintUrl);
        try {
          if (short)
            await expect(manager.ops.receive.execute(childId)).rejects.toThrow('net amount');
          const { manager: reopened, repositories: persisted } = await receiver.restart();
          await reopened.paymentRequests.incoming.recovery.run();
          const attempt = await persisted.paymentRequestReceiveAttemptRepository.getById(attemptId);
          expect(attempt?.state).toBe(short ? 'rejected' : 'finalized');
          expect((await reopened.paymentRequests.incoming.get(request.id))?.state).toBe(
            short ? 'active' : 'completed',
          );
          expect((await reopened.ops.receive.get(childId))?.state).toBe(
            short ? 'rolled_back' : 'finalized',
          );
          expect(await persisted.receiveOperationRepository.getByMintUrl(mintUrl)).toHaveLength(1);
          if (!short) {
            expect(attempt?.receiveOperationId).toBe(childId);
            expect(attempt?.netAmount?.toString()).toBe('7');
            expect(attempt?.fee?.toString()).toBe(grossAmount.subtract(7).toString());
          }
          expect(wire.swaps).toHaveLength(short ? 0 : 1);
          expect(await spendable(reopened)).toBe(short ? '0' : '7');
        } finally {
          wire.dispose();
        }
      }, 30000);
    }

    it('accepts redelivery after restart when both the legacy child and payload are missing', async () => {
      const token = await payment();
      const receiver = await wallet();
      const request = await receiver.manager.paymentRequests.incoming.create({
        amount: { amount: 7, unit },
      });
      const source = { transport: 'post' as const, transportMessageId: 'old-delivery' };
      await receiver.repositories.paymentRequestReceiveAttemptRepository.create({
        id: 'old-attempt',
        requestOperationId: request.id,
        requestId: request.requestId,
        ...source,
        payloadHash: 'old-hash',
        mintUrl,
        unit,
        grossAmount: sumProofs(token.proofs),
        receiveOperationId: 'missing-child',
        state: 'receiving',
        createdAt: 1,
        updatedAt: 1,
      });
      const wire = observeMint(mintUrl);
      try {
        const { manager, repositories } = await receiver.restart();
        const attempts = repositories.paymentRequestReceiveAttemptRepository;
        expect(await attempts.getById('old-attempt')).toBe(null);
        expect(wire.swaps).toHaveLength(0);
        const result = await manager.paymentRequests.incoming.ingestPayload(
          { ...token, unit, id: request.requestId },
          source,
        );
        expect(result.attempt.state).toBe('finalized');
        expect(await attempts.getByRequestOperationId(request.id)).toHaveLength(1);
        expect(wire.swaps).toHaveLength(1);
        expect(await spendable(manager)).toBe('7');
      } finally {
        wire.dispose();
      }
    }, 30000);

    it('rejects an altered stored payload on restart before allocating a child', async () => {
      const token = await payment();
      const receiver = await wallet();
      const request = await receiver.manager.paymentRequests.incoming.create({
        amount: { amount: 7, unit },
      });
      await receiver.repositories.paymentRequestReceiveAttemptRepository.create({
        id: 'altered',
        requestOperationId: request.id,
        requestId: request.requestId,
        transport: 'inband',
        payloadHash: 'hash-before-corruption',
        payload: { ...token, id: request.requestId, unit },
        mintUrl,
        unit,
        grossAmount: sumProofs(token.proofs),
        state: 'received',
        createdAt: 1,
        updatedAt: 1,
      });
      const wire = observeMint(mintUrl);
      try {
        const { manager, repositories } = await receiver.restart();
        const attempt =
          await repositories.paymentRequestReceiveAttemptRepository.getById('altered');
        expect(attempt?.state).toBe('rejected');
        expect(attempt?.error).toContain('hash mismatch');
        expect(await repositories.receiveOperationRepository.getByMintUrl(mintUrl)).toHaveLength(0);
        expect((await manager.paymentRequests.incoming.get(request.id))?.state).toBe('active');
        expect(wire.swaps).toHaveLength(0);
      } finally {
        wire.dispose();
      }
    }, 30000);

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
            expect(failedCommits).toBe(1);
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
