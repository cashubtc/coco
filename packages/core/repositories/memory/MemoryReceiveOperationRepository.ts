import type { ReceiveOperationRepository } from '..';
import type {
  ReceiveOperation,
  ReceiveOperationState,
} from '../../operations/receive/ReceiveOperation';

export class MemoryReceiveOperationRepository implements ReceiveOperationRepository {
  private readonly operations = new Map<string, ReceiveOperation>();

  async create(operation: ReceiveOperation): Promise<void> {
    if (this.operations.has(operation.id)) {
      throw new Error(`ReceiveOperation with id ${operation.id} already exists`);
    }
    this.operations.set(operation.id, { ...operation });
  }

  async update(operation: ReceiveOperation): Promise<void> {
    if (!this.operations.has(operation.id)) {
      throw new Error(`ReceiveOperation with id ${operation.id} not found`);
    }
    this.operations.set(operation.id, { ...operation, updatedAt: Date.now() });
  }

  async getById(id: string): Promise<ReceiveOperation | null> {
    const op = this.operations.get(id);
    return op ? { ...op } : null;
  }

  async getByState(state: ReceiveOperationState): Promise<ReceiveOperation[]> {
    const results: ReceiveOperation[] = [];
    for (const op of this.operations.values()) {
      if (op.state === state) {
        results.push({ ...op });
      }
    }
    return results;
  }

  async getPending(): Promise<ReceiveOperation[]> {
    const results: ReceiveOperation[] = [];
    for (const op of this.operations.values()) {
      if (op.state === 'executing') {
        results.push({ ...op });
      }
    }
    return results;
  }

  async getByMintUrl(mintUrl: string): Promise<ReceiveOperation[]> {
    const results: ReceiveOperation[] = [];
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
