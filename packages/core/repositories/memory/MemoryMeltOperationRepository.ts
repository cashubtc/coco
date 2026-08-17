import type { MeltOperationRepository } from '..';
import type { MeltOperation, MeltOperationState } from '../../operations/melt/MeltOperation';
import {
  assertParentOwnedMeltOperationInvariant,
  assertParentOwnedMeltOperationUpdate,
} from '../../operations/mintSwap/ChildOperationOwnership.ts';
import { cloneMemoryValue } from './clone.ts';

const getOperationQuoteId = (operation: MeltOperation): string | undefined =>
  'quoteId' in operation && operation.quoteId ? operation.quoteId : undefined;

export class MemoryMeltOperationRepository implements MeltOperationRepository {
  private readonly operations = new Map<string, MeltOperation>();

  async create(operation: MeltOperation): Promise<void> {
    assertParentOwnedMeltOperationInvariant(operation);
    if (this.operations.has(operation.id)) {
      throw new Error(`MeltOperation with id ${operation.id} already exists`);
    }
    this.assertNoDuplicateQuoteOperation(operation);
    this.assertUniqueParentOwnership(operation);
    this.operations.set(operation.id, cloneMemoryValue(operation));
  }

  async update(operation: MeltOperation): Promise<void> {
    assertParentOwnedMeltOperationInvariant(operation);
    const existing = this.operations.get(operation.id);
    if (!existing) {
      throw new Error(`MeltOperation with id ${operation.id} not found`);
    }
    assertParentOwnedMeltOperationUpdate(existing, operation);
    this.assertNoDuplicateQuoteOperation(operation);
    this.assertUniqueParentOwnership(operation);
    this.operations.set(operation.id, cloneMemoryValue(operation));
  }

  async getById(id: string): Promise<MeltOperation | null> {
    const operation = this.operations.get(id);
    return operation ? cloneMemoryValue(operation) : null;
  }

  async getByState(state: MeltOperationState): Promise<MeltOperation[]> {
    const results: MeltOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.state === state) {
        results.push(cloneMemoryValue(operation));
      }
    }
    return results;
  }

  async getPending(): Promise<MeltOperation[]> {
    const results: MeltOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.state === 'executing' || operation.state === 'pending') {
        results.push(cloneMemoryValue(operation));
      }
    }
    return results;
  }

  async getByMintUrl(mintUrl: string): Promise<MeltOperation[]> {
    const results: MeltOperation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.mintUrl === mintUrl) {
        results.push(cloneMemoryValue(operation));
      }
    }
    return results;
  }

  async getByQuoteId(mintUrl: string, quoteId: string): Promise<MeltOperation[]> {
    const results: MeltOperation[] = [];
    for (const operation of this.operations.values()) {
      if (
        operation.mintUrl === mintUrl &&
        'quoteId' in operation &&
        operation.quoteId === quoteId
      ) {
        results.push(cloneMemoryValue(operation));
      }
    }
    return results;
  }

  async getAll(): Promise<MeltOperation[]> {
    return Array.from(this.operations.values(), (operation) => cloneMemoryValue(operation));
  }

  async delete(id: string): Promise<void> {
    const operation = this.operations.get(id);
    if (operation?.parentSwapOperationId) {
      throw new Error(`Cannot delete parent-owned MeltOperation ${id}`);
    }
    this.operations.delete(id);
  }

  private assertNoDuplicateQuoteOperation(operation: MeltOperation): void {
    const quoteId = getOperationQuoteId(operation);
    if (!quoteId) return;

    for (const existing of this.operations.values()) {
      if (
        existing.id !== operation.id &&
        existing.mintUrl === operation.mintUrl &&
        getOperationQuoteId(existing) === quoteId
      ) {
        throw new Error(
          `MeltOperation already exists for mint ${operation.mintUrl} and quote ${quoteId}`,
        );
      }
    }
  }

  private assertUniqueParentOwnership(operation: MeltOperation): void {
    if (!operation.parentSwapOperationId) return;
    for (const existing of this.operations.values()) {
      if (
        existing.id !== operation.id &&
        existing.parentSwapOperationId === operation.parentSwapOperationId
      ) {
        throw new Error(
          `Mint swap ${operation.parentSwapOperationId} already owns source MeltOperation ${existing.id}`,
        );
      }
    }
  }
}
