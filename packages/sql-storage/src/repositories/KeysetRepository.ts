import {
  reconcileKeysetKeypairs,
  RepositoryTransactionConflictError,
} from '@cashu/coco-core/internal';
import type { KeysetRepository, Keyset } from '@cashu/coco-core/internal';
import { SqlTransactionConflictError } from '../SqlTransactionConflictError.ts';
import type { SqlDatabase } from '../index.ts';
import { getUnixTimeSeconds } from '../utils.ts';

export class ScopedSqliteKeysetRepository implements KeysetRepository {
  private readonly db: Pick<SqlDatabase, 'all' | 'get' | 'run'>;

  constructor(db: Pick<SqlDatabase, 'all' | 'get' | 'run'>) {
    this.db = db;
  }

  async getKeysetsByMintUrl(mintUrl: string): Promise<Keyset[]> {
    const rows = await this.db.all<{
      mintUrl: string;
      id: string;
      unit: string | null;
      keypairs: string;
      active: number;
      feePpk: number;
      updatedAt: number;
    }>(
      'SELECT mintUrl, id, unit, keypairs, active, feePpk, updatedAt FROM coco_cashu_keysets WHERE mintUrl = ?',
      [mintUrl],
    );
    return rows.map(
      (r) =>
        ({
          mintUrl: r.mintUrl,
          id: r.id,
          unit: r.unit ?? '',
          keypairs: JSON.parse(r.keypairs),
          active: !!r.active,
          feePpk: r.feePpk,
          updatedAt: r.updatedAt,
        }) satisfies Keyset,
    );
  }

  async getKeysetById(mintUrl: string, id: string): Promise<Keyset | null> {
    const row = await this.db.get<{
      mintUrl: string;
      id: string;
      unit: string | null;
      keypairs: string;
      active: number;
      feePpk: number;
      updatedAt: number;
    }>(
      'SELECT mintUrl, id, unit, keypairs, active, feePpk, updatedAt FROM coco_cashu_keysets WHERE mintUrl = ? AND id = ? LIMIT 1',
      [mintUrl, id],
    );
    if (!row) return null;
    return {
      mintUrl: row.mintUrl,
      id: row.id,
      unit: row.unit ?? '',
      keypairs: JSON.parse(row.keypairs),
      active: !!row.active,
      feePpk: row.feePpk,
      updatedAt: row.updatedAt,
    } satisfies Keyset;
  }

  updateKeyset(keyset: Omit<Keyset, 'keypairs' | 'updatedAt'>): Promise<void> {
    return this.addKeyset({ ...keyset, keypairs: {} });
  }

  async addKeyset(keyset: Omit<Keyset, 'updatedAt'>): Promise<void> {
    const now = getUnixTimeSeconds();
    // Reconcile against a snapshot, then update only if that exact snapshot is still current.
    // This compare-and-swap closes the read/upsert race without opening a nested transaction.
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = await this.db.get<{ keypairs: string }>(
        'SELECT keypairs FROM coco_cashu_keysets WHERE mintUrl = ? AND id = ? LIMIT 1',
        [keyset.mintUrl, keyset.id],
      );
      const keypairs = JSON.stringify(
        reconcileKeysetKeypairs(
          keyset.mintUrl,
          keyset.id,
          existing?.keypairs ? JSON.parse(existing.keypairs) : undefined,
          keyset.keypairs ?? {},
        ),
      );
      const result = await this.db.run(
        `INSERT INTO coco_cashu_keysets (mintUrl, id, unit, keypairs, active, feePpk, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mintUrl, id) DO UPDATE SET
           unit=excluded.unit,
           keypairs=excluded.keypairs,
           active=excluded.active,
           feePpk=excluded.feePpk,
           updatedAt=excluded.updatedAt
         WHERE ? IS NOT NULL AND coco_cashu_keysets.keypairs = ?`,
        [
          keyset.mintUrl,
          keyset.id,
          keyset.unit,
          keypairs,
          keyset.active ? 1 : 0,
          keyset.feePpk,
          now,
          existing?.keypairs ?? null,
          existing?.keypairs ?? '',
        ],
      );
      if (result.changes === 1) return;
    }
    throw new RepositoryTransactionConflictError(
      `Keyset ${keyset.id} for mint ${keyset.mintUrl} changed concurrently`,
    );
  }

  async deleteKeyset(mintUrl: string, keysetId: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_keysets WHERE mintUrl = ? AND id = ?', [
      mintUrl,
      keysetId,
    ]);
  }
}

/** Root writes own a transaction; scoped repositories reuse their caller's transaction. */
export class SqliteKeysetRepository extends ScopedSqliteKeysetRepository {
  constructor(private readonly database: SqlDatabase) {
    super(database);
  }

  override async addKeyset(keyset: Omit<Keyset, 'updatedAt'>): Promise<void> {
    try {
      await this.database.transaction(
        (database) => new ScopedSqliteKeysetRepository(database).addKeyset(keyset),
        { mode: 'immediate' },
      );
    } catch (error) {
      if (error instanceof SqlTransactionConflictError) {
        throw new RepositoryTransactionConflictError(undefined, error);
      }
      throw error;
    }
  }
}
