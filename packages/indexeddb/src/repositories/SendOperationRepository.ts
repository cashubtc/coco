import type {
  SendOperationRepository,
  SendOperation,
  SendOperationState,
  SendMethod,
} from 'coco-cashu-core';
import type { IdbDb, SendOperationRow } from '../lib/db.ts';
import { getUnixTimeSeconds } from '../lib/db.ts';

type LegacySendOperationRow = SendOperationRow & {
  methodData?: SendOperation['methodData'];
  methodDataJson?: string;
};

function parseToken(row: SendOperationRow): unknown {
  return row.tokenJson ? JSON.parse(row.tokenJson) : undefined;
}

function serializeToken(operation: SendOperation): string | null {
  const maybeTokenOperation = operation as SendOperation & { token?: unknown };
  return maybeTokenOperation.token ? JSON.stringify(maybeTokenOperation.token) : null;
}

function parseMethodData(row: SendOperationRow): SendOperation['methodData'] {
  const legacyRow = row as LegacySendOperationRow;

  if (typeof legacyRow.methodDataJson === 'string') {
    return JSON.parse(legacyRow.methodDataJson) as SendOperation['methodData'];
  }

  return legacyRow.methodData ?? {};
}

function rowToOperation(row: SendOperationRow): SendOperation {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    amount: row.amount,
    createdAt: row.createdAt * 1000, // Convert seconds to milliseconds
    updatedAt: row.updatedAt * 1000,
    error: row.error ?? undefined,
    method: row.method as SendMethod,
    methodData: parseMethodData(row),
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
      return {
        ...base,
        state: 'pending',
        ...preparedData,
        token: parseToken(row),
      } as SendOperation;
    case 'finalized':
      return {
        ...base,
        state: 'finalized',
        ...preparedData,
        token: parseToken(row),
      } as SendOperation;
    case 'rolling_back':
      return {
        ...base,
        state: 'rolling_back',
        ...preparedData,
        token: parseToken(row),
      } as SendOperation;
    case 'rolled_back':
      return {
        ...base,
        state: 'rolled_back',
        ...preparedData,
        token: parseToken(row),
      } as SendOperation;
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
      amount: op.amount,
      state: op.state,
      createdAt: createdAtSeconds,
      updatedAt: updatedAtSeconds,
      error: op.error ?? null,
      method: op.method,
      methodDataJson: JSON.stringify(op.methodData),
      needsSwap: null,
      fee: null,
      inputAmount: null,
      inputProofSecretsJson: null,
      outputDataJson: null,
      tokenJson: null,
    };
  }

  // All other states have PreparedData
  return {
    id: op.id,
    mintUrl: op.mintUrl,
    amount: op.amount,
    state: op.state,
    createdAt: createdAtSeconds,
    updatedAt: updatedAtSeconds,
    error: op.error ?? null,
    method: op.method,
    methodDataJson: JSON.stringify(op.methodData),
    needsSwap: op.needsSwap ? 1 : 0,
    fee: op.fee,
    inputAmount: op.inputAmount,
    inputProofSecretsJson: JSON.stringify(op.inputProofSecrets),
    outputDataJson: op.outputData ? JSON.stringify(op.outputData) : null,
    tokenJson: serializeToken(op),
  };
}

export class IdbSendOperationRepository implements SendOperationRepository {
  private readonly db: IdbDb;
  private readonly storeName = 'coco_cashu_send_operations';

  constructor(db: IdbDb) {
    this.db = db;
  }

  async create(operation: SendOperation): Promise<void> {
    await this.db.runTransaction('rw', [this.storeName], async (tx) => {
      const table = tx.table(this.storeName);
      const existing = await table.get(operation.id);
      if (existing) {
        throw new Error(`SendOperation with id ${operation.id} already exists`);
      }
      await table.add(operationToRow(operation));
    });
  }

  async update(operation: SendOperation): Promise<void> {
    await this.db.runTransaction('rw', [this.storeName], async (tx) => {
      const table = tx.table(this.storeName);
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
    const row = await this.db.runTransaction('r', [this.storeName], async (tx) => {
      return (await tx.table(this.storeName).get(id)) as SendOperationRow | undefined;
    });
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: SendOperationState): Promise<SendOperation[]> {
    const rows = await this.db.runTransaction('r', [this.storeName], async (tx) => {
      return (await tx
        .table(this.storeName)
        .where('state')
        .equals(state)
        .toArray()) as SendOperationRow[];
    });
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<SendOperation[]> {
    const rows = await this.db.runTransaction('r', [this.storeName], async (tx) => {
      return (await tx
        .table(this.storeName)
        .where('state')
        .anyOf(['executing', 'pending', 'rolling_back'])
        .toArray()) as SendOperationRow[];
    });
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<SendOperation[]> {
    const rows = await this.db.runTransaction('r', [this.storeName], async (tx) => {
      return (await tx
        .table(this.storeName)
        .where('mintUrl')
        .equals(mintUrl)
        .toArray()) as SendOperationRow[];
    });
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.runTransaction('rw', [this.storeName], async (tx) => {
      const table = tx.table(this.storeName);
      await table.delete(id);
    });
  }
}
