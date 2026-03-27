import type { MintOperationRepository } from 'coco-cashu-core';
import type { IdbDb, MintOperationRow } from '../lib/db.ts';
import { getUnixTimeSeconds } from '../lib/db.ts';

type MintOperation = NonNullable<Awaited<ReturnType<MintOperationRepository['getById']>>>;
type MintOperationState = Parameters<MintOperationRepository['getByState']>[0];
type MintMethodData = MintOperation['methodData'];
type MintOperationFailure = NonNullable<MintOperation['terminalFailure']>;

const persistedStates = ['pending', 'executing', 'finalized', 'failed'] as const;

const isPersistedState = (state: string): state is (typeof persistedStates)[number] =>
  persistedStates.includes(state as (typeof persistedStates)[number]);

const normalizeState = (state: string): MintOperationState => {
  if (state === 'pending' || state === 'executing' || state === 'finalized' || state === 'failed') {
    return state;
  }
  return 'init';
};

const rowToOperation = (row: MintOperationRow): MintOperation => {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    method: row.method as MintOperation['method'],
    methodData: JSON.parse(row.methodDataJson) as MintMethodData,
    createdAt: row.createdAt * 1000,
    updatedAt: row.updatedAt * 1000,
    error: row.error ?? undefined,
    ...(row.terminalFailureJson
      ? { terminalFailure: JSON.parse(row.terminalFailureJson) as MintOperationFailure }
      : {}),
  };

  const intent = {
    amount: row.amount ?? 0,
    unit: row.unit ?? '',
  };

  if (!isPersistedState(row.state)) {
    return {
      ...base,
      ...intent,
      state: 'init',
      ...(row.quoteId ? { quoteId: row.quoteId } : {}),
    };
  }

  return {
    ...base,
    ...intent,
    state: normalizeState(row.state),
    quoteId: row.quoteId ?? '',
    request: row.request ?? '',
    expiry: row.expiry ?? 0,
    pubkey: row.pubkey ?? undefined,
    lastObservedRemoteState: row.lastObservedRemoteState ?? undefined,
    lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
    outputData: row.outputDataJson ? JSON.parse(row.outputDataJson) : { keep: [], send: [] },
  } as MintOperation;
};

const operationToRow = (operation: MintOperation): MintOperationRow => {
  const createdAtSeconds = Math.floor(operation.createdAt / 1000);
  const updatedAtSeconds = Math.floor(operation.updatedAt / 1000);
  const methodDataJson = JSON.stringify(operation.methodData);

  if (operation.state === 'init') {
    return {
      id: operation.id,
      mintUrl: operation.mintUrl,
      quoteId: operation.quoteId ?? null,
      state: operation.state,
      createdAt: createdAtSeconds,
      updatedAt: updatedAtSeconds,
      error: operation.error ?? null,
      method: operation.method,
      methodDataJson,
      amount: operation.amount,
      unit: operation.unit,
      terminalFailureJson: operation.terminalFailure
        ? JSON.stringify(operation.terminalFailure)
        : null,
      outputDataJson: null,
    };
  }

  return {
    id: operation.id,
    mintUrl: operation.mintUrl,
    quoteId: operation.quoteId,
    state: operation.state,
    createdAt: createdAtSeconds,
    updatedAt: updatedAtSeconds,
    error: operation.error ?? null,
    method: operation.method,
    methodDataJson,
    amount: operation.amount,
    unit: operation.unit,
    request: operation.request,
    expiry: operation.expiry,
    pubkey: operation.pubkey ?? null,
    lastObservedRemoteState: operation.lastObservedRemoteState ?? null,
    lastObservedRemoteStateAt: operation.lastObservedRemoteStateAt ?? null,
    terminalFailureJson: operation.terminalFailure
      ? JSON.stringify(operation.terminalFailure)
      : null,
    outputDataJson: JSON.stringify(operation.outputData),
  };
};

export class IdbMintOperationRepository implements MintOperationRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async create(operation: MintOperation): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_mint_operations'], async (tx) => {
      const table = tx.table('coco_cashu_mint_operations');
      const existing = await table.get(operation.id);
      if (existing) {
        throw new Error(`MintOperation with id ${operation.id} already exists`);
      }
      await table.add(operationToRow(operation));
    });
  }

  async update(operation: MintOperation): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_mint_operations'], async (tx) => {
      const table = tx.table('coco_cashu_mint_operations');
      const existing = await table.get(operation.id);
      if (!existing) {
        throw new Error(`MintOperation with id ${operation.id} not found`);
      }

      const row = operationToRow(operation);
      row.updatedAt = getUnixTimeSeconds();
      await table.put(row);
    });
  }

  async getById(id: string): Promise<MintOperation | null> {
    const row = (await (this.db as any).table('coco_cashu_mint_operations').get(id)) as
      | MintOperationRow
      | undefined;
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: MintOperationState): Promise<MintOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_mint_operations')
      .where('state')
      .anyOf([state])
      .toArray()) as MintOperationRow[];
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<MintOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_mint_operations')
      .where('state')
      .anyOf(['pending', 'executing'])
      .toArray()) as MintOperationRow[];
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<MintOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_mint_operations')
      .where('mintUrl')
      .equals(mintUrl)
      .toArray()) as MintOperationRow[];
    return rows.map(rowToOperation);
  }

  async getByQuoteId(mintUrl: string, quoteId: string): Promise<MintOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_mint_operations')
      .where('[mintUrl+quoteId]')
      .equals([mintUrl, quoteId])
      .toArray()) as MintOperationRow[];
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_mint_operations'], async (tx) => {
      const table = tx.table('coco_cashu_mint_operations');
      await table.delete(id);
    });
  }
}
