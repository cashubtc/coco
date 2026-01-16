import type { MeltOperationRepository } from '..';
import type { MeltOperation, MeltOperationState } from '../../operations/melt/MeltOperation';

export class MemoryMeltOperationRepository implements MeltOperationRepository {
  private readonly operations = new Map<string, MeltOperation>();

  async create(operation: MeltOperation): Promise<void> {
    if (this.operations.has(operation.id)) {
      throw new Error(`MeltOperation with id ${operation.id} already exists`);
    }
    this.operations.set(operation.id, { ...operation });
  }

  async update(operation: MeltOperation): Promise<void> {
    if (!this.operations.has(operation.id)) {
      throw new Error(`MeltOperation with id ${operation.id} not found`);
    }
    this.operations.set(operation.id, { ...operation, updatedAt: Date.now() });
  }

  async getById(id: string): Promise<MeltOperation | null> {
    const operation = this.operations.get(id);
    return operation ? { ...operation } : null;
  }

  async getByState(state: MeltOperationState): Promise<MeltOperation[]> {
    const results: MeltOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.state === state) {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async getPending(): Promise<MeltOperation[]> {
    const results: MeltOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.state === 'executing' || operation.state === 'pending') {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async getByMintUrl(mintUrl: string): Promise<MeltOperation[]> {
    const results: MeltOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.mintUrl === mintUrl) {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async getByQuoteId(mintUrl: string, quoteId: string): Promise<MeltOperation[]> {
    const results: MeltOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.mintUrl === mintUrl && 'quoteId' in operation && operation.quoteId === quoteId) {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async delete(id: string): Promise<void> {
    this.operations.delete(id);
  }
}
