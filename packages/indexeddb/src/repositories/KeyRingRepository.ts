import Dexie from 'dexie';
import type { KeyRingRepository, Keypair, KeypairPurpose } from '@cashu/coco-core/adapter';
import type { IdbDb } from '../lib/db.ts';
import { hexToBytes, bytesToHex } from '../utils.ts';

const DEFAULT_KEYPAIR_PURPOSE: KeypairPurpose = 'p2pk';
const KEYPAIR_STORE = 'coco_cashu_keypairs';
const ALLOCATION_STORE = 'coco_cashu_keypair_derivation_allocations';

interface KeypairRow {
  publicKey: string;
  secretKey: string;
  createdAt: number;
  derivationIndex?: number;
  purpose?: KeypairPurpose;
}

interface KeypairDerivationAllocationRow {
  purpose: KeypairPurpose;
  lastAllocatedIndex: number;
}

export class IdbKeyRingRepository implements KeyRingRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getPersistedKeyPair(publicKey: string, purpose?: KeypairPurpose): Promise<Keypair | null> {
    const table = this.db.table(KEYPAIR_STORE);
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
    const table = this.db.table(KEYPAIR_STORE);
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
    const table = this.db.table(KEYPAIR_STORE);
    if (purpose) {
      const existing = (await table.get(publicKey)) as KeypairRow | undefined;
      if (existing && (existing.purpose ?? DEFAULT_KEYPAIR_PURPOSE) !== purpose) return;
    }
    await table.delete(publicKey);
  }

  async getAllPersistedKeyPairs(purpose?: KeypairPurpose): Promise<Keypair[]> {
    const table = this.db.table(KEYPAIR_STORE);
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
    const table = this.db.table(KEYPAIR_STORE);
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

  async getLastAllocatedIndex(purpose: KeypairPurpose): Promise<number | null> {
    const row = (await this.db.table(ALLOCATION_STORE).get(purpose)) as
      | KeypairDerivationAllocationRow
      | undefined;
    return row?.lastAllocatedIndex ?? null;
  }

  async getHighestStoredDerivationIndex(purpose: KeypairPurpose): Promise<number | null> {
    const row = (await this.db
      .table(KEYPAIR_STORE)
      .where('[purpose+derivationIndex]')
      .between([purpose, Dexie.minKey], [purpose, Dexie.maxKey])
      .last()) as KeypairRow | undefined;
    return row?.derivationIndex ?? null;
  }

  async setLastAllocatedIndex(purpose: KeypairPurpose, derivationIndex: number): Promise<void> {
    await this.db.table(ALLOCATION_STORE).put({ purpose, lastAllocatedIndex: derivationIndex });
  }
}
