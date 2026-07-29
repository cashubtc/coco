import type { MintSwapOperationRepository } from '..';
import {
  assertMintSwapTransition,
  assertPreparedMintSwapImmutable,
  isAutomaticMintSwapState,
  isTerminalMintSwapState,
  validateMintSwapOperation,
  type MintSwapOperation,
  type MintSwapOperationState,
} from '../../operations/mintSwap/MintSwapOperation';
import { cloneMemoryValue } from './clone';

export class MemoryMintSwapOperationRepository implements MintSwapOperationRepository {
  private readonly operations = new Map<string, MintSwapOperation>();

  async create(operation: MintSwapOperation): Promise<void> {
    validateMintSwapOperation(operation);
    if (operation.revision !== 0) {
      throw new Error('New mint swap operation must start at revision 0');
    }
    if (this.operations.has(operation.id)) {
      throw new Error(`Mint swap operation with id ${operation.id} already exists`);
    }
    this.assertUniqueOwnership(operation);
    this.operations.set(operation.id, cloneMemoryValue(operation));
  }

  async getById(id: string): Promise<MintSwapOperation | null> {
    const operation = this.operations.get(id);
    return operation ? cloneMemoryValue(operation) : null;
  }

  async getByState(state: MintSwapOperationState): Promise<MintSwapOperation[]> {
    return this.sorted((operation) => operation.state === state);
  }

  async getActive(): Promise<MintSwapOperation[]> {
    return this.sorted((operation) => !isTerminalMintSwapState(operation.state));
  }

  async getDue(now: number, limit: number): Promise<MintSwapOperation[]> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Due time must be non-negative');
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error('Due limit must be non-negative');
    return this.sorted(
      (operation) =>
        isAutomaticMintSwapState(operation.state) && (operation.retry.nextAttemptAt ?? 0) <= now,
      true,
    ).slice(0, limit);
  }

  async getByDestinationMintOperationId(id: string): Promise<MintSwapOperation | null> {
    return this.findByChild('destinationMintOperationId', id);
  }

  async getBySourceMeltOperationId(id: string): Promise<MintSwapOperation | null> {
    return this.findByChild('sourceMeltOperationId', id);
  }

  async compareAndSet(operation: MintSwapOperation, expectedRevision: number): Promise<boolean> {
    const current = this.operations.get(operation.id);
    if (!current || current.revision !== expectedRevision) return false;
    if (operation.revision !== expectedRevision + 1) {
      throw new Error('Mint swap compare-and-set must advance revision exactly once');
    }
    assertMintSwapTransition(current.state, operation.state);
    assertPreparedMintSwapImmutable(current, operation);
    validateMintSwapOperation(operation);
    this.assertUniqueOwnership(operation);
    this.operations.set(operation.id, cloneMemoryValue(operation));
    return true;
  }

  private async findByChild(
    field: 'destinationMintOperationId' | 'sourceMeltOperationId',
    id: string,
  ): Promise<MintSwapOperation | null> {
    for (const operation of this.operations.values()) {
      if (operation[field] === id) return cloneMemoryValue(operation);
    }
    return null;
  }

  private assertUniqueOwnership(candidate: MintSwapOperation): void {
    for (const operation of this.operations.values()) {
      if (operation.id === candidate.id) continue;
      if (
        candidate.destinationMintOperationId &&
        operation.destinationMintOperationId === candidate.destinationMintOperationId
      ) {
        throw new Error('Destination mint operation is already owned by another mint swap');
      }
      if (
        candidate.sourceMeltOperationId &&
        operation.sourceMeltOperationId === candidate.sourceMeltOperationId
      ) {
        throw new Error('Source melt operation is already owned by another mint swap');
      }
    }
  }

  private sorted(
    predicate: (operation: MintSwapOperation) => boolean,
    dueOrder = false,
  ): MintSwapOperation[] {
    return Array.from(this.operations.values())
      .filter(predicate)
      .sort((left, right) => {
        if (dueOrder) {
          const due = (left.retry.nextAttemptAt ?? 0) - (right.retry.nextAttemptAt ?? 0);
          if (due !== 0) return due;
        }
        return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
      })
      .map((operation) => cloneMemoryValue(operation));
  }
}
