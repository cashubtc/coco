import type {
  SendOperationRepository,
  SendOperation,
  SendOperationState,
  SendMethod,
} from '@cashu/coco-core';
import {
  deserializeAmount,
  deserializeToken,
  normalizeUnit,
  serializeAmount,
  stringifyJson,
} from '@cashu/coco-core';
import { ExpoSqliteDb, getUnixTimeSeconds } from '../db.ts';

interface SendOperationRow {
  id: string;
  mintUrl: string;
  amount: string | number;
  unit: string | null;
  state: SendOperationState;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  method: string;
  methodDataJson: string;
  needsSwap: number | null;
  fee: string | number | null;
  inputAmount: string | number | null;
  inputProofSecretsJson: string | null;
  outputDataJson: string | null;
  tokenJson: string | null;
}

function parseToken(tokenJson: string | null): unknown {
  return tokenJson ? deserializeToken(JSON.parse(tokenJson)) : undefined;
}

function serializeToken(operation: SendOperation): string | null {
  const maybeTokenOperation = operation as SendOperation & { token?: unknown };
  return maybeTokenOperation.token ? JSON.stringify(maybeTokenOperation.token) : null;
}

function rowToOperation(row: SendOperationRow): SendOperation {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    amount: deserializeAmount(row.amount),
    unit: normalizeUnit(row.unit ?? 'sat'),
    createdAt: row.createdAt * 1000, // Convert seconds to milliseconds
    updatedAt: row.updatedAt * 1000,
    error: row.error ?? undefined,
    method: row.method as SendMethod,
    methodData: JSON.parse(row.methodDataJson),
  };

  if (row.state === 'init') {
    return { ...base, state: 'init' };
  }

  // All other states have PreparedData
  const preparedData = {
    needsSwap: row.needsSwap === 1,
    fee: deserializeAmount(row.fee ?? 0),
    inputAmount: deserializeAmount(row.inputAmount ?? 0),
    inputProofSecrets: row.inputProofSecretsJson ? JSON.parse(row.inputProofSecretsJson) : [],
    outputData: row.outputDataJson ? JSON.parse(row.outputDataJson) : undefined,
  };

  switch (row.state) {
    case 'prepared':
      return { ...base, state: 'prepared', ...preparedData };
    case 'executing':
      return { ...base, state: 'executing', ...preparedData };
    case 'pending':
      return {
        ...base,
        state: 'pending',
        ...preparedData,
        token: parseToken(row.tokenJson),
      } as SendOperation;
    case 'finalized':
      return {
        ...base,
        state: 'finalized',
        ...preparedData,
        token: parseToken(row.tokenJson),
      } as SendOperation;
    case 'rolling_back':
      return {
        ...base,
        state: 'rolling_back',
        ...preparedData,
        token: parseToken(row.tokenJson),
      } as SendOperation;
    case 'rolled_back':
      return {
        ...base,
        state: 'rolled_back',
        ...preparedData,
        token: parseToken(row.tokenJson),
      } as SendOperation;
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
      serializeAmount(op.amount),
      op.unit,
      op.state,
      createdAtSeconds,
      updatedAtSeconds,
      op.error ?? null,
      op.method,
      stringifyJson(op.methodData),
      null, // needsSwap
      null, // fee
      null, // inputAmount
      null, // inputProofSecretsJson
      null, // outputDataJson
      null, // tokenJson
    ];
  }

  // All other states have PreparedData
  return [
    op.id,
    op.mintUrl,
    serializeAmount(op.amount),
    op.unit,
    op.state,
    createdAtSeconds,
    updatedAtSeconds,
    op.error ?? null,
    op.method,
    stringifyJson(op.methodData),
    op.needsSwap ? 1 : 0,
    serializeAmount(op.fee),
    serializeAmount(op.inputAmount),
    JSON.stringify(op.inputProofSecrets),
    op.outputData ? JSON.stringify(op.outputData) : null,
    serializeToken(op),
  ];
}

export class ExpoSendOperationRepository implements SendOperationRepository {
  private readonly db: ExpoSqliteDb;

  constructor(db: ExpoSqliteDb) {
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
        (id, mintUrl, amount, unit, state, createdAt, updatedAt, error, method, methodDataJson, needsSwap, fee, inputAmount, inputProofSecretsJson, outputDataJson, tokenJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
         SET state = ?, updatedAt = ?, error = ?, unit = ?
         WHERE id = ?`,
        [operation.state, updatedAtSeconds, operation.error ?? null, operation.unit, operation.id],
      );
    } else {
      await this.db.run(
        `UPDATE coco_cashu_send_operations 
         SET state = ?, updatedAt = ?, error = ?, unit = ?, needsSwap = ?, fee = ?, inputAmount = ?, inputProofSecretsJson = ?, outputDataJson = ?, tokenJson = ?
         WHERE id = ?`,
        [
          operation.state,
          updatedAtSeconds,
          operation.error ?? null,
          operation.unit,
          operation.needsSwap ? 1 : 0,
          serializeAmount(operation.fee),
          serializeAmount(operation.inputAmount),
          JSON.stringify(operation.inputProofSecrets),
          operation.outputData ? JSON.stringify(operation.outputData) : null,
          serializeToken(operation),
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
      `SELECT * FROM coco_cashu_send_operations WHERE state IN ('executing', 'pending', 'rolling_back')`,
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
