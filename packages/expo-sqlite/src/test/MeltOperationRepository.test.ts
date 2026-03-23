/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
// @ts-ignore bun:sqlite types are provided by the runtime in this workspace.
import { Database } from 'bun:sqlite';
import type { MeltOperation } from 'coco-cashu-core';
import {
  ExpoSqliteRepositories,
  type ExpoSqliteRepositoriesOptions,
} from '../index.ts';

type FinalizedMeltOperation = Extract<MeltOperation, { state: 'finalized' }>;

type RunResult = { changes: number; lastInsertRowId: number; lastInsertRowid: number };

class BunExpoSqliteDatabaseShim {
  private readonly db: Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
  }

  async execAsync(sql: string): Promise<void> {
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statementSql of statements) {
      this.db.prepare(statementSql).run();
    }
  }

  async runAsync(sql: string, ...params: any[]): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...params) as unknown as {
      changes?: number;
      lastInsertRowid?: number;
    };

    const changes = Number(result?.changes ?? 0);
    const lastInsertRowId = Number(result?.lastInsertRowid ?? 0);
    return { changes, lastInsertRowId, lastInsertRowid: lastInsertRowId };
  }

  async getFirstAsync<T = unknown>(sql: string, ...params: any[]): Promise<T | null> {
    const row = this.db.prepare(sql).get(...params) as T | undefined;
    return row ?? null;
  }

  async getAllAsync<T = unknown>(sql: string, ...params: any[]): Promise<T[]> {
    const rows = this.db.prepare(sql).all(...params) as T[] | undefined;
    return rows ?? [];
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }
}

function makeFinalizedMeltOperation(): FinalizedMeltOperation {
  return {
    id: 'melt-op-1',
    mintUrl: 'https://mint.test',
    state: 'finalized',
    method: 'bolt11',
    methodData: { invoice: 'lnbc1test' },
    createdAt: 1_000,
    updatedAt: 2_000,
    quoteId: 'quote-1',
    amount: 100,
    fee_reserve: 5,
    swap_fee: 0,
    needsSwap: false,
    inputAmount: 105,
    inputProofSecrets: ['secret-1'],
    changeOutputData: { keep: [], send: [] },
    changeAmount: 2,
    effectiveFee: 3,
    finalizedData: { preimage: '' },
  };
}

describe('ExpoMeltOperationRepository', () => {
  let database: BunExpoSqliteDatabaseShim;
  let repositories: ExpoSqliteRepositories;

  beforeEach(async () => {
    database = new BunExpoSqliteDatabaseShim();
    repositories = new ExpoSqliteRepositories({
      database: database as unknown as ExpoSqliteRepositoriesOptions['database'],
    });
    await repositories.init();
  });

  afterEach(async () => {
    await repositories.db.raw.closeAsync?.();
  });

  it('round-trips settlement amounts for finalized operations', async () => {
    const operation = makeFinalizedMeltOperation();

    await repositories.meltOperationRepository.create(operation);

    expect(await repositories.meltOperationRepository.getById(operation.id)).toEqual(operation);
  });
});
