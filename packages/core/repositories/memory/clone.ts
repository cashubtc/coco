export function cloneMemoryValue<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;

  if (value instanceof Map) {
    const result = new Map();
    seen.set(value, result);
    for (const [key, item] of value) {
      result.set(cloneMemoryValue(key, seen), cloneMemoryValue(item, seen));
    }
    return result as T;
  }
  if (value instanceof Set) {
    const result = new Set();
    seen.set(value, result);
    for (const item of value) result.add(cloneMemoryValue(item, seen));
    return result as T;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(cloneMemoryValue(item, seen));
    return result as T;
  }
  if (value instanceof Date) return new Date(value.getTime()) as T;

  const result = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
  seen.set(value, result);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) descriptor.value = cloneMemoryValue(descriptor.value, seen);
    Object.defineProperty(result, key, descriptor);
  }
  return result as T;
}

export function copyMemoryRepositoryState(
  source: object,
  target: object,
  excludedKeys: readonly string[] = [],
): void {
  const excluded = new Set(excludedKeys);
  const sourceRecord = source as Record<string, unknown>;
  const targetRecord = target as Record<string, unknown>;
  for (const key of Object.keys(sourceRecord)) {
    if (!excluded.has(key)) targetRecord[key] = cloneMemoryValue(sourceRecord[key]);
  }
}
