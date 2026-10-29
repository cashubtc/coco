import type {
  BatchMintOperation,
  BatchMintOperationState,
} from '../../operations/batchMint/BatchMintOperation.ts';
import type { BatchMintOperationRepository } from '../../operations/batchMint/BatchMintOperationRepository.ts';
import { assertBatchMintOperation, assertBatchMintUpdate } from '../../operations/batchMint/BatchMintValidation.ts';
import type { QuoteIdentity } from '../../models/QuoteIdentity.ts';
import { normalizeMintUrl } from '../../utils.ts';
import { cloneMemoryValue, COPY_MEMORY_REPOSITORY_STATE } from './MemoryRepositoryTransaction.ts';

function compareCreated(a: BatchMintOperation, b: BatchMintOperation): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function hydrate(operation: BatchMintOperation): BatchMintOperation {
  const copy = cloneMemoryValue(operation);
  copy.members.sort((a, b) => a.ordinal - b.ordinal);
  return copy;
}

export class MemoryBatchMintOperationRepository implements BatchMintOperationRepository {
  private readonly operations = new Map<string, BatchMintOperation>();

  [COPY_MEMORY_REPOSITORY_STATE](source: MemoryBatchMintOperationRepository): void {
    this.operations.clear();
    for (const [id, operation] of source.operations)
      this.operations.set(id, cloneMemoryValue(operation));
  }

  async create(operation: BatchMintOperation): Promise<void> {
    assertBatchMintOperation(operation);
    if (this.operations.has(operation.id))
      throw new Error(`Batch Mint Operation ${operation.id} already exists`);
    this.operations.set(
      operation.id,
      hydrate({ ...operation, mintUrl: normalizeMintUrl(operation.mintUrl) }),
    );
  }

  async update(operation: BatchMintOperation): Promise<void> {
    const current = this.operations.get(operation.id);
    if (!current) throw new Error(`Batch Mint Operation ${operation.id} not found`);
    assertBatchMintUpdate(current, operation);
    this.operations.set(operation.id, hydrate({ ...operation, mintUrl: current.mintUrl }));
  }

  async getById(id: string): Promise<BatchMintOperation | null> {
    const operation = this.operations.get(id);
    return operation ? hydrate(operation) : null;
  }

  async listByState(state: BatchMintOperationState): Promise<BatchMintOperation[]> {
    return this.list((operation) => operation.state === state);
  }

  async listInFlight(): Promise<BatchMintOperation[]> {
    return this.listByState('executing');
  }

  async listByQuote(quote: QuoteIdentity): Promise<BatchMintOperation[]> {
    const mintUrl = normalizeMintUrl(quote.mintUrl);
    return this.list(
      (operation) =>
        operation.mintUrl === mintUrl &&
        operation.members.some((member) => member.quoteId === quote.quoteId),
    );
  }

  private list(filter: (operation: BatchMintOperation) => boolean): BatchMintOperation[] {
    return Array.from(this.operations.values()).filter(filter).sort(compareCreated).map(hydrate);
  }
}
