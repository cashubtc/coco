import type { CounterRepository, Counter } from 'coco-cashu-core';
import { SqliteDb } from '../db.ts';

export class SqliteCounterRepository implements CounterRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async getCounter(mintUrl: string, keysetId: string): Promise<Counter | null> {
    const row = await this.db.get<{ counter: number }>(
      'SELECT counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ? LIMIT 1',
      [mintUrl, keysetId],
    );
    if (!row) return null;
    return { mintUrl, keysetId, counter: row.counter } satisfies Counter;
  }

  async setCounter(mintUrl: string, keysetId: string, counter: number): Promise<void> {
    await this.db.run(
      `INSERT INTO coco_cashu_counters (mintUrl, keysetId, counter)
       VALUES (?, ?, ?)
       ON CONFLICT(mintUrl, keysetId) DO UPDATE SET counter = excluded.counter`,
      [mintUrl, keysetId, counter],
    );
  }
}
