import type {
  MintSwapIdentityKind,
  MintSwapOperation,
  MintSwapOperationRepository,
  MintSwapOperationState,
} from '@cashu/coco-core/adapter';
import {
  compareMintSwapCreated,
  compareMintSwapDue,
  deserializeMintSwapOperation,
  isMintSwapAutomaticState,
  isMintSwapTerminalState,
  MintSwapIdentityConflictError,
  parseMintSwapOperation,
  serializeMintSwapOperation,
  validateMintSwapTransition,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase, SqlParams } from '../index.ts';

interface MintSwapOperationRow {
  id: string;
  state: MintSwapOperationState;
  revision: number;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  sourceQuoteMintUrl: string;
  sourceQuoteMethod: string;
  sourceQuoteId: string;
  destinationQuoteMintUrl: string;
  destinationQuoteMethod: string;
  destinationQuoteId: string;
  sourceOperationId: string;
  destinationOperationId: string;
  recordJson: string;
}

const TABLE = 'coco_cashu_mint_swap_operations';
const SELECT_COLUMNS = `
  id, state, revision, nextAttemptAt, createdAt, updatedAt,
  sourceQuoteMintUrl, sourceQuoteMethod, sourceQuoteId,
  destinationQuoteMintUrl, destinationQuoteMethod, destinationQuoteId,
  sourceOperationId, destinationOperationId, recordJson
`;

export class SqliteMintSwapOperationRepository implements MintSwapOperationRepository {
  constructor(private readonly db: SqlDatabase) {}

  async create(operation: MintSwapOperation): Promise<void> {
    const parsed = parseMintSwapOperation(operation);
    if (parsed.revision !== 0) throw new TypeError('Mint Swap creation requires revision zero');
    const row = toRow(parsed);
    try {
      await this.db.run(
        `INSERT INTO ${TABLE} (${SELECT_COLUMNS}) VALUES (${Array(15).fill('?').join(', ')})`,
        rowParams(row),
      );
    } catch (error) {
      const kind = await this.findIdentityConflict(parsed);
      if (kind) throw new MintSwapIdentityConflictError(kind);
      throw error;
    }
  }

  async getById(id: string): Promise<MintSwapOperation | null> {
    const row = await this.db.get<MintSwapOperationRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE id = ?`,
      [id],
    );
    return row ? fromRow(row) : null;
  }

  async transition(
    command: Parameters<MintSwapOperationRepository['transition']>[0],
  ): Promise<boolean> {
    const current = await this.getById(command.operationId);
    if (
      !current ||
      current.state !== command.expectedState ||
      current.revision !== command.expectedRevision
    ) {
      return false;
    }

    const next = parseMintSwapOperation({
      ...command.next,
      revision: command.expectedRevision + 1,
    });
    validateMintSwapTransition(current, next);
    const row = toRow(next);
    const result = await this.db.run(
      `UPDATE ${TABLE} SET
        state = ?, revision = ?, nextAttemptAt = ?, createdAt = ?, updatedAt = ?,
        sourceQuoteMintUrl = ?, sourceQuoteMethod = ?, sourceQuoteId = ?,
        destinationQuoteMintUrl = ?, destinationQuoteMethod = ?, destinationQuoteId = ?,
        sourceOperationId = ?, destinationOperationId = ?, recordJson = ?
       WHERE id = ? AND state = ? AND revision = ?`,
      [
        row.state,
        row.revision,
        row.nextAttemptAt,
        row.createdAt,
        row.updatedAt,
        row.sourceQuoteMintUrl,
        row.sourceQuoteMethod,
        row.sourceQuoteId,
        row.destinationQuoteMintUrl,
        row.destinationQuoteMethod,
        row.destinationQuoteId,
        row.sourceOperationId,
        row.destinationOperationId,
        row.recordJson,
        command.operationId,
        command.expectedState,
        command.expectedRevision,
      ],
    );
    return result.changes === 1;
  }

  async listActive(): Promise<MintSwapOperation[]> {
    const rows = await this.db.all<MintSwapOperationRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
       WHERE state NOT IN ('completed', 'cancelled', 'failed')`,
    );
    return rows.map(fromRow).filter(isActive).sort(compareMintSwapCreated);
  }

  async listDue(now: number, limit: number): Promise<MintSwapOperation[]> {
    assertDueArguments(now, limit);
    if (limit === 0) return [];
    const rows = await this.db.all<MintSwapOperationRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
       WHERE state IN ('preparing', 'source_pending', 'destination_funded', 'destination_pending')
         AND nextAttemptAt IS NOT NULL AND nextAttemptAt <= ?`,
      [now],
    );
    return rows
      .map(fromRow)
      .filter((operation) => isDue(operation, now))
      .sort(compareMintSwapDue)
      .slice(0, limit);
  }

  private async findIdentityConflict(
    operation: MintSwapOperation,
  ): Promise<MintSwapIdentityKind | null> {
    const checks: Array<[MintSwapIdentityKind, string, SqlParams]> = [
      ['parent', 'id = ?', [operation.id]],
      [
        'source_quote',
        'sourceQuoteMintUrl = ? AND sourceQuoteMethod = ? AND sourceQuoteId = ?',
        [
          operation.sourceQuote.mintUrl,
          operation.sourceQuote.method,
          operation.sourceQuote.quoteId,
        ],
      ],
      [
        'destination_quote',
        'destinationQuoteMintUrl = ? AND destinationQuoteMethod = ? AND destinationQuoteId = ?',
        [
          operation.destinationQuote.mintUrl,
          operation.destinationQuote.method,
          operation.destinationQuote.quoteId,
        ],
      ],
      ['source_child', 'sourceOperationId = ?', [operation.sourceOperationId]],
      ['destination_child', 'destinationOperationId = ?', [operation.destinationOperationId]],
    ];
    for (const [kind, predicate, params] of checks) {
      if (await this.db.get(`SELECT id FROM ${TABLE} WHERE ${predicate} LIMIT 1`, params)) {
        return kind;
      }
    }
    return null;
  }
}

function toRow(operation: MintSwapOperation): MintSwapOperationRow {
  return {
    id: operation.id,
    state: operation.state,
    revision: operation.revision,
    nextAttemptAt: operation.retry.nextAttemptAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    sourceQuoteMintUrl: operation.sourceQuote.mintUrl,
    sourceQuoteMethod: operation.sourceQuote.method,
    sourceQuoteId: operation.sourceQuote.quoteId,
    destinationQuoteMintUrl: operation.destinationQuote.mintUrl,
    destinationQuoteMethod: operation.destinationQuote.method,
    destinationQuoteId: operation.destinationQuote.quoteId,
    sourceOperationId: operation.sourceOperationId,
    destinationOperationId: operation.destinationOperationId,
    recordJson: serializeMintSwapOperation(operation),
  };
}

function rowParams(row: MintSwapOperationRow): SqlParams {
  return [
    row.id,
    row.state,
    row.revision,
    row.nextAttemptAt,
    row.createdAt,
    row.updatedAt,
    row.sourceQuoteMintUrl,
    row.sourceQuoteMethod,
    row.sourceQuoteId,
    row.destinationQuoteMintUrl,
    row.destinationQuoteMethod,
    row.destinationQuoteId,
    row.sourceOperationId,
    row.destinationOperationId,
    row.recordJson,
  ];
}

function fromRow(row: MintSwapOperationRow): MintSwapOperation {
  const operation = deserializeMintSwapOperation(row.recordJson);
  if (
    operation.id !== row.id ||
    operation.state !== row.state ||
    operation.revision !== row.revision ||
    operation.retry.nextAttemptAt !== row.nextAttemptAt ||
    operation.createdAt !== row.createdAt ||
    operation.updatedAt !== row.updatedAt ||
    operation.sourceQuote.mintUrl !== row.sourceQuoteMintUrl ||
    operation.sourceQuote.method !== row.sourceQuoteMethod ||
    operation.sourceQuote.quoteId !== row.sourceQuoteId ||
    operation.destinationQuote.mintUrl !== row.destinationQuoteMintUrl ||
    operation.destinationQuote.method !== row.destinationQuoteMethod ||
    operation.destinationQuote.quoteId !== row.destinationQuoteId ||
    operation.sourceOperationId !== row.sourceOperationId ||
    operation.destinationOperationId !== row.destinationOperationId
  ) {
    throw new TypeError('Stored Mint Swap projections do not match the operation record');
  }
  return operation;
}

function assertDueArguments(now: number, limit: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('Mint Swap due scan requires nonnegative safe integer time and limit');
  }
}

function isActive(operation: MintSwapOperation): boolean {
  return !isMintSwapTerminalState(operation.state);
}

function isDue(operation: MintSwapOperation, now: number): boolean {
  return (
    isMintSwapAutomaticState(operation.state) &&
    operation.retry.nextAttemptAt !== null &&
    operation.retry.nextAttemptAt <= now
  );
}
