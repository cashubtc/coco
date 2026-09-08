import { Amount } from '@cashu/cashu-ts';
import type {
  CoreProof,
  MeltOperation,
  MintSwapOperation,
  MintSwapOperationState,
  Repositories,
  RepositoryTransactionScope,
} from '@cashu/coco-core/adapter';
import { serializeMintSwapOperation } from '@cashu/coco-core/adapter';
import type { ContractRunner, TransactionFactory } from './index.ts';

export type MintSwapContractOptions<TRepositories extends Repositories = Repositories> = {
  createRepositories: TransactionFactory<TRepositories>;
  createDisabledRepositories?: TransactionFactory<TRepositories>;
};

const CREATED_AT = 1_700_000_000_000;

function fixtures(
  id = 'swap',
  createdAt = CREATED_AT,
): { [S in MintSwapOperationState]: Extract<MintSwapOperation, { state: S }> } {
  const base = {
    schemaVersion: 1 as const,
    id,
    revision: 0,
    sourceMintUrl: 'https://source.example',
    destinationMintUrl: 'https://destination.example',
    unit: 'sat' as const,
    destinationAmount: Amount.from(100),
    sourceDebitCap: Amount.from(110),
    sourceQuote: {
      mintUrl: 'https://source.example',
      method: 'bolt11' as const,
      quoteId: `melt-${id}`,
    },
    destinationQuote: {
      mintUrl: 'https://destination.example',
      method: 'bolt11' as const,
      quoteId: `mint-${id}`,
    },
    sourceOperationId: `source-${id}`,
    destinationOperationId: `destination-${id}`,
    paymentRequestHash: 'ab'.repeat(32),
    createdAt,
    cancellationRequestedAt: createdAt,
  };
  const retry = (nextAttemptAt: number | null) => ({
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt,
    lastError: null,
  });
  const preparedFacts = {
    sourceDebitBounds: {
      minimum: Amount.from(102),
      maximum: Amount.from(110),
      reserved: Amount.from(128),
    },
  };
  const sourceFacts = { ...preparedFacts, sourceStartedAt: createdAt + 2_000 };
  const fundedFacts = {
    ...sourceFacts,
    sourceSettlement: {
      reserved: Amount.from(128),
      returned: Amount.from(23),
      finalDebit: Amount.from(105),
      totalFee: Amount.from(5),
      sourcePaidObservedAt: createdAt + 3_000,
    },
  };
  const destinationFacts = { ...fundedFacts, destinationStartedAt: createdAt + 4_000 };
  const at = (offset: number) => ({
    updatedAt: createdAt + offset,
    stateEnteredAt: createdAt + offset,
  });
  const lastSafe = {
    state: 'source_pending' as const,
    stateEnteredAt: createdAt + 2_000,
    ...sourceFacts,
  };
  const valueNeutral = {
    sourcePayment: 'confirmed_unpaid' as const,
    sourceProofs: 'released' as const,
    verifiedAt: createdAt + 5_000,
  };

  return {
    preparing: { ...base, state: 'preparing', ...at(0), retry: retry(createdAt) },
    prepared: {
      ...base,
      state: 'prepared',
      ...at(1_000),
      ...preparedFacts,
      retry: retry(null),
    },
    source_pending: {
      ...base,
      state: 'source_pending',
      ...at(2_000),
      ...sourceFacts,
      retry: retry(createdAt + 2_000),
    },
    destination_funded: {
      ...base,
      state: 'destination_funded',
      ...at(3_000),
      ...fundedFacts,
      retry: retry(createdAt + 3_000),
    },
    destination_pending: {
      ...base,
      state: 'destination_pending',
      ...at(4_000),
      ...destinationFacts,
      retry: retry(createdAt + 4_000),
    },
    completed: {
      ...base,
      state: 'completed',
      ...at(5_000),
      ...destinationFacts,
      retry: retry(null),
      destinationCompletion: {
        quoteAmountIssued: Amount.from(100),
        storedProofAmount: Amount.from(100),
        proofsVerifiedAt: createdAt + 5_000,
      },
      completedAt: createdAt + 5_000,
    },
    cancelled: {
      ...base,
      state: 'cancelled',
      ...at(5_000),
      retry: retry(null),
      lastSafe,
      valueNeutral,
      cancelledAt: createdAt + 5_000,
    },
    failed: {
      ...base,
      state: 'failed',
      ...at(5_000),
      retry: retry(null),
      lastSafe,
      valueNeutral,
      failure: { code: 'source_payment_rejected' },
      failedAt: createdAt + 5_000,
    },
    needs_attention: {
      ...base,
      state: 'needs_attention',
      ...at(5_000),
      retry: retry(null),
      lastSafe: {
        state: 'destination_pending',
        stateEnteredAt: createdAt + 4_000,
        ...destinationFacts,
      },
      attentionAt: createdAt + 5_000,
      attention: {
        reason: 'contradictory_evidence',
        invariant: 'destination_completion',
        evidence: {
          code: 'proof_total_mismatch',
          leg: 'destination',
          observedAt: createdAt + 5_000,
        },
      },
    },
  };
}

export function runMintSwapPersistenceContract(
  options: MintSwapContractOptions,
  runner: ContractRunner,
): void {
  const { describe, it, expect } = runner;

  describe('Mint Swap persistence contract', () => {
    it('exposes one opt-in bundle and remains absent by default', async () => {
      const enabled = await options.createRepositories();
      try {
        expect(enabled.repositories.mintSwap !== undefined).toBe(true);
        expect(enabled.repositories.mintSwap?.operationRepository !== undefined).toBe(true);
      } finally {
        await enabled.dispose();
      }

      if (options.createDisabledRepositories) {
        const disabled = await options.createDisabledRepositories();
        try {
          expect(disabled.repositories.mintSwap).toBe(undefined);
          await disabled.repositories.withTransaction(async (scope) => {
            expect(scope.mintSwap).toBe(undefined);
          });
        } finally {
          await disabled.dispose();
        }
      }
    });

    it('round-trips every V1 state with lossless Amount values', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repository = requireMintSwap(repositories);
        for (const state of Object.keys(fixtures()) as MintSwapOperationState[]) {
          const operation = fixtures(state)[state];
          await repository.create(operation);
          const stored = await repository.getById(operation.id);
          expect(stored === null ? '' : serializeMintSwapOperation(stored)).toBe(
            serializeMintSwapOperation(operation),
          );
          if (stored) stored.sourceQuote.quoteId = 'mutated-read';
          const reread = await repository.getById(operation.id);
          expect(reread?.sourceQuote.quoteId).toBe(operation.sourceQuote.quoteId);
        }
      } finally {
        await dispose();
      }
    });

    it('maps all five all-time identity conflicts to stable non-sensitive kinds', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repository = requireMintSwap(repositories);
        const first = fixtures('first').preparing;
        await repository.create(first);
        const cases: Array<[string, MintSwapOperation]> = [
          ['parent', { ...fixtures('parent').preparing, id: first.id }],
          [
            'source_quote',
            { ...fixtures('source-quote').preparing, sourceQuote: first.sourceQuote },
          ],
          [
            'destination_quote',
            {
              ...fixtures('destination-quote').preparing,
              destinationQuote: first.destinationQuote,
            },
          ],
          [
            'source_child',
            { ...fixtures('source-child').preparing, sourceOperationId: first.sourceOperationId },
          ],
          [
            'destination_child',
            {
              ...fixtures('destination-child').preparing,
              destinationOperationId: first.destinationOperationId,
            },
          ],
        ];
        for (const [kind, operation] of cases) {
          let thrown: unknown;
          try {
            await repository.create(operation);
          } catch (error) {
            thrown = error;
          }
          expect(thrown instanceof Error ? thrown.name : '').toBe('MintSwapIdentityConflictError');
          expect((thrown as { kind?: unknown })?.kind).toBe(kind);
          expect(thrown instanceof Error && thrown.message.includes(operation.id)).toBe(false);
        }
      } finally {
        await dispose();
      }
    });

    it('has exactly one concurrent create winner', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repository = requireMintSwap(repositories);
        const operation = fixtures('create-race').preparing;
        const results = await Promise.allSettled([
          repository.create(operation),
          repository.create(operation),
        ]);
        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        const rejection = results.find(({ status }) => status === 'rejected');
        const reason = rejection?.status === 'rejected' ? rejection.reason : undefined;
        expect(reason instanceof Error ? reason.name : '').toBe('MintSwapIdentityConflictError');
        expect((reason as { kind?: unknown })?.kind).toBe('parent');
      } finally {
        await dispose();
      }
    });

    it('guards before parsing and assigns exactly one persistence-owned revision', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repository = requireMintSwap(repositories);
        const { preparing, prepared } = fixtures();
        await repository.create(preparing);
        expect(
          await repository.transition({
            operationId: preparing.id,
            expectedState: 'prepared',
            expectedRevision: 0,
            next: null as unknown as MintSwapOperation,
          }),
        ).toBe(false);
        expect(
          await repository.transition({
            operationId: preparing.id,
            expectedState: 'preparing',
            expectedRevision: 0,
            next: { ...prepared, revision: 999 },
          }),
        ).toBe(true);
        const stored = await repository.getById(preparing.id);
        expect(stored?.state).toBe('prepared');
        expect(stored?.revision).toBe(1);
        expect(
          await repository.transition({
            operationId: preparing.id,
            expectedState: 'preparing',
            expectedRevision: 0,
            next: preparing,
          }),
        ).toBe(false);

        let invalidTransitionThrew = false;
        try {
          await repository.transition({
            operationId: preparing.id,
            expectedState: 'prepared',
            expectedRevision: 1,
            next: fixtures().completed,
          });
        } catch {
          invalidTransitionThrew = true;
        }
        expect(invalidTransitionThrew).toBe(true);
        expect((await repository.getById(preparing.id))?.state).toBe('prepared');
        expect((await repository.getById(preparing.id))?.revision).toBe(1);
      } finally {
        await dispose();
      }
    });

    it('has one winner for concurrent transitions and same-state retry updates', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repository = requireMintSwap(repositories);
        const first = fixtures('concurrent');
        await repository.create(first.preparing);
        const transitions = await Promise.all([
          repository.transition({
            operationId: first.preparing.id,
            expectedState: 'preparing',
            expectedRevision: 0,
            next: first.prepared,
          }),
          repository.transition({
            operationId: first.preparing.id,
            expectedState: 'preparing',
            expectedRevision: 0,
            next: first.prepared,
          }),
        ]);
        expect(transitions.filter(Boolean)).toHaveLength(1);
        expect((await repository.getById(first.preparing.id))?.revision).toBe(1);

        const second = fixtures('same-state');
        await repository.create(second.source_pending);
        const retry: MintSwapOperation = {
          ...second.source_pending,
          updatedAt: CREATED_AT + 2_100,
          retry: {
            attemptCount: 1,
            lastAttemptAt: CREATED_AT + 2_100,
            nextAttemptAt: CREATED_AT + 4_100,
            lastError: {
              category: 'waiting',
              code: 'source_pending',
              at: CREATED_AT + 2_100,
            },
          },
        };
        expect(
          await repository.transition({
            operationId: second.source_pending.id,
            expectedState: 'source_pending',
            expectedRevision: 0,
            next: retry,
          }),
        ).toBe(true);
        const stored = await repository.getById(second.source_pending.id);
        expect(stored?.state).toBe('source_pending');
        expect(stored?.revision).toBe(1);
        expect(stored?.retry.attemptCount).toBe(1);
      } finally {
        await dispose();
      }
    });

    it('uses portable JavaScript ordering and applies the due limit afterward', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repository = requireMintSwap(repositories);
        const ids = ['\uE000', '😀'];
        for (const id of ids) await repository.create(fixtures(id).preparing);
        const expected = [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
        expect(JSON.stringify((await repository.listActive()).map(({ id }) => id))).toBe(
          JSON.stringify(expected),
        );
        expect(JSON.stringify((await repository.listDue(CREATED_AT, 1)).map(({ id }) => id))).toBe(
          JSON.stringify(expected.slice(0, 1)),
        );
        expect(await repository.listDue(CREATED_AT, 0)).toHaveLength(0);
        for (const invalid of [-1, 0.5, Number.POSITIVE_INFINITY]) {
          let invalidTimeThrew = false;
          let invalidLimitThrew = false;
          try {
            await repository.listDue(invalid, 1);
          } catch {
            invalidTimeThrew = true;
          }
          try {
            await repository.listDue(CREATED_AT, invalid);
          } catch {
            invalidLimitThrew = true;
          }
          expect(invalidTimeThrew).toBe(true);
          expect(invalidLimitThrew).toBe(true);
        }
      } finally {
        await dispose();
      }
    });

    it('commits and rolls back parent, child, proof, and revision as one Wallet write set', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const parent = fixtures('atomic').preparing;
        const child = meltOperation(parent.sourceOperationId);
        const proof = sourceProof('atomic-proof');
        await repositories.withTransaction(async (scope) => {
          await requireMintSwap(scope).create(parent);
          await scope.meltOperationRepository.create(child);
          await scope.proofRepository.saveProofs(proof.mintUrl, [proof]);
        });
        expect((await requireMintSwap(repositories).getById(parent.id))?.state).toBe('preparing');
        expect((await repositories.meltOperationRepository.getById(child.id))?.state).toBe('init');
        expect(
          await repositories.proofRepository.getProofsBySecrets(proof.mintUrl, [proof.secret]),
        ).toHaveLength(1);

        const next = fixtures('atomic').prepared;
        try {
          await repositories.withTransaction(async (scope) => {
            await requireMintSwap(scope).transition({
              operationId: parent.id,
              expectedState: 'preparing',
              expectedRevision: 0,
              next,
            });
            await scope.meltOperationRepository.update({ ...child, updatedAt: 1 });
            await scope.proofRepository.setProofState(proof.mintUrl, [proof.secret], 'inflight');
            throw new Error('injected failure');
          });
        } catch {}

        const after = await requireMintSwap(repositories).getById(parent.id);
        expect(after?.state).toBe('preparing');
        expect(after?.revision).toBe(0);
        expect((await repositories.meltOperationRepository.getById(child.id))?.updatedAt).toBe(0);
        expect(
          (await repositories.proofRepository.getProofsBySecrets(proof.mintUrl, [proof.secret]))[0]
            ?.state,
        ).toBe('ready');

        for (const failAfter of [1, 2, 3]) {
          const failedParent = fixtures(`failure-${failAfter}`).preparing;
          const failedChild = meltOperation(failedParent.sourceOperationId);
          const failedProof = sourceProof(`failure-proof-${failAfter}`);
          try {
            await repositories.withTransaction(async (scope) => {
              await requireMintSwap(scope).create(failedParent);
              if (failAfter === 1) throw new Error('injected parent boundary failure');
              await scope.meltOperationRepository.create(failedChild);
              if (failAfter === 2) throw new Error('injected child boundary failure');
              await scope.proofRepository.saveProofs(failedProof.mintUrl, [failedProof]);
              throw new Error('injected proof boundary failure');
            });
          } catch {}
          expect(await requireMintSwap(repositories).getById(failedParent.id)).toBe(null);
          expect(await repositories.meltOperationRepository.getById(failedChild.id)).toBe(null);
          expect(
            await repositories.proofRepository.getProofsBySecrets(failedProof.mintUrl, [
              failedProof.secret,
            ]),
          ).toHaveLength(0);
        }
      } finally {
        await dispose();
      }
    });

    it('persists PENDING, later PAID, and later UNPAID local Melt shapes atomically', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const parent = fixtures('pending').source_pending;
        const child = preparedMeltOperation(parent.sourceOperationId, 'pending');
        const proof = { ...sourceProof('pending-proof'), usedByOperationId: child.id };
        await repositories.withTransaction(async (scope) => {
          await requireMintSwap(scope).create(parent);
          await scope.meltOperationRepository.create(child);
          await scope.proofRepository.saveProofs(proof.mintUrl, [proof]);
        });

        const retry: MintSwapOperation = {
          ...parent,
          updatedAt: CREATED_AT + 2_100,
          retry: {
            attemptCount: 1,
            lastAttemptAt: CREATED_AT + 2_100,
            nextAttemptAt: CREATED_AT + 4_100,
            lastError: {
              category: 'waiting',
              code: 'source_pending',
              at: CREATED_AT + 2_100,
            },
          },
        };
        await repositories.withTransaction(async (scope) => {
          expect(
            await requireMintSwap(scope).transition({
              operationId: parent.id,
              expectedState: 'source_pending',
              expectedRevision: 0,
              next: retry,
            }),
          ).toBe(true);
        });
        expect((await requireMintSwap(repositories).getById(parent.id))?.revision).toBe(1);
        expect((await repositories.meltOperationRepository.getById(child.id))?.state).toBe(
          'pending',
        );
        expect(
          (await repositories.proofRepository.getProofsBySecrets(proof.mintUrl, [proof.secret]))[0]
            ?.usedByOperationId,
        ).toBe(child.id);

        await repositories.withTransaction(async (scope) => {
          await scope.meltOperationRepository.update({
            ...child,
            state: 'finalized',
            updatedAt: CREATED_AT + 3_000,
            changeAmount: Amount.zero(),
            effectiveFee: Amount.from(5),
            finalizedData: { preimage: 'preimage' },
          });
          await scope.proofRepository.setProofState(proof.mintUrl, [proof.secret], 'spent');
          expect(
            await requireMintSwap(scope).transition({
              operationId: parent.id,
              expectedState: 'source_pending',
              expectedRevision: 1,
              next: fixtures('pending').destination_funded,
            }),
          ).toBe(true);
        });
        expect((await requireMintSwap(repositories).getById(parent.id))?.state).toBe(
          'destination_funded',
        );
        expect((await repositories.meltOperationRepository.getById(child.id))?.state).toBe(
          'finalized',
        );

        const unpaidParent = fixtures('unpaid').source_pending;
        const unpaidChild = preparedMeltOperation(unpaidParent.sourceOperationId, 'pending');
        const unpaidProof = {
          ...sourceProof('unpaid-proof'),
          usedByOperationId: unpaidChild.id,
        };
        await repositories.withTransaction(async (scope) => {
          await requireMintSwap(scope).create(unpaidParent);
          await scope.meltOperationRepository.create(unpaidChild);
          await scope.proofRepository.saveProofs(unpaidProof.mintUrl, [unpaidProof]);
        });
        await repositories.withTransaction(async (scope) => {
          await scope.meltOperationRepository.update({
            ...unpaidChild,
            state: 'rolled_back',
            error: 'Rolled back',
            updatedAt: CREATED_AT + 5_000,
          });
          await scope.proofRepository.releaseProofs(unpaidProof.mintUrl, [unpaidProof.secret]);
          expect(
            await requireMintSwap(scope).transition({
              operationId: unpaidParent.id,
              expectedState: 'source_pending',
              expectedRevision: 0,
              next: fixtures('unpaid').cancelled,
            }),
          ).toBe(true);
        });
        expect((await requireMintSwap(repositories).getById(unpaidParent.id))?.state).toBe(
          'cancelled',
        );
        expect((await repositories.meltOperationRepository.getById(unpaidChild.id))?.state).toBe(
          'rolled_back',
        );
        expect(
          (
            await repositories.proofRepository.getProofsBySecrets(unpaidProof.mintUrl, [
              unpaidProof.secret,
            ])
          )[0]?.usedByOperationId,
        ).toBe(undefined);
      } finally {
        await dispose();
      }
    });

    it('rolls back every later PAID and UNPAID write boundary', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        for (const outcome of ['paid', 'unpaid'] as const) {
          for (const failAfter of [1, 2, 3]) {
            const suffix = `${outcome}-rollback-${failAfter}`;
            const parent = fixtures(suffix).source_pending;
            const child = preparedMeltOperation(parent.sourceOperationId, 'pending');
            const proof = {
              ...sourceProof(`${suffix}-proof`),
              usedByOperationId: child.id,
            };
            await repositories.withTransaction(async (scope) => {
              await requireMintSwap(scope).create(parent);
              await scope.meltOperationRepository.create(child);
              await scope.proofRepository.saveProofs(proof.mintUrl, [proof]);
            });

            try {
              await repositories.withTransaction(async (scope) => {
                if (outcome === 'paid') {
                  await scope.meltOperationRepository.update({
                    ...child,
                    state: 'finalized',
                    updatedAt: CREATED_AT + 3_000,
                    changeAmount: Amount.zero(),
                    effectiveFee: Amount.from(5),
                    finalizedData: { preimage: 'preimage' },
                  });
                } else {
                  await scope.meltOperationRepository.update({
                    ...child,
                    state: 'rolled_back',
                    error: 'Rolled back',
                    updatedAt: CREATED_AT + 5_000,
                  });
                }
                if (failAfter === 1) throw new Error('injected child update failure');

                if (outcome === 'paid') {
                  await scope.proofRepository.setProofState(proof.mintUrl, [proof.secret], 'spent');
                } else {
                  await scope.proofRepository.releaseProofs(proof.mintUrl, [proof.secret]);
                }
                if (failAfter === 2) throw new Error('injected proof update failure');

                expect(
                  await requireMintSwap(scope).transition({
                    operationId: parent.id,
                    expectedState: 'source_pending',
                    expectedRevision: 0,
                    next:
                      outcome === 'paid'
                        ? fixtures(suffix).destination_funded
                        : fixtures(suffix).cancelled,
                  }),
                ).toBe(true);
                throw new Error('injected parent transition failure');
              });
            } catch {}

            const storedParent = await requireMintSwap(repositories).getById(parent.id);
            expect(storedParent?.state).toBe('source_pending');
            expect(storedParent?.revision).toBe(0);
            expect((await repositories.meltOperationRepository.getById(child.id))?.state).toBe(
              'pending',
            );
            const storedProof = (
              await repositories.proofRepository.getProofsBySecrets(proof.mintUrl, [proof.secret])
            )[0];
            expect(storedProof?.state).toBe('ready');
            expect(storedProof?.usedByOperationId).toBe(child.id);
          }
        }
      } finally {
        await dispose();
      }
    });
  });
}

function requireMintSwap(repositories: Repositories | RepositoryTransactionScope) {
  if (!repositories.mintSwap) throw new Error('Mint Swap persistence is not enabled');
  return repositories.mintSwap.operationRepository;
}

function meltOperation(id: string): Extract<MeltOperation, { state: 'init' }> {
  return {
    id,
    state: 'init',
    mintUrl: 'https://source.example',
    unit: 'sat',
    method: 'bolt11',
    methodData: { invoice: 'lnbc1test', amountSats: Amount.from(100) },
    quoteId: `quote-${id}`,
    createdAt: 0,
    updatedAt: 0,
  };
}

function preparedMeltOperation(
  id: string,
  state: 'pending' | 'rolled_back',
): Extract<MeltOperation, { state: 'pending' | 'rolled_back' }> {
  return {
    ...meltOperation(id),
    state,
    amount: Amount.from(100),
    fee_reserve: Amount.from(5),
    swap_fee: Amount.zero(),
    needsSwap: false,
    inputAmount: Amount.from(105),
    inputProofSecrets: [`proof-${id}`],
    changeOutputData: { keep: [], send: [] },
    ...(state === 'rolled_back' ? { error: 'Rolled back' } : {}),
  } as Extract<MeltOperation, { state: 'pending' | 'rolled_back' }>;
}

function sourceProof(secret: string): CoreProof {
  return {
    id: 'proof-keyset',
    amount: Amount.from(128),
    secret,
    C: `C-${secret}`,
    mintUrl: 'https://source.example',
    unit: 'sat',
    state: 'ready',
  };
}
