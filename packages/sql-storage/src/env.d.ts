declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export const expect: any;
}

declare module 'bun:sqlite' {
  export interface StatementRunResult {
    lastInsertRowid: number | bigint;
    changes: number;
  }

  export class Statement {
    run(...params: any[]): StatementRunResult;
    get(...params: any[]): unknown;
    all(...params: any[]): unknown[];
  }

  export class Database {
    constructor(filename?: string);
    prepare(sql: string): Statement;
    exec(sql: string): void;
    close(): void;
  }
}
