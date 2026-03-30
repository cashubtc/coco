import type { MintOperationRepository } from '@cashu/coco-core';
import { SqliteDb, getUnixTimeSeconds } from '../db.ts';

type MintOperation = NonNullable<Awaited<ReturnType<MintOperationRepository['getById']>>>;
type MintOperationState = Parameters<MintOperationRepository['getByState']>[0];
type MintMethod = MintOperation['method'];
type MintMethodData = MintOperation['methodData'];
type MintOperationFailure = NonNullable<MintOperation['terminalFailure']>;

interface MintOperationRow {
  id: string;
  mintUrl: string;
  quoteId: string | null;
  state: MintOperationState;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  method: MintMethod;
  methodDataJson: string;
  amount: number | null;
  unit: string | null;
  request: string | null;
  expiry: number | null;
  pubkey: string | null;
  lastObservedRemoteState: string | null;
  lastObservedRemoteStateAt: number | null;
  terminalFailureJson: string | null;
  outputDataJson: string | null;
}

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
    method: row.method,
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

const operationToParams = (operation: MintOperation): unknown[] => {
  const createdAtSeconds = Math.floor(operation.createdAt / 1000);
  const updatedAtSeconds = Math.floor(operation.updatedAt / 1000);
  const methodDataJson = JSON.stringify(operation.methodData);

  if (operation.state === 'init') {
    return [
      operation.id,
      operation.mintUrl,
      operation.quoteId ?? null,
      operation.state,
      createdAtSeconds,
      updatedAtSeconds,
      operation.error ?? null,
      operation.method,
      methodDataJson,
      operation.amount,
      operation.unit,
      null,
      null,
      null,
      null,
      null,
      operation.terminalFailure ? JSON.stringify(operation.terminalFailure) : null,
      null,
    ];
  }

  return [
    operation.id,
    operation.mintUrl,
    operation.quoteId,
    operation.state,
    createdAtSeconds,
    updatedAtSeconds,
    operation.error ?? null,
    operation.method,
    methodDataJson,
    operation.amount,
    operation.unit,
    operation.request,
    operation.expiry,
    operation.pubkey ?? null,
    operation.lastObservedRemoteState ?? null,
    operation.lastObservedRemoteStateAt ?? null,
    operation.terminalFailure ? JSON.stringify(operation.terminalFailure) : null,
    JSON.stringify(operation.outputData),
  ];
};

export class SqliteMintOperationRepository implements MintOperationRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async create(operation: MintOperation): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_mint_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (exists) {
      throw new Error(`MintOperation with id ${operation.id} already exists`);
    }

    const params = operationToParams(operation);
    await this.db.run(
      `INSERT INTO coco_cashu_mint_operations
        (id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson, amount, unit, request, expiry, pubkey, lastObservedRemoteState, lastObservedRemoteStateAt, terminalFailureJson, outputDataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params,
    );
  }

  async update(operation: MintOperation): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_mint_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (!exists) {
      throw new Error(`MintOperation with id ${operation.id} not found`);
    }

    const updatedAtSeconds = getUnixTimeSeconds();

    if (operation.state === 'init') {
      await this.db.run(
        `UPDATE coco_cashu_mint_operations
         SET quoteId = ?, state = ?, updatedAt = ?, error = ?, method = ?, methodDataJson = ?, amount = ?, unit = ?, terminalFailureJson = ?
         WHERE id = ?`,
        [
          operation.quoteId ?? null,
          operation.state,
          updatedAtSeconds,
          operation.error ?? null,
          operation.method,
          JSON.stringify(operation.methodData),
          operation.amount,
          operation.unit,
          operation.terminalFailure ? JSON.stringify(operation.terminalFailure) : null,
          operation.id,
        ],
      );
      return;
    }

    await this.db.run(
      `UPDATE coco_cashu_mint_operations
       SET quoteId = ?, state = ?, updatedAt = ?, error = ?, method = ?, methodDataJson = ?, amount = ?, unit = ?, request = ?, expiry = ?, pubkey = ?, lastObservedRemoteState = ?, lastObservedRemoteStateAt = ?, terminalFailureJson = ?, outputDataJson = ?
       WHERE id = ?`,
      [
        operation.quoteId,
        operation.state,
        updatedAtSeconds,
        operation.error ?? null,
        operation.method,
        JSON.stringify(operation.methodData),
        operation.amount,
        operation.unit,
        operation.request,
        operation.expiry,
        operation.pubkey ?? null,
        operation.lastObservedRemoteState ?? null,
        operation.lastObservedRemoteStateAt ?? null,
        operation.terminalFailure ? JSON.stringify(operation.terminalFailure) : null,
        JSON.stringify(operation.outputData),
        operation.id,
      ],
    );
  }

  async getById(id: string): Promise<MintOperation | null> {
    const row = await this.db.get<MintOperationRow>(
      'SELECT * FROM coco_cashu_mint_operations WHERE id = ?',
      [id],
    );
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: MintOperationState): Promise<MintOperation[]> {
    const rows = await this.db.all<MintOperationRow>(
      'SELECT * FROM coco_cashu_mint_operations WHERE state = ?',
      [state],
    );
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<MintOperation[]> {
    const rows = await this.db.all<MintOperationRow>(
      "SELECT * FROM coco_cashu_mint_operations WHERE state IN ('pending', 'executing')",
    );
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<MintOperation[]> {
    const rows = await this.db.all<MintOperationRow>(
      'SELECT * FROM coco_cashu_mint_operations WHERE mintUrl = ?',
      [mintUrl],
    );
    return rows.map(rowToOperation);
  }

  async getByQuoteId(mintUrl: string, quoteId: string): Promise<MintOperation[]> {
    const rows = await this.db.all<MintOperationRow>(
      'SELECT * FROM coco_cashu_mint_operations WHERE mintUrl = ? AND quoteId = ? ORDER BY updatedAt DESC',
      [mintUrl, quoteId],
    );
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_mint_operations WHERE id = ?', [id]);
  }
}
