/**
 * Serializes access to the root in-memory repositories while transactions operate on
 * isolated staged repositories. This prevents a transaction commit or rollback from
 * clobbering a root write that raced with the transaction.
 */
export class MemoryRepositoryCoordinator {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      return await fn();
    } finally {
      release();
    }
  }

  wrap<T extends object>(repository: T): T {
    const coordinator = this;
    return new Proxy(repository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          coordinator.runExclusive(() =>
            Promise.resolve(Reflect.apply(value, target, args) as unknown),
          );
      },
    }) as T;
  }
}
