export type EventHandler<Payload> = (payload: Payload) => void | Promise<void>;

export type EventBusOptions<Events extends { [K in keyof Events]: unknown }> = {
  onError?: (args: {
    event: keyof Events;
    payload: Events[keyof Events];
    error: unknown;
  }) => void | Promise<void>;
  concurrency?: 'sequential' | 'parallel';
  throwOnError?: boolean;
};

export type EmitOptions = {
  throwOnError?: boolean;
  failFast?: boolean; // only relevant for sequential
};

export class EventBus<Events extends { [K in keyof Events]: unknown }> {
  private listeners: Map<keyof Events, Set<(payload: unknown) => void | Promise<void>>> = new Map();
  constructor(private readonly options: EventBusOptions<Events> = {}) {}

  on<E extends keyof Events>(event: E, handler: EventHandler<Events[E]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (payload: unknown) => void | Promise<void>);
    return () => this.off(event, handler);
  }

  once<E extends keyof Events>(event: E, handler: EventHandler<Events[E]>): () => void {
    const wrapped: EventHandler<Events[E]> = async (payload) => {
      this.off(event, wrapped);
      await handler(payload);
    };
    return this.on(event, wrapped);
  }

  off<E extends keyof Events>(event: E, handler: EventHandler<Events[E]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler as (payload: unknown) => void | Promise<void>);
    if (set.size === 0) this.listeners.delete(event);
  }

  async emit<E extends keyof Events>(
    event: E,
    payload: Events[E],
    options?: EmitOptions,
  ): Promise<void> {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;

    const handlers = Array.from(set) as Array<(payload: Events[E]) => void | Promise<void>>;
    const effectiveThrow = options?.throwOnError ?? this.options.throwOnError ?? false;
    const concurrency = this.options.concurrency ?? 'sequential';

    if (concurrency === 'parallel') {
      const results = await Promise.allSettled(handlers.map((h) => h(payload)));
      const errors: unknown[] = [];
      for (const r of results) {
        if (r.status === 'rejected') {
          errors.push(r.reason);
          if (this.options.onError) await this.options.onError({ event, payload, error: r.reason });
        }
      }
      if (errors.length && effectiveThrow) {
        throw new AggregateError(
          errors,
          `Event "${String(event)}" had ${errors.length} handler error(s)`,
        );
      }
      return;
    }

    const collectedErrors: unknown[] = [];
    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (error) {
        if (this.options.onError) await this.options.onError({ event, payload, error });
        if (effectiveThrow && options?.failFast) {
          throw error;
        }
        if (effectiveThrow) {
          collectedErrors.push(error);
        }
      }
    }
    if (collectedErrors.length && effectiveThrow) {
      throw new AggregateError(
        collectedErrors,
        `Event "${String(event)}" had ${collectedErrors.length} handler error(s)`,
      );
    }
  }
}
