import type {
  BatchMintMember,
  BatchMintOperation,
  BatchMintOperationFailure,
  BatchMintOperationRepository,
  BatchMintOperationState,
  QuoteIdentity,
} from '@cashu/coco-core/adapter';
import {
  assertBatchMintOperation,
  assertBatchMintUpdate,
  deserializeAmount,
  normalizeMintUrl,
  serializeAmount,
} from '@cashu/coco-core/adapter';
import type { BatchMintMemberRow, BatchMintOperationRow, IdbDb } from '../lib/db.ts';

const OPERATIONS = 'coco_cashu_batch_mint_operations';
const MEMBERS = 'coco_cashu_batch_mint_members';

/** JavaScript ordering keeps lists identical across adapters. */
function compareCreated(a: BatchMintOperation, b: BatchMintOperation): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class IdbBatchMintOperationRepository implements BatchMintOperationRepository {
  constructor(private readonly db: IdbDb) {}

  async create(operation: BatchMintOperation): Promise<void> {
    assertBatchMintOperation(operation);
    const mintUrl = normalizeMintUrl(operation.mintUrl);
    await this.db.runTransaction('rw', [OPERATIONS, MEMBERS], async () => {
      await this.operations().add({
        id: operation.id,
        mintUrl,
        method: operation.method,
        unit: operation.unit,
        state: operation.state,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
        error: operation.error ?? null,
        terminalFailureJson: failureJson(operation),
        outputDataJson: JSON.stringify(operation.outputData),
      });
      await this.members().bulkAdd(
        operation.members.map((member) => ({
          operationId: operation.id,
          ordinal: member.ordinal,
          mintUrl,
          quoteId: member.quoteId,
          amount: serializeAmount(member.amount),
          request: member.request,
          signature: member.signature,
        })),
      );
    });
  }

  async update(operation: BatchMintOperation): Promise<void> {
    await this.db.runTransaction('rw', [OPERATIONS, MEMBERS], async () => {
      const current = await this.getById(operation.id);
      if (!current) throw new Error(`Batch Mint Operation ${operation.id} not found`);
      assertBatchMintUpdate(current, operation);
      await this.operations().update(operation.id, {
        state: operation.state,
        updatedAt: operation.updatedAt,
        error: operation.error ?? null,
        terminalFailureJson: failureJson(operation),
      });
    });
  }

  async getById(id: string): Promise<BatchMintOperation | null> {
    const row = await this.operations().get(id);
    if (!row) return null;
    const [operation] = await this.hydrate([row]);
    return operation ?? null;
  }

  async listByState(state: BatchMintOperationState): Promise<BatchMintOperation[]> {
    return this.hydrate(await this.operations().where('state').equals(state).toArray());
  }

  async listInFlight(): Promise<BatchMintOperation[]> {
    return this.listByState('executing');
  }

  async listByQuote(quote: QuoteIdentity): Promise<BatchMintOperation[]> {
    const members = await this.members()
      .where('[mintUrl+quoteId]')
      .equals([normalizeMintUrl(quote.mintUrl), quote.quoteId])
      .toArray();
    const rows = await this.operations().bulkGet([
      ...new Set(members.map((member) => member.operationId)),
    ]);
    return this.hydrate(rows.filter((row): row is BatchMintOperationRow => row !== undefined));
  }

  private async hydrate(rows: BatchMintOperationRow[]): Promise<BatchMintOperation[]> {
    const operations: BatchMintOperation[] = [];
    for (const row of rows) {
      const members = await this.members().where('operationId').equals(row.id).sortBy('ordinal');
      operations.push(fromRow(row, members.map(toMember)));
    }
    return operations.sort(compareCreated);
  }

  private operations() {
    return this.db.table<BatchMintOperationRow, string>(OPERATIONS);
  }

  private members() {
    return this.db.table<BatchMintMemberRow, [string, number]>(MEMBERS);
  }
}

function failureJson(operation: BatchMintOperation): string | null {
  return operation.state === 'failed' ? JSON.stringify(operation.terminalFailure) : null;
}

function toMember(row: BatchMintMemberRow): BatchMintMember {
  return {
    ordinal: row.ordinal,
    quoteId: row.quoteId,
    amount: deserializeAmount(row.amount),
    request: row.request,
    signature: row.signature,
  };
}

function fromRow(row: BatchMintOperationRow, members: BatchMintMember[]): BatchMintOperation {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    method: row.method as BatchMintOperation['method'],
    unit: row.unit,
    members,
    outputData: JSON.parse(row.outputDataJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.error !== null ? { error: row.error } : {}),
  };
  if (row.state === 'failed') {
    if (!row.terminalFailureJson)
      throw new Error(`Failed Batch Mint Operation ${row.id} has no terminal failure`);
    return {
      ...base,
      state: 'failed',
      terminalFailure: JSON.parse(row.terminalFailureJson) as BatchMintOperationFailure,
    };
  }
  return { ...base, state: row.state };
}
