import { Amount } from '@cashu/cashu-ts';
import { mintSwapFixture, sourceUrl, destinationUrl, keys, outputProofs } from './fixture.ts';
import {
  beginMintSwapSource,
  applyMintSwapSource,
  beginMintSwapDestination,
  applyMintSwapDestination,
  cancelMintSwap,
  reconcileMintSwap,
  deferMintSwap,
  prepareMintSwap,
  createMintSwap,
  applyMintSwapPreSwap,
} from '../../../../core/operations/mintSwap/MintSwapTransitions.ts';
import {
  beginMeltExecution,
  applyMeltPaidResult,
  prepareMelt,
} from '../../../../core/operations/melt/MeltTransitions.ts';
import {
  beginMintExecution,
  applyMintResult,
  prepareMint,
} from '../../../../core/operations/mint/MintTransitions.ts';
import { MintSwapDebitCapError } from '../../../../core/operations/mintSwap/MintSwapDebitCapError.ts';
import { MintSwapIntentConflictError } from '../../../../core/operations/mintSwap/MintSwapValidation.ts';
import { defineTransition } from '../../../../core/transactions/Transition.ts';
import { RepositoryCoreTransactionRunner } from '../../../../core/transactions/CoreTransaction.ts';
import { overrideTransactions } from '../../../../core/test/overrideTransactions.ts';

import type { MintSwapContractOptions, MintSwapTestRunner } from './contract.ts';

export function runMintSwapTransitionContract(
  options: MintSwapContractOptions,
  runner: MintSwapTestRunner,
) {
  const { describe, it, expect, beforeEach, afterEach } = runner;
  describe('Mint Swap composition', () => {
    let fixture: Awaited<ReturnType<typeof mintSwapFixture>>;
    let store: Awaited<ReturnType<MintSwapContractOptions['createRepositories']>> | undefined;
    async function setup(input = 8, cap?: number) {
      await store?.dispose();
      store = await options.createRepositories();
      fixture = await mintSwapFixture(store.repositories, { input, cap });
      await fixture.create();
    }
    beforeEach(() => setup());
    afterEach(async () => {
      await store?.dispose();
      store = undefined;
    });

    it('drains a dropped composed preparation before commit and expires captured parent methods', async () => {
      const escaped = await fixture.runner.run(async (tx) => {
        void tx.perform(prepareMintSwap, fixture.preparation);
        return tx.mintSwapOperations!.getById;
      });
      expect(
        (await fixture.repositories.mintSwap!.operationRepository.getById('swap'))?.state,
      ).toBe('prepared');
      expect(
        (await fixture.repositories.meltOperationRepository.getById('source-child'))?.state,
      ).toBe('prepared');
      expect(
        (await fixture.repositories.mintOperationRepository.getById('destination-child'))?.state,
      ).toBe('pending');
      await expect(escaped('swap')).rejects.toThrow();
    });

    it('quarantines a missing child without inventing its replacement', async () => {
      await fixture.prepare();
      await fixture.repositories.mintOperationRepository.delete('destination-child');
      const parent = await fixture.service().reconcile('swap');
      expect(parent.state).toBe('needs_attention');
      expect(parent.attention?.evidence.code).toBe('child_missing');
      expect(
        await fixture.repositories.mintOperationRepository.getById('destination-child'),
      ).toBeNull();
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBe('source-child');
      await fixture.service().recoverActive();
      await fixture.service().recoverDue();
      expect(fixture.requests).toEqual([]);
    });

    it('refuses destination proofs attributed to another issuance and preserves that evidence', async () => {
      await fund();
      await fixture.saveDestination('PAID');
      const started = await fixture.runner.run((tx) =>
        tx.perform(beginMintSwapDestination, { id: 'swap', now: 4_000 }),
      );
      const proofs = outputProofs(started.destination!.outputData);
      await fixture.repositories.proofRepository.saveProofs(
        destinationUrl,
        proofs.map((proof) => ({
          ...proof,
          mintUrl: destinationUrl,
          unit: 'sat',
          state: 'ready' as const,
          createdByOperationId: 'other-issuance',
        })),
      );
      await fixture.saveDestination('ISSUED');
      const parent = await fixture.runner.run((tx) =>
        tx.perform(reconcileMintSwap, { id: 'swap', now: 5_000 }),
      );
      expect(parent.state).toBe('needs_attention');
      expect(
        (
          await fixture.repositories.proofRepository.getProofBySecret(
            destinationUrl,
            proofs[0]!.secret,
          )
        )?.createdByOperationId,
      ).toBe('other-issuance');
      expect(
        (await fixture.repositories.mintOperationRepository.getById('destination-child'))?.state,
      ).toBe('executing');
    });

    it('finishes from historical destination proofs reserved elsewhere without releasing their owner', async () => {
      await fund();
      await fixture.saveDestination('PAID');
      const started = await fixture.runner.run((tx) =>
        tx.perform(beginMintSwapDestination, { id: 'swap', now: 4_000 }),
      );
      const proofs = outputProofs(started.destination!.outputData);
      await fixture.repositories.proofRepository.saveProofs(
        destinationUrl,
        proofs.map((proof) => ({
          ...proof,
          mintUrl: destinationUrl,
          unit: 'sat',
          state: 'inflight' as const,
          createdByOperationId: 'destination-child',
          usedByOperationId: 'later-send',
        })),
      );
      await fixture.saveDestination('ISSUED');
      expect(
        (
          await fixture.runner.run((tx) =>
            tx.perform(reconcileMintSwap, { id: 'swap', now: 5_000 }),
          )
        ).state,
      ).toBe('completed');
      const stored = await fixture.repositories.proofRepository.getProofBySecret(
        destinationUrl,
        proofs[0]!.secret,
      );
      expect(stored?.state).toBe('inflight');
      expect(stored?.usedByOperationId).toBe('later-send');
    });

    const now = 2_000;
    async function authorize() {
      await fixture.prepare();
      return fixture.runner.run((tx) =>
        tx.perform(beginMintSwapSource, { ...fixture.preparation, now }),
      );
    }
    async function fund() {
      const started = await authorize();
      await fixture.saveSource('PAID', 3_000);
      return fixture.runner.run((tx) =>
        tx.perform(applyMintSwapSource, {
          id: 'swap',
          now: 3_000,
          paid: { operation: started.source!, changeProofs: [], now: 3_000 },
        }),
      );
    }

    it('prepares both children and reservations together and resumes with stable identities', async () => {
      const result = await fixture.prepare();
      expect(result.state).toBe('prepared');
      expect((await fixture.prepare()).revision).toBe(result.revision);
      const proof = await fixture.repositories.proofRepository.getProofBySecret(
        sourceUrl,
        'original',
      );
      expect(proof?.usedByOperationId).toBe('source-child');
      expect(
        (await fixture.repositories.mintOperationRepository.getById('destination-child'))?.state,
      ).toBe('pending');
    });

    it('rolls back both children, counters, proofs and parent when enclosing composition fails', async () => {
      const fail = defineTransition<void, void>(async (tx) => {
        await tx.perform(prepareMintSwap, fixture.preparation);
        throw new Error('late parent failure');
      });
      await expect(
        fixture.runner.run(async (tx) => {
          try {
            await tx.perform(fail);
          } catch {
            /* failure still poisons the attempt */
          }
        }),
      ).rejects.toThrow('late parent failure');
      expect(
        (await fixture.repositories.mintSwap!.operationRepository.getById('swap'))?.state,
      ).toBe('preparing');
      expect(await fixture.repositories.meltOperationRepository.getById('source-child')).toBeNull();
      expect(
        await fixture.repositories.mintOperationRepository.getById('destination-child'),
      ).toBeNull();
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBeUndefined();
      expect(
        await fixture.repositories.counterRepository.getCounter(destinationUrl, keys.id),
      ).toBeNull();
      expect((await fixture.prepare()).state).toBe('prepared');
    });

    it('rolls back parent identity indexes and permits the same creation after rollback', async () => {
      const other = {
        ...fixture.parent,
        id: 'other',
        sourceOperationId: 's2',
        destinationOperationId: 'd2',
        sourceQuote: { ...fixture.parent.sourceQuote, quoteId: 's2' },
        destinationQuote: { ...fixture.parent.destinationQuote, quoteId: 'd2' },
      };
      await expect(
        fixture.repositories.withTransaction(async (scope) => {
          await scope.mintSwap!.operationRepository.create(other);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      await fixture.repositories.mintSwap!.operationRepository.create(other);
      expect(
        await fixture.repositories.mintSwap!.operationRepository.getById('other'),
      ).not.toBeNull();
    });

    it('rejects conflicting caller intent without replacing the parent', async () => {
      await expect(
        fixture.runner.run((tx) =>
          tx.perform(createMintSwap, { ...fixture.parent, destinationAmount: Amount.from(9) }),
        ),
      ).rejects.toBeInstanceOf(MintSwapIntentConflictError);
    });

    it('aborts child writes when the final parent revision guard loses', async () => {
      const repositories = fixture.repositories;
      let attempts = 0;
      const runner = new RepositoryCoreTransactionRunner(
        overrideTransactions(repositories, (work) =>
          repositories.withTransaction((scope) => {
            attempts++;
            return work({
              ...scope,
              mintSwap: {
                operationRepository: new Proxy(scope.mintSwap!.operationRepository, {
                  get(target, key) {
                    if (key === 'transition') return async () => false;
                    const value = Reflect.get(target, key);
                    return typeof value === 'function' ? value.bind(target) : value;
                  },
                }),
              },
            });
          }),
        ),
      );
      await expect(
        runner.run((tx) => tx.perform(prepareMintSwap, fixture.preparation)),
      ).rejects.toThrow('changed during local composition');
      expect(attempts).toBe(3);
      expect(await repositories.meltOperationRepository.getById('source-child')).toBeNull();
      expect(await repositories.mintOperationRepository.getById('destination-child')).toBeNull();
      expect(
        (await repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBeUndefined();
    });

    it('retains valid child settlement when changed fee evidence contradicts parent accounting', async () => {
      const started = await authorize();
      const keyset = await fixture.repositories.keysetRepository.getKeysetById(sourceUrl, keys.id);
      await fixture.repositories.keysetRepository.updateKeyset({ ...keyset!, feePpk: 1_000 });
      await fixture.saveSource('PAID', 3_000);
      const parent = await fixture.runner.run((tx) =>
        tx.perform(applyMintSwapSource, {
          id: 'swap',
          now: 3_000,
          paid: { operation: started.source!, changeProofs: [], now: 3_000 },
        }),
      );
      expect(parent.state).toBe('needs_attention');
      expect(
        (await fixture.repositories.meltOperationRepository.getById('source-child'))?.state,
      ).toBe('finalized');
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))?.state,
      ).toBe('spent');
    });

    it('authorizes only once under concurrent source requests', async () => {
      await fixture.prepare();
      const outcomes = await Promise.all(
        [1, 2].map(() =>
          fixture.runner.run((tx) =>
            tx.perform(beginMintSwapSource, { ...fixture.preparation, now }),
          ),
        ),
      );
      expect(outcomes.filter((result) => result.changed)).toHaveLength(1);
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))?.state,
      ).toBe('inflight');
    });

    it('requires actual claimability and never starts an unpaid destination', async () => {
      await fund();
      const result = await fixture.runner.run((tx) =>
        tx.perform(beginMintSwapDestination, { id: 'swap', now: 4_000 }),
      );
      expect(result.changed).toBe(false);
      expect(result.operation.state).toBe('destination_funded');
    });

    it('commits issued proofs while accounting lags then completes without resetting spent proofs', async () => {
      await fund();
      await fixture.saveDestination('PAID');
      const started = await fixture.runner.run((tx) =>
        tx.perform(beginMintSwapDestination, { id: 'swap', now: 4_000 }),
      );
      const proofs = outputProofs(started.destination!.outputData);
      const settled = await fixture.runner.run((tx) =>
        tx.perform(applyMintSwapDestination, {
          id: 'swap',
          operation: started.destination!,
          proofs,
          now: 5_000,
        }),
      );
      expect(settled.state).toBe('destination_pending');
      await fixture.repositories.proofRepository.setProofState(
        destinationUrl,
        proofs.map((proof) => proof.secret),
        'spent',
      );
      await fixture.saveDestination('ISSUED');
      const completed = await fixture.runner.run((tx) =>
        tx.perform(reconcileMintSwap, { id: 'swap', now: 6_000 }),
      );
      expect(completed.state).toBe('completed');
      expect(
        (
          await fixture.repositories.proofRepository.getProofBySecret(
            destinationUrl,
            proofs[0]!.secret,
          )
        )?.state,
      ).toBe('spent');
      expect(
        (
          await fixture.runner.run((tx) =>
            tx.perform(reconcileMintSwap, { id: 'swap', now: 7_000 }),
          )
        ).revision,
      ).toBe(completed.revision);
    });

    it('prepared cancellation releases exact inputs and retains the immutable output plans', async () => {
      await fixture.prepare();
      const parent = await fixture.runner.run((tx) =>
        tx.perform(cancelMintSwap, { id: 'swap', now }),
      );
      expect(parent.state).toBe('cancelled');
      expect(
        (await fixture.repositories.meltOperationRepository.getById('source-child'))?.state,
      ).toBe('rolled_back');
      expect(
        (await fixture.repositories.mintOperationRepository.getById('destination-child'))?.state,
      ).toBe('pending');
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBeUndefined();
    });

    it('recovers exact locally restored outputs without issuance or resetting their spend state', async () => {
      await fund();
      await fixture.saveDestination('PAID');
      const started = await fixture.runner.run((tx) =>
        tx.perform(beginMintSwapDestination, { id: 'swap', now: 4_000 }),
      );
      const proofs = outputProofs(started.destination!.outputData);
      await fixture.repositories.proofRepository.saveProofs(
        destinationUrl,
        proofs.map((proof) => ({
          ...proof,
          mintUrl: destinationUrl,
          unit: 'sat',
          state: 'spent' as const,
        })),
      );
      await fixture.saveDestination('ISSUED');
      const parent = await fixture.runner.run((tx) =>
        tx.perform(reconcileMintSwap, { id: 'swap', now: 5_000 }),
      );
      expect(parent.state).toBe('completed');
      expect(
        (await fixture.repositories.mintOperationRepository.getById('destination-child'))?.state,
      ).toBe('finalized');
      expect(
        (
          await fixture.repositories.proofRepository.getProofBySecret(
            destinationUrl,
            proofs[0]!.secret,
          )
        )?.state,
      ).toBe('spent');
    });

    it('pending cancellation retains inputs until fresh non-payment evidence', async () => {
      await authorize();
      const intent = await fixture.runner.run((tx) =>
        tx.perform(cancelMintSwap, { id: 'swap', now: 2_500 }),
      );
      expect(intent.state).toBe('source_pending');
      expect(intent.cancellationRequestedAt).toBe(2_500);
      await fixture.saveSource('UNPAID', 3_000);
      const result = await fixture.runner.run((tx) =>
        tx.perform(applyMintSwapSource, {
          id: 'swap',
          now: 3_000,
          nonPayment: {
            kind: 'quote-observation-unpaid',
            mintUrl: sourceUrl,
            method: 'bolt11',
            quoteId: 'source-quote',
            observedAt: 3_000,
          },
        }),
      );
      expect(result.state).toBe('cancelled');
    });

    it('rejects old UNPAID evidence and keeps ambiguous source resources', async () => {
      await authorize();
      await expect(
        fixture.runner.run((tx) =>
          tx.perform(applyMintSwapSource, {
            id: 'swap',
            now: 3_000,
            nonPayment: {
              kind: 'quote-observation-unpaid',
              mintUrl: sourceUrl,
              method: 'bolt11',
              quoteId: 'source-quote',
              observedAt: 1_000,
            },
          }),
        ),
      ).rejects.toThrow('predates');
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))?.state,
      ).toBe('inflight');
    });

    it('cancellation after PAID advances toward destination recovery', async () => {
      await fund();
      expect(
        (await fixture.runner.run((tx) => tx.perform(cancelMintSwap, { id: 'swap', now: 4_000 })))
          .state,
      ).toBe('destination_funded');
    });

    it('adopts independently finalized children by following every legal parent edge', async () => {
      await fixture.prepare();
      const source = await fixture.runner.run((tx) =>
        tx.perform(beginMeltExecution, { operationId: 'source-child', now }),
      );
      if (source.operation.state !== 'executing') throw new Error('Expected executing');
      await fixture.saveSource('PAID', 3_000);
      await fixture.runner.run((tx) =>
        tx.perform(applyMeltPaidResult, {
          operation: source.operation as typeof source.operation & { state: 'executing' },
          changeProofs: [],
          now: 3_000,
        }),
      );
      await fixture.saveDestination('PAID');
      const destination = await fixture.runner.run((tx) =>
        tx.perform(beginMintExecution, { operationId: 'destination-child', now: 4_000 }),
      );
      if (destination.operation.state !== 'executing') throw new Error('Expected executing');
      const executing = destination.operation;
      await fixture.runner.run((tx) =>
        tx.perform(applyMintResult, {
          operation: executing,
          proofs: outputProofs(executing.outputData),
          now: 4_000,
        }),
      );
      await fixture.saveDestination('ISSUED');
      const parent = await fixture.runner.run((tx) =>
        tx.perform(reconcileMintSwap, { id: 'swap', now: 5_000 }),
      );
      expect(parent.state).toBe('completed');
      expect(parent.revision).toBe(5);
    });

    it('adopts advanced exact children from preparing without re-preparing inactive output plans', async () => {
      const { seed } = fixture.preparation;
      const quote = await fixture.saveSource('UNPAID');
      await fixture.runner.run(async (tx) => {
        await tx.perform(prepareMelt, {
          operationId: 'source-child',
          mintUrl: sourceUrl,
          method: 'bolt11',
          methodData: { invoice: quote.request },
          quoteId: 'source-quote',
          unit: 'sat',
          activeKeys: keys,
          seed,
          now,
        });
        await tx.perform(prepareMint, {
          operationId: 'destination-child',
          mintUrl: destinationUrl,
          method: 'bolt11',
          quoteId: 'destination-quote',
          amount: Amount.from(8),
          unit: 'sat',
          activeKeys: keys,
          seed,
          now,
        });
      });
      const authorized = await fixture.runner.run((tx) =>
        tx.perform(beginMeltExecution, { operationId: 'source-child', now }),
      );
      if (authorized.operation.state !== 'executing') throw new Error('Expected executing');
      const operation = authorized.operation;
      await fixture.saveSource('PAID', 3_000);
      await fixture.runner.run((tx) =>
        tx.perform(applyMeltPaidResult, { operation, changeProofs: [], now: 3_000 }),
      );
      for (const url of [sourceUrl, destinationUrl]) {
        const keyset = await fixture.repositories.keysetRepository.getKeysetById(url, keys.id);
        await fixture.repositories.keysetRepository.updateKeyset({ ...keyset!, active: false });
      }
      expect((await fixture.service().prepare(fixture.parent)).state).toBe('destination_funded');
      expect(fixture.requests).toEqual([]);
    });

    it('persists bounded retry with monotonic clocks and Retry-After lower bound', async () => {
      await authorize();
      const first = await fixture.runner.run((tx) =>
        tx.perform(deferMintSwap, {
          id: 'swap',
          now: 1,
          random: 0,
          error: { category: 'waiting', code: 'source_pending' },
          retryAfter: 900_000,
        }),
      );
      expect(first.retry.nextAttemptAt).toBe(900_000);
      const second = await fixture.runner.run((tx) =>
        tx.perform(deferMintSwap, {
          id: 'swap',
          now: 1,
          random: 0.5,
          error: { category: 'waiting', code: 'source_pending' },
        }),
      );
      expect(second.retry.lastAttemptAt).toBe(first.retry.lastAttemptAt! + 1);
      expect(second.retry.attemptCount).toBe(2);
      expect(second.retry.nextAttemptAt).toBe(second.updatedAt + 2_000);
    });

    it('moves missing immutable recovery material to attention and stops automatic scans', async () => {
      await fixture.prepare();
      await fixture.repositories.mintOperationRepository.delete('destination-child');
      const parent = await fixture.runner.run((tx) =>
        tx.perform(reconcileMintSwap, { id: 'swap', now }),
      );
      expect(parent.state).toBe('needs_attention');
      expect(parent.attention?.evidence.code).toBe('child_missing');
      expect(
        await fixture.repositories.mintSwap!.operationRepository.listDue(999_999, 10),
      ).toHaveLength(0);
    });
  });
}
