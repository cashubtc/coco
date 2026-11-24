import type { Manager } from '@cashu/coco-core';

/**
 * Describes how the shared store reads, observes and orders the records of one operation kind.
 *
 * Define each kind once at module scope: the store registry keys stores by the kind object.
 */
export interface OperationKind<TOperation extends { id: string }> {
  /** Passive storage read of one operation; `null` when the ID does not exist. */
  read(manager: Manager, operationId: string): Promise<TOperation | null>;
  /** Subscribes to the Manager events that carry this kind's records. */
  subscribe(manager: Manager, onObserved: (operation: TOperation) => void): () => void;
  /** Returns true when `incoming` is older than `current`, which has the same ID. */
  isOlder(incoming: TOperation, current: TOperation): boolean;
}

type Entry<TOperation> = {
  operation: TOperation | null;
  listeners: Set<() => void>;
  read: Promise<TOperation | null> | null;
};

/**
 * Latest observed record per operation ID for one Manager and one operation kind.
 *
 * Hooks observe an ID through {@link subscribe} and {@link getSnapshot}, which match the
 * `useSyncExternalStore` contract. The store holds an ID only while it has observers or a read in
 * flight, and holds the Manager event subscription only while it has at least one observer.
 * Records for IDs that nobody observes are not retained.
 *
 * The store promises the latest observed record, not the latest persisted one: a change that core
 * persists without an event stays invisible until a read, an event or an action result reveals it.
 */
export class OperationStore<TOperation extends { id: string }> {
  private readonly entries = new Map<string, Entry<TOperation>>();
  private observerCount = 0;
  private unsubscribeEvents: (() => void) | null = null;

  private readonly manager: Manager;
  private readonly kind: OperationKind<TOperation>;

  constructor(manager: Manager, kind: OperationKind<TOperation>) {
    this.manager = manager;
    this.kind = kind;
  }

  subscribe(operationId: string, listener: () => void): () => void {
    const entry = this.ensureEntry(operationId);
    if (entry.listeners.has(listener)) {
      // Each observer needs its own listener, or the observer count could not reach zero.
      throw new Error(`Listener already observes operation ${operationId}`);
    }
    entry.listeners.add(listener);
    this.observerCount += 1;
    if (this.observerCount === 1) {
      this.unsubscribeEvents = this.kind.subscribe(this.manager, (operation) =>
        this.observe(operation),
      );
    }

    return () => {
      if (!entry.listeners.delete(listener)) {
        return;
      }

      this.observerCount -= 1;
      if (this.observerCount === 0) {
        this.unsubscribeEvents?.();
        this.unsubscribeEvents = null;
      }
      this.releaseIfUnused(operationId, entry);
    };
  }

  getSnapshot(operationId: string): TOperation | null {
    return this.entries.get(operationId)?.operation ?? null;
  }

  /**
   * Offers a record observed from an event, a read or an action result. It replaces the current
   * record unless the kind orders it as older, and is dropped when nobody observes its ID.
   */
  observe(operation: TOperation): void {
    const entry = this.entries.get(operation.id);
    if (!entry || entry.operation === operation) {
      return;
    }
    if (entry.operation && this.kind.isOlder(operation, entry.operation)) {
      return;
    }

    entry.operation = operation;
    for (const listener of Array.from(entry.listeners)) {
      listener();
    }
  }

  /**
   * Reads an ID from storage and observes the result. Concurrent callers for the same ID, such as
   * a second observer or a StrictMode effect replay, share the read already in flight.
   */
  read(operationId: string): Promise<TOperation | null> {
    const entry = this.ensureEntry(operationId);
    if (entry.read) {
      return entry.read;
    }

    const read = this.kind
      .read(this.manager, operationId)
      .then((operation) => {
        if (operation) {
          this.observe(operation);
        }
        return operation;
      })
      .finally(() => {
        if (entry.read === read) {
          entry.read = null;
        }
        this.releaseIfUnused(operationId, entry);
      });
    entry.read = read;
    return read;
  }

  private ensureEntry(operationId: string): Entry<TOperation> {
    let entry = this.entries.get(operationId);
    if (!entry) {
      entry = { operation: null, listeners: new Set(), read: null };
      this.entries.set(operationId, entry);
    }
    return entry;
  }

  private releaseIfUnused(operationId: string, entry: Entry<TOperation>): void {
    if (entry.listeners.size === 0 && !entry.read && this.entries.get(operationId) === entry) {
      this.entries.delete(operationId);
    }
  }
}

const storesByManager = new WeakMap<Manager, Map<OperationKind<never>, OperationStore<never>>>();

/** Returns the one store for this Manager and kind, so records never leak between Managers. */
export function getOperationStore<TOperation extends { id: string }>(
  manager: Manager,
  kind: OperationKind<TOperation>,
): OperationStore<TOperation> {
  let stores = storesByManager.get(manager);
  if (!stores) {
    stores = new Map();
    storesByManager.set(manager, stores);
  }

  const key = kind as unknown as OperationKind<never>;
  let store = stores.get(key) as OperationStore<TOperation> | undefined;
  if (!store) {
    store = new OperationStore(manager, kind);
    stores.set(key, store as unknown as OperationStore<never>);
  }
  return store;
}

/** Picks the newer of two records with the same ID using the kind's ordering. */
export function newerOperation<TOperation extends { id: string }>(
  kind: OperationKind<TOperation>,
  left: TOperation | null,
  right: TOperation | null,
): TOperation | null {
  if (!left || !right) {
    return left ?? right;
  }
  return kind.isOlder(right, left) ? left : right;
}
