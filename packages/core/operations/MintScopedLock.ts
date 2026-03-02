type LockQueue = {
  locked: boolean;
  waiters: Array<() => void>;
};

/**
 * In-memory FIFO lock keyed by mint URL.
 *
 * This lock coordinates proof selection/reservation critical sections across
 * operation services within a single runtime.
 */
export class MintScopedLock {
  private readonly queues = new Map<string, LockQueue>();

  async acquire(mintUrl: string): Promise<() => void> {
    let queue = this.queues.get(mintUrl);
    if (!queue) {
      queue = { locked: false, waiters: [] };
      this.queues.set(mintUrl, queue);
    }

    if (queue.locked) {
      await new Promise<void>((resolve) => {
        queue!.waiters.push(resolve);
      });
    }

    queue.locked = true;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      const next = queue!.waiters.shift();
      if (next) {
        next();
        return;
      }

      queue!.locked = false;
      this.queues.delete(mintUrl);
    };
  }
}
