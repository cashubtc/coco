import type { SendOperation, SendOperationState } from '@core/operations/send/SendOperation.ts';
import type { CoreProof } from '@core/types.ts';

/** Informational Send reads. Callers must not use these reads to authorize a transaction write. */
export interface SendOperationQueries {
  getById(id: string): Promise<SendOperation | null>;
  getByState(state: SendOperationState): Promise<SendOperation[]>;
  getPending(): Promise<SendOperation[]>;
  getByMintUrl(mintUrl: string): Promise<SendOperation[]>;
}

export interface SendProofQueries {
  getProofsByOperationId(mintUrl: string, operationId: string): Promise<CoreProof[]>;
  getProofsBySecrets(mintUrl: string, secrets: string[]): Promise<CoreProof[]>;
  getReservedProofs(): Promise<CoreProof[]>;
}
