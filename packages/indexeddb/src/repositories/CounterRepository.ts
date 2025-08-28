import type { CounterRepository, Counter } from 'coco-cashu-core';
import type { IdbDb, CounterRow } from '../lib/db.ts';

export class IdbCounterRepository implements CounterRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getCounter(mintUrl: string, keysetId: string): Promise<Counter | null> {
    const row = (await (this.db as any).table('coco_cashu_counters').get([mintUrl, keysetId])) as
      | CounterRow
      | undefined;
    if (!row) return null;
    return { mintUrl, keysetId, counter: row.counter } satisfies Counter;
  }

  async setCounter(mintUrl: string, keysetId: string, counter: number): Promise<void> {
    await (this.db as any).table('coco_cashu_counters').put({
      mintUrl,
      keysetId,
      counter,
    } satisfies CounterRow);
  }
}
