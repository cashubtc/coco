import {
  Amount,
  RateLimitError,
  createNewMintKeys,
  serializeMintKeys,
  createBlindSignature,
  pointFromHex,
  type Wallet,
} from '@cashu/cashu-ts';
import { mintSwapFixture, sourceUrl, destinationUrl, keys, outputProofs } from './fixture.ts';
import { beginMintSwapSource } from '../../../../core/operations/mintSwap/MintSwapTransitions.ts';
import { MeltOperationService } from '../../../../core/operations/melt/MeltOperationService.ts';
import { KeyRingService } from '../../../../core/services/KeyRingService.ts';
import { KeypairDerivation } from '../../../../core/keypairs/KeypairDerivation.ts';
import { KeypairP2pkSigner } from '../../../../core/keypairs/P2pkSigner.ts';
import { RepositoryCoreTransactionRunner } from '../../../../core/transactions/CoreTransaction.ts';
import { RepositoryTransactionConflictError } from '../../../../core/repositories/index.ts';
import { overrideTransactions } from '../../../../core/test/overrideTransactions.ts';
import { deserializeOutputData } from '../../../../core/utils.ts';
import { testMintKeysetId } from '../../../../core/test/fixtures/MintMetadata.ts';

import type { MintSwapContractOptions, MintSwapTestRunner } from './contract.ts';

export function runMintSwapCoordinatorContract(
  options: MintSwapContractOptions,
  runner: MintSwapTestRunner,
) {
  const { describe, it, expect, beforeEach, afterEach } = runner;
  describe('Mint Swap coordinator', () => {
    let fixture: Awaited<ReturnType<typeof mintSwapFixture>>;
    let store: Awaited<ReturnType<MintSwapContractOptions['createRepositories']>> | undefined;
    async function setup(input = 8, cap?: number) {
      await store?.dispose();
      store = await options.createRepositories();
      fixture = await mintSwapFixture(store.repositories, { input, cap });
    }
    beforeEach(() => setup());
    afterEach(async () => {
      await store?.dispose();
      store = undefined;
    });

    for (const [name, changes] of [
      ['empty identity', { id: ' ' }],
      ['same normalized mint', { destinationMintUrl: sourceUrl + '/' }],
      ['zero receive amount', { destinationAmount: Amount.zero() }],
      ['cap below receive amount', { sourceDebitCap: Amount.from(7) }],
    ] as const) {
      it(`rejects ${name} before allocating keys or contacting mints`, async () => {
        await expect(
          fixture.service().prepare({ ...fixture.parent, ...changes }),
        ).rejects.toThrow();
        expect(fixture.requests).toEqual([]);
        expect(await fixture.repositories.mintSwap!.operationRepository.listActive()).toEqual([]);
      });
    }

    it('commits the real NUT-20 allocation before quote I/O and retains it if quote creation fails', async () => {
      const repositories = fixture.repositories;
      fixture.dependencies.keyRingService = new KeyRingService(
        repositories.keyRingRepository,
        fixture.dependencies.transactionRunner,
        new KeypairDerivation(fixture.dependencies.loadSeed),
        new KeypairP2pkSigner(repositories.keyRingRepository),
      );
      let allocatedKey = '';
      fixture.dependencies.quoteLifecycle.createMintQuote = async (
        _url: string,
        _method: unknown,
        params?: unknown,
      ) => {
        if (
          !params ||
          typeof params !== 'object' ||
          !('ownedPubkey' in params) ||
          typeof params.ownedPubkey !== 'string'
        )
          throw new Error('Expected a locked BOLT11 quote request');
        allocatedKey = params.ownedPubkey;
        expect(fixture.transactionActive).toBe(false);
        expect(
          await repositories.keyRingRepository.getPersistedKeyPair(
            allocatedKey,
            'nut20_mint_quote',
          ),
        ).not.toBeNull();
        throw new Error('destination unavailable');
      };
      await expect(fixture.service().prepare(fixture.parent)).rejects.toThrow(
        'destination unavailable',
      );
      const retained = await repositories.keyRingRepository.getPersistedKeyPair(
        allocatedKey,
        'nut20_mint_quote',
      );
      expect(retained?.derivationIndex).toBe(0);
      expect(
        await repositories.keyRingRepository.getPersistedKeyPair(allocatedKey, 'p2pk'),
      ).toBeNull();
      expect(await repositories.mintSwap!.operationRepository.getById('swap')).toBeNull();
      expect(
        (await repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBeUndefined();
    });

    it('rolls back failed preparation without publishing events and resumes the same child identities', async () => {
      await fixture.create();
      const published: string[] = [];
      fixture.events.on('melt-op:prepared', () => {
        published.push('prepared');
      });
      fixture.events.on('counter:updated', () => {
        published.push('counter');
      });
      const runner = fixture.dependencies.transactionRunner;
      let fail = true;
      fixture.dependencies.transactionRunner = {
        run: (work) =>
          runner.run(async (tx) => {
            const result = await work(tx);
            if (fail && (await tx.mintSwapOperations!.getById('swap'))?.state === 'prepared') {
              fail = false;
              throw new Error('commit failed');
            }
            return result;
          }),
      };
      expect((await fixture.service().prepare(fixture.parent)).state).toBe('preparing');
      expect(published).toEqual([]);
      expect(await fixture.repositories.meltOperationRepository.getById('source-child')).toBeNull();
      expect(
        await fixture.repositories.mintOperationRepository.getById('destination-child'),
      ).toBeNull();
      expect(
        await fixture.repositories.counterRepository.getCounter(destinationUrl, keys.id),
      ).toBeNull();
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBeUndefined();
      const prepared = await fixture.service().prepare(fixture.parent);
      expect(prepared.state).toBe('prepared');
      expect(prepared.sourceOperationId).toBe('source-child');
      expect(prepared.destinationOperationId).toBe('destination-child');
      expect(published.filter((event) => event === 'prepared')).toHaveLength(1);
      expect(fixture.requests).toEqual([]);
    });

    for (const prerequisite of ['trust', 'NUT-09', 'NUT-20', 'BOLT11'] as const) {
      it(`rejects a destination lacking ${prerequisite} before creating remote quotes`, async () => {
        const mint = await fixture.repositories.mintRepository.getMintByUrl(destinationUrl);
        const nuts = { ...mint!.mintInfo!.nuts };
        if (prerequisite === 'NUT-09') nuts['9'] = { supported: false };
        if (prerequisite === 'NUT-20') nuts['20'] = { supported: false };
        if (prerequisite === 'BOLT11') nuts['4'] = { disabled: true, methods: [] };
        await fixture.repositories.mintRepository.addOrUpdateMint({
          ...mint!,
          trusted: prerequisite !== 'trust',
          mintInfo: { ...mint!.mintInfo!, nuts },
        });
        await expect(fixture.service().prepare(fixture.parent)).rejects.toThrow();
        expect(fixture.requests).toEqual([]);
        expect(await fixture.repositories.mintSwap!.operationRepository.getById('swap')).toBeNull();
      });
    }

    it('includes input fees in debit bounds and rejects an unaffordable cap before reserving value', async () => {
      await setup(16, 8);
      const keyset = await fixture.repositories.keysetRepository.getKeysetById(sourceUrl, keys.id);
      await fixture.repositories.keysetRepository.updateKeyset({ ...keyset!, active: false });
      const feeKeysetId = testMintKeysetId('sat', { input_fee_ppk: 1_000 });
      await fixture.repositories.keysetRepository.addKeyset({
        ...keyset!,
        id: feeKeysetId,
        feePpk: 1_000,
      });
      await fixture.repositories.proofRepository.setProofState(sourceUrl, ['original'], 'spent');
      await fixture.repositories.proofRepository.saveProofs(sourceUrl, [
        {
          id: feeKeysetId,
          mintUrl: sourceUrl,
          unit: 'sat',
          state: 'ready',
          amount: Amount.from(16),
          secret: 'fee-input',
          C: keys.keys['1'],
        },
      ]);
      await fixture.create();
      const rejected = await fixture.service().prepare(fixture.parent);
      expect(rejected.state).toBe('failed');
      expect(rejected.failure?.code).toBe('source_debit_cap_exceeded');
      expect(await fixture.repositories.meltOperationRepository.getById('source-child')).toBeNull();
      expect(
        await fixture.repositories.mintOperationRepository.getById('destination-child'),
      ).toBeNull();
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'fee-input'))
          ?.usedByOperationId,
      ).toBeUndefined();
      expect(fixture.requests).toEqual([]);
    });

    it('preserves distinct completed event snapshots when issuance and accounting finish in one action', async () => {
      await fixture.create();
      await fixture.prepare();
      const states: string[] = [];
      fixture.events.on('mint-op:executing', ({ operation }) => {
        states.push(operation.state);
      });
      fixture.events.on('mint-op:finalized', ({ operation }) => {
        states.push(operation.state);
      });
      fixture.setDestinationState('ISSUED');
      expect((await fixture.service().execute('swap')).state).toBe('completed');
      expect(states).toEqual(['executing', 'finalized']);
    });

    for (const phase of ['authorization', 'source settlement', 'destination settlement'] as const) {
      it(`recovers a failed ${phase} commit without replaying a committed remote effect`, async () => {
        await fixture.create();
        await fixture.prepare();
        let fail = true;
        const runner = fixture.dependencies.transactionRunner;
        fixture.dependencies.transactionRunner = {
          run: (work) =>
            runner.run(async (tx) => {
              const result = await work(tx);
              const source = await tx.meltOperations.getById('source-child');
              const destination = await tx.mintOperations.getById('destination-child');
              if (
                fail &&
                ((phase === 'authorization' && source?.state === 'executing') ||
                  (phase === 'source settlement' && source?.state === 'finalized') ||
                  (phase === 'destination settlement' && destination?.state === 'finalized'))
              ) {
                fail = false;
                throw new Error('commit failed');
              }
              return result;
            }),
        };
        const parent = await fixture.service().execute('swap');
        if (phase === 'authorization') {
          expect(parent.state).toBe('prepared');
          expect(fixture.requests).toEqual([]);
          expect(
            (await fixture.repositories.meltOperationRepository.getById('source-child'))?.state,
          ).toBe('prepared');
          expect(
            (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
              ?.state,
          ).toBe('ready');
          await fixture.service().execute('swap');
        } else if (phase === 'source settlement') {
          expect(parent.state).toBe('source_pending');
          expect(
            (await fixture.repositories.meltOperationRepository.getById('source-child'))?.state,
          ).toBe('executing');
          expect(
            (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
              ?.state,
          ).toBe('inflight');
          expect(
            (
              await fixture.repositories.meltQuoteRepository.getMeltQuote(
                sourceUrl,
                'bolt11',
                'source-quote',
              )
            )?.state,
          ).toBe('PAID');
        } else {
          expect(parent.state).toBe('destination_pending');
          expect(
            (await fixture.repositories.mintOperationRepository.getById('destination-child'))
              ?.state,
          ).toBe('executing');
          expect(
            await fixture.repositories.proofRepository.getProofsByOperationId(
              destinationUrl,
              'destination-child',
            ),
          ).toHaveLength(0);
        }
        fixture.setDestinationState('ISSUED');
        expect((await fixture.service().reconcile('swap')).state).toBe('completed');
        expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
        expect(fixture.requests.filter((request) => request === 'mint').length).toBeLessThanOrEqual(
          1,
        );
      });
    }

    it('retries the whole preparation atomically and publishes only the committed allocation', async () => {
      await fixture.create();
      const repositories = fixture.repositories;
      let attempts = 0;
      const allocations: number[] = [];
      fixture.events.on('counter:updated', (event) => {
        allocations.push(event.counter);
      });
      fixture.dependencies.transactionRunner = new RepositoryCoreTransactionRunner(
        overrideTransactions(repositories, (work) =>
          repositories.withTransaction(async (scope) => {
            const result = await work(scope);
            if (
              (await scope.mintSwap!.operationRepository.getById('swap'))?.state === 'prepared' &&
              ++attempts === 1
            )
              throw new RepositoryTransactionConflictError('retry preparation');
            return result;
          }),
        ),
      );
      expect((await fixture.service().prepare(fixture.parent)).state).toBe('prepared');
      expect(attempts).toBe(2);
      const counter = await repositories.counterRepository.getCounter(destinationUrl, keys.id);
      expect(allocations).toEqual([counter!.counter]);
      expect(counter!.counter).toBe(1);
      expect(fixture.requests).toEqual([]);
    });

    it('publishes committed snapshots after releasing parent and child locks, allowing reentrant recovery', async () => {
      await fixture.create();
      const service = fixture.service();
      const observed: Array<{
        state?: string;
        active: boolean;
        locked: boolean;
        reentered?: string;
      }> = [];
      fixture.events.on('mint-op:pending', async () => {
        const snapshot = {
          state: (await fixture.repositories.mintSwap!.operationRepository.getById('swap'))?.state,
          active: fixture.transactionActive,
          locked:
            fixture.dependencies.sourceOperationLock.isLocked('source-child') ||
            fixture.dependencies.destinationOperationLock.isLocked('destination-child'),
          reentered: (await service.reconcile('swap')).state,
        };
        observed.push(snapshot);
      });
      await service.prepare(fixture.parent);
      expect(observed).toEqual([
        { state: 'prepared', active: false, locked: false, reentered: 'prepared' },
      ]);
      expect(fixture.requests).toEqual([]);
    });

    it('serializes cancellation racing a paid source response and continues destination recovery', async () => {
      await fixture.create();
      await fixture.prepare();
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const melt = fixture.dependencies.meltHandlerProvider.get('bolt11').melt;
      fixture.dependencies.meltHandlerProvider.get('bolt11').melt = async (context) => {
        entered();
        await blocked;
        return melt(context);
      };
      const service = fixture.service();
      const executing = service.execute('swap');
      await started;
      const cancelling = service.cancel('swap');
      release();
      await executing;
      expect((await cancelling).state).toBe('destination_pending');
      fixture.setDestinationState('ISSUED');
      expect((await service.reconcile('swap')).state).toBe('completed');
      expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
    });

    it('keeps remote error payloads out of persisted retry evidence and leaves terminal work quiescent', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.dependencies.meltHandlerProvider.get('bolt11').melt = async () => {
        throw new Error('sensitive remote payload');
      };
      const pending = await fixture.service().execute('swap');
      expect(pending.retry.lastError?.code).toBe('source_outcome_unknown');
      expect(JSON.stringify(pending)).not.toContain('sensitive remote payload');
      fixture.setSourceState('UNPAID');
      const failed = await fixture.service().reconcile('swap');
      expect(failed.state).toBe('failed');
      fixture.requests.length = 0;
      const service = fixture.service();
      await service.execute('swap');
      await service.cancel('swap');
      await service.reconcile('swap');
      await service.recoverActive();
      await service.recoverDue();
      expect(fixture.requests).toEqual([]);
      expect(
        (await fixture.repositories.mintSwap!.operationRepository.getById('swap'))?.revision,
      ).toBe(failed.revision);
    });

    if (options.supportsReopen) {
      for (const outcome of ['PAID', 'UNPAID'] as const) {
        it(`recovers persisted PENDING and cancellation after closing the store with later ${outcome}`, async () => {
          await fixture.create();
          await fixture.prepare();
          fixture.setSourceState('PENDING');
          await fixture.service().execute('swap');
          await fixture.service().cancel('swap');
          const before = await fixture.repositories.mintSwap!.operationRepository.getById('swap');
          const reopened = await store!.reopen!();
          fixture = await mintSwapFixture(reopened, { initialize: false });
          expect((await reopened.mintSwap!.operationRepository.getById('swap'))?.revision).toBe(
            before!.revision,
          );
          fixture.setTime(20_000);
          fixture.setSourceState(outcome);
          fixture.setDestinationState('ISSUED');
          const parent = await fixture.service().reconcile('swap');
          expect(parent.state).toBe(outcome === 'PAID' ? 'completed' : 'cancelled');
          expect(parent.cancellationRequestedAt).toBe(before!.cancellationRequestedAt);
          expect(fixture.requests).not.toContain('melt');
          expect(
            (await reopened.proofRepository.getProofBySecret(sourceUrl, 'original'))?.state,
          ).toBe(outcome === 'PAID' ? 'spent' : 'ready');
        });
      }
      it('restores exact destination outputs after closing the store with a lost issuance response', async () => {
        await fixture.create();
        await fixture.prepare();
        let secrets: string[] = [];
        fixture.dependencies.mintHandlerProvider.get('bolt11').execute = async ({ operation }) => {
          secrets = outputProofs(operation.outputData).map((proof) => proof.secret);
          throw new Error('lost issuance response');
        };
        await fixture.service().execute('swap');
        const reopened = await store!.reopen!();
        fixture = await mintSwapFixture(reopened, { initialize: false });
        fixture.setTime(20_000);
        fixture.setDestinationState('ISSUED');
        expect((await fixture.service().reconcile('swap')).state).toBe('completed');
        expect(fixture.requests).toEqual(['observe-destination', 'recover-mint']);
        expect(
          await reopened.proofRepository.getProofsBySecrets(destinationUrl, secrets),
        ).toHaveLength(secrets.length);
      });
    }

    it('accounts for a pre-swap keep amount and cryptographically unblinded nonzero Melt change', async () => {
      await setup(16);
      const generated = createNewMintKeys(5, new Uint8Array(32).fill(7));
      const generatedKeys = serializeMintKeys(generated.pubKeys);
      const old = await fixture.repositories.keysetRepository.getKeysetById(sourceUrl, keys.id);
      await fixture.repositories.keysetRepository.updateKeyset({ ...old!, active: false });
      await fixture.repositories.keysetRepository.addKeyset({
        mintUrl: sourceUrl,
        id: generated.keysetId,
        keypairs: generatedKeys,
        active: true,
        unit: 'sat',
        feePpk: 0,
      });
      await fixture.repositories.proofRepository.setProofState(sourceUrl, ['original'], 'spent');
      await fixture.repositories.proofRepository.saveProofs(sourceUrl, [
        {
          mintUrl: sourceUrl,
          id: generated.keysetId,
          amount: Amount.from(16),
          unit: 'sat',
          state: 'ready',
          secret: 'generated-original',
          C: generatedKeys['1']!,
        },
      ]);
      const quote = await fixture.saveSource('UNPAID');
      await fixture.repositories.meltQuoteRepository.upsertMeltQuote({
        ...quote,
        fee_reserve: Amount.from(4),
      });
      await fixture.create();
      const prepared = await fixture.service().prepare(fixture.parent);
      expect(prepared.sourceDebitBounds?.minimum.equals(Amount.from(8))).toBe(true);
      expect(prepared.sourceDebitBounds?.maximum.equals(Amount.from(12))).toBe(true);
      let changeSecret = '';
      fixture.dependencies.meltHandlerProvider.get('bolt11').melt = async ({ operation }) => {
        const output = deserializeOutputData(operation.changeOutputData).keep[0]!;
        changeSecret = new TextDecoder().decode(output.secret);
        const signature = createBlindSignature(
          pointFromHex(output.blindedMessage.B_),
          generated.privKeys['2']!,
          generated.keysetId,
        );
        return {
          status: 'PAID',
          change: [
            { id: generated.keysetId, amount: Amount.from(2), C_: signature.C_.toHex(true) },
          ],
        };
      };
      const parent = await fixture.service().execute('swap');
      expect(parent.state).toBe('destination_pending');
      expect(parent.sourceSettlement?.reserved.equals(Amount.from(16))).toBe(true);
      expect(parent.sourceSettlement?.returned.equals(Amount.from(6))).toBe(true);
      expect(parent.sourceSettlement?.finalDebit.equals(Amount.from(10))).toBe(true);
      expect(parent.sourceSettlement?.totalFee.equals(Amount.from(2))).toBe(true);
      const change = await fixture.repositories.proofRepository.getProofBySecret(
        sourceUrl,
        changeSecret,
      );
      expect(change?.amount.equals(Amount.from(2))).toBe(true);
      expect(change?.state).toBe('ready');
      expect(change?.createdByOperationId).toBe('source-child');
    });

    it('retains paid-source recovery material when the mint returns more change signatures than allocated', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.dependencies.meltHandlerProvider.get('bolt11').melt = async () => ({
        status: 'PAID',
        change: [{ id: keys.id, amount: Amount.from(1), C_: keys.keys['1']! }],
      });
      expect((await fixture.service().execute('swap')).state).toBe('source_pending');
      expect(
        (
          await fixture.repositories.meltQuoteRepository.getMeltQuote(
            sourceUrl,
            'bolt11',
            'source-quote',
          )
        )?.state,
      ).toBe('PAID');
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))?.state,
      ).toBe('inflight');
      expect((await fixture.service().cancel('swap')).state).toBe('source_pending');
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBe('source-child');
    });

    it('creates locked quote identities, prepares atomically, and never pays during prepare', async () => {
      const service = fixture.service();
      const result = await service.prepare(fixture.parent);
      expect(result.state).toBe('prepared');
      expect(fixture.requests).toEqual(['allocate-key', 'destination-quote', 'source-quote']);
      const repeat = await service.prepare({ ...fixture.parent, sourceMintUrl: sourceUrl + '/' });
      expect(repeat.id).toBe(result.id);
      expect(repeat.sourceOperationId).toBe(result.sourceOperationId);
      expect(fixture.requests).toHaveLength(3);
    });

    it('serializes concurrent same-ID preparations without creating more quotes or children', async () => {
      const service = fixture.service();
      const [first, second] = await Promise.all([
        service.prepare(fixture.parent),
        service.prepare(fixture.parent),
      ]);
      expect(first.sourceOperationId).toBe(second.sourceOperationId);
      expect(fixture.requests).toEqual(['allocate-key', 'destination-quote', 'source-quote']);
    });

    it('rejects the conservative debit cap without retaining either child or reservations', async () => {
      await setup(9, 8);
      const quote = await fixture.saveSource('UNPAID');
      await fixture.repositories.meltQuoteRepository.upsertMeltQuote({
        ...quote,
        fee_reserve: Amount.from(1),
      });
      await fixture.create();
      const result = await fixture.service().prepare(fixture.parent);
      expect(result.state).toBe('failed');
      expect(result.failure?.code).toBe('source_debit_cap_exceeded');
      expect(await fixture.repositories.meltOperationRepository.getById('source-child')).toBeNull();
      expect(
        await fixture.repositories.mintOperationRepository.getById('destination-child'),
      ).toBeNull();
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBeUndefined();
    });

    it('does not replay unchanged child events when preparation is resumed', async () => {
      const events: string[] = [];
      fixture.events.on('melt-op:prepared', () => {
        events.push('source');
      });
      fixture.events.on('mint-op:pending', () => {
        events.push('destination');
      });
      fixture.events.on('proofs:reserved', () => {
        events.push('reserved');
      });
      fixture.events.on('counter:updated', () => {
        events.push('counter');
      });
      const service = fixture.service();
      await service.prepare(fixture.parent);
      const initial = [...events];
      await service.prepare(fixture.parent);
      expect(events).toEqual(initial);
      expect(events).toContain('reserved');
      expect(events).toContain('counter');
    });

    it('respects Retry-After and schedules a failed recovery only once', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.setSourceState('PENDING');
      await fixture.service().execute('swap');
      fixture.dependencies.quoteLifecycle.refreshMeltQuote = async () => {
        throw new RateLimitError('slow down', 600_000);
      };
      const result = await fixture.service().reconcile('swap');
      expect(result.retry.attemptCount).toBe(1);
      expect(result.retry.nextAttemptAt! - result.updatedAt).toBeGreaterThan(590_000);
    });

    for (const waitingFor of ['source settlement', 'destination availability'] as const) {
      it(`caps backoff without abandoning value while waiting for ${waitingFor}`, async () => {
        await fixture.create();
        await fixture.prepare();
        const refreshDestination = fixture.dependencies.quoteLifecycle.refreshMintQuote;
        if (waitingFor === 'source settlement') fixture.setSourceState('PENDING');
        else
          fixture.dependencies.quoteLifecycle.refreshMintQuote = async () => {
            throw new Error('offline');
          };
        const service = fixture.service();
        let parent = await service.execute('swap');
        const firstCount = parent.retry.attemptCount;
        for (let attempt = 0; attempt < 20; attempt++) {
          fixture.setTime(parent.retry.nextAttemptAt ?? parent.updatedAt);
          parent = await service.reconcile('swap');
        }
        expect(parent.state).toBe(
          waitingFor === 'source settlement' ? 'source_pending' : 'destination_funded',
        );
        expect(parent.retry.attemptCount).toBe(firstCount + 20);
        // Fixed 0.5 entropy samples half the capped waiting (5 min) or transient (30 s) window.
        expect(parent.retry.nextAttemptAt! - parent.retry.lastAttemptAt!).toBe(
          waitingFor === 'source settlement' ? 150_000 : 15_000,
        );
        expect(
          (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
            ?.state,
        ).toBe(waitingFor === 'source settlement' ? 'inflight' : 'spent');
        fixture.dependencies.quoteLifecycle.refreshMintQuote = refreshDestination;
        fixture.setSourceState('PAID');
        fixture.setDestinationState('ISSUED');
        expect((await service.reconcile('swap')).state).toBe('completed');
        expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
      });
    }

    it('rechecks due time after a stale scan has already been rescheduled', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.setSourceState('PENDING');
      await fixture.service().execute('swap');
      const stale = await fixture.repositories.mintSwap!.operationRepository.getById('swap');
      await fixture.service().reconcile('swap');
      fixture.dependencies.parentQueries = {
        ...fixture.dependencies.parentQueries,
        getById: (id) => fixture.repositories.mintSwap!.operationRepository.getById(id),
        listActive: () => fixture.repositories.mintSwap!.operationRepository.listActive(),
        listDue: async () => [stale!],
      };
      fixture.requests.length = 0;
      await fixture.service().recoverDue();
      expect(fixture.requests).toEqual([]);
    });

    it('settles both legs, waits for canonical accounting, and finishes after restart', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.events.on('mint-op:finalized', () => {
        expect(fixture.transactionActive).toBe(false);
        throw new Error('listener failed');
      });
      const service = fixture.service();
      expect((await service.execute('swap')).state).toBe('destination_pending');
      expect(fixture.requests).toEqual(['melt', 'record-source', 'observe-destination', 'mint']);
      fixture.setDestinationState('ISSUED');
      expect((await fixture.service().reconcile('swap')).state).toBe('completed');
      expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
      expect(fixture.requests.filter((request) => request === 'mint')).toHaveLength(1);
    });

    it('does not automatically dispatch a prepared source on startup', async () => {
      await fixture.create();
      await fixture.prepare();
      await fixture.service().recoverActive();
      expect(fixture.requests).toEqual([]);
      expect(
        (await fixture.repositories.mintSwap!.operationRepository.getById('swap'))?.state,
      ).toBe('prepared');
    });

    it('observes after a crash immediately following authorization without redispatch', async () => {
      await fixture.create();
      await fixture.prepare();
      await fixture.runner.run((tx) =>
        tx.perform(beginMintSwapSource, { ...fixture.preparation, now: 1_001 }),
      );
      fixture.setSourceState('UNPAID');
      fixture.setTime(2_000);
      const parent = await fixture.service().reconcile('swap');
      expect(parent.state).toBe('failed');
      expect(fixture.requests).toEqual(['observe-source']);
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBeUndefined();
    });

    it('retains ownership on a lost source response and adopts later PAID without another payment', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.dependencies.meltHandlerProvider.get('bolt11').melt = async () => {
        fixture.requests.push('lost-melt');
        throw new Error('timeout');
      };
      expect((await fixture.service().execute('swap')).state).toBe('source_pending');
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))?.state,
      ).toBe('inflight');
      expect((await fixture.service().reconcile('swap')).state).toBe('destination_pending');
      expect(fixture.requests.filter((request) => request === 'lost-melt')).toHaveLength(1);
      expect(fixture.requests).toContain('observe-source');
    });

    it('leaves PENDING recoverable with a cancellation request, then cancels on fresh UNPAID', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.setSourceState('PENDING');
      const service = fixture.service();
      expect((await service.execute('swap')).state).toBe('source_pending');
      const requested = await service.cancel('swap');
      expect(requested.cancellationRequestedAt).toBeDefined();
      expect(requested.state).toBe('source_pending');
      fixture.setSourceState('UNPAID');
      expect((await fixture.service().reconcile('swap')).state).toBe('cancelled');
      expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
    });

    it('does not cancel PAID value even when cancellation was requested while pending', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.setSourceState('PENDING');
      const service = fixture.service();
      await service.execute('swap');
      await service.cancel('swap');
      fixture.setSourceState('PAID');
      const recovered = await fixture.service().reconcile('swap');
      expect(recovered.state).toBe('destination_pending');
      expect(recovered.cancellationRequestedAt).toBeDefined();
    });

    it('requires the pre-swap checkpoint before payment and derives debit from keep plus change', async () => {
      await setup(16);
      await fixture.create();
      await fixture.prepare();
      const handler = fixture.dependencies.meltHandlerProvider.get('bolt11');
      const melt = handler.melt;
      handler.melt = async (context) => {
        const stored = await fixture.repositories.proofRepository.getProofsBySecrets(
          sourceUrl,
          context.inputProofs.map((proof) => proof.secret),
        );
        expect(stored).toHaveLength(context.inputProofs.length);
        expect(
          stored.every(
            (proof) => proof.state === 'inflight' && proof.usedByOperationId === 'source-child',
          ),
        ).toBe(true);
        return melt(context);
      };
      const parent = await fixture.service().execute('swap');
      expect(parent.state).toBe('destination_pending');
      expect(parent.sourceSettlement?.reserved.equals(Amount.from(16))).toBe(true);
      expect(parent.sourceSettlement?.returned.equals(Amount.from(8))).toBe(true);
      expect(parent.sourceSettlement?.finalDebit.equals(Amount.from(8))).toBe(true);
      expect(fixture.requests.slice(0, 2)).toEqual(['swap', 'melt']);
    });

    it('releases an unsubmitted pre-swap only after checking originals are remotely unspent', async () => {
      await setup(16);
      await fixture.create();
      await fixture.prepare();
      fixture.dependencies.meltHandlerProvider.get('bolt11').swap = async () => {
        fixture.requests.push('lost-swap');
        throw new Error('timeout');
      };
      await fixture.service().execute('swap');
      fixture.setSourceState('UNPAID');
      const parent = await fixture.service().reconcile('swap');
      expect(parent.state).toBe('failed');
      expect(fixture.requests).toEqual(['lost-swap', 'observe-source']);
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBeUndefined();
    });

    it('restores the exact pre-swap after checkpoint rollback; incomplete restore retains ownership', async () => {
      await setup(16);
      const generated = createNewMintKeys(5, new Uint8Array(32).fill(7));
      const generatedKeys = serializeMintKeys(generated.pubKeys);
      const old = await fixture.repositories.keysetRepository.getKeysetById(sourceUrl, keys.id);
      await fixture.repositories.keysetRepository.updateKeyset({ ...old!, active: false });
      await fixture.repositories.keysetRepository.addKeyset({
        mintUrl: sourceUrl,
        id: generated.keysetId,
        keypairs: generatedKeys,
        active: true,
        unit: 'sat',
        feePpk: 0,
      });
      await fixture.repositories.proofRepository.setProofState(sourceUrl, ['original'], 'spent');
      await fixture.repositories.proofRepository.saveProofs(sourceUrl, [
        {
          mintUrl: sourceUrl,
          id: generated.keysetId,
          amount: Amount.from(16),
          unit: 'sat',
          state: 'ready',
          secret: 'generated-original',
          C: generatedKeys['1']!,
        },
      ]);
      await fixture.create();
      await fixture.service().prepare(fixture.parent);
      let rejectCheckpoint = true;
      const realRunner = fixture.dependencies.transactionRunner;
      fixture.dependencies.transactionRunner = {
        run: (work) =>
          realRunner.run(async (tx) => {
            const result = await work(tx);
            const proofs = await tx.proofs.getProofsByOperationId(sourceUrl, 'source-child');
            if (
              rejectCheckpoint &&
              proofs.some((proof) => proof.createdByOperationId === 'source-child')
            ) {
              rejectCheckpoint = false;
              throw new Error('checkpoint commit failed');
            }
            return result;
          }),
      };
      expect((await fixture.service().execute('swap')).state).toBe('source_pending');
      expect(fixture.requests).toEqual(['swap']);
      let complete = false;
      const getWallet = fixture.dependencies.walletService.getWalletWithActiveKeysetId;
      fixture.dependencies.walletService.getWalletWithActiveKeysetId = async (...args) => {
        const original = await getWallet(...args);
        const wallet = {
          checkProofsStates: async (proofs: Array<{ secret: string }>) =>
            proofs.map((proof) => ({
              state: proof.secret === 'generated-original' ? 'SPENT' : 'UNSPENT',
            })),
          mint: {
            restore: async ({
              outputs,
            }: {
              outputs: Array<{ id: string; amount: Amount; B_: string }>;
            }) => {
              if (!complete) return { outputs: [], signatures: [] };
              return {
                outputs,
                signatures: outputs.map((output) => {
                  const signature = createBlindSignature(
                    pointFromHex(output.B_),
                    generated.privKeys[output.amount.toString()]!,
                    generated.keysetId,
                  );
                  return {
                    id: generated.keysetId,
                    amount: output.amount,
                    C_: signature.C_.toHex(true),
                  };
                }),
              };
            },
          },
        } as unknown as Wallet;
        return { ...original, wallet };
      };
      fixture.setSourceState('UNPAID');
      expect((await fixture.service().reconcile('swap')).state).toBe('source_pending');
      expect(
        (
          await fixture.repositories.proofRepository.getProofBySecret(
            sourceUrl,
            'generated-original',
          )
        )?.usedByOperationId,
      ).toBe('source-child');
      complete = true;
      expect((await fixture.service().reconcile('swap')).state).toBe('failed');
      expect(
        (
          await fixture.repositories.proofRepository.getProofBySecret(
            sourceUrl,
            'generated-original',
          )
        )?.state,
      ).toBe('spent');
      expect(fixture.requests).not.toContain('melt');
      const created = (
        await fixture.repositories.proofRepository.getProofsByOperationId(sourceUrl, 'source-child')
      ).filter((proof) => proof.createdByOperationId === 'source-child');
      expect(Amount.sum(created.map((proof) => proof.amount)).equals(Amount.from(16))).toBe(true);
      expect(created.every((proof) => proof.state === 'ready' && !proof.usedByOperationId)).toBe(
        true,
      );
    });

    it('destination outages retain funded value and never reverse a paid source', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.dependencies.quoteLifecycle.refreshMintQuote = async () => {
        throw new Error('offline');
      };
      const parent = await fixture.service().execute('swap');
      expect(parent.state).toBe('destination_funded');
      expect(parent.retry.attemptCount).toBe(1);
      expect((await fixture.service().cancel('swap')).state).toBe('destination_funded');
    });

    it('recovers a lost issuance response through the child handler without replacing outputs', async () => {
      await fixture.create();
      await fixture.prepare();
      let originalSecrets: string[] = [];
      fixture.dependencies.mintHandlerProvider.get('bolt11').execute = async ({ operation }) => {
        originalSecrets = outputProofs(operation.outputData).map((proof) => proof.secret);
        throw new Error('response lost');
      };
      expect((await fixture.service().execute('swap')).state).toBe('destination_pending');
      fixture.setDestinationState('ISSUED');
      expect((await fixture.service().reconcile('swap')).state).toBe('completed');
      expect(
        await fixture.repositories.proofRepository.getProofsBySecrets(
          destinationUrl,
          originalSecrets,
        ),
      ).toHaveLength(originalSecrets.length);
      expect(fixture.requests).toContain('recover-mint');
    });

    it('rejects output rotation before funding and releases reserved inputs', async () => {
      await fixture.create();
      await fixture.prepare();
      const source = await fixture.repositories.keysetRepository.getKeysetById(sourceUrl, keys.id);
      await fixture.repositories.keysetRepository.updateKeyset({ ...source!, active: false });
      const parent = await fixture.service().execute('swap');
      expect(parent.state).toBe('failed');
      expect(fixture.requests).not.toContain('melt');
      expect(
        (await fixture.repositories.proofRepository.getProofBySecret(sourceUrl, 'original'))
          ?.usedByOperationId,
      ).toBeUndefined();
    });

    it('shares the child lock with ordinary services during source dispatch', async () => {
      await fixture.create();
      await fixture.prepare();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const original = fixture.dependencies.meltHandlerProvider.get('bolt11').melt;
      fixture.dependencies.meltHandlerProvider.get('bolt11').melt = async (context) => {
        entered();
        await blocked;
        return original(context);
      };
      const execution = fixture.service().execute('swap');
      await started;
      expect(fixture.dependencies.sourceOperationLock.isLocked('source-child')).toBe(true);
      const getQuote = async (identity: { mintUrl: string; quoteId: string }) => {
        const quote = await fixture.repositories.meltQuoteRepository.getMeltQuoteById(identity);
        if (!quote) throw new Error('Missing fixture quote');
        return quote;
      };
      const childService = new MeltOperationService({
        handlerProvider: fixture.dependencies.meltHandlerProvider,
        meltOperationQueries: fixture.repositories.meltOperationRepository,
        proofQueries: fixture.repositories.proofRepository,
        transactionRunner: fixture.dependencies.transactionRunner,
        loadSeed: fixture.dependencies.loadSeed,
        quoteLifecycle: {
          ...fixture.dependencies.quoteLifecycle,
          requireMeltQuoteRefForPrepare: getQuote,
          getMeltQuoteById: (identity) =>
            fixture.repositories.meltQuoteRepository.getMeltQuoteById(identity),
          refreshMeltQuoteById: getQuote,
        },
        mintService: fixture.dependencies.mintService,
        walletService: fixture.dependencies.walletService,
        mintAdapter: fixture.dependencies.mintAdapter,
        eventBus: fixture.events,
        operationIdLock: fixture.dependencies.sourceOperationLock,
        mintScopedLock: fixture.dependencies.mintScopedLock,
      });
      expect(childService.isOperationLocked('source-child')).toBe(true);
      const childExecution = childService.execute('source-child');
      await expect(
        fixture.dependencies.sourceOperationLock.acquire('source-child'),
      ).rejects.toThrow();
      release();
      await execution;
      expect((await childExecution).state).toBe('finalized');
      expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
      expect(fixture.dependencies.sourceOperationLock.isLocked('source-child')).toBe(false);
    });

    it('treats expiry as a payment deadline while retaining funded destination recovery', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.setDestinationState('UNPAID');
      expect((await fixture.service().execute('swap')).state).toBe('destination_funded');
      fixture.setTime(200_000_000);
      fixture.setDestinationState('PAID');
      expect((await fixture.service().reconcile('swap')).state).toBe('destination_pending');
      expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
    });

    it('pauses recovery when trust is revoked and never silently restores trust', async () => {
      await fixture.create();
      await fixture.prepare();
      fixture.setSourceState('PENDING');
      await fixture.service().execute('swap');
      const mint = await fixture.repositories.mintRepository.getMintByUrl(sourceUrl);
      await fixture.repositories.mintRepository.addOrUpdateMint({ ...mint, trusted: false });
      fixture.requests.length = 0;
      expect((await fixture.service().reconcile('swap')).state).toBe('source_pending');
      expect(fixture.requests).toEqual([]);
      expect(await fixture.repositories.mintRepository.isTrustedMint(sourceUrl)).toBe(false);
    });
  });
}
