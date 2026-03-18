/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { describe, expect, it } from 'bun:test';
import type {
  CounterRow,
  HistoryRow,
  MeltOperationRow,
  MeltQuoteRow,
  MintQuoteRow,
  ProofRow,
  SendOperationRow,
} from './lib/db.ts';
import {
  detectIndexedDbMintUrlStorageIssues,
  repairIndexedDbMintUrlStorageIssues,
} from './index.ts';

const normalizedMintUrl = 'https://mint.test';
const rawMintUrl = 'https://MINT.TEST:443/';

type MintUrlRow = { mintUrl: string; [key: string]: unknown };
type TableName =
  | 'coco_cashu_mints'
  | 'coco_cashu_counters'
  | 'coco_cashu_proofs'
  | 'coco_cashu_mint_quotes'
  | 'coco_cashu_melt_quotes'
  | 'coco_cashu_history'
  | 'coco_cashu_send_operations'
  | 'coco_cashu_melt_operations';
type TableState = Record<TableName, MintUrlRow[]>;

function cloneRow<T extends MintUrlRow>(row: T): T {
  return { ...row };
}

function createTableState(overrides: Partial<TableState>): TableState {
  return {
    coco_cashu_mints: (overrides.coco_cashu_mints ?? []).map((row) => cloneRow(row)),
    coco_cashu_counters: (overrides.coco_cashu_counters ?? []).map((row) => cloneRow(row)),
    coco_cashu_proofs: (overrides.coco_cashu_proofs ?? []).map((row) => cloneRow(row)),
    coco_cashu_mint_quotes: (overrides.coco_cashu_mint_quotes ?? []).map((row) => cloneRow(row)),
    coco_cashu_melt_quotes: (overrides.coco_cashu_melt_quotes ?? []).map((row) => cloneRow(row)),
    coco_cashu_history: (overrides.coco_cashu_history ?? []).map((row) => cloneRow(row)),
    coco_cashu_send_operations: (overrides.coco_cashu_send_operations ?? []).map((row) =>
      cloneRow(row),
    ),
    coco_cashu_melt_operations: (overrides.coco_cashu_melt_operations ?? []).map((row) =>
      cloneRow(row),
    ),
  };
}

function createKey(tableName: TableName, row: MintUrlRow): string {
  switch (tableName) {
    case 'coco_cashu_mints':
      return row.mintUrl;
    case 'coco_cashu_counters':
      return `${row.mintUrl}::${String(row.keysetId)}`;
    case 'coco_cashu_proofs':
      return `${row.mintUrl}::${String(row.secret)}`;
    case 'coco_cashu_mint_quotes':
      return `${row.mintUrl}::${String(row.quote)}`;
    case 'coco_cashu_melt_quotes':
      return `${row.mintUrl}::${String(row.quote)}`;
    case 'coco_cashu_history':
      return String(row.id);
    case 'coco_cashu_send_operations':
      return String(row.id);
    case 'coco_cashu_melt_operations':
      return String(row.id);
  }
}

function createDb(overrides: Partial<TableState>) {
  const state = createTableState(overrides);

  const db = {
    async runTransaction(
      _mode: 'r' | 'rw',
      _stores: string[],
      fn: (tx: { table: (name: string) => unknown }) => Promise<unknown>,
    ) {
      return fn({
        table(name: string) {
          const tableName = name as TableName;
          return {
            async toArray() {
              return state[tableName].map((row) => cloneRow(row));
            },
            async get(key: unknown) {
              const match = state[tableName].find((row) => {
                if (typeof key === 'string' || typeof key === 'number') {
                  return createKey(tableName, row) === String(key);
                }
                if (Array.isArray(key)) {
                  return createKey(tableName, row) === key.map(String).join('::');
                }
                return false;
              });
              return match ? cloneRow(match) : undefined;
            },
            async put(value: MintUrlRow) {
              const key = createKey(tableName, value);
              const index = state[tableName].findIndex((row) => createKey(tableName, row) === key);
              if (index >= 0) {
                state[tableName][index] = cloneRow(value);
              } else {
                state[tableName].push(cloneRow(value));
              }
            },
            async delete(key: unknown) {
              const normalizedKey = Array.isArray(key) ? key.map(String).join('::') : String(key);
              state[tableName] = state[tableName].filter(
                (row) => createKey(tableName, row) !== normalizedKey,
              );
            },
          };
        },
      });
    },
  };

  return { db, state };
}

function bySecret(a: ProofRow, b: ProofRow): number {
  return a.secret.localeCompare(b.secret);
}

describe('IndexedDB mint URL repair helpers', () => {
  it('detects non-canonical rows across quote and operation tables', async () => {
    const { db } = createDb({
      coco_cashu_mints: [{ mintUrl: normalizedMintUrl, name: 'Mint' }],
      coco_cashu_counters: [{ mintUrl: rawMintUrl, keysetId: 'keyset-1', counter: 2 }],
      coco_cashu_proofs: [
        {
          mintUrl: rawMintUrl,
          secret: 'secret-1',
          id: 'keyset-1',
          amount: 10,
          C: 'C1',
          state: 'ready',
          createdAt: 1,
        },
      ],
      coco_cashu_mint_quotes: [
        {
          mintUrl: rawMintUrl,
          quote: 'mint-quote-1',
          state: 'PAID',
          request: 'lnbc1mint',
          amount: 21,
          unit: 'sat',
          expiry: 10,
          pubkey: null,
        },
      ],
      coco_cashu_melt_quotes: [
        {
          mintUrl: rawMintUrl,
          quote: 'melt-quote-1',
          state: 'PENDING',
          request: 'lnbc1melt',
          amount: 34,
          unit: 'sat',
          expiry: 20,
          fee_reserve: 3,
          payment_preimage: null,
        },
      ],
      coco_cashu_history: [
        {
          id: 1,
          mintUrl: rawMintUrl,
          type: 'mint',
          unit: 'sat',
          amount: 21,
          createdAt: 1,
          quoteId: 'mint-quote-1',
          state: 'PAID',
          paymentRequest: 'lnbc1mint',
        },
      ],
      coco_cashu_send_operations: [
        {
          id: 'send-op-1',
          mintUrl: rawMintUrl,
          amount: 55,
          state: 'init',
          createdAt: 1,
          updatedAt: 1,
          method: 'default',
          methodDataJson: '{}',
        },
      ],
      coco_cashu_melt_operations: [
        {
          id: 'melt-op-1',
          mintUrl: rawMintUrl,
          state: 'prepared',
          createdAt: 1,
          updatedAt: 1,
          method: 'bolt11',
          methodDataJson: '{}',
          quoteId: 'melt-quote-1',
          amount: 89,
          fee_reserve: 5,
          swap_fee: 0,
          needsSwap: 0,
          inputAmount: 89,
          inputProofSecretsJson: '[]',
          changeOutputDataJson: '{"keep":[],"send":[]}',
          swapOutputDataJson: null,
        },
      ],
    });

    const report = await detectIndexedDbMintUrlStorageIssues(db as any);

    expect(report.issueCount).toBe(7);
    expect(report.repairableIssueCount).toBe(7);
    expect(report.issues).toEqual([
      {
        table: 'coco_cashu_counters',
        mintUrl: rawMintUrl,
        normalizedMintUrl,
        rowCount: 1,
        repairable: true,
        reason: undefined,
      },
      {
        table: 'coco_cashu_history',
        mintUrl: rawMintUrl,
        normalizedMintUrl,
        rowCount: 1,
        repairable: true,
        reason: undefined,
      },
      {
        table: 'coco_cashu_melt_operations',
        mintUrl: rawMintUrl,
        normalizedMintUrl,
        rowCount: 1,
        repairable: true,
        reason: undefined,
      },
      {
        table: 'coco_cashu_melt_quotes',
        mintUrl: rawMintUrl,
        normalizedMintUrl,
        rowCount: 1,
        repairable: true,
        reason: undefined,
      },
      {
        table: 'coco_cashu_mint_quotes',
        mintUrl: rawMintUrl,
        normalizedMintUrl,
        rowCount: 1,
        repairable: true,
        reason: undefined,
      },
      {
        table: 'coco_cashu_proofs',
        mintUrl: rawMintUrl,
        normalizedMintUrl,
        rowCount: 1,
        repairable: true,
        reason: undefined,
      },
      {
        table: 'coco_cashu_send_operations',
        mintUrl: rawMintUrl,
        normalizedMintUrl,
        rowCount: 1,
        repairable: true,
        reason: undefined,
      },
    ]);
  });

  it('repairs counters, quotes, and operations conservatively', async () => {
    const { db, state } = createDb({
      coco_cashu_mints: [{ mintUrl: normalizedMintUrl, name: 'Mint' }],
      coco_cashu_counters: [
        { mintUrl: normalizedMintUrl, keysetId: 'keyset-1', counter: 5 },
        { mintUrl: rawMintUrl, keysetId: 'keyset-1', counter: 7 },
      ],
      coco_cashu_proofs: [
        {
          mintUrl: rawMintUrl,
          id: 'keyset-1',
          amount: 11,
          secret: 'move-me',
          C: 'C-move',
          state: 'ready',
          createdAt: 1,
        },
        {
          mintUrl: normalizedMintUrl,
          id: 'keyset-1',
          amount: 12,
          secret: 'dup-proof',
          C: 'C-dup',
          state: 'ready',
          createdAt: 5,
        },
        {
          mintUrl: rawMintUrl,
          id: 'keyset-1',
          amount: 12,
          secret: 'dup-proof',
          C: 'C-dup',
          state: 'ready',
          createdAt: 2,
        },
        {
          mintUrl: normalizedMintUrl,
          id: 'keyset-1',
          amount: 13,
          secret: 'conflict-proof',
          C: 'C-normalized',
          state: 'ready',
          createdAt: 1,
        },
        {
          mintUrl: rawMintUrl,
          id: 'keyset-1',
          amount: 13,
          secret: 'conflict-proof',
          C: 'C-raw',
          state: 'ready',
          createdAt: 2,
        },
      ],
      coco_cashu_mint_quotes: [
        {
          mintUrl: rawMintUrl,
          quote: 'mint-quote-1',
          state: 'PAID',
          request: 'lnbc1mint',
          amount: 21,
          unit: 'sat',
          expiry: 10,
          pubkey: null,
        },
      ],
      coco_cashu_melt_quotes: [
        {
          mintUrl: rawMintUrl,
          quote: 'melt-quote-1',
          state: 'PENDING',
          request: 'lnbc1melt',
          amount: 34,
          unit: 'sat',
          expiry: 20,
          fee_reserve: 3,
          payment_preimage: null,
        },
      ],
      coco_cashu_history: [
        {
          id: 1,
          mintUrl: rawMintUrl,
          type: 'mint',
          unit: 'sat',
          amount: 21,
          createdAt: 1,
          quoteId: 'mint-quote-1',
          state: 'PAID',
          paymentRequest: 'lnbc1mint',
        },
        {
          id: 2,
          mintUrl: normalizedMintUrl,
          type: 'send',
          unit: 'sat',
          amount: 55,
          createdAt: 5,
          operationId: 'send-op-1',
          state: 'pending',
          tokenJson: '{"token":"normalized"}',
        },
        {
          id: 3,
          mintUrl: rawMintUrl,
          type: 'send',
          unit: 'sat',
          amount: 55,
          createdAt: 2,
          operationId: 'send-op-1',
          state: 'pending',
          tokenJson: '{"token":"normalized"}',
        },
        {
          id: 4,
          mintUrl: normalizedMintUrl,
          type: 'mint',
          unit: 'sat',
          amount: 99,
          createdAt: 3,
          quoteId: 'history-conflict',
          state: 'PAID',
          paymentRequest: 'lnbc1existing',
        },
        {
          id: 5,
          mintUrl: rawMintUrl,
          type: 'mint',
          unit: 'sat',
          amount: 100,
          createdAt: 4,
          quoteId: 'history-conflict',
          state: 'ISSUED',
          paymentRequest: 'lnbc1raw',
        },
      ],
      coco_cashu_send_operations: [
        {
          id: 'send-op-1',
          mintUrl: rawMintUrl,
          amount: 55,
          state: 'init',
          createdAt: 1,
          updatedAt: 1,
          method: 'default',
          methodDataJson: '{}',
        },
      ],
      coco_cashu_melt_operations: [
        {
          id: 'melt-op-1',
          mintUrl: rawMintUrl,
          state: 'prepared',
          createdAt: 1,
          updatedAt: 1,
          method: 'bolt11',
          methodDataJson: '{}',
          quoteId: 'melt-quote-1',
          amount: 89,
          fee_reserve: 5,
          swap_fee: 0,
          needsSwap: 0,
          inputAmount: 89,
          inputProofSecretsJson: '[]',
          changeOutputDataJson: '{"keep":[],"send":[]}',
          swapOutputDataJson: null,
        },
      ],
    });

    const dryRunReport = await repairIndexedDbMintUrlStorageIssues(db as any);

    expect(dryRunReport.dryRun).toBe(true);
    expect(dryRunReport.updatedRows).toBe(9);
    expect(dryRunReport.deletedRows).toBe(3);
    expect(dryRunReport.skippedRows).toBe(2);
    expect(state.coco_cashu_counters).toHaveLength(2);

    const report = await repairIndexedDbMintUrlStorageIssues(db as any, { dryRun: false });

    expect(report.dryRun).toBe(false);
    expect(state.coco_cashu_counters).toEqual([
      { mintUrl: normalizedMintUrl, keysetId: 'keyset-1', counter: 7 },
    ] satisfies CounterRow[]);
    expect([...(state.coco_cashu_proofs as unknown as ProofRow[])].sort(bySecret)).toEqual([
      {
        mintUrl: normalizedMintUrl,
        id: 'keyset-1',
        amount: 13,
        secret: 'conflict-proof',
        C: 'C-normalized',
        state: 'ready',
        createdAt: 1,
      },
      {
        mintUrl: rawMintUrl,
        id: 'keyset-1',
        amount: 13,
        secret: 'conflict-proof',
        C: 'C-raw',
        state: 'ready',
        createdAt: 2,
      },
      {
        mintUrl: normalizedMintUrl,
        id: 'keyset-1',
        amount: 12,
        secret: 'dup-proof',
        C: 'C-dup',
        state: 'ready',
        createdAt: 2,
      },
      {
        mintUrl: normalizedMintUrl,
        id: 'keyset-1',
        amount: 11,
        secret: 'move-me',
        C: 'C-move',
        state: 'ready',
        createdAt: 1,
      },
    ] satisfies ProofRow[]);
    expect(state.coco_cashu_mint_quotes).toEqual([
      {
        mintUrl: normalizedMintUrl,
        quote: 'mint-quote-1',
        state: 'PAID',
        request: 'lnbc1mint',
        amount: 21,
        unit: 'sat',
        expiry: 10,
        pubkey: null,
      },
    ] satisfies MintQuoteRow[]);
    expect(state.coco_cashu_melt_quotes).toEqual([
      {
        mintUrl: normalizedMintUrl,
        quote: 'melt-quote-1',
        state: 'PENDING',
        request: 'lnbc1melt',
        amount: 34,
        unit: 'sat',
        expiry: 20,
        fee_reserve: 3,
        payment_preimage: null,
      },
    ] satisfies MeltQuoteRow[]);
    expect(state.coco_cashu_history).toEqual([
      {
        id: 1,
        mintUrl: normalizedMintUrl,
        type: 'mint',
        unit: 'sat',
        amount: 21,
        createdAt: 1,
        quoteId: 'mint-quote-1',
        state: 'PAID',
        paymentRequest: 'lnbc1mint',
      },
      {
        id: 2,
        mintUrl: normalizedMintUrl,
        type: 'send',
        unit: 'sat',
        amount: 55,
        createdAt: 2,
        operationId: 'send-op-1',
        state: 'pending',
        tokenJson: '{"token":"normalized"}',
      },
      {
        id: 4,
        mintUrl: normalizedMintUrl,
        type: 'mint',
        unit: 'sat',
        amount: 99,
        createdAt: 3,
        quoteId: 'history-conflict',
        state: 'PAID',
        paymentRequest: 'lnbc1existing',
      },
      {
        id: 5,
        mintUrl: rawMintUrl,
        type: 'mint',
        unit: 'sat',
        amount: 100,
        createdAt: 4,
        quoteId: 'history-conflict',
        state: 'ISSUED',
        paymentRequest: 'lnbc1raw',
      },
    ] satisfies HistoryRow[]);
    expect(state.coco_cashu_send_operations).toEqual([
      {
        id: 'send-op-1',
        mintUrl: normalizedMintUrl,
        amount: 55,
        state: 'init',
        createdAt: 1,
        updatedAt: 1,
        method: 'default',
        methodDataJson: '{}',
      },
    ] satisfies SendOperationRow[]);
    expect(state.coco_cashu_melt_operations).toEqual([
      {
        id: 'melt-op-1',
        mintUrl: normalizedMintUrl,
        state: 'prepared',
        createdAt: 1,
        updatedAt: 1,
        method: 'bolt11',
        methodDataJson: '{}',
        quoteId: 'melt-quote-1',
        amount: 89,
        fee_reserve: 5,
        swap_fee: 0,
        needsSwap: 0,
        inputAmount: 89,
        inputProofSecretsJson: '[]',
        changeOutputDataJson: '{"keep":[],"send":[]}',
        swapOutputDataJson: null,
      },
    ] satisfies MeltOperationRow[]);
  });

  it('treats missing optional proof fields as equivalent to null when merging duplicates', async () => {
    const { db, state } = createDb({
      coco_cashu_mints: [{ mintUrl: normalizedMintUrl, name: 'Mint' }],
      coco_cashu_proofs: [
        {
          mintUrl: normalizedMintUrl,
          id: 'keyset-1',
          amount: 12,
          secret: 'dup-proof',
          C: 'C-dup',
          dleqJson: null,
          witness: null,
          state: 'ready',
          createdAt: 5,
          usedByOperationId: null,
          createdByOperationId: null,
        },
        {
          mintUrl: rawMintUrl,
          id: 'keyset-1',
          amount: 12,
          secret: 'dup-proof',
          C: 'C-dup',
          state: 'ready',
          createdAt: 2,
        },
      ],
    });

    const report = await repairIndexedDbMintUrlStorageIssues(db as any, { dryRun: false });

    expect(report.skippedRows).toBe(0);
    expect(report.conflictRows).toBe(0);
    expect(report.deletedRows).toBe(1);
    expect([...(state.coco_cashu_proofs as unknown as ProofRow[])]).toEqual([
      {
        mintUrl: normalizedMintUrl,
        id: 'keyset-1',
        amount: 12,
        secret: 'dup-proof',
        C: 'C-dup',
        dleqJson: null,
        witness: null,
        state: 'ready',
        createdAt: 2,
        usedByOperationId: null,
        createdByOperationId: null,
      },
    ] satisfies ProofRow[]);
  });

  it('lets callers retry skipped rows after the canonical mint record is restored', async () => {
    const { db, state } = createDb({
      coco_cashu_counters: [{ mintUrl: rawMintUrl, keysetId: 'keyset-1', counter: 4 }],
    });

    const initialReport = await repairIndexedDbMintUrlStorageIssues(db as any, { dryRun: false });

    expect(initialReport.skippedRows).toBe(1);
    expect(state.coco_cashu_counters).toEqual([
      { mintUrl: rawMintUrl, keysetId: 'keyset-1', counter: 4 },
    ] satisfies CounterRow[]);

    state.coco_cashu_mints.push({ mintUrl: normalizedMintUrl, name: 'Mint' });

    const retryReport = await repairIndexedDbMintUrlStorageIssues(db as any, { dryRun: false });

    expect(retryReport.skippedRows).toBe(0);
    expect(state.coco_cashu_counters).toEqual([
      { mintUrl: normalizedMintUrl, keysetId: 'keyset-1', counter: 4 },
    ] satisfies CounterRow[]);
  });
});
