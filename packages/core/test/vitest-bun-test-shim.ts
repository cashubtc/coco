import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from 'vitest';

type AnyFunction = (...args: any[]) => any;

export type Mock<T extends AnyFunction = AnyFunction> = ReturnType<typeof vi.fn<T>>;

export const mock = vi.fn;

export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test };
