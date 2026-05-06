import type {
  MintBatchAttempt,
  MintBatchAttemptRepository,
  MintBatchAttemptState,
} from '@cashu/coco-core';
import { deserializeAmount, serializeAmount, stringifyJson } from '@cashu/coco-core';
import type { IdbDb, MintBatchAttemptRow } from '../lib/db.ts';
import { getUnixTimeSeconds } from '../lib/db.ts';

const rowToAttempt = (row: MintBatchAttemptRow): MintBatchAttempt => ({
  id: row.id,
  mintUrl: row.mintUrl,
  method: row.method as MintBatchAttempt['method'],
  unit: row.unit,
  operationIds: JSON.parse(row.operationIdsJson) as string[],
  quoteIds: JSON.parse(row.quoteIdsJson) as string[],
  quoteAmounts: (JSON.parse(row.quoteAmountsJson) as Array<string | number>).map(deserializeAmount),
  totalAmount: deserializeAmount(row.totalAmount),
  outputData: JSON.parse(row.outputDataJson),
  keysetId: row.keysetId,
  ...(row.counterStart !== null && row.counterStart !== undefined
    ? { counterStart: row.counterStart }
    : {}),
  ...(row.counterEnd !== null && row.counterEnd !== undefined ? { counterEnd: row.counterEnd } : {}),
  state: row.state,
  ...(row.error ? { error: row.error } : {}),
  createdAt: row.createdAt * 1000,
  updatedAt: row.updatedAt * 1000,
  ...(row.requestedAt ? { requestedAt: row.requestedAt * 1000 } : {}),
  ...(row.finalizedAt ? { finalizedAt: row.finalizedAt * 1000 } : {}),
});

const attemptToRow = (attempt: MintBatchAttempt): MintBatchAttemptRow => ({
  id: attempt.id,
  mintUrl: attempt.mintUrl,
  method: attempt.method,
  unit: attempt.unit,
  operationIdsJson: stringifyJson(attempt.operationIds),
  quoteIdsJson: stringifyJson(attempt.quoteIds),
  quoteAmountsJson: stringifyJson(attempt.quoteAmounts.map(serializeAmount)),
  totalAmount: serializeAmount(attempt.totalAmount),
  outputDataJson: stringifyJson(attempt.outputData),
  keysetId: attempt.keysetId,
  counterStart: attempt.counterStart ?? null,
  counterEnd: attempt.counterEnd ?? null,
  state: attempt.state,
  error: attempt.error ?? null,
  createdAt: Math.floor(attempt.createdAt / 1000),
  updatedAt: Math.floor(attempt.updatedAt / 1000),
  requestedAt: attempt.requestedAt ? Math.floor(attempt.requestedAt / 1000) : null,
  finalizedAt: attempt.finalizedAt ? Math.floor(attempt.finalizedAt / 1000) : null,
});

export class IdbMintBatchAttemptRepository implements MintBatchAttemptRepository {
  constructor(private readonly db: IdbDb) {}

  async create(attempt: MintBatchAttempt): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_mint_batch_attempts'], async (tx) => {
      const table = tx.table('coco_cashu_mint_batch_attempts');
      const existing = await table.get(attempt.id);
      if (existing) {
        throw new Error(`MintBatchAttempt with id ${attempt.id} already exists`);
      }
      await table.add(attemptToRow(attempt));
    });
  }

  async update(attempt: MintBatchAttempt): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_mint_batch_attempts'], async (tx) => {
      const table = tx.table('coco_cashu_mint_batch_attempts');
      const existing = await table.get(attempt.id);
      if (!existing) {
        throw new Error(`MintBatchAttempt with id ${attempt.id} not found`);
      }
      const row = attemptToRow(attempt);
      row.updatedAt = getUnixTimeSeconds();
      await table.put(row);
    });
  }

  async getById(id: string): Promise<MintBatchAttempt | null> {
    const row = (await (this.db as any).table('coco_cashu_mint_batch_attempts').get(id)) as
      | MintBatchAttemptRow
      | undefined;
    return row ? rowToAttempt(row) : null;
  }

  async getByState(state: MintBatchAttemptState): Promise<MintBatchAttempt[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_mint_batch_attempts')
      .where('state')
      .equals(state)
      .toArray()) as MintBatchAttemptRow[];
    return rows.map(rowToAttempt);
  }

  async getByOperationId(operationId: string): Promise<MintBatchAttempt | null> {
    const rows = (await (this.db as any)
      .table('coco_cashu_mint_batch_attempts')
      .toArray()) as MintBatchAttemptRow[];
    return rows.map(rowToAttempt).find((attempt) => attempt.operationIds.includes(operationId)) ?? null;
  }

  async getPending(): Promise<MintBatchAttempt[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_mint_batch_attempts')
      .where('state')
      .anyOf(['prepared', 'requesting', 'recovering'])
      .toArray()) as MintBatchAttemptRow[];
    return rows.map(rowToAttempt);
  }

  async delete(id: string): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_mint_batch_attempts'], async (tx) => {
      await tx.table('coco_cashu_mint_batch_attempts').delete(id);
    });
  }
}
