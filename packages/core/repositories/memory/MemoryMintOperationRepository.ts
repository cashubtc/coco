import type { MintOperationRepository } from '..';
import type { MintOperation, MintOperationState } from '../../operations/mint/MintOperation';
import { assertParentOwnedMintOperationInvariant } from '../../operations/mintSwap/ChildOperationOwnership.ts';

export class MemoryMintOperationRepository implements MintOperationRepository {
  private readonly operations = new Map<string, MintOperation>();

  async create(operation: MintOperation): Promise<void> {
    assertParentOwnedMintOperationInvariant(operation);
    if (this.operations.has(operation.id)) {
      throw new Error(`MintOperation with id ${operation.id} already exists`);
    }
    this.assertUniqueParentOwnership(operation);
    this.operations.set(operation.id, { ...operation });
  }

  async update(operation: MintOperation): Promise<void> {
    assertParentOwnedMintOperationInvariant(operation);
    const existing = this.operations.get(operation.id);
    if (!existing) {
      throw new Error(`MintOperation with id ${operation.id} not found`);
    }
    if (existing.parentSwapOperationId !== operation.parentSwapOperationId) {
      throw new Error(`Cannot change parent ownership of MintOperation ${operation.id}`);
    }
    this.assertUniqueParentOwnership(operation);
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
    const operation = this.operations.get(id);
    if (operation?.parentSwapOperationId) {
      throw new Error(`Cannot delete parent-owned MintOperation ${id}`);
    }
    this.operations.delete(id);
  }

  private assertUniqueParentOwnership(operation: MintOperation): void {
    if (!operation.parentSwapOperationId) return;
    for (const existing of this.operations.values()) {
      if (
        existing.id !== operation.id &&
        existing.parentSwapOperationId === operation.parentSwapOperationId
      ) {
        throw new Error(
          `Mint swap ${operation.parentSwapOperationId} already owns destination MintOperation ${existing.id}`,
        );
      }
    }
  }
}
