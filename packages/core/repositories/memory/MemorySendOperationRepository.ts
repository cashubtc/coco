import type { SendOperationRepository } from '..';
import type { SendOperation, SendOperationState } from '../../operations/send/SendOperation';
import { cloneMemoryValue, COPY_MEMORY_REPOSITORY_STATE } from './MemoryRepositoryTransaction.ts';

export class MemorySendOperationRepository implements SendOperationRepository {
  private operations = new Map<string, SendOperation>();

  [COPY_MEMORY_REPOSITORY_STATE](source: MemorySendOperationRepository): void {
    this.operations = cloneMemoryValue(source.operations);
  }

  async create(operation: SendOperation): Promise<void> {
    if (this.operations.has(operation.id)) {
      throw new Error(`SendOperation with id ${operation.id} already exists`);
    }
    this.operations.set(operation.id, { ...operation, revision: operation.revision ?? 0 });
  }

  async update(operation: SendOperation): Promise<void> {
    if (!this.operations.has(operation.id)) {
      throw new Error(`SendOperation with id ${operation.id} not found`);
    }
    this.operations.set(operation.id, {
      ...operation,
      revision: operation.revision ?? 0,
      updatedAt: Date.now(),
    });
  }

  async transition(command: {
    operationId: string;
    expectedState: SendOperationState;
    expectedRevision: number;
    next: SendOperation;
  }): Promise<boolean> {
    const current = this.operations.get(command.operationId);
    if (
      !current ||
      current.state !== command.expectedState ||
      (current.revision ?? 0) !== command.expectedRevision
    ) {
      return false;
    }
    if (command.next.id !== command.operationId) {
      throw new Error('Send operation transition cannot change the operation id');
    }
    this.operations.set(command.operationId, {
      ...command.next,
      revision: command.expectedRevision + 1,
    });
    return true;
  }

  async getById(id: string): Promise<SendOperation | null> {
    const op = this.operations.get(id);
    return op ? { ...op, revision: op.revision ?? 0 } : null;
  }

  async getByState(state: SendOperationState): Promise<SendOperation[]> {
    const results: SendOperation[] = [];
    for (const op of this.operations.values()) {
      if (op.state === state) {
        results.push({ ...op });
      }
    }
    return results;
  }

  async getPending(): Promise<SendOperation[]> {
    const results: SendOperation[] = [];
    for (const op of this.operations.values()) {
      if (op.state === 'executing' || op.state === 'pending' || op.state === 'rolling_back') {
        results.push({ ...op });
      }
    }
    return results;
  }

  async getByMintUrl(mintUrl: string): Promise<SendOperation[]> {
    const results: SendOperation[] = [];
    for (const op of this.operations.values()) {
      if (op.mintUrl === mintUrl) {
        results.push({ ...op });
      }
    }
    return results;
  }

  async getAll(): Promise<SendOperation[]> {
    return Array.from(this.operations.values(), (operation) => ({ ...operation }));
  }

  async delete(id: string): Promise<void> {
    this.operations.delete(id);
  }
}
