import type { KeyRingRepository, Keypair, KeypairPurpose } from '@cashu/coco-core';
import { ExpoSqliteDb } from '../db.ts';
import { hexToBytes, bytesToHex } from '../utils.ts';

const DEFAULT_KEYPAIR_PURPOSE: KeypairPurpose = 'p2pk';

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

export class ExpoKeyRingRepository implements KeyRingRepository {
  private readonly db: ExpoSqliteDb;

  constructor(db: ExpoSqliteDb) {
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

  async getLastDerivationIndex(purpose?: KeypairPurpose): Promise<number> {
    const row = await this.db.get<{ derivationIndex: number }>(
      `SELECT derivationIndex FROM coco_cashu_keypairs
       WHERE derivationIndex IS NOT NULL ${purpose ? 'AND purpose = ?' : ''}
       ORDER BY derivationIndex DESC LIMIT 1`,
      purpose ? [purpose] : [],
    );
    return row?.derivationIndex ?? -1;
  }
}
