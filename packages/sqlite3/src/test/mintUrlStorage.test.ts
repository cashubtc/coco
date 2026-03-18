import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import {
  SqliteDb,
  ensureSchema,
  ensureSchemaUpTo,
  repairSqliteMintUrlStorageIssues,
} from '../index.ts';

const normalizedMintUrl = 'https://mint.test';
const rawMintUrl = 'https://MINT.TEST:443/';
const repairMigrationId = '018_repair_noncanonical_proof_and_counter_urls';

describe('SQLite mint URL repair migration', () => {
  let database: BetterSqlite3Database;
  let db: SqliteDb;

  beforeEach(async () => {
    database = new Database(':memory:');
    db = new SqliteDb({ database });
    await ensureSchemaUpTo(db, repairMigrationId);
  });

  afterEach(async () => {
    await db.close();
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

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ensureSchema(db);

    expect(warnSpy).not.toHaveBeenCalled();
    await expect(
      db.get('SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?', [
        normalizedMintUrl,
        'keyset-1',
      ]),
    ).resolves.toEqual({ counter: 7 });
    await expect(
      db.get('SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?', [
        rawMintUrl,
        'keyset-1',
      ]),
    ).resolves.toBeUndefined();
    await expect(
      db.get('SELECT mintUrl, createdAt FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?', [
        normalizedMintUrl,
        'move-me',
      ]),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl, createdAt: 1 });
    await expect(
      db.get('SELECT mintUrl, createdAt FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?', [
        normalizedMintUrl,
        'dup-proof',
      ]),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl, createdAt: 2 });
    await expect(
      db.get('SELECT mintUrl FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?', [
        rawMintUrl,
        'dup-proof',
      ]),
    ).resolves.toBeUndefined();
    await expect(
      db.get('SELECT mintUrl FROM coco_cashu_mint_quotes WHERE mintUrl = ? AND quote = ?', [
        normalizedMintUrl,
        'mint-quote-1',
      ]),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl });
    await expect(
      db.get('SELECT mintUrl FROM coco_cashu_melt_quotes WHERE mintUrl = ? AND quote = ?', [
        normalizedMintUrl,
        'melt-quote-1',
      ]),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl });
    await expect(
      db.get('SELECT mintUrl FROM coco_cashu_send_operations WHERE id = ?', ['send-op-1']),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl });
    await expect(
      db.get('SELECT mintUrl, quoteId FROM coco_cashu_melt_operations WHERE id = ?', ['melt-op-1']),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl, quoteId: 'melt-quote-1' });
    await expect(
      db.get('SELECT mintUrl FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = ?', [
        normalizedMintUrl,
        'mint-quote-1',
        'mint',
      ]),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl });
    await expect(
      db.get('SELECT mintUrl FROM coco_cashu_history WHERE mintUrl = ? AND operationId = ? AND type = ?', [
        normalizedMintUrl,
        'send-op-1',
        'send',
      ]),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl });

    warnSpy.mockRestore();
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

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ensureSchema(db);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('left 1 issue(s) affecting 1 row(s) for manual inspection'),
    );
    await expect(
      db.get('SELECT mintUrl, C FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?', [
        normalizedMintUrl,
        'conflict-proof',
      ]),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl, C: 'C-normalized' });
    await expect(
      db.get('SELECT mintUrl, C FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?', [
        rawMintUrl,
        'conflict-proof',
      ]),
    ).resolves.toEqual({ mintUrl: rawMintUrl, C: 'C-raw' });

    warnSpy.mockRestore();
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

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ensureSchema(db);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    await expect(
      db.get('SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?', [
        rawMintUrl,
        'keyset-1',
      ]),
    ).resolves.toEqual({ counter: 4 });

    await insertMint(normalizedMintUrl);

    const repairReport = await repairSqliteMintUrlStorageIssues(db, { dryRun: false });

    expect(repairReport.skippedRows).toBe(0);
    await expect(
      db.get('SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?', [
        normalizedMintUrl,
        'keyset-1',
      ]),
    ).resolves.toEqual({ counter: 4 });
    await expect(
      db.get('SELECT mintUrl FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = ?', [
        normalizedMintUrl,
        'mint-quote-1',
        'mint',
      ]),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl });
    await expect(
      db.get('SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?', [
        rawMintUrl,
        'keyset-1',
      ]),
    ).resolves.toBeUndefined();
    await expect(
      db.get('SELECT mintUrl FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = ?', [
        rawMintUrl,
        'mint-quote-1',
        'mint',
      ]),
    ).resolves.toBeUndefined();

    warnSpy.mockRestore();
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

    const repairReport = await repairSqliteMintUrlStorageIssues(db, { dryRun: false });

    expect(repairReport.skippedRows).toBe(0);
    expect(repairReport.conflictRows).toBe(0);
    await expect(
      db.get('SELECT mintUrl, createdAt FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?', [
        normalizedMintUrl,
        'dup-proof',
      ]),
    ).resolves.toEqual({ mintUrl: normalizedMintUrl, createdAt: 2 });
    await expect(
      db.get('SELECT mintUrl FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?', [
        rawMintUrl,
        'dup-proof',
      ]),
    ).resolves.toBeUndefined();
  });
});
