import type { MintRecoveryRecord } from '../../operations/mint/MintRecovery.ts';
import type { MintRecoveryRepository } from '../index.ts';
import { cloneMemoryValue, COPY_MEMORY_REPOSITORY_STATE } from './MemoryRepositoryTransaction.ts';

export class MemoryMintRecoveryRepository implements MintRecoveryRepository {
  private records = new Map<string, MintRecoveryRecord>();
  [COPY_MEMORY_REPOSITORY_STATE](source: MemoryMintRecoveryRepository): void {
    this.records = cloneMemoryValue(source.records);
  }
  async get(operationId: string): Promise<MintRecoveryRecord | null> {
    return cloneMemoryValue(this.records.get(operationId) ?? null);
  }
  async set(record: MintRecoveryRecord): Promise<void> {
    this.records.set(record.operationId, cloneMemoryValue(record));
  }
  async getAll(): Promise<MintRecoveryRecord[]> {
    return cloneMemoryValue([...this.records.values()]);
  }
}
