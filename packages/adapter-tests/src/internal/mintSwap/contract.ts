import type { Repositories } from '../../../../core/repositories/index.ts';

// Repository-local tests of dormant core internals. Deliberately absent from the published
// adapter-tests entry point: running these contracts must not make the coordinator public.
export interface MintSwapContractOptions {
  supportsReopen?: boolean;
  createRepositories(): Promise<{
    repositories: Repositories;
    dispose(): Promise<void>;
    /** Close and reopen the physical store, without seeding or rewriting persisted state. */
    reopen?(): Promise<Repositories>;
  }>;
}

interface Assertions {
  toBe(value: unknown): void;
  toEqual(value: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toHaveLength(value: number): void;
  toContain(value: unknown): void;
  toBeGreaterThan(value: number): void;
  toBeGreaterThanOrEqual(value: number): void;
  toBeLessThanOrEqual(value: number): void;
  toThrow(message?: string): void;
  toBeInstanceOf(value: unknown): void;
}

export interface MintSwapTestRunner {
  describe(name: string, work: () => void): void;
  it(name: string, work: () => Promise<void>): void;
  beforeEach(work: () => Promise<void>): void;
  afterEach(work: () => Promise<void>): void;
  expect(value: unknown): Assertions & {
    not: Assertions;
    rejects: { [K in keyof Assertions]: (...args: Parameters<Assertions[K]>) => unknown };
  };
}
