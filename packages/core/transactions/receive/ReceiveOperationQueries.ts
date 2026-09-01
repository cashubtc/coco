import type {
  ReceiveOperation,
  ReceiveOperationState,
} from '@core/operations/receive/ReceiveOperation.ts';
import type { CoreProof } from '@core/types.ts';

/** Informational Receive reads. Mutations must re-authorize their state inside a transaction. */
export interface ReceiveOperationQueries {
  getById(id: string): Promise<ReceiveOperation | null>;
  getByState(state: ReceiveOperationState): Promise<ReceiveOperation[]>;
  getPending(): Promise<ReceiveOperation[]>;
  getByMintUrl(mintUrl: string): Promise<ReceiveOperation[]>;
  getByPaymentRequestAttemptId(attemptId: string): Promise<ReceiveOperation | null>;
}

export interface ReceiveProofQueries {
  getProofsBySecrets(mintUrl: string, secrets: string[]): Promise<CoreProof[]>;
}
