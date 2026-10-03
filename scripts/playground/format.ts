/** Bounded, getter-free formatting; values never need to be structured-cloneable. */
export function format(value: unknown): string {
  const seen = new WeakSet<object>();
  let remaining = 200;
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === 'bigint') return `${item}n`;
    if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
    if (typeof item === 'symbol') return String(item);
    if (item === undefined) return 'undefined';
    if (typeof item === 'string') return item.length > 4000 ? `${item.slice(0, 4000)}…` : item;
    if (item === null || typeof item !== 'object') return item;
    if (--remaining < 0 || depth > 5) return '[…]';
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    if (item instanceof Error) return item.stack ?? `${item.name}: ${item.message}`;
    if (item instanceof Date) return item.toISOString();
    if (item instanceof Map) {
      const entries = [];
      for (const [key, value] of Map.prototype.entries.call(item)) {
        entries.push([visit(key, depth + 1), visit(value, depth + 1)]);
        if (entries.length === 40) break;
      }
      return { Map: entries };
    }
    if (item instanceof Set) {
      const values = [];
      for (const value of Set.prototype.values.call(item)) {
        values.push(visit(value, depth + 1));
        if (values.length === 40) break;
      }
      return { Set: values };
    }
    if (ArrayBuffer.isView(item))
      return `${item.constructor.name} [${Array.from(new Uint8Array(item.buffer, item.byteOffset, Math.min(item.byteLength, 80))).join(', ')}${item.byteLength > 80 ? ', …' : ''}]`;
    if (Array.isArray(item)) {
      const values = [];
      for (let index = 0; index < Math.min(item.length, 40); index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        values.push(
          !descriptor || 'value' in descriptor
            ? visit(descriptor?.value, depth + 1)
            : '[Getter]',
        );
      }
      if (item.length > 40) values.push('…');
      return values;
    }
    const entries = Object.entries(Object.getOwnPropertyDescriptors(item)).slice(0, 40);
    return Object.fromEntries(
      entries.map(([key, descriptor]) => [
        key,
        'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Getter]',
      ]),
    );
  };
  try {
    if (typeof value === 'string') return value.slice(0, 8000);
    if (value === undefined) return 'undefined';
    return (JSON.stringify(visit(value, 0), null, 2) ?? String(value)).slice(0, 12000);
  } catch {
    return '[Unprintable value]';
  }
}
export function errorText(error: unknown): string {
  // Formatting a thrown value must not throw again and leave a run pending.
  try {
    return error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`).slice(0, 12000)
      : format(error);
  } catch {
    return '[Unprintable error]';
  }
}
