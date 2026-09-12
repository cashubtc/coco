import type {
  MintSwapIdentityKind,
  MintSwapOperation,
  MintSwapOperationRepository,
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
import { IdbDb, type MintSwapOperationRow } from '../lib/db.ts';

const STORE = 'coco_cashu_mint_swap_operations';

export class IdbMintSwapOperationRepository implements MintSwapOperationRepository {
  constructor(private readonly db: IdbDb) {}

  async create(operation: MintSwapOperation): Promise<void> {
    const parsed = parseMintSwapOperation(operation);
    if (parsed.revision !== 0) throw new TypeError('Mint Swap creation requires revision zero');
    try {
      await this.table().add(toRow(parsed));
    } catch (error) {
      const kind = await this.findIdentityConflict(parsed);
      if (kind) throw new MintSwapIdentityConflictError(kind);
      throw error;
    }
  }

  async getById(id: string): Promise<MintSwapOperation | null> {
    const row = await this.table().get(id);
    return row ? fromRow(row) : null;
  }

  async transition(
    command: Parameters<MintSwapOperationRepository['transition']>[0],
  ): Promise<boolean> {
    return this.db.runTransaction('rw', [STORE], async () => {
      const currentRow = await this.table().get(command.operationId);
      if (
        !currentRow ||
        currentRow.state !== command.expectedState ||
        currentRow.revision !== command.expectedRevision
      ) {
        return false;
      }

      const current = fromRow(currentRow);
      const next = parseMintSwapOperation({
        ...command.next,
        revision: command.expectedRevision + 1,
      });
      validateMintSwapTransition(current, next);
      await this.table().put(toRow(next));
      return true;
    });
  }

  async listActive(): Promise<MintSwapOperation[]> {
    const rows = await this.table().toArray();
    return rows
      .map(fromRow)
      .filter((operation) => !isMintSwapTerminalState(operation.state))
      .sort(compareMintSwapCreated);
  }

  async listDue(now: number, limit: number): Promise<MintSwapOperation[]> {
    assertDueArguments(now, limit);
    if (limit === 0) return [];
    const rows = await this.table().where('nextAttemptAt').belowOrEqual(now).toArray();
    return rows
      .map(fromRow)
      .filter(
        (operation) =>
          isMintSwapAutomaticState(operation.state) &&
          operation.retry.nextAttemptAt !== null &&
          operation.retry.nextAttemptAt <= now,
      )
      .sort(compareMintSwapDue)
      .slice(0, limit);
  }

  private async findIdentityConflict(
    operation: MintSwapOperation,
  ): Promise<MintSwapIdentityKind | null> {
    const checks: Array<[MintSwapIdentityKind, Promise<unknown>]> = [
      ['parent', this.table().get(operation.id)],
      [
        'source_quote',
        this.table()
          .where('[sourceQuoteMintUrl+sourceQuoteMethod+sourceQuoteId]')
          .equals([
            operation.sourceQuote.mintUrl,
            operation.sourceQuote.method,
            operation.sourceQuote.quoteId,
          ])
          .first(),
      ],
      [
        'destination_quote',
        this.table()
          .where('[destinationQuoteMintUrl+destinationQuoteMethod+destinationQuoteId]')
          .equals([
            operation.destinationQuote.mintUrl,
            operation.destinationQuote.method,
            operation.destinationQuote.quoteId,
          ])
          .first(),
      ],
      [
        'source_child',
        this.table().where('sourceOperationId').equals(operation.sourceOperationId).first(),
      ],
      [
        'destination_child',
        this.table()
          .where('destinationOperationId')
          .equals(operation.destinationOperationId)
          .first(),
      ],
    ];
    for (const [kind, query] of checks) {
      if (await query) return kind;
    }
    return null;
  }

  private table() {
    return this.db.table<MintSwapOperationRow, string>(STORE);
  }
}

function toRow(operation: MintSwapOperation): MintSwapOperationRow {
  return {
    id: operation.id,
    state: operation.state,
    revision: operation.revision,
    ...(operation.retry.nextAttemptAt === null
      ? {}
      : { nextAttemptAt: operation.retry.nextAttemptAt }),
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

function fromRow(row: MintSwapOperationRow): MintSwapOperation {
  const operation = deserializeMintSwapOperation(row.recordJson);
  if (
    operation.id !== row.id ||
    operation.state !== row.state ||
    operation.revision !== row.revision ||
    operation.retry.nextAttemptAt !== (row.nextAttemptAt ?? null) ||
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
