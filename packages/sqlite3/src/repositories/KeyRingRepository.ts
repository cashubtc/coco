import type { KeyRingRepository, Keypair } from 'coco-cashu-core';
import { SqliteDb } from '../db.ts';
import { hexToBytes, bytesToHex } from '../utils.ts';

export class SqliteKeyRingRepository implements KeyRingRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async getPersistedKeyPair(publicKey: string): Promise<Keypair | null> {
    const row = await this.db.get<{
      publicKey: string;
      secretKey: string;
      derivationIndex: number | null;
      derivationPath: string | null;
    }>(
      'SELECT publicKey, secretKey, derivationIndex, derivationPath FROM coco_cashu_keypairs WHERE publicKey = ? LIMIT 1',
      [publicKey],
    );
    if (!row) return null;

    try {
      const secretKeyBytes = hexToBytes(row.secretKey);
      return {
        publicKeyHex: row.publicKey,
        secretKey: secretKeyBytes,
        derivationIndex: row.derivationIndex ?? undefined,
        derivationPath: row.derivationPath ?? undefined,
      };
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

    await this.db.run(
      `INSERT INTO coco_cashu_keypairs (publicKey, secretKey, createdAt, derivationIndex, derivationPath)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(publicKey) DO UPDATE SET
         secretKey=excluded.secretKey,
         derivationIndex=COALESCE(excluded.derivationIndex, coco_cashu_keypairs.derivationIndex),
         derivationPath=COALESCE(excluded.derivationPath, coco_cashu_keypairs.derivationPath)`,
      [
        keyPair.publicKeyHex,
        secretKeyHex,
        Date.now(),
        keyPair.derivationIndex ?? null,
        keyPair.derivationPath ?? null,
      ],
    );
  }

  async deletePersistedKeyPair(publicKey: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_keypairs WHERE publicKey = ?', [publicKey]);
  }

  async getAllPersistedKeyPairs(): Promise<Keypair[]> {
    const rows = await this.db.all<{
      publicKey: string;
      secretKey: string;
      derivationIndex: number | null;
      derivationPath: string | null;
    }>('SELECT publicKey, secretKey, derivationIndex, derivationPath FROM coco_cashu_keypairs');

    return rows.map((row) => {
      try {
        const secretKeyBytes = hexToBytes(row.secretKey);
        return {
          publicKeyHex: row.publicKey,
          secretKey: secretKeyBytes,
          derivationIndex: row.derivationIndex ?? undefined,
          derivationPath: row.derivationPath ?? undefined,
        };
      } catch (error) {
        throw new Error(
          `Failed to parse secret key for public key ${row.publicKey}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    });
  }

  async getLatestKeyPair(): Promise<Keypair | null> {
    const row = await this.db.get<{
      publicKey: string;
      secretKey: string;
      derivationIndex: number | null;
      derivationPath: string | null;
    }>(
      'SELECT publicKey, secretKey, derivationIndex, derivationPath FROM coco_cashu_keypairs ORDER BY createdAt DESC LIMIT 1',
    );
    if (!row) return null;

    try {
      const secretKeyBytes = hexToBytes(row.secretKey);
      return {
        publicKeyHex: row.publicKey,
        secretKey: secretKeyBytes,
        derivationIndex: row.derivationIndex ?? undefined,
        derivationPath: row.derivationPath ?? undefined,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse latest secret key for public key ${row.publicKey}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  async getLastDerivationIndex(): Promise<number> {
    const row = await this.db.get<{ derivationIndex: number }>(
      'SELECT derivationIndex FROM coco_cashu_keypairs WHERE derivationIndex IS NOT NULL ORDER BY derivationIndex DESC LIMIT 1',
    );
    return row?.derivationIndex ?? -1;
  }
}
