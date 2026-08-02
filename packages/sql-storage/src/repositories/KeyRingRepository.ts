import { DerivationIndexExhaustedError } from '@cashu/coco-core/adapter';
import type {
  KeyRingAllocationRepository,
  Keypair,
  KeypairPurpose,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase } from '../index.ts';
import { hexToBytes, bytesToHex } from '../utils.ts';

const DEFAULT_KEYPAIR_PURPOSE: KeypairPurpose = 'p2pk';
const MAX_DERIVATION_INDEX = 0x7fffffff;
const MAX_BUSY_RETRIES = 3;

function isSqliteBusy(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return code === 'SQLITE_BUSY' || message.includes('database is locked');
}

function waitForRetry(attempt: number): Promise<void> {
  const runtime = globalThis as typeof globalThis & {
    setTimeout(callback: () => void, milliseconds: number): unknown;
  };
  return new Promise((resolve) => runtime.setTimeout(resolve, attempt * 5));
}

type KeypairRow = {
  publicKey: string;
  secretKey: string;
  derivationIndex: number | null;
  purpose?: KeypairPurpose | null;
};

function rowToKeypair(row: KeypairRow): Keypair {
  return {
    publicKeyHex: row.publicKey,
    secretKey: hexToBytes(row.secretKey),
    derivationIndex: row.derivationIndex ?? undefined,
    purpose: row.purpose ?? DEFAULT_KEYPAIR_PURPOSE,
  };
}

export class SqliteKeyRingRepository implements KeyRingAllocationRepository {
  private readonly db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.db = db;
  }

  async getPersistedKeyPair(publicKey: string, purpose?: KeypairPurpose): Promise<Keypair | null> {
    const row = await this.db.get<KeypairRow>(
      `SELECT publicKey, secretKey, derivationIndex, purpose
       FROM coco_cashu_keypairs
       WHERE publicKey = ? ${purpose ? 'AND purpose = ?' : ''} LIMIT 1`,
      purpose ? [publicKey, purpose] : [publicKey],
    );
    if (!row) return null;

    try {
      return rowToKeypair(row);
    } catch (error) {
      throw new Error(
        `Failed to parse secret key for public key ${publicKey}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  async setPersistedKeyPair(keyPair: Keypair): Promise<void> {
    const secretKeyHex = bytesToHex(keyPair.secretKey);
    const purpose = keyPair.purpose ?? DEFAULT_KEYPAIR_PURPOSE;

    await this.db.run(
      `INSERT INTO coco_cashu_keypairs (publicKey, secretKey, createdAt, derivationIndex, purpose)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(publicKey) DO UPDATE SET
         secretKey=excluded.secretKey,
         derivationIndex=COALESCE(excluded.derivationIndex, coco_cashu_keypairs.derivationIndex),
         purpose=excluded.purpose`,
      [keyPair.publicKeyHex, secretKeyHex, Date.now(), keyPair.derivationIndex ?? null, purpose],
    );
  }

  async deletePersistedKeyPair(publicKey: string, purpose?: KeypairPurpose): Promise<void> {
    await this.db.run(
      `DELETE FROM coco_cashu_keypairs WHERE publicKey = ? ${purpose ? 'AND purpose = ?' : ''}`,
      purpose ? [publicKey, purpose] : [publicKey],
    );
  }

  async getAllPersistedKeyPairs(purpose?: KeypairPurpose): Promise<Keypair[]> {
    const rows = await this.db.all<KeypairRow>(
      `SELECT publicKey, secretKey, derivationIndex, purpose
       FROM coco_cashu_keypairs ${purpose ? 'WHERE purpose = ?' : ''}`,
      purpose ? [purpose] : [],
    );

    return rows.map((row) => {
      try {
        return rowToKeypair(row);
      } catch (error) {
        throw new Error(
          `Failed to parse secret key for public key ${row.publicKey}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    });
  }

  async getLatestKeyPair(purpose?: KeypairPurpose): Promise<Keypair | null> {
    const row = await this.db.get<KeypairRow>(
      `SELECT publicKey, secretKey, derivationIndex, purpose
       FROM coco_cashu_keypairs
       ${purpose ? 'WHERE purpose = ?' : ''}
       ORDER BY createdAt DESC LIMIT 1`,
      purpose ? [purpose] : [],
    );
    if (!row) return null;

    try {
      return rowToKeypair(row);
    } catch (error) {
      throw new Error(
        `Failed to parse latest secret key for public key ${row.publicKey}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  async reserveNextDerivationIndex(purpose: KeypairPurpose): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.reserveNextDerivationIndexOnce(purpose);
      } catch (error) {
        if (!isSqliteBusy(error) || attempt > MAX_BUSY_RETRIES) throw error;
        await waitForRetry(attempt);
      }
    }
  }

  private async reserveNextDerivationIndexOnce(purpose: KeypairPurpose): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO coco_cashu_keypair_derivation_allocations (purpose, lastAllocatedIndex)
         VALUES (?, -1)
         ON CONFLICT(purpose) DO NOTHING`,
        [purpose],
      );

      const update = await tx.run(
        `UPDATE coco_cashu_keypair_derivation_allocations
         SET lastAllocatedIndex = MAX(
           lastAllocatedIndex,
           COALESCE(
             (SELECT MAX(keypairs.derivationIndex)
              FROM coco_cashu_keypairs AS keypairs
              WHERE keypairs.purpose = ?),
             -1
           )
         ) + 1
         WHERE purpose = ?
           AND MAX(
             lastAllocatedIndex,
             COALESCE(
               (SELECT MAX(keypairs.derivationIndex)
                FROM coco_cashu_keypairs AS keypairs
                WHERE keypairs.purpose = ?),
               -1
             )
           ) < ?`,
        [purpose, purpose, purpose, MAX_DERIVATION_INDEX],
      );

      if (update.changes !== 1) {
        const allocation = await tx.get<{ lastAllocatedIndex: number }>(
          `SELECT lastAllocatedIndex
           FROM coco_cashu_keypair_derivation_allocations
           WHERE purpose = ?`,
          [purpose],
        );
        const greatestStored = await tx.get<{ derivationIndex: number | null }>(
          `SELECT MAX(derivationIndex) AS derivationIndex
           FROM coco_cashu_keypairs
           WHERE purpose = ? AND derivationIndex IS NOT NULL`,
          [purpose],
        );
        const baseIndex = Math.max(
          allocation?.lastAllocatedIndex ?? -1,
          greatestStored?.derivationIndex ?? -1,
        );
        if (baseIndex >= MAX_DERIVATION_INDEX) {
          throw new DerivationIndexExhaustedError(purpose);
        }
        throw new Error(`Failed to reserve a derivation index for keypair purpose ${purpose}`);
      }

      const allocation = await tx.get<{ lastAllocatedIndex: number }>(
        `SELECT lastAllocatedIndex
         FROM coco_cashu_keypair_derivation_allocations
         WHERE purpose = ?`,
        [purpose],
      );
      if (!allocation) {
        throw new Error(`Missing derivation allocation for keypair purpose ${purpose}`);
      }
      return allocation.lastAllocatedIndex;
    });
  }
}
