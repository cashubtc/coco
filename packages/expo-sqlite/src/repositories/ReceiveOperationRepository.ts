import type {
  ReceiveOperationRepository,
  ReceiveOperation,
  ReceiveOperationState,
} from '@cashu/coco-core';
import { ExpoSqliteDb, getUnixTimeSeconds } from '../db.ts';

interface ReceiveOperationRow {
  id: string;
  mintUrl: string;
  amount: number;
  state: ReceiveOperationState;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  fee: number | null;
  inputProofsJson: string | null;
  outputDataJson: string | null;
}

function rowToOperation(row: ReceiveOperationRow): ReceiveOperation {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    amount: row.amount,
    inputProofs: row.inputProofsJson ? JSON.parse(row.inputProofsJson) : [],
    createdAt: row.createdAt * 1000,
    updatedAt: row.updatedAt * 1000,
    error: row.error ?? undefined,
  };

  if (row.state === 'init') {
    return { ...base, state: 'init' };
  }

  const preparedData = {
    fee: row.fee ?? 0,
    outputData: row.outputDataJson ? JSON.parse(row.outputDataJson) : undefined,
  };

  switch (row.state) {
    case 'prepared':
      return { ...base, state: 'prepared', ...preparedData };
    case 'executing':
      return { ...base, state: 'executing', ...preparedData };
    case 'finalized':
      return { ...base, state: 'finalized', ...preparedData };
    case 'rolled_back':
      return { ...base, state: 'rolled_back', ...preparedData };
    default:
      throw new Error(`Unknown state: ${row.state}`);
  }
}

function operationToParams(op: ReceiveOperation): unknown[] {
  const createdAtSeconds = Math.floor(op.createdAt / 1000);
  const updatedAtSeconds = Math.floor(op.updatedAt / 1000);

  if (op.state === 'init') {
    return [
      op.id,
      op.mintUrl,
      op.amount,
      op.state,
      createdAtSeconds,
      updatedAtSeconds,
      op.error ?? null,
      null, //fee
      JSON.stringify(op.inputProofs),
      null, // outputDataJson
    ];
  }

  return [
    op.id,
    op.mintUrl,
    op.amount,
    op.state,
    createdAtSeconds,
    updatedAtSeconds,
    op.error ?? null,
    op.fee,
    JSON.stringify(op.inputProofs),
    op.outputData ? JSON.stringify(op.outputData) : null,
  ];
}

export class ExpoReceiveOperationRepository implements ReceiveOperationRepository {
  private readonly db: ExpoSqliteDb;

  constructor(db: ExpoSqliteDb) {
    this.db = db;
  }

  async create(operation: ReceiveOperation): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_receive_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (exists) {
      throw new Error(`ReceiveOperation with id ${operation.id} already exists`);
    }

    const params = operationToParams(operation);
    await this.db.run(
      `INSERT INTO coco_cashu_receive_operations
        (id, mintUrl, amount, state, createdAt, updatedAt, error, fee, inputProofsJson, outputDataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params,
    );
  }

  async update(operation: ReceiveOperation): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_receive_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (!exists) {
      throw new Error(`ReceiveOperation with id ${operation.id} not found`);
    }

    const updatedAtSeconds = getUnixTimeSeconds();

    if (operation.state === 'init') {
      await this.db.run(
        `UPDATE coco_cashu_receive_operations
         SET state = ?, updatedAt = ?, error = ?, inputProofsJson = ?
         WHERE id = ?`,
        [
          operation.state,
          updatedAtSeconds,
          operation.error ?? null,
          JSON.stringify(operation.inputProofs),
          operation.id,
        ],
      );
    } else {
      await this.db.run(
        `UPDATE coco_cashu_receive_operations
         SET state = ?, updatedAt = ?, error = ?, fee = ?, inputProofsJson = ?, outputDataJson = ?
         WHERE id = ?`,
        [
          operation.state,
          updatedAtSeconds,
          operation.error ?? null,
          operation.fee,
          JSON.stringify(operation.inputProofs),
          operation.outputData ? JSON.stringify(operation.outputData) : null,
          operation.id,
        ],
      );
    }
  }

  async getById(id: string): Promise<ReceiveOperation | null> {
    const row = await this.db.get<ReceiveOperationRow>(
      'SELECT * FROM coco_cashu_receive_operations WHERE id = ?',
      [id],
    );
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: ReceiveOperationState): Promise<ReceiveOperation[]> {
    const rows = await this.db.all<ReceiveOperationRow>(
      'SELECT * FROM coco_cashu_receive_operations WHERE state = ?',
      [state],
    );
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<ReceiveOperation[]> {
    const rows = await this.db.all<ReceiveOperationRow>(
      "SELECT * FROM coco_cashu_receive_operations WHERE state IN ('executing')",
    );
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<ReceiveOperation[]> {
    const rows = await this.db.all<ReceiveOperationRow>(
      'SELECT * FROM coco_cashu_receive_operations WHERE mintUrl = ?',
      [mintUrl],
    );
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_receive_operations WHERE id = ?', [id]);
  }
}
