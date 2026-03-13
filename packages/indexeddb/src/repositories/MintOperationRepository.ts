import type { MintOperationRepository } from 'coco-cashu-core';
import type { IdbDb, MintOperationRow } from '../lib/db.ts';
import { getUnixTimeSeconds } from '../lib/db.ts';

type MintOperation = NonNullable<Awaited<ReturnType<MintOperationRepository['getById']>>>;
type MintOperationState = Parameters<MintOperationRepository['getByState']>[0];
type MintMethodData = MintOperation['methodData'];

const preparedStates: MintOperationState[] = ['prepared', 'executing', 'finalized', 'rolled_back'];

const isPreparedState = (state: MintOperationState) => preparedStates.includes(state);

const rowToOperation = (row: MintOperationRow): MintOperation => {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    quoteId: row.quoteId,
    method: row.method as MintOperation['method'],
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

const operationToRow = (operation: MintOperation): MintOperationRow => {
  const createdAtSeconds = Math.floor(operation.createdAt / 1000);
  const updatedAtSeconds = Math.floor(operation.updatedAt / 1000);
  const methodDataJson = JSON.stringify(operation.methodData);

  if (operation.state === 'init') {
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
      amount: null,
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
    const row = (await (this.db as any)
      .table('coco_cashu_mint_operations')
      .get(id)) as MintOperationRow | undefined;
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: MintOperationState): Promise<MintOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_mint_operations')
      .where('state')
      .equals(state)
      .toArray()) as MintOperationRow[];
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<MintOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_mint_operations')
      .where('state')
      .anyOf(['executing'])
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
