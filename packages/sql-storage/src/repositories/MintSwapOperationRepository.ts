import { Amount } from '@cashu/cashu-ts';
import { type MintSwapOperation, type MintSwapOperationState } from '@cashu/coco-core/adapter';
import {
  assertMintSwapOperationUpdate,
  getMintSwapOperationDueAt,
  validateMintSwapOperation,
  type MintSwapOperationRepository,
} from '@cashu/coco-core/adapter';

import type { SqlDatabase } from '../index.ts';

interface MintSwapOperationRow {
  id: string;
  state: MintSwapOperationState;
  revision: number;
  sourceMintUrl: string;
  destinationMintUrl: string;
  destinationMintOperationId: string | null;
  sourceMeltOperationId: string | null;
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
  recordJson: string;
}

const SELECT_COLUMNS = `
  id, state, revision, sourceMintUrl, destinationMintUrl, destinationMintOperationId,
  sourceMeltOperationId, dueAt, createdAt, updatedAt, recordJson
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
        sourceMeltOperationId, dueAt, createdAt, updatedAt, recordJson
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
       WHERE dueAt IS NOT NULL AND dueAt <= ?
       ORDER BY dueAt ASC, createdAt ASC, id ASC
       LIMIT ?`,
      [now, limit],
    );
    return operations;
  }

  async getByDestinationMintOperationId(id: string): Promise<MintSwapOperation | null> {
    return this.getByChild('destinationMintOperationId', id);
  }

  async getBySourceMeltOperationId(id: string): Promise<MintSwapOperation | null> {
    return this.getByChild('sourceMeltOperationId', id);
  }

  async getPaginated(
    limit: number,
    offset: number,
    mintUrl?: string,
  ): Promise<MintSwapOperation[]> {
    return this.query(
      `SELECT ${SELECT_COLUMNS} FROM coco_cashu_mint_swap_operations
       ${mintUrl ? 'WHERE sourceMintUrl = ? OR destinationMintUrl = ?' : ''}
       ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`,
      mintUrl ? [mintUrl, mintUrl, limit, offset] : [limit, offset],
    );
  }

  async getByChildOperationIds(ids: readonly string[]): Promise<MintSwapOperation[]> {
    if (ids.length === 0) return [];
    const operations = new Map<string, MintSwapOperation>();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const chunk = ids.slice(offset, offset + 400);
      const placeholders = chunk.map(() => '?').join(', ');
      const matches = await this.query(
        `SELECT ${SELECT_COLUMNS} FROM coco_cashu_mint_swap_operations
         WHERE destinationMintOperationId IN (${placeholders})
            OR sourceMeltOperationId IN (${placeholders})`,
        [...chunk, ...chunk],
      );
      for (const operation of matches) operations.set(operation.id, operation);
    }
    return [...operations.values()];
  }

  async compareAndSet(operation: MintSwapOperation, expectedRevision: number): Promise<boolean> {
    assertNonNegativeSafeInteger(expectedRevision, 'Expected revision');
    const current = await this.getById(operation.id);
    if (!current || current.revision !== expectedRevision) return false;
    assertMintSwapOperationUpdate(current, operation);
    const row = toRow(operation);
    const result = await this.db.run(
      `UPDATE coco_cashu_mint_swap_operations SET
        state = ?, revision = ?, sourceMintUrl = ?, destinationMintUrl = ?,
        destinationMintOperationId = ?, sourceMeltOperationId = ?, dueAt = ?,
        createdAt = ?, updatedAt = ?, recordJson = ?
       WHERE id = ? AND revision = ?`,
      [
        row.state,
        row.revision,
        row.sourceMintUrl,
        row.destinationMintUrl,
        row.destinationMintOperationId,
        row.sourceMeltOperationId,
        row.dueAt,
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
    dueAt: getMintSwapOperationDueAt(operation),
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
    row.dueAt,
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

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}
