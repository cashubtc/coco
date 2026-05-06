import type { MintBatchAttemptRepository } from '..';
import type {
  MintBatchAttempt,
  MintBatchAttemptState,
} from '../../operations/mint/MintBatchAttempt';

export class MemoryMintBatchAttemptRepository implements MintBatchAttemptRepository {
  private readonly attempts = new Map<string, MintBatchAttempt>();

  async create(attempt: MintBatchAttempt): Promise<void> {
    if (this.attempts.has(attempt.id)) {
      throw new Error(`MintBatchAttempt with id ${attempt.id} already exists`);
    }
    this.attempts.set(attempt.id, { ...attempt });
  }

  async update(attempt: MintBatchAttempt): Promise<void> {
    if (!this.attempts.has(attempt.id)) {
      throw new Error(`MintBatchAttempt with id ${attempt.id} not found`);
    }
    this.attempts.set(attempt.id, { ...attempt, updatedAt: Date.now() });
  }

  async getById(id: string): Promise<MintBatchAttempt | null> {
    const attempt = this.attempts.get(id);
    return attempt ? { ...attempt } : null;
  }

  async getByState(state: MintBatchAttemptState): Promise<MintBatchAttempt[]> {
    const results: MintBatchAttempt[] = [];
    for (const attempt of this.attempts.values()) {
      if (attempt.state === state) {
        results.push({ ...attempt });
      }
    }
    return results;
  }

  async getByOperationId(operationId: string): Promise<MintBatchAttempt | null> {
    for (const attempt of this.attempts.values()) {
      if (attempt.operationIds.includes(operationId)) {
        return { ...attempt };
      }
    }
    return null;
  }

  async getPending(): Promise<MintBatchAttempt[]> {
    const pendingStates = new Set<MintBatchAttemptState>(['prepared', 'requesting', 'recovering']);
    const results: MintBatchAttempt[] = [];
    for (const attempt of this.attempts.values()) {
      if (pendingStates.has(attempt.state)) {
        results.push({ ...attempt });
      }
    }
    return results;
  }

  async delete(id: string): Promise<void> {
    this.attempts.delete(id);
  }
}
