import type { MintOperationRepository } from '..';
import type { MintOperationRecord, MintOperationState } from '../../operations/mint/MintOperation';

export class MemoryMintOperationRepository implements MintOperationRepository {
  private readonly operations = new Map<string, MintOperationRecord>();

  async create(operation: MintOperationRecord): Promise<void> {
    if (this.operations.has(operation.id)) {
      throw new Error(`MintOperation with id ${operation.id} already exists`);
    }
    this.operations.set(operation.id, { ...operation });
  }

  async update(operation: MintOperationRecord): Promise<void> {
    if (!this.operations.has(operation.id)) {
      throw new Error(`MintOperation with id ${operation.id} not found`);
    }
    this.operations.set(operation.id, { ...operation, updatedAt: Date.now() });
  }

  async getById(id: string): Promise<MintOperationRecord | null> {
    const operation = this.operations.get(id);
    return operation ? { ...operation } : null;
  }

  async getByState(state: MintOperationState): Promise<MintOperationRecord[]> {
    const results: MintOperationRecord[] = [];
    for (const operation of this.operations.values()) {
      if (operation.state === state) {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async getPending(): Promise<MintOperationRecord[]> {
    const results: MintOperationRecord[] = [];
    for (const operation of this.operations.values()) {
      if (operation.state === 'pending' || operation.state === 'executing') {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async getByMintUrl(mintUrl: string): Promise<MintOperationRecord[]> {
    const results: MintOperationRecord[] = [];
    for (const operation of this.operations.values()) {
      if (operation.mintUrl === mintUrl) {
        results.push({ ...operation });
      }
    }
    return results;
  }

  async getByQuoteId(
    mintUrl: string,
    method: string,
    quoteId: string,
  ): Promise<MintOperationRecord[]> {
    const results: MintOperationRecord[] = [];
    for (const operation of this.operations.values()) {
      if (
        operation.mintUrl === mintUrl &&
        operation.method === method &&
        'quoteId' in operation &&
        operation.quoteId === quoteId
      ) {
        results.push({ ...operation });
      }
    }
    return results.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async getAll(): Promise<MintOperationRecord[]> {
    return Array.from(this.operations.values(), (operation) => ({ ...operation }));
  }

  async delete(id: string): Promise<void> {
    this.operations.delete(id);
  }
}
