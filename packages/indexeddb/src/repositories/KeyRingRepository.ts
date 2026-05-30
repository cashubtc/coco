import type { KeyRingRepository, Keypair, KeypairPurpose } from '@cashu/coco-core';
import type { IdbDb } from '../lib/db.ts';
import { hexToBytes, bytesToHex } from '../utils.ts';

const DEFAULT_KEYPAIR_PURPOSE: KeypairPurpose = 'p2pk';

interface KeypairRow {
  publicKey: string;
  secretKey: string;
  createdAt: number;
  derivationIndex?: number;
  purpose?: KeypairPurpose;
}

export class IdbKeyRingRepository implements KeyRingRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getPersistedKeyPair(publicKey: string, purpose?: KeypairPurpose): Promise<Keypair | null> {
    const table = this.db.table('coco_cashu_keypairs');
    const row = await table.get(publicKey);
    if (!row) return null;

    const keypairRow = row as KeypairRow;
    if (purpose && (keypairRow.purpose ?? DEFAULT_KEYPAIR_PURPOSE) !== purpose) return null;
    // Convert hex string back to Uint8Array
    const secretKeyBytes = hexToBytes(keypairRow.secretKey);

    return {
      publicKeyHex: keypairRow.publicKey,
      secretKey: secretKeyBytes,
      derivationIndex: keypairRow.derivationIndex,
      purpose: keypairRow.purpose ?? DEFAULT_KEYPAIR_PURPOSE,
    };
  }

  async setPersistedKeyPair(keyPair: Keypair): Promise<void> {
    const table = this.db.table('coco_cashu_keypairs');
    const secretKeyHex = bytesToHex(keyPair.secretKey);

    // Preserve existing derivationIndex if new one is not provided
    let derivationIndex = keyPair.derivationIndex;
    const purpose = keyPair.purpose ?? DEFAULT_KEYPAIR_PURPOSE;
    if (derivationIndex == null) {
      const existing = (await table.get(keyPair.publicKeyHex)) as KeypairRow | undefined;
      if (existing?.derivationIndex != null) {
        derivationIndex = existing.derivationIndex;
      }
    }

    await table.put({
      publicKey: keyPair.publicKeyHex,
      secretKey: secretKeyHex,
      createdAt: Date.now(),
      derivationIndex,
      purpose,
    });
  }

  async deletePersistedKeyPair(publicKey: string, purpose?: KeypairPurpose): Promise<void> {
    const table = this.db.table('coco_cashu_keypairs');
    if (purpose) {
      const existing = (await table.get(publicKey)) as KeypairRow | undefined;
      if (existing && (existing.purpose ?? DEFAULT_KEYPAIR_PURPOSE) !== purpose) return;
    }
    await table.delete(publicKey);
  }

  async getAllPersistedKeyPairs(purpose?: KeypairPurpose): Promise<Keypair[]> {
    const table = this.db.table('coco_cashu_keypairs');
    const rows = (await table.toArray()) as KeypairRow[];

    return rows
      .filter((row) => !purpose || (row.purpose ?? DEFAULT_KEYPAIR_PURPOSE) === purpose)
      .map((row) => ({
        publicKeyHex: row.publicKey,
        secretKey: hexToBytes(row.secretKey),
        derivationIndex: row.derivationIndex,
        purpose: row.purpose ?? DEFAULT_KEYPAIR_PURPOSE,
      }));
  }

  async getLatestKeyPair(purpose?: KeypairPurpose): Promise<Keypair | null> {
    const table = this.db.table('coco_cashu_keypairs');
    const rows = (await table.orderBy('createdAt').reverse().toArray()) as KeypairRow[];
    const row = rows.find(
      (candidate) => !purpose || (candidate.purpose ?? DEFAULT_KEYPAIR_PURPOSE) === purpose,
    );

    if (!row) return null;

    return {
      publicKeyHex: row.publicKey,
      secretKey: hexToBytes(row.secretKey),
      derivationIndex: row.derivationIndex,
      purpose: row.purpose ?? DEFAULT_KEYPAIR_PURPOSE,
    };
  }

  async getLastDerivationIndex(purpose?: KeypairPurpose): Promise<number> {
    const table = this.db.table('coco_cashu_keypairs');
    const rows = (await table.orderBy('derivationIndex').reverse().toArray()) as KeypairRow[];
    const row = rows.find(
      (candidate) =>
        candidate.derivationIndex != null &&
        (!purpose || (candidate.purpose ?? DEFAULT_KEYPAIR_PURPOSE) === purpose),
    );

    if (!row || row.derivationIndex == null) {
      return -1;
    }

    return row.derivationIndex;
  }
}
