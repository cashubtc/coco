import type { MintOperationRepository, OperationParent } from '@cashu/coco-core/adapter';
import { deserializeAmount, serializeAmount, stringifyJson } from '@cashu/coco-core/adapter';
import type { SqlDatabase, SqlValue } from '../index.ts';
import { getUnixTimeSeconds } from '../utils.ts';

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
  amount: string | number | null;
  unit: string | null;
  request: string | null;
  expiry: number | null;
  pubkey: string | null;
  lastObservedRemoteState: string | null;
  lastObservedRemoteStateAt: number | null;
  terminalFailureJson: string | null;
  outputDataJson: string | null;
  parentKind: string | null;
  parentId: string | null;
  batchingDisabled: number | null;
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

const requireQuoteId = (row: MintOperationRow): string => {
  if (!row.quoteId || row.quoteId.trim() === '') {
    throw new Error(`MintOperation ${row.id} is missing required quoteId`);
  }

  return row.quoteId;
};

const parseParent = (row: MintOperationRow): OperationParent | undefined => {
  if (row.parentKind === null && row.parentId === null) return undefined;
  if (!row.parentId || (row.parentKind !== 'mint-swap' && row.parentKind !== 'mint-batch')) {
    throw new Error(`MintOperation ${row.id} has invalid parent metadata`);
  }

  return { kind: row.parentKind, id: row.parentId };
};

const rowToOperation = (row: MintOperationRow): MintOperation => {
  const quoteId = requireQuoteId(row);
  const parent = parseParent(row);
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
    ...(parent ? { parent } : {}),
    ...(row.batchingDisabled === 1 ? { batchingDisabled: true } : {}),
  };

  const intent = {
    amount: deserializeAmount(row.amount ?? 0),
    unit: row.unit ?? '',
  };

  if (!isPersistedState(row.state)) {
    return {
      ...base,
      ...intent,
      state: 'init',
      quoteId,
    };
  }

  return {
    ...base,
    ...intent,
    state: normalizeState(row.state),
    quoteId,
    request: row.request ?? '',
    expiry: row.expiry ?? null,
    pubkey: row.pubkey ?? undefined,
    outputData: row.outputDataJson ? JSON.parse(row.outputDataJson) : { keep: [], send: [] },
  } as MintOperation;
};

const operationToParams = (operation: MintOperation): SqlValue[] => {
  const createdAtSeconds = Math.floor(operation.createdAt / 1000);
  const updatedAtSeconds = Math.floor(operation.updatedAt / 1000);
  const methodDataJson = stringifyJson(operation.methodData);

  if (operation.state === 'init') {
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
      serializeAmount(operation.amount),
      operation.unit,
      null,
      null,
      null,
      null,
      null,
      operation.terminalFailure ? JSON.stringify(operation.terminalFailure) : null,
      null,
      operation.parent?.kind ?? null,
      operation.parent?.id ?? null,
      operation.batchingDisabled ? 1 : null,
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
    serializeAmount(operation.amount),
    operation.unit,
    operation.request,
    operation.expiry,
    operation.pubkey ?? null,
    null,
    null,
    operation.terminalFailure ? JSON.stringify(operation.terminalFailure) : null,
    JSON.stringify(operation.outputData),
    operation.parent?.kind ?? null,
    operation.parent?.id ?? null,
    operation.batchingDisabled ? 1 : null,
  ];
};

export class SqliteMintOperationRepository implements MintOperationRepository {
  private readonly db: SqlDatabase;

  constructor(db: SqlDatabase) {
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
        (id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson, amount, unit, request, expiry, pubkey, lastObservedRemoteState, lastObservedRemoteStateAt, terminalFailureJson, outputDataJson, parentKind, parentId, batchingDisabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    await this.updateWhere(operation, 'id = ?', [operation.id]);
  }

  async updateIfStateAndParentMatch(
    operation: MintOperation,
    expected: { state: MintOperationState; parent?: OperationParent },
  ): Promise<boolean> {
    const parentCondition = expected.parent
      ? 'parentKind = ? AND parentId = ?'
      : 'parentKind IS NULL AND parentId IS NULL';
    const parentParams = expected.parent ? [expected.parent.kind, expected.parent.id] : [];

    const changes = await this.updateWhere(
      operation,
      `id = ? AND state = ? AND ${parentCondition}`,
      [operation.id, expected.state, ...parentParams],
    );
    return changes > 0;
  }

  private async updateWhere(
    operation: MintOperation,
    where: string,
    whereParams: SqlValue[],
  ): Promise<number> {
    const updatedAtSeconds = getUnixTimeSeconds();

    if (operation.state === 'init') {
      const result = await this.db.run(
        `UPDATE coco_cashu_mint_operations
         SET quoteId = ?, state = ?, updatedAt = ?, error = ?, method = ?, methodDataJson = ?, amount = ?, unit = ?, terminalFailureJson = ?, parentKind = ?, parentId = ?, batchingDisabled = ?
         WHERE ${where}`,
        [
          operation.quoteId,
          operation.state,
          updatedAtSeconds,
          operation.error ?? null,
          operation.method,
          stringifyJson(operation.methodData),
          serializeAmount(operation.amount),
          operation.unit,
          operation.terminalFailure ? JSON.stringify(operation.terminalFailure) : null,
          operation.parent?.kind ?? null,
          operation.parent?.id ?? null,
          operation.batchingDisabled ? 1 : null,
          ...whereParams,
        ],
      );
      return result.changes;
    }

    const result = await this.db.run(
      `UPDATE coco_cashu_mint_operations
       SET quoteId = ?, state = ?, updatedAt = ?, error = ?, method = ?, methodDataJson = ?, amount = ?, unit = ?, request = ?, expiry = ?, pubkey = ?, lastObservedRemoteState = ?, lastObservedRemoteStateAt = ?, terminalFailureJson = ?, outputDataJson = ?, parentKind = ?, parentId = ?, batchingDisabled = ?
       WHERE ${where}`,
      [
        operation.quoteId,
        operation.state,
        updatedAtSeconds,
        operation.error ?? null,
        operation.method,
        stringifyJson(operation.methodData),
        serializeAmount(operation.amount),
        operation.unit,
        operation.request,
        operation.expiry,
        operation.pubkey ?? null,
        null,
        null,
        operation.terminalFailure ? JSON.stringify(operation.terminalFailure) : null,
        JSON.stringify(operation.outputData),
        operation.parent?.kind ?? null,
        operation.parent?.id ?? null,
        operation.batchingDisabled ? 1 : null,
        ...whereParams,
      ],
    );
    return result.changes;
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

  async getByQuoteId(mintUrl: string, method: string, quoteId: string): Promise<MintOperation[]> {
    const rows = await this.db.all<MintOperationRow>(
      `SELECT * FROM coco_cashu_mint_operations
       WHERE mintUrl = ? AND method = ? AND quoteId = ?
       ORDER BY createdAt ASC, id ASC`,
      [mintUrl, method, quoteId],
    );
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_mint_operations WHERE id = ?', [id]);
  }
}
