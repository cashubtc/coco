import { normalizeMintUrl, stringifyJson } from '@cashu/coco-core/adapter';
import type { IdbDb } from './db.ts';

function normalizeStoredAmount(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value;
  return String(value);
}

function normalizeStoredUnit(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return 'sat';
  return value.trim().toLowerCase();
}

function removeNullOptionalPaymentRequestAttemptIndexValues(row: {
  transportMessageId?: unknown;
  receiveOperationId?: unknown;
}): void {
  if (row.transportMessageId == null) {
    delete row.transportMessageId;
  }
  if (row.receiveOperationId == null) {
    delete row.receiveOperationId;
  }
}

export async function ensureSchema(db: IdbDb): Promise<void> {
  // Dexie schema with final versioned stores (flattened for first release)
  db.version(1).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs: '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history: '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type]',
  });

  // Version 2: Add trusted field to mints
  db.version(2)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history: '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type]',
    })
    .upgrade(async (tx) => {
      // Set all existing mints to trusted for backwards compatibility
      const mints = await tx.table('coco_cashu_mints').toArray();
      for (const mint of mints) {
        await tx.table('coco_cashu_mints').update(mint.mintUrl, { trusted: true });
      }
    });

  // Version 3: Add unit field to keysets
  db.version(3).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs: '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history: '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type]',
  });

  // Version 4: Add keypairs table
  db.version(4).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs: '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history: '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
  });

  // Version 5: Normalize mint URLs
  db.version(5)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history: '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    })
    .upgrade(async (tx) => {
      // Get all mints to build the URL mapping
      const mints = await tx.table('coco_cashu_mints').toArray();

      // Build mapping of old -> normalized URLs
      const urlMapping = new Map<string, string>();
      for (const mint of mints) {
        const normalized = normalizeMintUrl(mint.mintUrl);
        urlMapping.set(mint.mintUrl, normalized);
      }

      // Check for conflicts: two different URLs normalizing to the same value
      const normalizedToOriginal = new Map<string, string>();
      for (const [original, normalized] of urlMapping) {
        const existing = normalizedToOriginal.get(normalized);
        if (existing && existing !== original) {
          throw new Error(
            `Mint URL normalization conflict: "${existing}" and "${original}" both normalize to "${normalized}". ` +
              `Please manually resolve this conflict before running the migration.`,
          );
        }
        normalizedToOriginal.set(normalized, original);
      }

      // Process each URL that needs normalization
      for (const [original, normalized] of urlMapping) {
        if (original === normalized) continue; // No change needed

        // For IndexedDB with compound keys, we need to delete old records and insert new ones
        // because we can't update primary key fields directly

        // 1. Mints table (primary key is mintUrl)
        const mint = await tx.table('coco_cashu_mints').get(original);
        if (mint) {
          await tx.table('coco_cashu_mints').delete(original);
          await tx.table('coco_cashu_mints').add({ ...mint, mintUrl: normalized });
        }

        // 2. Keysets table (compound key: mintUrl + id)
        const keysets = await tx
          .table('coco_cashu_keysets')
          .where('mintUrl')
          .equals(original)
          .toArray();
        for (const keyset of keysets) {
          await tx.table('coco_cashu_keysets').delete([original, keyset.id]);
          await tx.table('coco_cashu_keysets').add({ ...keyset, mintUrl: normalized });
        }

        // 3. Counters table (compound key: mintUrl + keysetId)
        const counters = await tx
          .table('coco_cashu_counters')
          .where('[mintUrl+keysetId]')
          .between([original, ''], [original, '\uffff'])
          .toArray();
        for (const counter of counters) {
          await tx.table('coco_cashu_counters').delete([original, counter.keysetId]);
          await tx.table('coco_cashu_counters').add({ ...counter, mintUrl: normalized });
        }

        // 4. Proofs table (compound key: mintUrl + secret)
        const proofs = await tx
          .table('coco_cashu_proofs')
          .where('mintUrl')
          .equals(original)
          .toArray();
        for (const proof of proofs) {
          await tx.table('coco_cashu_proofs').delete([original, proof.secret]);
          await tx.table('coco_cashu_proofs').add({ ...proof, mintUrl: normalized });
        }

        // 5. Mint quotes table (compound key: mintUrl + quote)
        const mintQuotes = await tx
          .table('coco_cashu_mint_quotes')
          .where('mintUrl')
          .equals(original)
          .toArray();
        for (const quote of mintQuotes) {
          await tx.table('coco_cashu_mint_quotes').delete([original, quote.quote]);
          await tx.table('coco_cashu_mint_quotes').add({ ...quote, mintUrl: normalized });
        }

        // 6. Melt quotes table (compound key: mintUrl + quote)
        const meltQuotes = await tx
          .table('coco_cashu_melt_quotes')
          .where('mintUrl')
          .equals(original)
          .toArray();
        for (const quote of meltQuotes) {
          await tx.table('coco_cashu_melt_quotes').delete([original, quote.quote]);
          await tx.table('coco_cashu_melt_quotes').add({ ...quote, mintUrl: normalized });
        }

        // 7. History table (mintUrl is not part of primary key, just update)
        await tx
          .table('coco_cashu_history')
          .where('mintUrl')
          .equals(original)
          .modify({ mintUrl: normalized });
      }
    });

  // Version 6: Add send_operations table and operation tracking fields to proofs
  db.version(6).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history: '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl',
  });

  // Version 7: Add operationId index for send history entries
  db.version(7).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl',
  });

  // Version 8: Rename 'completed' state to 'finalized' in send operations and history
  db.version(8)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl',
    })
    .upgrade(async (tx) => {
      // Update send operations from 'completed' to 'finalized'
      await tx
        .table('coco_cashu_send_operations')
        .where('state')
        .equals('completed')
        .modify({ state: 'finalized' });

      // Update history entries from 'completed' to 'finalized' for send type
      await tx
        .table('coco_cashu_history')
        .where('type')
        .equals('send')
        .filter((entry: any) => entry.state === 'completed')
        .modify({ state: 'finalized' });
    });

  // Version 9: Add melt operations store
  db.version(9).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl',
    coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
  });

  // Version 10: Add method and methodData fields to send_operations
  db.version(10)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl',
      coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    })
    .upgrade(async (tx) => {
      // Add default method and methodData to existing send operations
      await tx
        .table('coco_cashu_send_operations')
        .toCollection()
        .modify((op: any) => {
          if (!op.method) {
            op.method = 'default';
          }
          if (!op.methodDataJson) {
            op.methodDataJson = stringifyJson(op.methodData ?? {});
          }
          if ('methodData' in op) {
            delete op.methodData;
          }
        });
    });

  // Version 11: Add receive operations store
  db.version(11).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl',
    coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl',
  });

  // Version 12: Repair send operation methodDataJson backfill
  db.version(12)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl',
      coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl',
    })
    .upgrade(async (tx) => {
      await tx
        .table('coco_cashu_send_operations')
        .toCollection()
        .modify((op: any) => {
          if (!op.method) {
            op.method = 'default';
          }
          if (!op.methodDataJson) {
            op.methodDataJson = stringifyJson(op.methodData ?? {});
          }
          if ('methodData' in op) {
            delete op.methodData;
          }
        });
    });

  // Version 13: Add tokenJson to send operations for persisted resurfacing.
  db.version(13)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl',
      coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl',
    })
    .upgrade(async (tx) => {
      await tx
        .table('coco_cashu_send_operations')
        .toCollection()
        .modify((op: any) => {
          if (!('tokenJson' in op)) {
            op.tokenJson = null;
          }
        });
    });

  db.version(14)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl',
      coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl',
    })
    .upgrade(async (tx) => {
      await tx.table('coco_cashu_keysets').clear();
      await tx
        .table('coco_cashu_mints')
        .toCollection()
        .modify((mint: { updatedAt: number }) => {
          mint.updatedAt = 0;
        });
    });

  // Version 15: Add auth sessions store
  db.version(15).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl',
    coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl',
    coco_cashu_auth_sessions: '&mintUrl',
  });

  // Version 16: Add mint operations store with the current unreleased row shape
  db.version(16).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl',
    coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl',
    coco_cashu_auth_sessions: '&mintUrl',
    coco_cashu_mint_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
  });

  // Version 17: Persist receive operation units for lifecycle-aware history updates
  db.version(17)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl',
      coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl',
      coco_cashu_auth_sessions: '&mintUrl',
      coco_cashu_mint_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    })
    .upgrade(async (tx) => {
      await tx
        .table('coco_cashu_receive_operations')
        .toCollection()
        .modify((op: { unit?: string | null }) => {
          if (!op.unit) {
            op.unit = 'sat';
          }
        });
    });

  // Version 18: Store amount-bearing fields as canonical decimal text.
  db.version(18)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl',
      coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl',
      coco_cashu_auth_sessions: '&mintUrl',
      coco_cashu_mint_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    })
    .upgrade(async (tx) => {
      await tx
        .table('coco_cashu_proofs')
        .toCollection()
        .modify((row: { amount: unknown }) => {
          row.amount = normalizeStoredAmount(row.amount);
        });

      await tx
        .table('coco_cashu_mint_quotes')
        .toCollection()
        .modify((row: { amount: unknown }) => {
          row.amount = normalizeStoredAmount(row.amount);
        });

      await tx
        .table('coco_cashu_melt_quotes')
        .toCollection()
        .modify((row: { amount: unknown; fee_reserve: unknown }) => {
          row.amount = normalizeStoredAmount(row.amount);
          row.fee_reserve = normalizeStoredAmount(row.fee_reserve);
        });

      await tx
        .table('coco_cashu_history')
        .toCollection()
        .modify((row: { amount: unknown }) => {
          row.amount = normalizeStoredAmount(row.amount);
        });

      await tx
        .table('coco_cashu_send_operations')
        .toCollection()
        .modify((row: { amount: unknown; fee?: unknown; inputAmount?: unknown }) => {
          row.amount = normalizeStoredAmount(row.amount);
          row.fee = normalizeStoredAmount(row.fee);
          row.inputAmount = normalizeStoredAmount(row.inputAmount);
        });

      await tx
        .table('coco_cashu_melt_operations')
        .toCollection()
        .modify(
          (row: {
            amount?: unknown;
            fee_reserve?: unknown;
            swap_fee?: unknown;
            inputAmount?: unknown;
            changeAmount?: unknown;
            effectiveFee?: unknown;
          }) => {
            row.amount = normalizeStoredAmount(row.amount);
            row.fee_reserve = normalizeStoredAmount(row.fee_reserve);
            row.swap_fee = normalizeStoredAmount(row.swap_fee);
            row.inputAmount = normalizeStoredAmount(row.inputAmount);
            row.changeAmount = normalizeStoredAmount(row.changeAmount);
            row.effectiveFee = normalizeStoredAmount(row.effectiveFee);
          },
        );

      await tx
        .table('coco_cashu_receive_operations')
        .toCollection()
        .modify((row: { amount: unknown; fee?: unknown }) => {
          row.amount = normalizeStoredAmount(row.amount);
          row.fee = normalizeStoredAmount(row.fee);
        });

      await tx
        .table('coco_cashu_mint_operations')
        .toCollection()
        .modify((row: { amount?: unknown }) => {
          row.amount = normalizeStoredAmount(row.amount);
        });
    });

  // Version 19: Persist proof units and add unit-aware proof indexes.
  db.version(19)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl',
      coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl',
      coco_cashu_auth_sessions: '&mintUrl',
      coco_cashu_mint_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    })
    .upgrade(async (tx) => {
      const keysets = (await tx.table('coco_cashu_keysets').toArray()) as Array<{
        mintUrl?: unknown;
        id?: unknown;
        unit?: unknown;
      }>;
      const unitByKeyset = new Map<string, string>();
      for (const keyset of keysets) {
        if (typeof keyset.mintUrl !== 'string' || typeof keyset.id !== 'string') continue;
        unitByKeyset.set(`${keyset.mintUrl}\0${keyset.id}`, normalizeStoredUnit(keyset.unit));
      }

      await tx
        .table('coco_cashu_proofs')
        .toCollection()
        .modify((row: { mintUrl?: unknown; id?: unknown; unit?: unknown }) => {
          const keysetKey =
            typeof row.mintUrl === 'string' && typeof row.id === 'string'
              ? `${row.mintUrl}\0${row.id}`
              : undefined;
          const keysetUnit = keysetKey ? unitByKeyset.get(keysetKey) : undefined;
          row.unit = normalizeStoredUnit(keysetUnit ?? row.unit);
        });
    });

  // Version 20: Persist send operation units for recovery-safe multi-unit sends.
  db.version(20)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl',
      coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl',
      coco_cashu_auth_sessions: '&mintUrl',
      coco_cashu_mint_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    })
    .upgrade(async (tx) => {
      await tx
        .table('coco_cashu_send_operations')
        .toCollection()
        .modify((row: { unit?: unknown }) => {
          row.unit = normalizeStoredUnit(row.unit);
        });
    });

  // Version 21: Add mint/unit/keyset proof index for unit-aware keyset scans.
  db.version(21).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl',
    coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl',
    coco_cashu_auth_sessions: '&mintUrl',
    coco_cashu_mint_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
  });

  // Version 22: Incoming payment-request receive saga tables.
  db.version(22).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl',
    coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl',
    coco_cashu_auth_sessions: '&mintUrl',
    coco_cashu_mint_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    coco_cashu_payment_request_receive_operations: '&id, state, requestId',
    coco_cashu_payment_request_receive_attempts:
      '&id, requestOperationId, state, payloadHash, transportMessageId, receiveOperationId',
  });

  // Version 23: Add request-id payload lookup and request-operation payload uniqueness.
  db.version(23)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl',
      coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl',
      coco_cashu_auth_sessions: '&mintUrl',
      coco_cashu_mint_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
      coco_cashu_payment_request_receive_operations: '&id, state, requestId',
      coco_cashu_payment_request_receive_attempts:
        '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], transportMessageId, receiveOperationId',
    })
    .upgrade(async (tx) => {
      await tx
        .table('coco_cashu_payment_request_receive_attempts')
        .toCollection()
        .modify(removeNullOptionalPaymentRequestAttemptIndexValues);
    });

  // Version 24: Make optional attempt linkage indexes unique after null cleanup.
  db.version(24).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl',
    coco_cashu_melt_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl',
    coco_cashu_auth_sessions: '&mintUrl',
    coco_cashu_mint_operations: '&id, state, mintUrl, [mintUrl+quoteId]',
    coco_cashu_payment_request_receive_operations: '&id, state, requestId',
    coco_cashu_payment_request_receive_attempts:
      '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
  });

  // Version 25: Add createdAt indexes used by operation-backed history projection pagination.
  db.version(25).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl, createdAt',
    coco_cashu_melt_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl, createdAt',
    coco_cashu_auth_sessions: '&mintUrl',
    coco_cashu_mint_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
    coco_cashu_payment_request_receive_operations: '&id, state, requestId',
    coco_cashu_payment_request_receive_attempts:
      '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
  });

  // Version 26: Preserve legacy send tokens when history is projected from operations.
  db.version(26)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl, createdAt',
      coco_cashu_melt_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl, createdAt',
      coco_cashu_auth_sessions: '&mintUrl',
      coco_cashu_mint_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
      coco_cashu_payment_request_receive_operations: '&id, state, requestId',
      coco_cashu_payment_request_receive_attempts:
        '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
    })
    .upgrade(async (tx) => {
      const legacyRows = (await tx
        .table('coco_cashu_history')
        .where('type')
        .equals('send')
        .toArray()) as Array<{
        id: number;
        mintUrl: string;
        operationId?: string | null;
        tokenJson?: string | null;
        createdAt: number;
      }>;

      legacyRows.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);

      const legacyTokens = new Map<string, string>();
      for (const row of legacyRows) {
        if (!row.operationId || !row.tokenJson) continue;
        const key = `${row.mintUrl}\0${row.operationId}`;
        if (!legacyTokens.has(key)) legacyTokens.set(key, row.tokenJson);
      }

      await tx
        .table('coco_cashu_send_operations')
        .toCollection()
        .modify((op: { id: string; mintUrl: string; tokenJson?: string | null }) => {
          if (op.tokenJson != null) return;
          const tokenJson = legacyTokens.get(`${op.mintUrl}\0${op.id}`);
          if (tokenJson) op.tokenJson = tokenJson;
        });
    });

  // Version 27: Add canonical mint quote records and method-aware operation lookup.
  db.version(27)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_canonical_mint_quotes: '&[mintUrl+method+quoteId], state, mintUrl, method',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl, createdAt',
      coco_cashu_melt_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl, createdAt',
      coco_cashu_auth_sessions: '&mintUrl',
      coco_cashu_mint_operations:
        '&id, state, mintUrl, createdAt, [mintUrl+quoteId], [mintUrl+method+quoteId]',
      coco_cashu_payment_request_receive_operations: '&id, state, requestId',
      coco_cashu_payment_request_receive_attempts:
        '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
    })
    .upgrade(async (tx) => {
      const now = Date.now();

      const operations = (await tx.table('coco_cashu_mint_operations').toArray()) as Array<{
        mintUrl?: string;
        method?: string;
        quoteId?: string | null;
        state?: string;
        request?: string | null;
        amount?: unknown;
        unit?: string | null;
        expiry?: number | null;
        pubkey?: string | null;
        lastObservedRemoteState?: string | null;
        lastObservedRemoteStateAt?: number | null;
        createdAt?: number;
        updatedAt?: number;
      }>;

      for (const op of operations) {
        if (!op.mintUrl || !op.method || !op.quoteId || !op.request || op.amount == null) continue;
        const existing = await tx
          .table('coco_cashu_canonical_mint_quotes')
          .get([op.mintUrl, op.method, op.quoteId]);
        const observedState =
          op.lastObservedRemoteState === 'UNPAID' ||
          op.lastObservedRemoteState === 'PAID' ||
          op.lastObservedRemoteState === 'ISSUED'
            ? op.lastObservedRemoteState
            : op.state === 'finalized'
              ? 'ISSUED'
              : 'UNPAID';
        const createdAt = (op.createdAt ?? Math.floor(now / 1000)) * 1000;
        const updatedAt = (op.updatedAt ?? Math.floor(now / 1000)) * 1000;
        await tx.table('coco_cashu_canonical_mint_quotes').put({
          ...existing,
          mintUrl: op.mintUrl,
          method: op.method,
          quoteId: op.quoteId,
          state: observedState,
          request: op.request,
          amount: normalizeStoredAmount(op.amount) ?? '0',
          unit: normalizeStoredUnit(op.unit),
          expiry: op.expiry ?? null,
          pubkey: op.pubkey ?? null,
          lastObservedRemoteState: observedState,
          lastObservedRemoteStateAt: op.lastObservedRemoteStateAt ?? updatedAt,
          reusable: 0,
          createdAt: existing?.createdAt ?? createdAt,
          updatedAt,
        });
      }
    });

  // Version 28: Make canonical melt quote records method-aware.
  db.version(28)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_canonical_mint_quotes: '&[mintUrl+method+quoteId], state, mintUrl, method',
      coco_cashu_melt_quotes: '&[mintUrl+method+quoteId], state, mintUrl, method',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl, createdAt',
      coco_cashu_melt_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl, createdAt',
      coco_cashu_auth_sessions: '&mintUrl',
      coco_cashu_mint_operations:
        '&id, state, mintUrl, createdAt, [mintUrl+quoteId], [mintUrl+method+quoteId]',
      coco_cashu_payment_request_receive_operations: '&id, state, requestId',
      coco_cashu_payment_request_receive_attempts:
        '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
    })
    .upgrade(async (tx) => {
      const now = Date.now();

      await tx
        .table('coco_cashu_melt_quotes')
        .toCollection()
        .modify(
          (row: {
            quote?: string;
            quoteId?: string;
            method?: string;
            state?: string;
            lastObservedRemoteState?: string;
            lastObservedRemoteStateAt?: number;
            createdAt?: number;
            updatedAt?: number;
          }) => {
            row.method = row.method ?? 'bolt11';
            row.quoteId = row.quoteId ?? row.quote ?? '';
            row.lastObservedRemoteState = row.lastObservedRemoteState ?? row.state;
            row.lastObservedRemoteStateAt = row.lastObservedRemoteStateAt ?? now;
            row.createdAt = row.createdAt ?? now;
            row.updatedAt = row.updatedAt ?? now;
          },
        );

      const operations = (await tx.table('coco_cashu_melt_operations').toArray()) as Array<{
        mintUrl?: string;
        method?: string;
        methodData?: { invoice?: string };
        methodDataJson?: string;
        quoteId?: string | null;
        state?: string;
        amount?: unknown;
        unit?: string | null;
        fee_reserve?: unknown;
        finalizedData?: { preimage?: string };
        finalizedDataJson?: string | null;
        createdAt?: number;
        updatedAt?: number;
      }>;

      for (const op of operations) {
        if (!op.mintUrl || !op.method || !op.quoteId || op.amount == null || op.fee_reserve == null)
          continue;
        const methodData =
          op.methodData ??
          (op.methodDataJson ? (JSON.parse(op.methodDataJson) as { invoice?: string }) : {});
        const finalizedData =
          op.finalizedData ??
          (op.finalizedDataJson ? (JSON.parse(op.finalizedDataJson) as { preimage?: string }) : {});
        const existing = await tx
          .table('coco_cashu_melt_quotes')
          .get([op.mintUrl, op.method, op.quoteId]);
        const observedState =
          op.state === 'finalized'
            ? 'PAID'
            : op.state === 'pending' || op.state === 'executing'
              ? 'PENDING'
              : 'UNPAID';
        const createdAt = (op.createdAt ?? Math.floor(now / 1000)) * 1000;
        const updatedAt = (op.updatedAt ?? Math.floor(now / 1000)) * 1000;
        await tx.table('coco_cashu_melt_quotes').put({
          ...existing,
          mintUrl: op.mintUrl,
          method: op.method,
          quoteId: op.quoteId,
          quote: op.quoteId,
          state: observedState,
          request: methodData.invoice ?? op.quoteId,
          amount: normalizeStoredAmount(op.amount) ?? '0',
          unit: normalizeStoredUnit(op.unit),
          fee_reserve: normalizeStoredAmount(op.fee_reserve) ?? '0',
          expiry: existing?.expiry ?? 0,
          payment_preimage: finalizedData.preimage ?? null,
          lastObservedRemoteState: observedState,
          lastObservedRemoteStateAt: updatedAt,
          createdAt: existing?.createdAt ?? createdAt,
          updatedAt,
        });
      }
    });

  // Version 29: Remove legacy mint operations that cannot be tied to a canonical quote.
  db.version(29)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_canonical_mint_quotes: '&[mintUrl+method+quoteId], state, mintUrl, method',
      coco_cashu_melt_quotes: '&[mintUrl+method+quoteId], state, mintUrl, method',
      coco_cashu_history:
        '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
      coco_cashu_send_operations: '&id, state, mintUrl, createdAt',
      coco_cashu_melt_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
      coco_cashu_receive_operations: '&id, state, mintUrl, createdAt',
      coco_cashu_auth_sessions: '&mintUrl',
      coco_cashu_mint_operations:
        '&id, state, mintUrl, createdAt, [mintUrl+quoteId], [mintUrl+method+quoteId]',
      coco_cashu_payment_request_receive_operations: '&id, state, requestId',
      coco_cashu_payment_request_receive_attempts:
        '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
    })
    .upgrade(async (tx) => {
      await tx
        .table('coco_cashu_mint_operations')
        .toCollection()
        .filter((row: { quoteId?: string | null }) => !row.quoteId || row.quoteId.trim() === '')
        .delete();
    });

  // Version 30: Allow method-specific onchain melt quote data on existing rows.
  db.version(30).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_canonical_mint_quotes: '&[mintUrl+method+quoteId], state, mintUrl, method',
    coco_cashu_melt_quotes: '&[mintUrl+method+quoteId], state, mintUrl, method',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl, createdAt',
    coco_cashu_melt_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl, createdAt',
    coco_cashu_auth_sessions: '&mintUrl',
    coco_cashu_mint_operations:
      '&id, state, mintUrl, createdAt, [mintUrl+quoteId], [mintUrl+method+quoteId]',
    coco_cashu_payment_request_receive_operations: '&id, state, requestId',
    coco_cashu_payment_request_receive_attempts:
      '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
  });

  // Version 31: Enforce canonical quote identity uniqueness per quote kind.
  db.version(31).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_canonical_mint_quotes:
      '&[mintUrl+method+quoteId], &[mintUrl+quoteId], state, mintUrl, method',
    coco_cashu_melt_quotes: '&[mintUrl+method+quoteId], &[mintUrl+quoteId], state, mintUrl, method',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl, createdAt',
    coco_cashu_melt_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl, createdAt',
    coco_cashu_auth_sessions: '&mintUrl',
    coco_cashu_mint_operations:
      '&id, state, mintUrl, createdAt, [mintUrl+quoteId], [mintUrl+method+quoteId]',
    coco_cashu_payment_request_receive_operations: '&id, state, requestId',
    coco_cashu_payment_request_receive_attempts:
      '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
  });

  // Version 32: Add recoverable mint-swap parents and the durable operation event outbox.
  db.version(32).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_canonical_mint_quotes:
      '&[mintUrl+method+quoteId], &[mintUrl+quoteId], state, mintUrl, method',
    coco_cashu_melt_quotes: '&[mintUrl+method+quoteId], &[mintUrl+quoteId], state, mintUrl, method',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl, createdAt',
    coco_cashu_melt_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl, createdAt',
    coco_cashu_auth_sessions: '&mintUrl',
    coco_cashu_mint_operations:
      '&id, state, mintUrl, createdAt, [mintUrl+quoteId], [mintUrl+method+quoteId]',
    coco_cashu_payment_request_receive_operations: '&id, state, requestId',
    coco_cashu_payment_request_receive_attempts:
      '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
    coco_cashu_mint_swap_operations:
      '&id, state, revision, &destinationMintOperationId, &sourceMeltOperationId, nextAttemptAt, [state+nextAttemptAt], createdAt',
    coco_cashu_operation_event_outbox:
      '&id, &[operationId+revision+eventType], publishedAt, nextAttemptAt, [publishedAt+nextAttemptAt], createdAt',
  });

  // Version 33: Index durable ownership of mint-swap child operations.
  db.version(33).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs:
      '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], state, mintUrl, unit, id, usedByOperationId, createdByOperationId',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_canonical_mint_quotes:
      '&[mintUrl+method+quoteId], &[mintUrl+quoteId], state, mintUrl, method',
    coco_cashu_melt_quotes: '&[mintUrl+method+quoteId], &[mintUrl+quoteId], state, mintUrl, method',
    coco_cashu_history:
      '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
    coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    coco_cashu_send_operations: '&id, state, mintUrl, createdAt',
    coco_cashu_melt_operations:
      '&id, state, mintUrl, createdAt, parentSwapOperationId, [mintUrl+quoteId]',
    coco_cashu_receive_operations: '&id, state, mintUrl, createdAt',
    coco_cashu_auth_sessions: '&mintUrl',
    coco_cashu_mint_operations:
      '&id, state, mintUrl, createdAt, parentSwapOperationId, [mintUrl+quoteId], [mintUrl+method+quoteId]',
    coco_cashu_payment_request_receive_operations: '&id, state, requestId',
    coco_cashu_payment_request_receive_attempts:
      '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
    coco_cashu_mint_swap_operations:
      '&id, state, revision, &destinationMintOperationId, &sourceMeltOperationId, nextAttemptAt, [state+nextAttemptAt], createdAt',
    coco_cashu_operation_event_outbox:
      '&id, &[operationId+revision+eventType], publishedAt, nextAttemptAt, [publishedAt+nextAttemptAt], createdAt',
  });
}
