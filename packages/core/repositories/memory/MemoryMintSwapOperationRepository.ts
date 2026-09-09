import {
  isMintSwapAutomaticState,
  isMintSwapTerminalState,
  type MintSwapOperation,
} from '../../operations/mintSwap/MintSwapOperation.ts';
import type { MintSwapOperationRepository } from '../../operations/mintSwap/MintSwapOperationRepository.ts';
import { parseMintSwapOperation } from '../../operations/mintSwap/parseMintSwapOperation.ts';
import { validateMintSwapTransition } from '../../operations/mintSwap/validateMintSwapTransition.ts';

function quoteKey(quote: MintSwapOperation['sourceQuote']): string {
  return JSON.stringify([quote.mintUrl, quote.method, quote.quoteId]);
}

function compareCreated(a: MintSwapOperation, b: MintSwapOperation): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Dormant, standalone memory implementation. Every mutation runs synchronously to completion,
 * without an await between validation, uniqueness checks, and writes. This is the repository's
 * own serialization boundary; it makes no cross-repository Wallet rollback guarantee.
 */
export class MemoryMintSwapOperationRepository implements MintSwapOperationRepository {
  private readonly operations = new Map<string, MintSwapOperation>();
  private readonly sourceQuotes = new Set<string>();
  private readonly destinationQuotes = new Set<string>();
  private readonly sourceChildren = new Set<string>();
  private readonly destinationChildren = new Set<string>();

  async create(operation: MintSwapOperation): Promise<void> {
    const parsed = parseMintSwapOperation(operation);
    if (parsed.revision !== 0) throw new TypeError('Mint Swap creation requires revision zero');
    const sourceQuote = quoteKey(parsed.sourceQuote);
    const destinationQuote = quoteKey(parsed.destinationQuote);
    if (this.operations.has(parsed.id)) throw new Error('Mint Swap parent identity already exists');
    if (this.sourceQuotes.has(sourceQuote))
      throw new Error('Mint Swap source quote already exists');
    if (this.destinationQuotes.has(destinationQuote))
      throw new Error('Mint Swap destination quote already exists');
    if (this.sourceChildren.has(parsed.sourceOperationId))
      throw new Error('Mint Swap source child already exists');
    if (this.destinationChildren.has(parsed.destinationOperationId))
      throw new Error('Mint Swap destination child already exists');

    this.operations.set(parsed.id, parsed);
    this.sourceQuotes.add(sourceQuote);
    this.destinationQuotes.add(destinationQuote);
    this.sourceChildren.add(parsed.sourceOperationId);
    this.destinationChildren.add(parsed.destinationOperationId);
  }

  async getById(id: string): Promise<MintSwapOperation | null> {
    const operation = this.operations.get(id);
    return operation ? parseMintSwapOperation(operation) : null;
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
