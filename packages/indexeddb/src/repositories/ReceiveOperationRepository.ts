import type {
  ReceiveOperationRepository,
  ReceiveOperation,
  ReceiveOperationState,
} from 'coco-cashu-core';
import type { IdbDb, ReceiveOperationRow } from '../lib/db.ts';
import { getUnixTimeSeconds } from '../lib/db.ts';

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

function operationToRow(op: ReceiveOperation): ReceiveOperationRow {
  const createdAtSeconds = Math.floor(op.createdAt / 1000);
  const updatedAtSeconds = Math.floor(op.updatedAt / 1000);

  if (op.state === 'init') {
    return {
      id: op.id,
      mintUrl: op.mintUrl,
      amount: op.amount,
      state: op.state,
      createdAt: createdAtSeconds,
      updatedAt: updatedAtSeconds,
      error: op.error ?? null,
      fee: null,
      inputProofsJson: JSON.stringify(op.inputProofs),
      outputDataJson: null,
    };
  }

  return {
    id: op.id,
    mintUrl: op.mintUrl,
    amount: op.amount,
    state: op.state,
    createdAt: createdAtSeconds,
    updatedAt: updatedAtSeconds,
    error: op.error ?? null,
    fee: op.fee,
    inputProofsJson: JSON.stringify(op.inputProofs),
    outputDataJson: op.outputData ? JSON.stringify(op.outputData) : null,
  };
}

export class IdbReceiveOperationRepository implements ReceiveOperationRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async create(operation: ReceiveOperation): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_receive_operations'], async (tx) => {
      const table = tx.table('coco_cashu_receive_operations');
      const existing = await table.get(operation.id);
      if (existing) {
        throw new Error(`ReceiveOperation with id ${operation.id} already exists`);
      }
      await table.add(operationToRow(operation));
    });
  }

  async update(operation: ReceiveOperation): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_receive_operations'], async (tx) => {
      const table = tx.table('coco_cashu_receive_operations');
      const existing = await table.get(operation.id);
      if (!existing) {
        throw new Error(`ReceiveOperation with id ${operation.id} not found`);
      }
      const row = operationToRow(operation);
      row.updatedAt = getUnixTimeSeconds();
      await table.put(row);
    });
  }

  async getById(id: string): Promise<ReceiveOperation | null> {
    const row = (await (this.db as any).table('coco_cashu_receive_operations').get(id)) as
      | ReceiveOperationRow
      | undefined;
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: ReceiveOperationState): Promise<ReceiveOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_receive_operations')
      .where('state')
      .equals(state)
      .toArray()) as ReceiveOperationRow[];
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<ReceiveOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_receive_operations')
      .where('state')
      .anyOf(['executing'])
      .toArray()) as ReceiveOperationRow[];
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<ReceiveOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_receive_operations')
      .where('mintUrl')
      .equals(mintUrl)
      .toArray()) as ReceiveOperationRow[];
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_receive_operations'], async (tx) => {
      const table = tx.table('coco_cashu_receive_operations');
      await table.delete(id);
    });
  }
}
