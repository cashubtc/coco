import type { PreparedReceiveOperation } from '../../operations/receive/ReceiveOperation.ts';
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import {
  createReceiveEnvironment,
  receiveMint,
  receiveKeys,
  receiveToken,
  receivedCoreProofs,
} from '../fixtures/ReceiveEnvironment.ts';

function open(database: Database) {
  return new SqlStorageRepositories({ database: new SqliteDb({ database }) });
}

describe('Receive transactions with SQLite', () => {
  it('rolls back output allocation when operation creation fails', async () => {
    const database = new Database(':memory:');
    try {
      const repositories = open(database);
      await repositories.init();
      const env = await createReceiveEnvironment(repositories);
      const draft = await env.service.init(receiveToken());
      database.exec(
        "CREATE TRIGGER reject_receive BEFORE INSERT ON coco_cashu_receive_operations BEGIN SELECT RAISE(ABORT, 'create failed'); END",
      );
      await expect(env.service.prepare(draft)).rejects.toThrow('create failed');
      expect(await env.service.getOperation(draft.id)).toBeNull();
      expect(await repositories.counterRepository.getCounter(receiveMint, receiveKeys)).toBeNull();
      database.exec('DROP TRIGGER reject_receive');
      expect((await env.service.prepare(draft)).state).toBe('prepared');
    } finally {
      database.close();
    }
  });

  it('rolls back saved proofs and spent-state reconciliation when finalization fails', async () => {
    const database = new Database(':memory:');
    try {
      const repositories = open(database);
      await repositories.init();
      const env = await createReceiveEnvironment(repositories);
      const prepared = await env.prepare();
      const executing = await env.transactions.beginExecution({
        operationId: prepared.id,
        updatedAt: Date.now(),
      });
      const proofs = receivedCoreProofs(executing);
      await repositories.proofRepository.saveProofs(receiveMint, [
        { ...proofs[0]!, usedByOperationId: 'later-send' },
      ]);
      database.exec(
        "CREATE TRIGGER reject_finalized BEFORE UPDATE ON coco_cashu_receive_operations WHEN NEW.state = 'finalized' BEGIN SELECT RAISE(ABORT, 'finalization failed'); END",
      );
      const input = {
        operationId: executing.id,
        updatedAt: Date.now(),
        proofs: proofs.map((proof) => ({ ...proof, state: 'spent' as const })),
      };
      await expect(env.transactions.applyResult(input)).rejects.toThrow('finalization failed');
      const existing = await repositories.proofRepository.getProofsBySecrets(
        receiveMint,
        proofs.map((proof) => proof.secret),
      );
      expect(existing).toHaveLength(1);
      expect(existing[0]?.state).toBe('ready');
      expect(existing[0]?.usedByOperationId).toBe('later-send');
      expect((await env.service.getOperation(executing.id))?.state).toBe('executing');
      database.exec('DROP TRIGGER reject_finalized');
      await env.transactions.applyResult(input);
      expect((await env.service.getOperation(executing.id))?.state).toBe('finalized');
      expect(await repositories.proofRepository.getAvailableProofs(receiveMint)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('allocates unique outputs and conditionally advances operations across independent connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'receive-transactions-'));
    const first = new Database(join(dir, 'wallet.sqlite'));
    const second = new Database(join(dir, 'wallet.sqlite'));
    try {
      const reposA = open(first);
      const reposB = open(second);
      await reposA.init();
      await reposB.init();
      first.exec('PRAGMA busy_timeout = 1');
      second.exec('PRAGMA busy_timeout = 1');
      const envA = await createReceiveEnvironment(reposA);
      const envB = await createReceiveEnvironment(reposB);
      const drafts = await Promise.all([
        envA.service.init(receiveToken()),
        envB.service.init(receiveToken()),
      ]);
      const prepared = await Promise.allSettled([
        envA.service.prepare(drafts[0]),
        envB.service.prepare(drafts[1]),
      ]);
      const operations = [];
      for (const [index, outcome] of prepared.entries()) {
        if (outcome.status === 'fulfilled') operations.push(outcome.value);
        else {
          expect(outcome.reason).toMatchObject({
            name: 'RepositoryTransactionConflictError',
            transient: true,
          });
          const env = index === 0 ? envA : envB;
          expect(await env.service.getOperation(drafts[index]!.id)).toBeNull();
          operations.push(await env.service.prepare(drafts[index]!));
        }
      }
      const [a, b] = operations as [PreparedReceiveOperation, PreparedReceiveOperation];
      const secrets = [a, b].flatMap((operation) =>
        receivedCoreProofs(operation).map((proof) => proof.secret),
      );
      expect(new Set(secrets).size).toBe(secrets.length);
      const results = await Promise.allSettled([
        envA.transactions.beginExecution({ operationId: a.id, updatedAt: Date.now() }),
        envB.transactions.cancel({ operationId: a.id, updatedAt: Date.now(), reason: 'cancelled' }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const after = (await envB.service.getOperation(a.id))!;
      expect(after.revision).toBe(1);
      expect(['executing', 'rolled_back']).toContain(after.state);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
