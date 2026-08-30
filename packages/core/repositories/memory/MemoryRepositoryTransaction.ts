/** Internal protocol that lets each memory repository own its transaction-state representation. */
export const COPY_MEMORY_REPOSITORY_STATE = Symbol('copyMemoryRepositoryState');

export type MemoryRepositoryStateOwner<TRepository extends object> = {
  [COPY_MEMORY_REPOSITORY_STATE](source: TRepository): void;
};

/** Clone the domain values stored by memory repositories without sharing mutable references. */
export function cloneMemoryValue<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return seen.get(value) as T;

  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof Uint8Array) return value.slice() as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(cloneMemoryValue(item, seen));
    return clone as T;
  }

  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    seen.set(value, clone);
    for (const [key, item] of value) {
      clone.set(cloneMemoryValue(key, seen), cloneMemoryValue(item, seen));
    }
    return clone as T;
  }

  if (value instanceof Set) {
    const clone = new Set<unknown>();
    seen.set(value, clone);
    for (const item of value) clone.add(cloneMemoryValue(item, seen));
    return clone as T;
  }

  const clone = Object.create(Object.getPrototypeOf(value)) as object;
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) descriptor.value = cloneMemoryValue(descriptor.value, seen);
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as T;
}
