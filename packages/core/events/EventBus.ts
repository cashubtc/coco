export type EventHandler<Payload> = (payload: Payload) => void | Promise<void>;

export class EventBus<Events extends { [K in keyof Events]: unknown }> {
  private listeners: Map<keyof Events, Set<(payload: unknown) => void | Promise<void>>> = new Map();

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

  async emit<E extends keyof Events>(event: E, payload: Events[E]): Promise<void> {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const handler of Array.from(set)) {
      await (handler as (payload: Events[E]) => void | Promise<void>)(payload);
    }
  }
}
