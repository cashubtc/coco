import type {
  ReceiveOperationRepository,
  ReceiveOperation,
  ReceiveOperationState,
} from '@cashu/coco-core/adapter';
import { deserializeAmount, serializeAmount } from '@cashu/coco-core/adapter';
import type { SqlDatabase, SqlValue } from '../index.ts';
import { assertFieldPresent } from '../utils.ts';

function getOperationUnit(op: ReceiveOperation): string {
  return (op as ReceiveOperation & { unit?: string }).unit ?? 'sat';
}

interface ReceiveOperationRow {
  revision: number;
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
    revision: row.revision ?? 0,
    mintUrl: row.mintUrl,
    unit: row.unit ?? 'sat',
    amount: deserializeAmount(row.amount),
    inputProofs: parseInputProofs(row.inputProofsJson),
    createdAt: row.createdAt * 1000,
    updatedAt: row.updatedAt * 1000,
    error: row.error ?? undefined,
    source: row.sourceJson ? JSON.parse(row.sourceJson) : undefined,
  };

  if (row.state === 'init') {
    return { ...base, state: 'init' };
  }

  const preparedData = {
    fee: deserializeAmount(assertFieldPresent(row.fee, 'fee', row.id)),
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

  if (op.state === 'init') {
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
      op.revision ?? 0,
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
    op.revision ?? 0,
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
        (id, mintUrl, unit, amount, state, createdAt, updatedAt, error, fee, inputProofsJson, outputDataJson, sourceJson, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params,
    );
  }

  async update(operation: ReceiveOperation): Promise<void> {
    const params = operationToParams({ ...operation, updatedAt: Date.now() });
    const result = await this.db.run(
      `UPDATE coco_cashu_receive_operations SET mintUrl = ?, unit = ?, amount = ?, state = ?, createdAt = ?, updatedAt = ?, error = ?, fee = ?, inputProofsJson = ?, outputDataJson = ?, sourceJson = ?, revision = ? WHERE id = ?`,
      [...params.slice(1), operation.id],
    );
    if (result.changes === 0) throw new Error(`ReceiveOperation with id ${operation.id} not found`);
  }

  async transition(
    input: Parameters<ReceiveOperationRepository['transition']>[0],
  ): Promise<boolean> {
    if (input.next.id !== input.operationId)
      throw new Error('Receive operation transition cannot change the operation id');
    const params = operationToParams({ ...input.next, revision: input.expectedRevision + 1 });
    const result = await this.db.run(
      `UPDATE coco_cashu_receive_operations SET mintUrl = ?, unit = ?, amount = ?, state = ?, createdAt = ?, updatedAt = ?, error = ?, fee = ?, inputProofsJson = ?, outputDataJson = ?, sourceJson = ?, revision = ? WHERE id = ? AND state = ? AND revision = ?`,
      [...params.slice(1), input.operationId, input.expectedState, input.expectedRevision],
    );
    return result.changes === 1;
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
      "SELECT * FROM coco_cashu_receive_operations WHERE state IN ('executing')",
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
