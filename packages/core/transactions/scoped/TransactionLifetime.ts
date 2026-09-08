/**
 * Owns asynchronous commands and repository calls for one transaction attempt. Failure revokes
 * further work; calls already executing settle before the adapter may roll back or retry.
 * This helper has no authority to open, commit, or roll back a transaction.
 */
export class TransactionLifetime {
  private readonly pending = new Set<Promise<void>>();
  private failure: { error: unknown } | undefined;
  private closed = false;

  /** Recursively wrap capabilities, preserving inherited bindings and getter receivers. */
  bind<T extends object>(modules: T): T {
    const bound = new WeakMap<object, object>();
    const bindObject = <TObject extends object>(source: TObject): TObject => {
      const existing = bound.get(source);
      if (existing) return existing as TObject;

      const methods = new Map<PropertyKey, unknown>();
      // An inheriting target lets even frozen source properties return their bound wrappers.
      const proxy = new Proxy(Object.create(source) as TObject, {
        get: (_target, property) => {
          const value: unknown = Reflect.get(source, property, source);
          if (typeof value === 'function') {
            if (!methods.has(property)) {
              methods.set(property, (...args: unknown[]) =>
                this.invoke(() => Reflect.apply(value, source, args) as Promise<unknown>),
              );
            }
            return methods.get(property);
          }
          if (typeof value === 'object' && value !== null) return bindObject(value);
          return value;
        },
      });
      bound.set(source, proxy);
      return proxy;
    };

    return bindObject(modules);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    let result!: T;
    try {
      try {
        result = await work();
      } catch (error) {
        this.fail(error);
      }

      // A callback may finish before its siblings (Promise.all failure, Promise.race, or an
      // omitted await). Draining may discover further calls made by an executing command.
      while (this.pending.size > 0) {
        await Promise.all([...this.pending]);
      }
      if (this.failure) throw this.failure.error;
      return result;
    } finally {
      this.closed = true;
    }
  }

  private invoke<T>(call: () => Promise<T>): Promise<T> {
    let result: Promise<T>;
    try {
      if (this.closed) throw new Error('Wallet transaction scope is closed');
      if (this.failure) throw this.failure.error;
      result = Promise.resolve(call());
    } catch (error) {
      this.fail(error);
      result = Promise.reject(error);
    }

    const observed = result.then(
      (value) => value,
      (error: unknown) => {
        this.fail(error);
        throw error;
      },
    );
    // Observe every rejection even when the caller drops its promise. The first failure is
    // rethrown by run(), so catching a command failure cannot commit a partial transaction.
    const settled = observed.then(
      () => {
        this.pending.delete(settled);
      },
      () => {
        this.pending.delete(settled);
      },
    );
    this.pending.add(settled);
    return observed;
  }

  private fail(error: unknown): void {
    this.failure ??= { error };
  }
}
