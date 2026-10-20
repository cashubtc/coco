import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Amount } from '@cashu/cashu-ts';
import { prepareSend } from '../../operations/send/SendTransitions.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { createSendOperation } from '../../operations/send/SendOperation.ts';
import type { PreparedSendOperation } from '../../operations/send/SendOperation.ts';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import type {
  PrepareSendInput,
  PrepareSendResult,
} from '../../operations/send/SendTransitionTypes.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';
const keysetId = testMintKeysetId();
const activeKeys = { id: keysetId, unit: 'sat', keys: testMintKeypairs };
const callerId = 'send:cmd-1';
const allSecrets = ['proof-1', 'proof-2'];

/**
 * Two independent connections (a real file database, not `:memory:`) preparing the same
 * caller-supplied operation ID at the same time.
 *
 * The create-or-join read lives inside the `prepareSend` transaction, so neither writer can act on
 * a stale decision: exactly one of them creates the operation and reserves proofs. The other either
 * observes the committed row and joins, or loses the SQLite write lock and surfaces the existing
 * retryable conflict — SQLite refuses to upgrade a read snapshot to a write while another writer
 * holds the lock, and `busy_timeout` does not cover that case. What must never happen is two
 * created operations, two persisted rows, or a proof reserved twice; and the loser's next attempt
 * must join rather than reserve again.
 */
describe('Send transitions create-or-join on SQLite', () => {
  it('never creates twice under two concurrent writers and joins the loser on its next attempt', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'coco-join-sqlite-'));
    const databaseA = new Database(path.join(dir, 'coco.sqlite'));
    const databaseB = new Database(path.join(dir, 'coco.sqlite'));
    try {
      const repositoriesA = new SqlStorageRepositories({
        database: new SqliteDb({ database: databaseA }),
      });
      const repositoriesB = new SqlStorageRepositories({
        database: new SqliteDb({ database: databaseB }),
      });
      await repositoriesA.init();
      await repositoriesB.init();

      await repositoriesA.mintRepository.addNewMint({
        mintUrl,
        name: 'Test Mint',
        trusted: true,
        mintInfo: testMintInfo,
        createdAt: 1,
        updatedAt: 1,
      });
      await repositoriesA.keysetRepository.addKeyset({
        mintUrl,
        id: keysetId,
        unit: 'sat',
        keypairs: testMintKeypairs,
        active: true,
        feePpk: 0,
      });
      await repositoriesA.proofRepository.saveProofs(
        mintUrl,
        allSecrets.map((secret) => ({
          id: keysetId,
          secret,
          amount: Amount.from(10),
          C: `C-${secret}`,
          mintUrl,
          unit: 'sat',
          state: 'ready' as const,
        })),
      );

      const runnerA = new RepositoryCoreTransactionRunner(repositoriesA);
      const runnerB = new RepositoryCoreTransactionRunner(repositoriesB);

      const inputFor = (delta: number, seedByte: number): PrepareSendInput => ({
        operation: {
          ...createSendOperation(
            callerId,
            mintUrl,
            { amount: Amount.from(10), unit: 'sat' },
            { method: 'default' as const, methodData: {} },
          ),
          createdAt: 100 + delta,
          updatedAt: 200 + delta,
        },
        activeKeys,
        seed: new Uint8Array(32).fill(seedByte),
        forceSwap: false,
        joinable: true,
      });

      const settled = await Promise.allSettled([
        runnerA.run((tx) => tx.perform(prepareSend, inputFor(0, 1))),
        runnerB.run((tx) => tx.perform(prepareSend, inputFor(200, 2))),
      ]);
      const fulfilled = settled.filter(
        (result): result is PromiseFulfilledResult<PrepareSendResult> =>
          result.status === 'fulfilled',
      );
      const created = fulfilled.filter((result) => result.value.outcome === 'created');
      const joinedInline = fulfilled.filter((result) => result.value.outcome === 'joined');
      const rejected = settled.filter((result) => result.status === 'rejected');

      // Both writers can never believe they created the operation.
      expect(created).toHaveLength(1);
      expect(joinedInline.length + rejected.length).toBe(1);
      // A loser that could not join inline must have failed retryably, never with a silent
      // second create and never with an unrelated error. The class is checked by name because
      // this test mixes source imports with the adapter's built entry point, which yields two
      // distinct class identities for the same error.
      for (const failure of rejected) {
        if (failure.status !== 'rejected') continue;
        expect(failure.reason?.constructor?.name).toBe('RepositoryTransactionConflictError');
        expect(failure.reason?.cause?.code).toBe('SQLITE_BUSY');
      }

      const [createdResult] = created;
      expect(createdResult).toBeDefined();
      const createdOperation = createdResult!.value.operation;

      const row = (await repositoriesA.sendOperationRepository.getById(
        callerId,
      )) as PreparedSendOperation | null;
      expect(row?.id).toBe(callerId);
      expect(row?.state).toBe('prepared');
      expect(row?.inputProofSecrets).toEqual(createdOperation.inputProofSecrets);

      const availableAfterRace = await repositoriesA.proofRepository.getAvailableProofs(mintUrl, {
        unit: 'sat',
      });
      // Exactly one proof was reserved, it is the one the created operation claims, and the
      // loser reserved nothing even though it failed.
      expect(createdOperation.inputProofSecrets).toHaveLength(1);
      expect(availableAfterRace).toHaveLength(1);
      expect(availableAfterRace.every((proof) => allSecrets.includes(proof.secret))).toBe(true);
      expect(availableAfterRace.map((proof) => proof.secret)).not.toContain(
        createdOperation.inputProofSecrets[0],
      );

      // The loser's next attempt sees the committed row and joins it: same operation, no new
      // reservation, no second row.
      const nextAttempt = await runnerB.run((tx) => tx.perform(prepareSend, inputFor(400, 3)));
      expect(nextAttempt.outcome).toBe('joined');
      expect(nextAttempt.reservation).toBeNull();
      expect(nextAttempt.operation.id).toBe(callerId);
      expect(nextAttempt.operation.inputProofSecrets).toEqual(createdOperation.inputProofSecrets);

      const rows = await repositoriesA.sendOperationRepository.getByState('prepared');
      expect(rows).toHaveLength(1);
      const availableAfterJoin = await repositoriesB.proofRepository.getAvailableProofs(mintUrl, {
        unit: 'sat',
      });
      // The join reserved nothing new.
      expect(availableAfterJoin.map((proof) => proof.secret)).toEqual(
        availableAfterRace.map((proof) => proof.secret),
      );
    } finally {
      databaseA.close();
      databaseB.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
