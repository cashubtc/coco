import type { MintRecoveryRecord, MintRecoveryRepository } from '@cashu/coco-core/adapter';
import type { IdbDb } from '../lib/db.ts';

export class IdbMintRecoveryRepository implements MintRecoveryRepository {
  constructor(private readonly db: IdbDb) {}
  async get(operationId: string): Promise<MintRecoveryRecord | null> {
    return (
      (await this.db.table<MintRecoveryRecord>('coco_cashu_mint_recovery').get(operationId)) ?? null
    );
  }
  async set(record: MintRecoveryRecord): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_mint_recovery'], async (tx) => {
      await tx.table('coco_cashu_mint_recovery').put(record);
    });
  }
  async getAll(): Promise<MintRecoveryRecord[]> {
    return this.db.table<MintRecoveryRecord>('coco_cashu_mint_recovery').toArray();
  }
}
