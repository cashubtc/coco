/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
// @ts-ignore bun:sqlite types are provided by the runtime in this workspace.
import { Database } from 'bun:sqlite';
import {
  ExpoSqliteDb,
  ExpoCounterRepository,
  ExpoMintRepository,
  ExpoProofRepository,
  ensureSchema,
  ensureSchemaUpTo,
  repairExpoSqliteMintUrlStorageIssues,
} from '../index.ts';

type RunResult = { changes: number; lastInsertRowId: number; lastInsertRowid: number };

class BunExpoSqliteDatabaseShim {
  private readonly db: Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
  }

  async execAsync(sql: string): Promise<void> {
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statementSql of statements) {
      this.db.prepare(statementSql).run();
    }
  }

  async runAsync(sql: string, ...params: any[]): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...params) as unknown as {
      changes?: number;
      lastInsertRowid?: number;
    };

    const changes = Number(result?.changes ?? 0);
    const lastInsertRowId = Number(result?.lastInsertRowid ?? 0);
    return { changes, lastInsertRowId, lastInsertRowid: lastInsertRowId };
  }

  async getFirstAsync<T = unknown>(sql: string, ...params: any[]): Promise<T | null> {
    const row = this.db.prepare(sql).get(...params) as T | undefined;
    return row ?? null;
  }

  async getAllAsync<T = unknown>(sql: string, ...params: any[]): Promise<T[]> {
    const rows = this.db.prepare(sql).all(...params) as T[] | undefined;
    return rows ?? [];
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }
}

const normalizedMintUrl = 'https://mint.test';
const rawMintUrl = 'https://MINT.TEST:443/';
const repairMigrationId = '018_repair_noncanonical_proof_and_counter_urls';

describe('expo-sqlite mint URL repair migration', () => {
  let database: BunExpoSqliteDatabaseShim;
  let db: ExpoSqliteDb;

  beforeEach(async () => {
    database = new BunExpoSqliteDatabaseShim();
    db = new ExpoSqliteDb({ database: database as any });
    await ensureSchemaUpTo(db, repairMigrationId);
  });

  afterEach(async () => {
    await db.raw.closeAsync?.();
  });

  async function insertMint(mintUrl: string): Promise<void> {
    await db.run(
      'INSERT INTO coco_cashu_mints (mintUrl, name, mintInfo, trusted, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      [mintUrl, 'Mint', '{}', 1, 1, 1],
    );
  }

  async function insertCounter(mintUrl: string, keysetId: string, counter: number): Promise<void> {
    await db.run('INSERT INTO coco_cashu_counters (mintUrl, keysetId, counter) VALUES (?, ?, ?)', [
      mintUrl,
      keysetId,
      counter,
    ]);
  }

  async function insertProof(params: {
    mintUrl: string;
    secret: string;
    amount: number;
    C: string;
    createdAt: number;
  }): Promise<void> {
    await db.run(
      'INSERT INTO coco_cashu_proofs (mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, createdAt, usedByOperationId, createdByOperationId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        params.mintUrl,
        'keyset-1',
        params.amount,
        params.secret,
        params.C,
        null,
        null,
        'ready',
        params.createdAt,
        null,
        null,
      ],
    );
  }

  async function insertMintQuote(mintUrl: string, quote: string): Promise<void> {
    await db.run(
      'INSERT INTO coco_cashu_mint_quotes (mintUrl, quote, state, request, amount, unit, expiry, pubkey) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [mintUrl, quote, 'PAID', 'lnbc1mint', 21, 'sat', 10, null],
    );
  }

  async function insertMeltQuote(mintUrl: string, quote: string): Promise<void> {
    await db.run(
      'INSERT INTO coco_cashu_melt_quotes (mintUrl, quote, state, request, amount, unit, expiry, fee_reserve, payment_preimage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [mintUrl, quote, 'PENDING', 'lnbc1melt', 34, 'sat', 20, 3, null],
    );
  }

  async function insertSendOperation(mintUrl: string, id: string): Promise<void> {
    await db.run(
      'INSERT INTO coco_cashu_send_operations (id, mintUrl, amount, state, createdAt, updatedAt, error, needsSwap, fee, inputAmount, inputProofSecretsJson, outputDataJson, method, methodDataJson, tokenJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, mintUrl, 55, 'init', 1, 1, null, null, null, null, null, null, 'default', '{}', null],
    );
  }

  async function insertMeltOperation(mintUrl: string, id: string, quoteId: string): Promise<void> {
    await db.run(
      'INSERT INTO coco_cashu_melt_operations (id, mintUrl, state, createdAt, updatedAt, error, method, methodDataJson, quoteId, amount, fee_reserve, swap_fee, needsSwap, inputAmount, inputProofSecretsJson, changeOutputDataJson, swapOutputDataJson, changeAmount, effectiveFee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        mintUrl,
        'prepared',
        1,
        1,
        null,
        'bolt11',
        '{}',
        quoteId,
        89,
        5,
        0,
        0,
        89,
        '[]',
        '{"keep":[],"send":[]}',
        null,
        null,
        null,
      ],
    );
  }

  async function insertHistoryEntry(params: {
    mintUrl: string;
    type: 'mint' | 'send';
    amount: number;
    createdAt: number;
    quoteId?: string | null;
    state?: string | null;
    paymentRequest?: string | null;
    operationId?: string | null;
    tokenJson?: string | null;
  }): Promise<void> {
    await db.run(
      'INSERT INTO coco_cashu_history (mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        params.mintUrl,
        params.type,
        'sat',
        params.amount,
        params.createdAt,
        params.quoteId ?? null,
        params.state ?? null,
        params.paymentRequest ?? null,
        params.tokenJson ?? null,
        null,
        params.operationId ?? null,
      ],
    );
  }

  it('repairs non-canonical counters and proofs during migration', async () => {
    await insertMint(normalizedMintUrl);
    await insertCounter(normalizedMintUrl, 'keyset-1', 5);
    await insertCounter(rawMintUrl, 'keyset-1', 7);
    await insertMintQuote(rawMintUrl, 'mint-quote-1');
    await insertMeltQuote(rawMintUrl, 'melt-quote-1');
    await insertSendOperation(rawMintUrl, 'send-op-1');
    await insertMeltOperation(rawMintUrl, 'melt-op-1', 'melt-quote-1');
    await insertHistoryEntry({
      mintUrl: rawMintUrl,
      type: 'mint',
      amount: 21,
      createdAt: 1,
      quoteId: 'mint-quote-1',
      state: 'PAID',
      paymentRequest: 'lnbc1mint',
    });
    await insertHistoryEntry({
      mintUrl: rawMintUrl,
      type: 'send',
      amount: 55,
      createdAt: 2,
      operationId: 'send-op-1',
      state: 'pending',
      tokenJson: '{"token":"pending"}',
    });
    await insertProof({
      mintUrl: rawMintUrl,
      secret: 'move-me',
      amount: 11,
      C: 'C-move',
      createdAt: 1,
    });
    await insertProof({
      mintUrl: normalizedMintUrl,
      secret: 'dup-proof',
      amount: 12,
      C: 'C-dup',
      createdAt: 5,
    });
    await insertProof({
      mintUrl: rawMintUrl,
      secret: 'dup-proof',
      amount: 12,
      C: 'C-dup',
      createdAt: 2,
    });

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      await ensureSchema(db);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnSpy).not.toHaveBeenCalled();
    const normalizedCounter = await db.get(
      'SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?',
      [normalizedMintUrl, 'keyset-1'],
    );
    const rawCounter = await db.get(
      'SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?',
      [rawMintUrl, 'keyset-1'],
    );
    const movedProof = await db.get(
      'SELECT mintUrl, createdAt FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      [normalizedMintUrl, 'move-me'],
    );
    const mergedDuplicate = await db.get(
      'SELECT mintUrl, createdAt FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      [normalizedMintUrl, 'dup-proof'],
    );
    const removedDuplicate = await db.get(
      'SELECT mintUrl FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      [rawMintUrl, 'dup-proof'],
    );
    const movedMintQuote = await db.get(
      'SELECT mintUrl FROM coco_cashu_mint_quotes WHERE mintUrl = ? AND quote = ?',
      [normalizedMintUrl, 'mint-quote-1'],
    );
    const movedMeltQuote = await db.get(
      'SELECT mintUrl FROM coco_cashu_melt_quotes WHERE mintUrl = ? AND quote = ?',
      [normalizedMintUrl, 'melt-quote-1'],
    );
    const movedSendOperation = await db.get(
      'SELECT mintUrl FROM coco_cashu_send_operations WHERE id = ?',
      ['send-op-1'],
    );
    const movedMeltOperation = await db.get(
      'SELECT mintUrl, quoteId FROM coco_cashu_melt_operations WHERE id = ?',
      ['melt-op-1'],
    );
    const movedMintHistory = await db.get(
      'SELECT mintUrl FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = ?',
      [normalizedMintUrl, 'mint-quote-1', 'mint'],
    );
    const movedSendHistory = await db.get(
      'SELECT mintUrl FROM coco_cashu_history WHERE mintUrl = ? AND operationId = ? AND type = ?',
      [normalizedMintUrl, 'send-op-1', 'send'],
    );

    expect(normalizedCounter).toEqual({ counter: 7 });
    expect(rawCounter == null).toBe(true);
    expect(movedProof).toEqual({ mintUrl: normalizedMintUrl, createdAt: 1 });
    expect(mergedDuplicate).toEqual({ mintUrl: normalizedMintUrl, createdAt: 2 });
    expect(removedDuplicate == null).toBe(true);
    expect(movedMintQuote).toEqual({ mintUrl: normalizedMintUrl });
    expect(movedMeltQuote).toEqual({ mintUrl: normalizedMintUrl });
    expect(movedMintHistory).toEqual({ mintUrl: normalizedMintUrl });
    expect(movedSendHistory).toEqual({ mintUrl: normalizedMintUrl });
    expect(movedSendOperation).toEqual({ mintUrl: normalizedMintUrl });
    expect(movedMeltOperation).toEqual({ mintUrl: normalizedMintUrl, quoteId: 'melt-quote-1' });
  });

  it('preserves conflicting proof rows and warns for manual inspection', async () => {
    await insertMint(normalizedMintUrl);
    await insertProof({
      mintUrl: normalizedMintUrl,
      secret: 'conflict-proof',
      amount: 13,
      C: 'C-normalized',
      createdAt: 1,
    });
    await insertProof({
      mintUrl: rawMintUrl,
      secret: 'conflict-proof',
      amount: 13,
      C: 'C-raw',
      createdAt: 2,
    });

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      await ensureSchema(db);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String((warnSpy as any).mock.calls[0]?.[0] ?? '')).toContain(
      'left 1 issue(s) affecting 1 row(s)',
    );

    const normalizedProof = await db.get(
      'SELECT mintUrl, C FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      [normalizedMintUrl, 'conflict-proof'],
    );
    const rawProof = await db.get(
      'SELECT mintUrl, C FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      [rawMintUrl, 'conflict-proof'],
    );

    expect(normalizedProof).toEqual({ mintUrl: normalizedMintUrl, C: 'C-normalized' });
    expect(rawProof).toEqual({ mintUrl: rawMintUrl, C: 'C-raw' });
  });

  it('lets callers retry skipped rows after the canonical mint record is restored', async () => {
    await insertCounter(rawMintUrl, 'keyset-1', 4);
    await insertHistoryEntry({
      mintUrl: rawMintUrl,
      type: 'mint',
      amount: 21,
      createdAt: 1,
      quoteId: 'mint-quote-1',
      state: 'PAID',
      paymentRequest: 'lnbc1mint',
    });

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      await ensureSchema(db);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String((warnSpy as any).mock.calls[0]?.[0] ?? '')).toContain(
      'left 2 issue(s) affecting 2 row(s)',
    );

    const rawCounter = await db.get(
      'SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?',
      [rawMintUrl, 'keyset-1'],
    );
    expect(rawCounter).toEqual({ counter: 4 });

    await insertMint(normalizedMintUrl);

    const repairReport = await repairExpoSqliteMintUrlStorageIssues(db, { dryRun: false });

    expect(repairReport.skippedRows).toBe(0);

    const normalizedCounter = await db.get(
      'SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?',
      [normalizedMintUrl, 'keyset-1'],
    );
    const normalizedHistory = await db.get(
      'SELECT mintUrl FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = ?',
      [normalizedMintUrl, 'mint-quote-1', 'mint'],
    );
    const removedRawCounter = await db.get(
      'SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?',
      [rawMintUrl, 'keyset-1'],
    );
    const removedRawHistory = await db.get(
      'SELECT mintUrl FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = ?',
      [rawMintUrl, 'mint-quote-1', 'mint'],
    );

    expect(normalizedCounter).toEqual({ counter: 4 });
    expect(normalizedHistory).toEqual({ mintUrl: normalizedMintUrl });
    expect(removedRawCounter == null).toBe(true);
    expect(removedRawHistory == null).toBe(true);
  });

  it('repairs skipped proof and counter rows when a mint is restored through the repository', async () => {
    await insertCounter(rawMintUrl, 'keyset-1', 4);
    await insertProof({
      mintUrl: rawMintUrl,
      secret: 'restore-proof',
      amount: 12,
      C: 'C-restore',
      createdAt: 2,
    });

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      await ensureSchema(db);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);

    const rawCounter = await db.get(
      'SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?',
      [rawMintUrl, 'keyset-1'],
    );
    expect(rawCounter).toEqual({ counter: 4 });

    const mintRepo = new ExpoMintRepository(db);
    const counterRepo = new ExpoCounterRepository(db);
    const proofRepo = new ExpoProofRepository(db);

    await mintRepo.addOrUpdateMint({
      mintUrl: normalizedMintUrl,
      name: 'Mint',
      mintInfo: {} as any,
      trusted: true,
      createdAt: 1,
      updatedAt: 1,
    });

    const normalizedCounter = await counterRepo.getCounter(normalizedMintUrl, 'keyset-1');
    const normalizedProofs = await proofRepo.getReadyProofs(normalizedMintUrl);
    const removedRawCounter = await db.get(
      'SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?',
      [rawMintUrl, 'keyset-1'],
    );
    const removedRawProof = await db.get(
      'SELECT mintUrl FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      [rawMintUrl, 'restore-proof'],
    );

    expect(normalizedCounter).toEqual({
      mintUrl: normalizedMintUrl,
      keysetId: 'keyset-1',
      counter: 4,
    });
    expect(normalizedProofs).toEqual([
      expect.objectContaining({
        mintUrl: normalizedMintUrl,
        secret: 'restore-proof',
        amount: 12,
        C: 'C-restore',
      }),
    ]);
    expect(removedRawCounter == null).toBe(true);
    expect(removedRawProof == null).toBe(true);
  });

  it('treats null and missing optional proof fields as equivalent when merging duplicates', async () => {
    await insertMint(normalizedMintUrl);
    await db.run(
      'INSERT INTO coco_cashu_proofs (mintUrl, id, amount, secret, C, state, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [rawMintUrl, 'keyset-1', 12, 'dup-proof', 'C-dup', 'ready', 2],
    );
    await insertProof({
      mintUrl: normalizedMintUrl,
      secret: 'dup-proof',
      amount: 12,
      C: 'C-dup',
      createdAt: 5,
    });

    const repairReport = await repairExpoSqliteMintUrlStorageIssues(db, { dryRun: false });

    expect(repairReport.skippedRows).toBe(0);
    expect(repairReport.conflictRows).toBe(0);

    const normalizedProof = await db.get(
      'SELECT mintUrl, createdAt FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      [normalizedMintUrl, 'dup-proof'],
    );
    const removedRawProof = await db.get(
      'SELECT mintUrl FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      [rawMintUrl, 'dup-proof'],
    );

    expect(normalizedProof).toEqual({ mintUrl: normalizedMintUrl, createdAt: 2 });
    expect(removedRawProof == null).toBe(true);
  });
});
