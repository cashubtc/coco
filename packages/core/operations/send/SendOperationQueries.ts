import type { SendOperation, SendOperationState } from '@core/operations/send/SendOperation.ts';

/** Informational Send reads. Callers must not use these reads to authorize a transaction write. */
export interface SendOperationQueries {
  getById(id: string): Promise<SendOperation | null>;
  getByState(state: SendOperationState): Promise<SendOperation[]>;
  getPending(): Promise<SendOperation[]>;
  getByMintUrl(mintUrl: string): Promise<SendOperation[]>;
}
