import type {
  SendOperationRepository,
  SendOperation,
  SendOperationState,
} from 'coco-cashu-core';
import type { IdbDb, SendOperationRow } from '../lib/db.ts';
import { getUnixTimeSeconds } from '../lib/db.ts';

function rowToOperation(row: SendOperationRow): SendOperation {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    unit: row.unit ?? 'sat',
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
    case 'rolling_back':
      return { ...base, state: 'rolling_back', ...preparedData };
    case 'rolled_back':
      return { ...base, state: 'rolled_back', ...preparedData };
    default:
      throw new Error(`Unknown state: ${row.state}`);
  }
}

function operationToRow(op: SendOperation): SendOperationRow {
  const createdAtSeconds = Math.floor(op.createdAt / 1000);
  const updatedAtSeconds = Math.floor(op.updatedAt / 1000);

  if (op.state === 'init') {
    return {
      id: op.id,
      mintUrl: op.mintUrl,
      unit: op.unit,
      amount: op.amount,
      state: op.state,
      createdAt: createdAtSeconds,
      updatedAt: updatedAtSeconds,
      error: op.error ?? null,
      needsSwap: null,
      fee: null,
      inputAmount: null,
      inputProofSecretsJson: null,
      outputDataJson: null,
    };
  }

  // All other states have PreparedData
  return {
    id: op.id,
    mintUrl: op.mintUrl,
    unit: op.unit,
    amount: op.amount,
    state: op.state,
    createdAt: createdAtSeconds,
    updatedAt: updatedAtSeconds,
    error: op.error ?? null,
    needsSwap: op.needsSwap ? 1 : 0,
    fee: op.fee,
    inputAmount: op.inputAmount,
    inputProofSecretsJson: JSON.stringify(op.inputProofSecrets),
    outputDataJson: op.outputData ? JSON.stringify(op.outputData) : null,
  };
}

export class IdbSendOperationRepository implements SendOperationRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async create(operation: SendOperation): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_send_operations'], async (tx) => {
      const table = tx.table('coco_cashu_send_operations');
      const existing = await table.get(operation.id);
      if (existing) {
        throw new Error(`SendOperation with id ${operation.id} already exists`);
      }
      await table.add(operationToRow(operation));
    });
  }

  async update(operation: SendOperation): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_send_operations'], async (tx) => {
      const table = tx.table('coco_cashu_send_operations');
      const existing = await table.get(operation.id);
      if (!existing) {
        throw new Error(`SendOperation with id ${operation.id} not found`);
      }
      const row = operationToRow(operation);
      row.updatedAt = getUnixTimeSeconds();
      await table.put(row);
    });
  }

  async getById(id: string): Promise<SendOperation | null> {
    const row = (await (this.db as any)
      .table('coco_cashu_send_operations')
      .get(id)) as SendOperationRow | undefined;
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: SendOperationState): Promise<SendOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_send_operations')
      .where('state')
      .equals(state)
      .toArray()) as SendOperationRow[];
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<SendOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_send_operations')
      .where('state')
      .anyOf(['executing', 'pending', 'rolling_back'])
      .toArray()) as SendOperationRow[];
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<SendOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_send_operations')
      .where('mintUrl')
      .equals(mintUrl)
      .toArray()) as SendOperationRow[];
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_send_operations'], async (tx) => {
      const table = tx.table('coco_cashu_send_operations');
      await table.delete(id);
    });
  }
}

