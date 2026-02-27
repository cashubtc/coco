import { OperationInProgressError } from '../models/Error';

/**
 * In-memory fail-fast lock keyed by operation ID.
 *
 * If an operation ID is already locked, acquire throws immediately.
 */
export class OperationIdLock {
  private readonly locks = new Set<string>();

  async acquire(operationId: string): Promise<() => void> {
    if (this.locks.has(operationId)) {
      throw new OperationInProgressError(operationId);
    }

    this.locks.add(operationId);

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.locks.delete(operationId);
    };
  }

  isLocked(operationId: string): boolean {
    return this.locks.has(operationId);
  }
}
