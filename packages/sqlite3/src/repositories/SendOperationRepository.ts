import type {
  SendOperationRepository,
  SendOperation,
  SendOperationState,
} from 'coco-cashu-core';
import { SqliteDb, getUnixTimeSeconds } from '../db.ts';

interface SendOperationRow {
  id: string;
  mintUrl: string;
  amount: number;
  state: SendOperationState;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  needsSwap: number | null;
  fee: number | null;
  inputAmount: number | null;
  inputProofSecretsJson: string | null;
  outputDataJson: string | null;
}

function rowToOperation(row: SendOperationRow): SendOperation {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    amount: row.amount,
    createdAt: row.createdAt * 1000, // Convert seconds to milliseconds
    updatedAt: row.updatedAt * 1000,
    error: row.error ?? undefined,
  };

  if (row.state === 'init') {
    return { ...base, state: 'init' };
  }

  // All other states have PreparedData
  const preparedData = {
    needsSwap: row.needsSwap === 1,
    fee: row.fee ?? 0,
    inputAmount: row.inputAmount ?? 0,
    inputProofSecrets: row.inputProofSecretsJson ? JSON.parse(row.inputProofSecretsJson) : [],
    outputData: row.outputDataJson ? JSON.parse(row.outputDataJson) : undefined,
  };

  switch (row.state) {
    case 'prepared':
      return { ...base, state: 'prepared', ...preparedData };
    case 'executing':
      return { ...base, state: 'executing', ...preparedData };
    case 'pending':
      return { ...base, state: 'pending', ...preparedData };
    case 'finalized':
      return { ...base, state: 'finalized', ...preparedData };
    case 'rolled_back':
      return { ...base, state: 'rolled_back', ...preparedData };
    default:
      throw new Error(`Unknown state: ${row.state}`);
  }
}

function operationToParams(op: SendOperation): unknown[] {
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
      null, // needsSwap
      null, // fee
      null, // inputAmount
      null, // inputProofSecretsJson
      null, // outputDataJson
    ];
  }

  // All other states have PreparedData
  return [
    op.id,
    op.mintUrl,
    op.amount,
    op.state,
    createdAtSeconds,
    updatedAtSeconds,
    op.error ?? null,
    op.needsSwap ? 1 : 0,
    op.fee,
    op.inputAmount,
    JSON.stringify(op.inputProofSecrets),
    op.outputData ? JSON.stringify(op.outputData) : null,
  ];
}

export class SqliteSendOperationRepository implements SendOperationRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async create(operation: SendOperation): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_send_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (exists) {
      throw new Error(`SendOperation with id ${operation.id} already exists`);
    }

    const params = operationToParams(operation);
    await this.db.run(
      `INSERT INTO coco_cashu_send_operations 
        (id, mintUrl, amount, state, createdAt, updatedAt, error, needsSwap, fee, inputAmount, inputProofSecretsJson, outputDataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params,
    );
  }

  async update(operation: SendOperation): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_send_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (!exists) {
      throw new Error(`SendOperation with id ${operation.id} not found`);
    }

    const updatedAtSeconds = getUnixTimeSeconds();

    if (operation.state === 'init') {
      await this.db.run(
        `UPDATE coco_cashu_send_operations 
         SET state = ?, updatedAt = ?, error = ?
         WHERE id = ?`,
        [operation.state, updatedAtSeconds, operation.error ?? null, operation.id],
      );
    } else {
      await this.db.run(
        `UPDATE coco_cashu_send_operations 
         SET state = ?, updatedAt = ?, error = ?, needsSwap = ?, fee = ?, inputAmount = ?, inputProofSecretsJson = ?, outputDataJson = ?
         WHERE id = ?`,
        [
          operation.state,
          updatedAtSeconds,
          operation.error ?? null,
          operation.needsSwap ? 1 : 0,
          operation.fee,
          operation.inputAmount,
          JSON.stringify(operation.inputProofSecrets),
          operation.outputData ? JSON.stringify(operation.outputData) : null,
          operation.id,
        ],
      );
    }
  }

  async getById(id: string): Promise<SendOperation | null> {
    const row = await this.db.get<SendOperationRow>(
      'SELECT * FROM coco_cashu_send_operations WHERE id = ?',
      [id],
    );
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: SendOperationState): Promise<SendOperation[]> {
    const rows = await this.db.all<SendOperationRow>(
      'SELECT * FROM coco_cashu_send_operations WHERE state = ?',
      [state],
    );
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<SendOperation[]> {
    const rows = await this.db.all<SendOperationRow>(
      'SELECT * FROM coco_cashu_send_operations WHERE state IN ("executing", "pending", "rolling_back")',
    );
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<SendOperation[]> {
    const rows = await this.db.all<SendOperationRow>(
      'SELECT * FROM coco_cashu_send_operations WHERE mintUrl = ?',
      [mintUrl],
    );
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_send_operations WHERE id = ?', [id]);
  }
}

