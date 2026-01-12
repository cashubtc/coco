import type { MeltOperationRepository } from 'coco-cashu-core';
import type { IdbDb, MeltOperationRow } from '../lib/db.ts';
import { getUnixTimeSeconds } from '../lib/db.ts';

type MeltOperation = NonNullable<Awaited<ReturnType<MeltOperationRepository['getById']>>>;
type MeltOperationState = Parameters<MeltOperationRepository['getByState']>[0];
type MeltMethodData = MeltOperation['methodData'];

const preparedStates: MeltOperationState[] = [
  'prepared',
  'executing',
  'pending',
  'finalized',
  'rolling_back',
  'rolled_back',
];

const isPreparedState = (state: MeltOperationState) => preparedStates.includes(state);

const rowToOperation = (row: MeltOperationRow): MeltOperation => {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    method: row.method as MeltOperation['method'],
    methodData: JSON.parse(row.methodDataJson) as MeltMethodData,
    createdAt: row.createdAt * 1000,
    updatedAt: row.updatedAt * 1000,
    error: row.error ?? undefined,
  };

  if (!isPreparedState(row.state)) {
    return { ...base, state: 'init' };
  }

  const preparedData = {
    quoteId: row.quoteId ?? '',
    amount: row.amount ?? 0,
    fee_reserve: row.fee_reserve ?? 0,
    swap_fee: row.swap_fee ?? 0,
    needsSwap: row.needsSwap === 1,
    inputAmount: row.inputAmount ?? 0,
    inputProofSecrets: row.inputProofSecretsJson ? JSON.parse(row.inputProofSecretsJson) : [],
    changeOutputData: row.changeOutputDataJson
      ? JSON.parse(row.changeOutputDataJson)
      : { keep: [], send: [] },
    swapOutputData: row.swapOutputDataJson ? JSON.parse(row.swapOutputDataJson) : undefined,
  };

  return {
    ...base,
    state: row.state,
    ...preparedData,
  } as MeltOperation;
};

const operationToRow = (operation: MeltOperation): MeltOperationRow => {
  if (operation.state === 'failed') {
    throw new Error('Cannot persist failed melt operation');
  }

  const createdAtSeconds = Math.floor(operation.createdAt / 1000);
  const updatedAtSeconds = Math.floor(operation.updatedAt / 1000);
  const methodDataJson = JSON.stringify(operation.methodData);

  if (operation.state === 'init') {
    return {
      id: operation.id,
      mintUrl: operation.mintUrl,
      state: operation.state,
      createdAt: createdAtSeconds,
      updatedAt: updatedAtSeconds,
      error: operation.error ?? null,
      method: operation.method,
      methodDataJson,
      quoteId: null,
      amount: null,
      fee_reserve: null,
      swap_fee: null,
      needsSwap: null,
      inputAmount: null,
      inputProofSecretsJson: null,
      changeOutputDataJson: null,
      swapOutputDataJson: null,
    };
  }

  return {
    id: operation.id,
    mintUrl: operation.mintUrl,
    state: operation.state,
    createdAt: createdAtSeconds,
    updatedAt: updatedAtSeconds,
    error: operation.error ?? null,
    method: operation.method,
    methodDataJson,
    quoteId: operation.quoteId,
    amount: operation.amount,
    fee_reserve: operation.fee_reserve,
    swap_fee: operation.swap_fee,
    needsSwap: operation.needsSwap ? 1 : 0,
    inputAmount: operation.inputAmount,
    inputProofSecretsJson: JSON.stringify(operation.inputProofSecrets),
    changeOutputDataJson: JSON.stringify(operation.changeOutputData),
    swapOutputDataJson: operation.swapOutputData ? JSON.stringify(operation.swapOutputData) : null,
  };
};

export class IdbMeltOperationRepository implements MeltOperationRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async create(operation: MeltOperation): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_melt_operations'], async (tx) => {
      const table = tx.table('coco_cashu_melt_operations');
      const existing = await table.get(operation.id);
      if (existing) {
        throw new Error(`MeltOperation with id ${operation.id} already exists`);
      }

      if (operation.state !== 'init') {
        const duplicate = await table
          .where('[mintUrl+quoteId]')
          .equals([operation.mintUrl, operation.quoteId])
          .first();
        if (duplicate) {
          throw new Error(
            `MeltOperation already exists for mint ${operation.mintUrl} and quote ${operation.quoteId}`,
          );
        }
      }

      await table.add(operationToRow(operation));
    });
  }

  async update(operation: MeltOperation): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_melt_operations'], async (tx) => {
      const table = tx.table('coco_cashu_melt_operations');
      const existing = await table.get(operation.id);
      if (!existing) {
        throw new Error(`MeltOperation with id ${operation.id} not found`);
      }

      if (operation.state !== 'init') {
        const duplicate = await table
          .where('[mintUrl+quoteId]')
          .equals([operation.mintUrl, operation.quoteId])
          .first();
        if (duplicate && duplicate.id !== operation.id) {
          throw new Error(
            `MeltOperation already exists for mint ${operation.mintUrl} and quote ${operation.quoteId}`,
          );
        }
      }

      const row = operationToRow(operation);
      row.updatedAt = getUnixTimeSeconds();
      await table.put(row);
    });
  }

  async getById(id: string): Promise<MeltOperation | null> {
    const row = (await (this.db as any)
      .table('coco_cashu_melt_operations')
      .get(id)) as MeltOperationRow | undefined;
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: MeltOperationState): Promise<MeltOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_melt_operations')
      .where('state')
      .equals(state)
      .toArray()) as MeltOperationRow[];
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<MeltOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_melt_operations')
      .where('state')
      .anyOf(['executing', 'pending'])
      .toArray()) as MeltOperationRow[];
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<MeltOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_melt_operations')
      .where('mintUrl')
      .equals(mintUrl)
      .toArray()) as MeltOperationRow[];
    return rows.map(rowToOperation);
  }

  async getByQuoteId(mintUrl: string, quoteId: string): Promise<MeltOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_melt_operations')
      .where('[mintUrl+quoteId]')
      .equals([mintUrl, quoteId])
      .toArray()) as MeltOperationRow[];
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_melt_operations'], async (tx) => {
      const table = tx.table('coco_cashu_melt_operations');
      await table.delete(id);
    });
  }
}
