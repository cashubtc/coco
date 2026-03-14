declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export const expect: any;
}

declare const process: {
  env: Record<string, string | undefined>;
};

declare function setTimeout(
  handler: (...args: any[]) => void,
  timeout?: number,
  ...args: any[]
): number;
