import type { SendOperationRepository } from '..';
import type { SendOperation, SendOperationState } from '../../operations/send/SendOperation';

export class MemorySendOperationRepository implements SendOperationRepository {
  private readonly operations = new Map<string, SendOperation>();

  async create(operation: SendOperation): Promise<void> {
    if (this.operations.has(operation.id)) {
      throw new Error(`SendOperation with id ${operation.id} already exists`);
    }
    this.operations.set(operation.id, { ...operation });
  }

  async update(operation: SendOperation): Promise<void> {
    if (!this.operations.has(operation.id)) {
      throw new Error(`SendOperation with id ${operation.id} not found`);
    }
    this.operations.set(operation.id, { ...operation, updatedAt: Date.now() });
  }

  async getById(id: string): Promise<SendOperation | null> {
    const op = this.operations.get(id);
    return op ? { ...op } : null;
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
      if (op.state === 'executing' || op.state === 'pending') {
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

  async delete(id: string): Promise<void> {
    this.operations.delete(id);
  }
}

