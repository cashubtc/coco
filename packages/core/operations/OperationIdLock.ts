import { OperationInProgressError } from '../models/Error';

type LockEntry = {
  waiters: Array<() => void>;
};

/**
 * In-memory fail-fast lock keyed by operation ID.
 *
 * If an operation ID is already locked, acquire throws immediately.
 */
export class OperationIdLock {
  private readonly locks = new Map<string, LockEntry>();

  async acquire(operationId: string): Promise<() => void> {
    if (this.locks.has(operationId)) {
      throw new OperationInProgressError(operationId);
    }

    const entry: LockEntry = { waiters: [] };
    this.locks.set(operationId, entry);

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      const currentEntry = this.locks.get(operationId);
      if (currentEntry !== entry) {
        return;
      }

      this.locks.delete(operationId);
      for (const waiter of entry.waiters) {
        waiter();
      }
    };
  }

  async waitForUnlock(operationId: string): Promise<void> {
    const entry = this.locks.get(operationId);
    if (!entry) {
      return;
    }

    await new Promise<void>((resolve) => {
      entry.waiters.push(resolve);
    });
  }

  isLocked(operationId: string): boolean {
    return this.locks.has(operationId);
  }
}
