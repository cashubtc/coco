import { normalizeMintUrl } from '../../utils.ts';
import {
  isMintSwapAutomaticState,
  isMintSwapTerminalState,
  type MintSwapOperation,
} from '../../operations/mintSwap/MintSwapOperation.ts';
import type { MintSwapOperationRepository } from '../../operations/mintSwap/MintSwapOperationRepository.ts';
import { parseMintSwapOperation } from '../../operations/mintSwap/parseMintSwapOperation.ts';
import { validateMintSwapTransition } from '../../operations/mintSwap/validateMintSwapTransition.ts';
import { MintSwapIdentityConflictError } from '../../operations/mintSwap/MintSwapErrors.ts';
import { COPY_MEMORY_REPOSITORY_STATE } from './MemoryRepositoryTransaction.ts';

function quoteKey(quote: Parameters<MintSwapOperationRepository['getByQuote']>[1]): string {
  return JSON.stringify([quote.mintUrl, quote.method, quote.quoteId]);
}

function compareCreated(a: MintSwapOperation, b: MintSwapOperation): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Opt-in memory implementation. Every mutation runs synchronously to completion,
 * without an await between validation, uniqueness checks, and writes. This is the repository's
 * standalone serialization boundary. MemoryRepositories also binds it to the Wallet snapshot.
 */
export class MemoryMintSwapOperationRepository implements MintSwapOperationRepository {
  private readonly operations = new Map<string, MintSwapOperation>();
  private readonly sourceQuotes = new Map<string, string>();
  private readonly destinationQuotes = new Map<string, string>();
  private readonly sourceChildren = new Map<string, string>();
  private readonly destinationChildren = new Map<string, string>();

  [COPY_MEMORY_REPOSITORY_STATE](source: MemoryMintSwapOperationRepository): void {
    this.operations.clear();
    for (const [id, operation] of source.operations)
      this.operations.set(id, parseMintSwapOperation(operation));
    for (const key of [
      'sourceQuotes',
      'destinationQuotes',
      'sourceChildren',
      'destinationChildren',
    ] as const) {
      this[key].clear();
      for (const [value, id] of source[key]) this[key].set(value, id);
    }
  }

  async create(operation: MintSwapOperation): Promise<void> {
    const parsed = parseMintSwapOperation(operation);
    if (parsed.revision !== 0) throw new TypeError('Mint Swap creation requires revision zero');
    const sourceQuote = quoteKey(parsed.sourceQuote);
    const destinationQuote = quoteKey(parsed.destinationQuote);
    if (this.operations.has(parsed.id)) throw new MintSwapIdentityConflictError('parent');
    if (this.sourceQuotes.has(sourceQuote)) throw new MintSwapIdentityConflictError('source_quote');
    if (this.destinationQuotes.has(destinationQuote))
      throw new MintSwapIdentityConflictError('destination_quote');
    if (this.sourceChildren.has(parsed.sourceOperationId))
      throw new MintSwapIdentityConflictError('source_child');
    if (this.destinationChildren.has(parsed.destinationOperationId))
      throw new MintSwapIdentityConflictError('destination_child');

    this.operations.set(parsed.id, parsed);
    this.sourceQuotes.set(sourceQuote, parsed.id);
    this.destinationQuotes.set(destinationQuote, parsed.id);
    this.sourceChildren.set(parsed.sourceOperationId, parsed.id);
    this.destinationChildren.set(parsed.destinationOperationId, parsed.id);
  }

  async getById(id: string): Promise<MintSwapOperation | null> {
    const operation = this.operations.get(id);
    return operation ? parseMintSwapOperation(operation) : null;
  }

  async getByChild(kind: 'mint' | 'melt', operationId: string): Promise<MintSwapOperation | null> {
    const id = (kind === 'mint' ? this.destinationChildren : this.sourceChildren).get(operationId);
    return id ? this.getById(id) : null;
  }

  async getByQuote(
    kind: 'mint' | 'melt',
    quote: Parameters<MintSwapOperationRepository['getByQuote']>[1],
  ): Promise<MintSwapOperation | null> {
    const key = quoteKey({ ...quote, mintUrl: normalizeMintUrl(quote.mintUrl) });
    const id = (kind === 'mint' ? this.destinationQuotes : this.sourceQuotes).get(key);
    return id ? this.getById(id) : null;
  }

  async transition(
    command: Parameters<MintSwapOperationRepository['transition']>[0],
  ): Promise<boolean> {
    const current = this.operations.get(command.operationId);
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
    this.operations.set(command.operationId, next);
    return true;
  }

  async listActive(): Promise<MintSwapOperation[]> {
    return Array.from(this.operations.values())
      .filter((operation) => !isMintSwapTerminalState(operation.state))
      .sort(compareCreated)
      .map(parseMintSwapOperation);
  }

  async listDue(now: number, limit: number): Promise<MintSwapOperation[]> {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 0) {
      throw new TypeError('Mint Swap due scan requires nonnegative safe integer time and limit');
    }
    if (limit === 0) return [];
    return Array.from(this.operations.values())
      .filter(
        (operation) =>
          isMintSwapAutomaticState(operation.state) &&
          operation.retry.nextAttemptAt !== null &&
          operation.retry.nextAttemptAt <= now,
      )
      .sort((a, b) => a.retry.nextAttemptAt! - b.retry.nextAttemptAt! || compareCreated(a, b))
      .slice(0, limit)
      .map(parseMintSwapOperation);
  }
}
