import { Amount } from '@cashu/cashu-ts';
import {
  assertMintSwapTransition,
  assertPreparedMintSwapImmutable,
  isAutomaticMintSwapState,
  validateMintSwapOperation,
  type MintSwapOperation,
  type MintSwapOperationState,
} from '@cashu/coco-core';
import type { MintSwapOperationRepository } from '@cashu/coco-core/adapter';

import type { SqlDatabase } from '../index.ts';

interface MintSwapOperationRow {
  id: string;
  state: MintSwapOperationState;
  revision: number;
  sourceMintUrl: string;
  destinationMintUrl: string;
  destinationMintOperationId: string | null;
  sourceMeltOperationId: string | null;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  recordJson: string;
}

const SELECT_COLUMNS = `
  id, state, revision, sourceMintUrl, destinationMintUrl, destinationMintOperationId,
  sourceMeltOperationId, nextAttemptAt, createdAt, updatedAt, recordJson
`;

export class SqliteMintSwapOperationRepository implements MintSwapOperationRepository {
  constructor(private readonly db: SqlDatabase) {}

  async create(operation: MintSwapOperation): Promise<void> {
    validateMintSwapOperation(operation);
    if (operation.revision !== 0) {
      throw new Error('New mint swap operation must start at revision 0');
    }
    const row = toRow(operation);
    await this.db.run(
      `INSERT INTO coco_cashu_mint_swap_operations (
        id, state, revision, sourceMintUrl, destinationMintUrl, destinationMintOperationId,
        sourceMeltOperationId, nextAttemptAt, createdAt, updatedAt, recordJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rowParams(row),
    );
  }

  async getById(id: string): Promise<MintSwapOperation | null> {
    const row = await this.db.get<MintSwapOperationRow>(
      `SELECT ${SELECT_COLUMNS} FROM coco_cashu_mint_swap_operations WHERE id = ?`,
      [id],
    );
    return row ? fromRow(row) : null;
  }

  async getByState(state: MintSwapOperationState): Promise<MintSwapOperation[]> {
    return this.query(
      `SELECT ${SELECT_COLUMNS} FROM coco_cashu_mint_swap_operations
       WHERE state = ? ORDER BY createdAt ASC, id ASC`,
      [state],
    );
  }

  async getActive(): Promise<MintSwapOperation[]> {
    return this.query(
      `SELECT ${SELECT_COLUMNS} FROM coco_cashu_mint_swap_operations
       WHERE state NOT IN ('completed', 'cancelled', 'failed')
       ORDER BY createdAt ASC, id ASC`,
    );
  }

  async getDue(now: number, limit: number): Promise<MintSwapOperation[]> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Due time must be non-negative');
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error('Due limit must be non-negative');
    const operations = await this.query(
      `SELECT ${SELECT_COLUMNS} FROM coco_cashu_mint_swap_operations
       WHERE state IN ('preparing', 'source_inflight', 'destination_funded', 'issuing')
         AND COALESCE(nextAttemptAt, 0) <= ?
       ORDER BY COALESCE(nextAttemptAt, 0) ASC, createdAt ASC, id ASC
       LIMIT ?`,
      [now, limit],
    );
    return operations.filter((operation) => isAutomaticMintSwapState(operation.state));
  }

  async getByDestinationMintOperationId(id: string): Promise<MintSwapOperation | null> {
    return this.getByChild('destinationMintOperationId', id);
  }

  async getBySourceMeltOperationId(id: string): Promise<MintSwapOperation | null> {
    return this.getByChild('sourceMeltOperationId', id);
  }

  async compareAndSet(operation: MintSwapOperation, expectedRevision: number): Promise<boolean> {
    const current = await this.getById(operation.id);
    if (!current || current.revision !== expectedRevision) return false;
    if (operation.revision !== expectedRevision + 1) {
      throw new Error('Mint swap compare-and-set must advance revision exactly once');
    }
    assertMintSwapTransition(current.state, operation.state);
    assertPreparedMintSwapImmutable(current, operation);
    validateMintSwapOperation(operation);
    const row = toRow(operation);
    const result = await this.db.run(
      `UPDATE coco_cashu_mint_swap_operations SET
        state = ?, revision = ?, sourceMintUrl = ?, destinationMintUrl = ?,
        destinationMintOperationId = ?, sourceMeltOperationId = ?, nextAttemptAt = ?,
        createdAt = ?, updatedAt = ?, recordJson = ?
       WHERE id = ? AND revision = ?`,
      [
        row.state,
        row.revision,
        row.sourceMintUrl,
        row.destinationMintUrl,
        row.destinationMintOperationId,
        row.sourceMeltOperationId,
        row.nextAttemptAt,
        row.createdAt,
        row.updatedAt,
        row.recordJson,
        row.id,
        expectedRevision,
      ],
    );
    return result.changes === 1;
  }

  private async getByChild(
    column: 'destinationMintOperationId' | 'sourceMeltOperationId',
    id: string,
  ): Promise<MintSwapOperation | null> {
    const row = await this.db.get<MintSwapOperationRow>(
      `SELECT ${SELECT_COLUMNS} FROM coco_cashu_mint_swap_operations WHERE ${column} = ?`,
      [id],
    );
    return row ? fromRow(row) : null;
  }

  private async query(sql: string, params: readonly (string | number)[] = []) {
    const rows = await this.db.all<MintSwapOperationRow>(sql, params);
    return rows.map(fromRow);
  }
}

function toRow(operation: MintSwapOperation): MintSwapOperationRow {
  return {
    id: operation.id,
    state: operation.state,
    revision: operation.revision,
    sourceMintUrl: operation.sourceMintUrl,
    destinationMintUrl: operation.destinationMintUrl,
    destinationMintOperationId: operation.destinationMintOperationId ?? null,
    sourceMeltOperationId: operation.sourceMeltOperationId ?? null,
    nextAttemptAt: operation.retry.nextAttemptAt ?? null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    recordJson: JSON.stringify(serializeOperation(operation)),
  };
}

function rowParams(row: MintSwapOperationRow) {
  return [
    row.id,
    row.state,
    row.revision,
    row.sourceMintUrl,
    row.destinationMintUrl,
    row.destinationMintOperationId,
    row.sourceMeltOperationId,
    row.nextAttemptAt,
    row.createdAt,
    row.updatedAt,
    row.recordJson,
  ] as const;
}

function serializeOperation(operation: MintSwapOperation): unknown {
  return {
    ...operation,
    destinationAmount: operation.destinationAmount.toString(),
    preparedPlan: operation.preparedPlan
      ? mapAmountsToStrings(operation.preparedPlan, [
          'sourceMeltAmount',
          'sourceFeeReserve',
          'sourcePreparationFee',
          'sourceMeltInputFee',
          'minimumSourceDebit',
          'maximumSourceDebit',
          'reservedSourceAmount',
        ])
      : undefined,
    settlement: operation.settlement
      ? mapAmountsToStrings(operation.settlement, [
          'sourcePaymentFee',
          'totalSourceFee',
          'sourceMeltChangeAmount',
          'sourceKeepAmount',
          'sourceReturnedAmount',
          'finalSourceDebit',
          'destinationAmountIssued',
        ])
      : undefined,
  };
}

function fromRow(row: MintSwapOperationRow): MintSwapOperation {
  const parsed = JSON.parse(row.recordJson) as Record<string, unknown> & {
    destinationAmount: string;
    preparedPlan?: Record<string, unknown>;
    settlement?: Record<string, unknown>;
  };
  const operation = {
    ...parsed,
    destinationAmount: Amount.from(parsed.destinationAmount),
    preparedPlan: parsed.preparedPlan
      ? mapStringsToAmounts(parsed.preparedPlan, [
          'sourceMeltAmount',
          'sourceFeeReserve',
          'sourcePreparationFee',
          'sourceMeltInputFee',
          'minimumSourceDebit',
          'maximumSourceDebit',
          'reservedSourceAmount',
        ])
      : undefined,
    settlement: parsed.settlement
      ? mapStringsToAmounts(parsed.settlement, [
          'sourcePaymentFee',
          'totalSourceFee',
          'sourceMeltChangeAmount',
          'sourceKeepAmount',
          'sourceReturnedAmount',
          'finalSourceDebit',
          'destinationAmountIssued',
        ])
      : undefined,
  } as MintSwapOperation;
  return validateMintSwapOperation(operation);
}

function mapAmountsToStrings<T extends object>(value: T, keys: readonly string[]): object {
  const result = { ...value } as Record<string, unknown>;
  for (const key of keys) {
    if (result[key] !== undefined) result[key] = Amount.from(result[key] as Amount).toString();
  }
  return result;
}

function mapStringsToAmounts(value: Record<string, unknown>, keys: readonly string[]): object {
  const result = { ...value };
  for (const key of keys) {
    if (result[key] !== undefined) result[key] = Amount.from(result[key] as string);
  }
  return result;
}
