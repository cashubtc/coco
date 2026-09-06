import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';

describe('CoreTransaction with SQLite', () => {
  it('rolls back concurrent allocations when a sibling import fails', async () => {
    const database = new Database(':memory:');
    const repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    await repositories.init();
    const command = await new KeypairDerivation(async () => new Uint8Array(64)).prepare('p2pk');
    const imported = { ...command.derive(100), purpose: 'p2pk' as const };
    database.exec(`
      CREATE TRIGGER reject_import BEFORE INSERT ON coco_cashu_keypairs
      WHEN NEW.publicKey = '${imported.publicKeyHex}'
      BEGIN SELECT RAISE(ABORT, 'import failed'); END;
    `);
    const runner = new RepositoryCoreTransactionRunner(repositories);
    let pending: Promise<unknown>[] = [];

    try {
      await expect(
        runner.run((scope) => {
          pending = [
            ...Array.from({ length: 3 }, () => scope.keypairs.allocate(command)),
            scope.keypairs.importP2pk(imported),
          ];
          return Promise.all(pending);
        }),
      ).rejects.toThrow('import failed');

      await Promise.allSettled(pending);
      expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toHaveLength(0);
      expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBeNull();
      await expect(runner.run((scope) => scope.keypairs.allocate(command))).resolves.toMatchObject({
        derivationIndex: 0,
      });
    } finally {
      await Promise.allSettled(pending);
      database.close();
    }
  });
});
