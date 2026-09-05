import type { MintOperationRepository } from '..';
import type { MintOperation, MintOperationState } from '../../operations/mint/MintOperation';
import { cloneMemoryValue, COPY_MEMORY_REPOSITORY_STATE } from './MemoryRepositoryTransaction.ts';

export class MemoryMintOperationRepository implements MintOperationRepository {
  private operations = new Map<string, MintOperation>();

  [COPY_MEMORY_REPOSITORY_STATE](source: MemoryMintOperationRepository): void {
    this.operations = cloneMemoryValue(source.operations);
  }

  async create(operation: MintOperation): Promise<void> {
    if (this.operations.has(operation.id)) {
      throw new Error(`MintOperation with id ${operation.id} already exists`);
    }
    this.operations.set(operation.id, cloneMemoryValue(operation));
  }

  async update(operation: MintOperation): Promise<void> {
    if (!this.operations.has(operation.id)) {
      throw new Error(`MintOperation with id ${operation.id} not found`);
    }
    this.operations.set(operation.id, cloneMemoryValue({ ...operation, updatedAt: Date.now() }));
  }

  async getById(id: string): Promise<MintOperation | null> {
    const operation = this.operations.get(id);
    return operation ? cloneMemoryValue(operation) : null;
  }

  async getByState(state: MintOperationState): Promise<MintOperation[]> {
    const results: MintOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.state === state) {
        results.push(cloneMemoryValue(operation));
      }
    }
    return results;
  }

  async getPending(): Promise<MintOperation[]> {
    const results: MintOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.state === 'pending' || operation.state === 'executing') {
        results.push(cloneMemoryValue(operation));
      }
    }
    return results;
  }

  async getByMintUrl(mintUrl: string): Promise<MintOperation[]> {
    const results: MintOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.mintUrl === mintUrl) {
        results.push(cloneMemoryValue(operation));
      }
    }
    return results;
  }

  async getByQuoteId(mintUrl: string, method: string, quoteId: string): Promise<MintOperation[]> {
    const results: MintOperation[] = [];
    for (const operation of this.operations.values()) {
      if (
        operation.mintUrl === mintUrl &&
        operation.method === method &&
        'quoteId' in operation &&
        operation.quoteId === quoteId
      ) {
        results.push(cloneMemoryValue(operation));
      }
    }
    return results.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async getAll(): Promise<MintOperation[]> {
    return Array.from(this.operations.values(), (operation) => cloneMemoryValue(operation));
  }

  async delete(id: string): Promise<void> {
    this.operations.delete(id);
  }
}
