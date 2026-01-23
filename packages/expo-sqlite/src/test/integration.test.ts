import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runIntegrationTests } from 'coco-cashu-adapter-tests';
import { ExpoSqliteRepositories } from '../index.ts';
import type { ExpoSqliteRepositoriesOptions } from '../index.ts';
import { ConsoleLogger, type Logger } from 'coco-cashu-core';

const mintUrl = process.env.MINT_URL;

if (!mintUrl) {
  throw new Error('MINT_URL is not set');
}

function getTestLogger(): Logger | undefined {
  const logLevel = process.env.TEST_LOG_LEVEL;
  if (logLevel && ['error', 'warn', 'info', 'debug'].includes(logLevel)) {
    return new ConsoleLogger('expo-sqlite-integration', {
      level: logLevel as 'error' | 'warn' | 'info' | 'debug',
    });
  }
  return undefined;
}

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
      const statement = this.db.prepare(statementSql);
      statement.run();
    }
  }

  async runAsync(sql: string, ...params: any[]): Promise<RunResult> {
    const statement = this.db.prepare(sql);
    const result = statement.run(...params) as unknown as {
      changes?: number;
      lastInsertRowid?: number;
    };
    const changes = Number(result?.changes ?? 0);
    const lastInsertRowId = Number(result?.lastInsertRowid ?? 0);
    return { changes, lastInsertRowId, lastInsertRowid: lastInsertRowId };
  }

  async getFirstAsync<T = unknown>(sql: string, ...params: any[]): Promise<T | null> {
    const statement = this.db.prepare(sql);
    const row = statement.get(...params) as T | undefined;
    return row ?? null;
  }

  async getAllAsync<T = unknown>(sql: string, ...params: any[]): Promise<T[]> {
    const statement = this.db.prepare(sql);
    const rows = statement.all(...params) as T[] | undefined;
    return rows ?? [];
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }
}

async function createRepositories() {
  const database = new BunExpoSqliteDatabaseShim();
  const repositories = new ExpoSqliteRepositories({
    database: database as unknown as ExpoSqliteRepositoriesOptions['database'],
  });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      await repositories.db.raw.closeAsync?.();
    },
  } as const;
}

runIntegrationTests(
  {
    createRepositories,
    mintUrl,
    logger: getTestLogger(),
    suiteName: 'Expo SQLite Integration Tests',
  },
  //@ts-expect-error stupid type error that no one cares about
  { describe, it, beforeEach, afterEach, expect },
);
