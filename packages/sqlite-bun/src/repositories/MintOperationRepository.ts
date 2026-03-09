import type { MintOperationRepository } from 'coco-cashu-core';
import { SqliteDb, getUnixTimeSeconds } from '../db.ts';

type MintOperation = NonNullable<Awaited<ReturnType<MintOperationRepository['getById']>>>;
type MintOperationState = Parameters<MintOperationRepository['getByState']>[0];
type MintMethod = MintOperation['method'];
type MintMethodData = MintOperation['methodData'];

interface MintOperationRow {
  id: string;
  mintUrl: string;
  quoteId: string;
  state: MintOperationState;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  method: MintMethod;
  methodDataJson: string;
  amount: number | null;
  outputDataJson: string | null;
}

const preparedStates: MintOperationState[] = ['prepared', 'executing', 'finalized', 'rolled_back'];

const isPreparedState = (state: MintOperationState) => preparedStates.includes(state);

const rowToOperation = (row: MintOperationRow): MintOperation => {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    quoteId: row.quoteId,
    method: row.method,
    methodData: JSON.parse(row.methodDataJson) as MintMethodData,
    createdAt: row.createdAt * 1000,
    updatedAt: row.updatedAt * 1000,
    error: row.error ?? undefined,
  };

  if (!isPreparedState(row.state)) {
    return { ...base, state: 'init' };
  }

  return {
    ...base,
    state: row.state,
    amount: row.amount ?? 0,
    outputData: row.outputDataJson ? JSON.parse(row.outputDataJson) : { keep: [], send: [] },
  } as MintOperation;
};

const operationToParams = (operation: MintOperation): unknown[] => {
  const createdAtSeconds = Math.floor(operation.createdAt / 1000);
  const updatedAtSeconds = Math.floor(operation.updatedAt / 1000);
  const methodDataJson = JSON.stringify(operation.methodData);

  if (operation.state === 'init') {
    return [
      operation.id,
      operation.mintUrl,
      operation.quoteId,
      operation.state,
      createdAtSeconds,
      updatedAtSeconds,
      operation.error ?? null,
      operation.method,
      methodDataJson,
      null,
      null,
    ];
  }

  return [
    operation.id,
    operation.mintUrl,
    operation.quoteId,
    operation.state,
    createdAtSeconds,
    updatedAtSeconds,
    operation.error ?? null,
    operation.method,
    methodDataJson,
    operation.amount,
    JSON.stringify(operation.outputData),
  ];
};

export class SqliteMintOperationRepository implements MintOperationRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async create(operation: MintOperation): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_mint_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (exists) {
      throw new Error(`MintOperation with id ${operation.id} already exists`);
    }

    const params = operationToParams(operation);
    await this.db.run(
      `INSERT INTO coco_cashu_mint_operations
        (id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson, amount, outputDataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params,
    );
  }

  async update(operation: MintOperation): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_mint_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (!exists) {
      throw new Error(`MintOperation with id ${operation.id} not found`);
    }

    const updatedAtSeconds = getUnixTimeSeconds();

    if (operation.state === 'init') {
      await this.db.run(
        `UPDATE coco_cashu_mint_operations
         SET state = ?, updatedAt = ?, error = ?, method = ?, methodDataJson = ?
         WHERE id = ?`,
        [
          operation.state,
          updatedAtSeconds,
          operation.error ?? null,
          operation.method,
          JSON.stringify(operation.methodData),
          operation.id,
        ],
      );
      return;
    }

    await this.db.run(
      `UPDATE coco_cashu_mint_operations
       SET state = ?, updatedAt = ?, error = ?, method = ?, methodDataJson = ?, amount = ?, outputDataJson = ?
       WHERE id = ?`,
      [
        operation.state,
        updatedAtSeconds,
        operation.error ?? null,
        operation.method,
        JSON.stringify(operation.methodData),
        operation.amount,
        JSON.stringify(operation.outputData),
        operation.id,
      ],
    );
  }

  async getById(id: string): Promise<MintOperation | null> {
    const row = await this.db.get<MintOperationRow>(
      'SELECT * FROM coco_cashu_mint_operations WHERE id = ?',
      [id],
    );
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: MintOperationState): Promise<MintOperation[]> {
    const rows = await this.db.all<MintOperationRow>(
      'SELECT * FROM coco_cashu_mint_operations WHERE state = ?',
      [state],
    );
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<MintOperation[]> {
    const rows = await this.db.all<MintOperationRow>(
      "SELECT * FROM coco_cashu_mint_operations WHERE state IN ('executing')",
    );
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<MintOperation[]> {
    const rows = await this.db.all<MintOperationRow>(
      'SELECT * FROM coco_cashu_mint_operations WHERE mintUrl = ?',
      [mintUrl],
    );
    return rows.map(rowToOperation);
  }

  async getByQuoteId(mintUrl: string, quoteId: string): Promise<MintOperation[]> {
    const rows = await this.db.all<MintOperationRow>(
      'SELECT * FROM coco_cashu_mint_operations WHERE mintUrl = ? AND quoteId = ? ORDER BY updatedAt DESC',
      [mintUrl, quoteId],
    );
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_mint_operations WHERE id = ?', [id]);
  }
}
