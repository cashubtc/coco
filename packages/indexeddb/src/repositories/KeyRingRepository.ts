import type { KeyRingRepository, Keypair } from 'coco-cashu-core';
import type { IdbDb } from '../lib/db.ts';
import { hexToBytes, bytesToHex } from '../utils.ts';

interface KeypairRow {
  publicKey: string;
  secretKey: string;
  createdAt: number;
  derivationIndex?: number;
}

export class IdbKeyRingRepository implements KeyRingRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getPersistedKeyPair(publicKey: string): Promise<Keypair | null> {
    const table = this.db.table('coco_cashu_keypairs');
    const row = await table.get(publicKey);
    if (!row) return null;

    const keypairRow = row as KeypairRow;
    // Convert hex string back to Uint8Array
    const secretKeyBytes = hexToBytes(keypairRow.secretKey);

    return {
      publicKeyHex: keypairRow.publicKey,
      secretKey: secretKeyBytes,
      derivationIndex: keypairRow.derivationIndex,
    };
  }

  async setPersistedKeyPair(keyPair: Keypair): Promise<void> {
    const table = this.db.table('coco_cashu_keypairs');
    const secretKeyHex = bytesToHex(keyPair.secretKey);

    await table.put({
      publicKey: keyPair.publicKeyHex,
      secretKey: secretKeyHex,
      createdAt: Date.now(),
      derivationIndex: keyPair.derivationIndex,
    });
  }

  async deletePersistedKeyPair(publicKey: string): Promise<void> {
    const table = this.db.table('coco_cashu_keypairs');
    await table.delete(publicKey);
  }

  async getAllPersistedKeyPairs(): Promise<Keypair[]> {
    const table = this.db.table('coco_cashu_keypairs');
    const rows = (await table.toArray()) as KeypairRow[];

    return rows.map((row) => ({
      publicKeyHex: row.publicKey,
      secretKey: hexToBytes(row.secretKey),
      derivationIndex: row.derivationIndex,
    }));
  }

  async getLatestKeyPair(): Promise<Keypair | null> {
    const table = this.db.table('coco_cashu_keypairs');
    const row = (await table.orderBy('createdAt').reverse().first()) as KeypairRow | undefined;

    if (!row) return null;

    return {
      publicKeyHex: row.publicKey,
      secretKey: hexToBytes(row.secretKey),
      derivationIndex: row.derivationIndex,
    };
  }

  async getLastDerivationIndex(): Promise<number> {
    const table = this.db.table('coco_cashu_keypairs');
    const row = (await table
      .where('derivationIndex')
      .above(-1)
      .reverse()
      .sortBy('derivationIndex')) as KeypairRow[];

    if (!row || row.length === 0 || row[0].derivationIndex == null) {
      return -1;
    }

    return row[0].derivationIndex;
  }
}

