import type { MintOperationRepository } from '..';
import type { MintOperation, MintOperationState } from '../../operations/mint/MintOperation';
import type { MintSwapOperationParent } from '../../operations/OperationParent.ts';

export class MemoryMintOperationRepository implements MintOperationRepository {
  private readonly operations = new Map<string, MintOperation>();

  async create(operation: MintOperation): Promise<void> {
    if (this.operations.has(operation.id)) {
      throw new Error(`MintOperation with id ${operation.id} already exists`);
    }
    this.operations.set(operation.id, { ...operation });
  }

  async update(operation: MintOperation): Promise<void> {
    const current = this.operations.get(operation.id);
    if (!current) {
      throw new Error(`MintOperation with id ${operation.id} not found`);
    }
    this.operations.set(operation.id, {
      ...operation,
      parent: current.parent,
      updatedAt: Date.now(),
    });
  }

  async assignMintSwapParentIfUnparented(
    operationId: string,
    expectedState: MintOperationState,
    parent: MintSwapOperationParent,
  ): Promise<boolean> {
    const current = this.operations.get(operationId);
    if (!current || current.state !== expectedState || current.parent) {
      return false;
    }

    this.operations.set(operationId, { ...current, parent, updatedAt: Date.now() });
    return true;
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
      if (operation.state === 'pending' || operation.state === 'executing') {
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

  async getByQuoteId(mintUrl: string, method: string, quoteId: string): Promise<MintOperation[]> {
    const results: MintOperation[] = [];
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

  async getAll(): Promise<MintOperation[]> {
    return Array.from(this.operations.values(), (operation) => ({ ...operation }));
  }

  async delete(id: string): Promise<void> {
    this.operations.delete(id);
  }
}
