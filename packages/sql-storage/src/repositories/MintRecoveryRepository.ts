import type { MintRecoveryRecord, MintRecoveryRepository } from '@cashu/coco-core/adapter';
import type { SqlDatabase } from '../index.ts';

export class SqliteMintRecoveryRepository implements MintRecoveryRepository {
  constructor(private readonly db: SqlDatabase) {}
  async get(operationId: string): Promise<MintRecoveryRecord | null> {
    const row = await this.db.get<{ data: string }>(
      'SELECT data FROM coco_cashu_mint_recovery WHERE operationId = ?',
      [operationId],
    );
    return row ? JSON.parse(row.data) : null;
  }
  async set(record: MintRecoveryRecord): Promise<void> {
    await this.db.run(
      'INSERT INTO coco_cashu_mint_recovery (operationId, data) VALUES (?, ?) ON CONFLICT(operationId) DO UPDATE SET data = excluded.data',
      [record.operationId, JSON.stringify(record)],
    );
  }
  async getAll(): Promise<MintRecoveryRecord[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM coco_cashu_mint_recovery');
    return rows.map((row) => JSON.parse(row.data));
  }
}
