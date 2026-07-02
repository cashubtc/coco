import type {
  DeferredReceiveReason,
  ReceiveOperationRepository,
  ReceiveOperation,
  ReceiveOperationState,
} from '@cashu/coco-core/adapter';
import { deserializeAmount, serializeAmount } from '@cashu/coco-core/adapter';
import type { SqlDatabase, SqlValue } from '../index.ts';
import { getUnixTimeSeconds } from '../utils.ts';

function getOperationUnit(op: ReceiveOperation): string {
  return (op as ReceiveOperation & { unit?: string }).unit ?? 'sat';
}

interface ReceiveOperationRow {
  id: string;
  mintUrl: string;
  unit: string | null;
  amount: string | number;
  state: ReceiveOperationState;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  fee: string | number | null;
  inputProofsJson: string | null;
  outputDataJson: string | null;
  sourceJson: string | null;
  deferredReason: DeferredReceiveReason | null;
  batchId: string | null;
}

function parseInputProofs(inputProofsJson: string | null): ReceiveOperation['inputProofs'] {
  const proofs = inputProofsJson
    ? (JSON.parse(inputProofsJson) as ReceiveOperation['inputProofs'])
    : [];
  return proofs.map((proof) => ({
    ...proof,
    amount: deserializeAmount(proof.amount),
  }));
}

function rowToOperation(row: ReceiveOperationRow): ReceiveOperation {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    unit: row.unit ?? 'sat',
    amount: deserializeAmount(row.amount),
    inputProofs: parseInputProofs(row.inputProofsJson),
    createdAt: row.createdAt * 1000,
    updatedAt: row.updatedAt * 1000,
    error: row.error ?? undefined,
    source: row.sourceJson ? JSON.parse(row.sourceJson) : undefined,
    batchId: row.batchId ?? undefined,
  };

  if (row.state === 'init') {
    return { ...base, state: 'init' };
  }

  if (row.state === 'deferred') {
    return { ...base, state: 'deferred', deferredReason: row.deferredReason ?? 'dust' };
  }

  const preparedData = {
    fee: deserializeAmount(row.fee ?? 0),
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

function operationToParams(op: ReceiveOperation): SqlValue[] {
  const createdAtSeconds = Math.floor(op.createdAt / 1000);
  const updatedAtSeconds = Math.floor(op.updatedAt / 1000);

  if (op.state === 'init' || op.state === 'deferred') {
    return [
      op.id,
      op.mintUrl,
      getOperationUnit(op),
      serializeAmount(op.amount),
      op.state,
      createdAtSeconds,
      updatedAtSeconds,
      op.error ?? null,
      null,
      JSON.stringify(op.inputProofs),
      null,
      op.source ? JSON.stringify(op.source) : null,
      op.state === 'deferred' ? op.deferredReason : null,
      op.batchId ?? null,
    ];
  }

  return [
    op.id,
    op.mintUrl,
    getOperationUnit(op),
    serializeAmount(op.amount),
    op.state,
    createdAtSeconds,
    updatedAtSeconds,
    op.error ?? null,
    serializeAmount(op.fee),
    JSON.stringify(op.inputProofs),
    op.outputData ? JSON.stringify(op.outputData) : null,
    op.source ? JSON.stringify(op.source) : null,
    null,
    op.batchId ?? null,
  ];
}

export class SqliteReceiveOperationRepository implements ReceiveOperationRepository {
  private readonly db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.db = db;
  }

  async create(operation: ReceiveOperation): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_receive_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (exists) {
      throw new Error(`ReceiveOperation with id ${operation.id} already exists`);
    }

    const params = operationToParams(operation);
    await this.db.run(
      `INSERT INTO coco_cashu_receive_operations
        (id, mintUrl, unit, amount, state, createdAt, updatedAt, error, fee, inputProofsJson, outputDataJson, sourceJson, deferredReason, batchId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params,
    );
  }

  async update(operation: ReceiveOperation): Promise<void> {
    const exists = await this.db.get<{ id: string }>(
      'SELECT id FROM coco_cashu_receive_operations WHERE id = ? LIMIT 1',
      [operation.id],
    );
    if (!exists) {
      throw new Error(`ReceiveOperation with id ${operation.id} not found`);
    }

    const updatedAtSeconds = getUnixTimeSeconds();

    if (operation.state === 'init' || operation.state === 'deferred') {
      await this.db.run(
        `UPDATE coco_cashu_receive_operations
         SET state = ?, updatedAt = ?, error = ?, unit = ?, fee = NULL, inputProofsJson = ?, outputDataJson = NULL, sourceJson = ?, deferredReason = ?, batchId = ?
         WHERE id = ?`,
        [
          operation.state,
          updatedAtSeconds,
          operation.error ?? null,
          getOperationUnit(operation),
          JSON.stringify(operation.inputProofs),
          operation.source ? JSON.stringify(operation.source) : null,
          operation.state === 'deferred' ? operation.deferredReason : null,
          operation.batchId ?? null,
          operation.id,
        ],
      );
    } else {
      await this.db.run(
        `UPDATE coco_cashu_receive_operations
         SET state = ?, updatedAt = ?, error = ?, unit = ?, fee = ?, inputProofsJson = ?, outputDataJson = ?, sourceJson = ?, deferredReason = NULL, batchId = ?
         WHERE id = ?`,
        [
          operation.state,
          updatedAtSeconds,
          operation.error ?? null,
          getOperationUnit(operation),
          serializeAmount(operation.fee),
          JSON.stringify(operation.inputProofs),
          operation.outputData ? JSON.stringify(operation.outputData) : null,
          operation.source ? JSON.stringify(operation.source) : null,
          operation.batchId ?? null,
          operation.id,
        ],
      );
    }
  }

  async getById(id: string): Promise<ReceiveOperation | null> {
    const row = await this.db.get<ReceiveOperationRow>(
      'SELECT * FROM coco_cashu_receive_operations WHERE id = ?',
      [id],
    );
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: ReceiveOperationState): Promise<ReceiveOperation[]> {
    const rows = await this.db.all<ReceiveOperationRow>(
      'SELECT * FROM coco_cashu_receive_operations WHERE state = ?',
      [state],
    );
    return rows.map(rowToOperation);
  }

  async getPending(): Promise<ReceiveOperation[]> {
    const rows = await this.db.all<ReceiveOperationRow>(
      "SELECT * FROM coco_cashu_receive_operations WHERE state IN ('executing', 'deferred')",
    );
    return rows.map(rowToOperation);
  }

  async getByMintUrl(mintUrl: string): Promise<ReceiveOperation[]> {
    const rows = await this.db.all<ReceiveOperationRow>(
      'SELECT * FROM coco_cashu_receive_operations WHERE mintUrl = ?',
      [mintUrl],
    );
    return rows.map(rowToOperation);
  }

  async getByPaymentRequestAttemptId(attemptId: string): Promise<ReceiveOperation | null> {
    const rows = await this.db.all<ReceiveOperationRow>(
      'SELECT * FROM coco_cashu_receive_operations WHERE sourceJson IS NOT NULL',
    );
    const operation = rows
      .map(rowToOperation)
      .find(
        (candidate) =>
          candidate.source?.type === 'payment-request' && candidate.source.attemptId === attemptId,
      );
    return operation ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_receive_operations WHERE id = ?', [id]);
  }
}
