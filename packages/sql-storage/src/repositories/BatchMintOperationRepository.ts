import type {
  BatchMintMember,
  BatchMintOperation,
  BatchMintOperationFailure,
  BatchMintOperationRepository,
  BatchMintOperationState,
  QuoteIdentity,
} from '@cashu/coco-core/adapter';
import {
  assertBatchMintOperation,
  assertBatchMintUpdate,
  deserializeAmount,
  normalizeMintUrl,
  serializeAmount,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase, SqlParams } from '../index.ts';

interface BatchMintOperationRow {
  id: string;
  mintUrl: string;
  method: BatchMintOperation['method'];
  unit: string;
  state: BatchMintOperationState;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  terminalFailureJson: string | null;
  outputDataJson: string;
}

interface BatchMintMemberRow {
  operationId: string;
  ordinal: number;
  quoteId: string;
  amount: string;
  request: string;
  pubkey: string | null;
}

const OPERATIONS = 'coco_cashu_batch_mint_operations';
const MEMBERS = 'coco_cashu_batch_mint_members';

/** JavaScript ordering keeps lists identical across SQLite collations and other adapters. */
function compareCreated(a: BatchMintOperation, b: BatchMintOperation): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class SqliteBatchMintOperationRepository implements BatchMintOperationRepository {
  constructor(private readonly db: SqlDatabase) {}

  async create(operation: BatchMintOperation): Promise<void> {
    assertBatchMintOperation(operation);
    const mintUrl = normalizeMintUrl(operation.mintUrl);
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO ${OPERATIONS} (
          id, mintUrl, method, unit, state, createdAt, updatedAt, error, terminalFailureJson,
          outputDataJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          operation.id,
          mintUrl,
          operation.method,
          operation.unit,
          operation.state,
          operation.createdAt,
          operation.updatedAt,
          operation.error ?? null,
          failureJson(operation),
          JSON.stringify(operation.outputData),
        ],
      );
      for (const member of operation.members) {
        await tx.run(
          `INSERT INTO ${MEMBERS} (operationId, ordinal, mintUrl, quoteId, amount, request, pubkey)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            operation.id,
            member.ordinal,
            mintUrl,
            member.quoteId,
            serializeAmount(member.amount),
            member.request,
            member.pubkey,
          ],
        );
      }
    });
  }

  async update(operation: BatchMintOperation): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await new SqliteBatchMintOperationRepository(tx).getById(operation.id);
      if (!current) throw new Error(`Batch Mint Operation ${operation.id} not found`);
      assertBatchMintUpdate(current, operation);
      await tx.run(
        `UPDATE ${OPERATIONS} SET state = ?, updatedAt = ?, error = ?, terminalFailureJson = ?
         WHERE id = ?`,
        [
          operation.state,
          operation.updatedAt,
          operation.error ?? null,
          failureJson(operation),
          operation.id,
        ],
      );
    });
  }

  async getById(id: string): Promise<BatchMintOperation | null> {
    const [operation] = await this.select('id = ?', [id]);
    return operation ?? null;
  }

  async listByState(state: BatchMintOperationState): Promise<BatchMintOperation[]> {
    return this.select('state = ?', [state]);
  }

  async listInFlight(): Promise<BatchMintOperation[]> {
    return this.listByState('executing');
  }

  async listByQuote(quote: QuoteIdentity): Promise<BatchMintOperation[]> {
    return this.select(
      `id IN (SELECT operationId FROM ${MEMBERS} WHERE mintUrl = ? AND quoteId = ?)`,
      [normalizeMintUrl(quote.mintUrl), quote.quoteId],
    );
  }

  private async select(where: string, params: SqlParams): Promise<BatchMintOperation[]> {
    const rows = await this.db.all<BatchMintOperationRow>(
      `SELECT * FROM ${OPERATIONS} WHERE ${where}`,
      params,
    );
    if (rows.length === 0) return [];
    const members = await this.db.all<BatchMintMemberRow>(
      `SELECT operationId, ordinal, quoteId, amount, request, pubkey FROM ${MEMBERS}
       WHERE operationId IN (SELECT id FROM ${OPERATIONS} WHERE ${where})
       ORDER BY operationId, ordinal ASC`,
      params,
    );
    const byOperation = new Map<string, BatchMintMember[]>();
    for (const row of members) {
      const list = byOperation.get(row.operationId) ?? [];
      list.push({
        ordinal: row.ordinal,
        quoteId: row.quoteId,
        amount: deserializeAmount(row.amount),
        request: row.request,
        pubkey: row.pubkey,
      });
      byOperation.set(row.operationId, list);
    }
    return rows.map((row) => fromRow(row, byOperation.get(row.id) ?? [])).sort(compareCreated);
  }
}

function failureJson(operation: BatchMintOperation): string | null {
  return operation.state === 'failed' ? JSON.stringify(operation.terminalFailure) : null;
}

function fromRow(row: BatchMintOperationRow, members: BatchMintMember[]): BatchMintOperation {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    method: row.method,
    unit: row.unit,
    members,
    outputData: JSON.parse(row.outputDataJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.error !== null ? { error: row.error } : {}),
  };
  if (row.state === 'failed') {
    if (!row.terminalFailureJson)
      throw new Error(`Failed Batch Mint Operation ${row.id} has no terminal failure`);
    return {
      ...base,
      state: 'failed',
      terminalFailure: JSON.parse(row.terminalFailureJson) as BatchMintOperationFailure,
    };
  }
  return { ...base, state: row.state };
}
