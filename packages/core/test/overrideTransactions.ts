import type { Repositories } from '../repositories/index.ts';

export function overrideTransactions(
  base: Repositories,
  withTransaction: Repositories['withTransaction'],
): Repositories {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'withTransaction') return withTransaction;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
