import type { MintOperationRepository } from '..';
import type { MintOperation, MintOperationState } from '../../operations/mint/MintOperation';

export class MemoryMintOperationRepository implements MintOperationRepository {
  private readonly operations = new Map<string, MintOperation>();

  async create(operation: MintOperation): Promise<void> {
    if (this.operations.has(operation.id)) {
      throw new Error(`MintOperation with id ${operation.id} already exists`);
    }
    this.operations.set(operation.id, { ...operation });
  }

  async update(operation: MintOperation): Promise<void> {
    if (!this.operations.has(operation.id)) {
      throw new Error(`MintOperation with id ${operation.id} not found`);
    }
    this.operations.set(operation.id, { ...operation, updatedAt: Date.now() });
  }

  async getById(id: string): Promise<MintOperation | null> {
    const operation = this.operations.get(id);
    return operation ? { ...operation } : null;
  }

  async getByState(state: MintOperationState): Promise<MintOperation[]> {
    const results: MintOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.state === state) {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async getPending(): Promise<MintOperation[]> {
    const results: MintOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.state === 'executing') {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async getByMintUrl(mintUrl: string): Promise<MintOperation[]> {
    const results: MintOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.mintUrl === mintUrl) {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async getByQuoteId(mintUrl: string, quoteId: string): Promise<MintOperation[]> {
    const results: MintOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.mintUrl === mintUrl && operation.quoteId === quoteId) {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async delete(id: string): Promise<void> {
    this.operations.delete(id);
  }
}
