import type {
  MintBatchAttempt,
  MintBatchAttemptRepository,
  MintBatchAttemptState,
} from '@cashu/coco-core';
import { deserializeAmount, serializeAmount, stringifyJson } from '@cashu/coco-core';
import { SqliteDb, getUnixTimeSeconds } from '../db.ts';

interface MintBatchAttemptRow {
  id: string;
  mintUrl: string;
  method: MintBatchAttempt['method'];
  unit: string;
  operationIdsJson: string;
  quoteIdsJson: string;
  quoteAmountsJson: string;
  totalAmount: string | number;
  outputDataJson: string;
  keysetId: string;
  counterStart: number | null;
  counterEnd: number | null;
  state: MintBatchAttemptState;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  requestedAt: number | null;
  finalizedAt: number | null;
}

const rowToAttempt = (row: MintBatchAttemptRow): MintBatchAttempt => ({
  id: row.id,
  mintUrl: row.mintUrl,
  method: row.method,
  unit: row.unit,
  operationIds: JSON.parse(row.operationIdsJson) as string[],
  quoteIds: JSON.parse(row.quoteIdsJson) as string[],
  quoteAmounts: (JSON.parse(row.quoteAmountsJson) as Array<string | number>).map(deserializeAmount),
  totalAmount: deserializeAmount(row.totalAmount),
  outputData: JSON.parse(row.outputDataJson),
  keysetId: row.keysetId,
  ...(row.counterStart !== null ? { counterStart: row.counterStart } : {}),
  ...(row.counterEnd !== null ? { counterEnd: row.counterEnd } : {}),
  state: row.state,
  ...(row.error ? { error: row.error } : {}),
  createdAt: row.createdAt * 1000,
  updatedAt: row.updatedAt * 1000,
  ...(row.requestedAt !== null ? { requestedAt: row.requestedAt * 1000 } : {}),
  ...(row.finalizedAt !== null ? { finalizedAt: row.finalizedAt * 1000 } : {}),
});

const attemptToParams = (attempt: MintBatchAttempt): unknown[] => [
  attempt.id,
  attempt.mintUrl,
  attempt.method,
  attempt.unit,
  stringifyJson(attempt.operationIds),
  stringifyJson(attempt.quoteIds),
  stringifyJson(attempt.quoteAmounts.map(serializeAmount)),
  serializeAmount(attempt.totalAmount),
  stringifyJson(attempt.outputData),
  attempt.keysetId,
  attempt.counterStart ?? null,
  attempt.counterEnd ?? null,
  attempt.state,
  attempt.error ?? null,
  Math.floor(attempt.createdAt / 1000),
  Math.floor(attempt.updatedAt / 1000),
  attempt.requestedAt ? Math.floor(attempt.requestedAt / 1000) : null,
  attempt.finalizedAt ? Math.floor(attempt.finalizedAt / 1000) : null,
];

export class SqliteMintBatchAttemptRepository implements MintBatchAttemptRepository {
  constructor(private readonly db: SqliteDb) {}

  async create(attempt: MintBatchAttempt): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_mint_batch_attempts WHERE id = ? LIMIT 1',
      [attempt.id],
    );
    if (exists) {
      throw new Error(`MintBatchAttempt with id ${attempt.id} already exists`);
    }

    await this.db.run(
      `INSERT INTO coco_cashu_mint_batch_attempts
        (id, mintUrl, method, unit, operationIdsJson, quoteIdsJson, quoteAmountsJson, totalAmount, outputDataJson, keysetId, counterStart, counterEnd, state, error, createdAt, updatedAt, requestedAt, finalizedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attemptToParams(attempt),
    );
  }

  async update(attempt: MintBatchAttempt): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_mint_batch_attempts WHERE id = ? LIMIT 1',
      [attempt.id],
    );
    if (!exists) {
      throw new Error(`MintBatchAttempt with id ${attempt.id} not found`);
    }

    await this.db.run(
      `UPDATE coco_cashu_mint_batch_attempts
       SET mintUrl = ?, method = ?, unit = ?, operationIdsJson = ?, quoteIdsJson = ?, quoteAmountsJson = ?, totalAmount = ?, outputDataJson = ?, keysetId = ?, counterStart = ?, counterEnd = ?, state = ?, error = ?, updatedAt = ?, requestedAt = ?, finalizedAt = ?
       WHERE id = ?`,
      [
        attempt.mintUrl,
        attempt.method,
        attempt.unit,
        stringifyJson(attempt.operationIds),
        stringifyJson(attempt.quoteIds),
        stringifyJson(attempt.quoteAmounts.map(serializeAmount)),
        serializeAmount(attempt.totalAmount),
        stringifyJson(attempt.outputData),
        attempt.keysetId,
        attempt.counterStart ?? null,
        attempt.counterEnd ?? null,
        attempt.state,
        attempt.error ?? null,
        getUnixTimeSeconds(),
        attempt.requestedAt ? Math.floor(attempt.requestedAt / 1000) : null,
        attempt.finalizedAt ? Math.floor(attempt.finalizedAt / 1000) : null,
        attempt.id,
      ],
    );
  }

  async getById(id: string): Promise<MintBatchAttempt | null> {
    const row = await this.db.get<MintBatchAttemptRow>(
      'SELECT * FROM coco_cashu_mint_batch_attempts WHERE id = ?',
      [id],
    );
    return row ? rowToAttempt(row) : null;
  }

  async getByState(state: MintBatchAttemptState): Promise<MintBatchAttempt[]> {
    const rows = await this.db.all<MintBatchAttemptRow>(
      'SELECT * FROM coco_cashu_mint_batch_attempts WHERE state = ?',
      [state],
    );
    return rows.map(rowToAttempt);
  }

  async getByOperationId(operationId: string): Promise<MintBatchAttempt | null> {
    const rows = await this.db.all<MintBatchAttemptRow>(
      "SELECT * FROM coco_cashu_mint_batch_attempts WHERE state IN ('prepared', 'requesting', 'recovering', 'finalized') ORDER BY updatedAt DESC",
    );
    return rows.map(rowToAttempt).find((attempt) => attempt.operationIds.includes(operationId)) ?? null;
  }

  async getPending(): Promise<MintBatchAttempt[]> {
    const rows = await this.db.all<MintBatchAttemptRow>(
      "SELECT * FROM coco_cashu_mint_batch_attempts WHERE state IN ('prepared', 'requesting', 'recovering')",
    );
    return rows.map(rowToAttempt);
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_mint_batch_attempts WHERE id = ?', [id]);
  }
}
