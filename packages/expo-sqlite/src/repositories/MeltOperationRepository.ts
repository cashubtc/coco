import type { MeltOperationRepository } from 'coco-cashu-core';
import { ExpoSqliteDb, getUnixTimeSeconds } from '../db.ts';

type MeltOperation = NonNullable<Awaited<ReturnType<MeltOperationRepository['getById']>>>;
type MeltOperationState = Parameters<MeltOperationRepository['getByState']>[0];
type MeltMethod = MeltOperation['method'];
type MeltMethodData = MeltOperation['methodData'];

interface MeltOperationRow {
  id: string;
  mintUrl: string;
  unit: string | null;
  state: MeltOperationState;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  method: MeltMethod;
  methodDataJson: string;
  quoteId: string | null;
  amount: number | null;
  fee_reserve: number | null;
  swap_fee: number | null;
  needsSwap: number | null;
  inputAmount: number | null;
  inputProofSecretsJson: string | null;
  changeOutputDataJson: string | null;
  swapOutputDataJson: string | null;
}

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
    unit: row.unit ?? 'sat',
    method: row.method,
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

const operationToParams = (operation: MeltOperation): unknown[] => {
  const createdAtSeconds = Math.floor(operation.createdAt / 1000);
  const updatedAtSeconds = Math.floor(operation.updatedAt / 1000);
  const methodDataJson = JSON.stringify(operation.methodData);

  if (operation.state === 'init') {
    return [
      operation.id,
      operation.mintUrl,
      operation.unit,
      operation.state,
      createdAtSeconds,
      updatedAtSeconds,
      operation.error ?? null,
      operation.method,
      methodDataJson,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];
  }

  return [
    operation.id,
    operation.mintUrl,
    operation.unit,
    operation.state,
    createdAtSeconds,
    updatedAtSeconds,
    operation.error ?? null,
    operation.method,
    methodDataJson,
    operation.quoteId,
    operation.amount,
    operation.fee_reserve,
    operation.swap_fee,
    operation.needsSwap ? 1 : 0,
    operation.inputAmount,
    JSON.stringify(operation.inputProofSecrets),
    JSON.stringify(operation.changeOutputData),
    operation.swapOutputData ? JSON.stringify(operation.swapOutputData) : null,
  ];
};

export class ExpoMeltOperationRepository implements MeltOperationRepository {
  private readonly db: ExpoSqliteDb;

  constructor(db: ExpoSqliteDb) {
    this.db = db;
  }

  async create(operation: MeltOperation): Promise<void> {
    if (operation.state === 'failed') {
      throw new Error('Cannot persist failed melt operation');
    }

    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_melt_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (exists) {
      throw new Error(`MeltOperation with id ${operation.id} already exists`);
    }

    const params = operationToParams(operation);
    await this.db.run(
      `INSERT INTO coco_cashu_melt_operations
        (id, mintUrl, state, createdAt, updatedAt, error, method, methodDataJson, quoteId, amount, fee_reserve, swap_fee, needsSwap, inputAmount, inputProofSecretsJson, changeOutputDataJson, swapOutputDataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params,
    );
  }

  async update(operation: MeltOperation): Promise<void> {
    if (operation.state === 'failed') {
      throw new Error('Cannot persist failed melt operation');
    }

    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_melt_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (!exists) {
      throw new Error(`MeltOperation with id ${operation.id} not found`);
    }

    const updatedAtSeconds = getUnixTimeSeconds();

    if (operation.state === 'init') {
      await this.db.run(
        `UPDATE coco_cashu_melt_operations
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
      `UPDATE coco_cashu_melt_operations
       SET state = ?, updatedAt = ?, error = ?, method = ?, methodDataJson = ?, quoteId = ?, amount = ?, fee_reserve = ?, swap_fee = ?, needsSwap = ?, inputAmount = ?, inputProofSecretsJson = ?, changeOutputDataJson = ?, swapOutputDataJson = ?
       WHERE id = ?`,
      [
        operation.state,
        updatedAtSeconds,
        operation.error ?? null,
        operation.method,
        JSON.stringify(operation.methodData),
        operation.quoteId,
        operation.amount,
        operation.fee_reserve,
        operation.swap_fee,
        operation.needsSwap ? 1 : 0,
        operation.inputAmount,
        JSON.stringify(operation.inputProofSecrets),
        JSON.stringify(operation.changeOutputData),
        operation.swapOutputData ? JSON.stringify(operation.swapOutputData) : null,
        operation.id,
      ],
    );
  }

  async getById(id: string): Promise<MeltOperation | null> {
    const row = await this.db.get<MeltOperationRow>(
      'SELECT * FROM coco_cashu_melt_operations WHERE id = ?',
      [id],
    );
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: MeltOperationState): Promise<MeltOperation[]> {
    const rows = await this.db.all<MeltOperationRow>(
      'SELECT * FROM coco_cashu_melt_operations WHERE state = ?',
      [state],
    );
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<MeltOperation[]> {
    const rows = await this.db.all<MeltOperationRow>(
      'SELECT * FROM coco_cashu_melt_operations WHERE state IN ("executing", "pending")',
    );
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<MeltOperation[]> {
    const rows = await this.db.all<MeltOperationRow>(
      'SELECT * FROM coco_cashu_melt_operations WHERE mintUrl = ?',
      [mintUrl],
    );
    return rows.map(rowToOperation);
  }

  async getByQuoteId(mintUrl: string, quoteId: string): Promise<MeltOperation[]> {
    const rows = await this.db.all<MeltOperationRow>(
      'SELECT * FROM coco_cashu_melt_operations WHERE mintUrl = ? AND quoteId = ?',
      [mintUrl, quoteId],
    );
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_melt_operations WHERE id = ?', [id]);
  }
}
