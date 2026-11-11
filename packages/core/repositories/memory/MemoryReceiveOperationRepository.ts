import type { ReceiveOperationRepository } from '..';
import type {
  ReceiveOperation,
  ReceiveOperationState,
} from '../../operations/receive/ReceiveOperation';
import { cloneMemoryValue, COPY_MEMORY_REPOSITORY_STATE } from './MemoryRepositoryTransaction.ts';

export class MemoryReceiveOperationRepository implements ReceiveOperationRepository {
  private operations = new Map<string, ReceiveOperation>();

  [COPY_MEMORY_REPOSITORY_STATE](source: MemoryReceiveOperationRepository): void {
    this.operations = cloneMemoryValue(source.operations);
  }

  async create(operation: ReceiveOperation): Promise<void> {
    if (this.operations.has(operation.id)) {
      throw new Error(`ReceiveOperation with id ${operation.id} already exists`);
    }
    this.operations.set(
      operation.id,
      cloneMemoryValue({ ...operation, revision: operation.revision ?? 0 }),
    );
  }

  async update(operation: ReceiveOperation): Promise<void> {
    if (!this.operations.has(operation.id)) {
      throw new Error(`ReceiveOperation with id ${operation.id} not found`);
    }
    this.operations.set(
      operation.id,
      cloneMemoryValue({ ...operation, revision: operation.revision ?? 0, updatedAt: Date.now() }),
    );
  }

  async transition(
    input: Parameters<ReceiveOperationRepository['transition']>[0],
  ): Promise<boolean> {
    const current = this.operations.get(input.operationId);
    if (
      !current ||
      current.state !== input.expectedState ||
      (current.revision ?? 0) !== input.expectedRevision
    )
      return false;
    if (input.next.id !== input.operationId)
      throw new Error('Receive operation transition cannot change the operation id');
    this.operations.set(
      input.operationId,
      cloneMemoryValue({ ...input.next, revision: input.expectedRevision + 1 }),
    );
    return true;
  }

  async getById(id: string): Promise<ReceiveOperation | null> {
    const op = this.operations.get(id);
    return op ? cloneMemoryValue(op) : null;
  }

  async getByState(state: ReceiveOperationState): Promise<ReceiveOperation[]> {
    const results: ReceiveOperation[] = [];
    for (const op of this.operations.values()) {
      if (op.state === state) {
        results.push(cloneMemoryValue(op));
      }
    }
    return results;
  }

  async getPending(): Promise<ReceiveOperation[]> {
    const results: ReceiveOperation[] = [];
    for (const op of this.operations.values()) {
      if (op.state === 'executing') {
        results.push(cloneMemoryValue(op));
      }
    }
    return results;
  }

  async getByMintUrl(mintUrl: string): Promise<ReceiveOperation[]> {
    const results: ReceiveOperation[] = [];
    for (const op of this.operations.values()) {
      if (op.mintUrl === mintUrl) {
        results.push(cloneMemoryValue(op));
      }
    }
    return results;
  }

  async getByPaymentRequestAttemptId(attemptId: string): Promise<ReceiveOperation | null> {
    for (const op of this.operations.values()) {
      if (op.source?.type === 'payment-request' && op.source.attemptId === attemptId) {
        return cloneMemoryValue(op);
      }
    }
    return null;
  }

  async getAll(): Promise<ReceiveOperation[]> {
    return Array.from(this.operations.values(), (operation) =>
      cloneMemoryValue({ ...operation, revision: operation.revision ?? 0 }),
    );
  }

  async delete(id: string): Promise<void> {
    this.operations.delete(id);
  }
}
