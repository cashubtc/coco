import type { CoreProof } from '@core/types.ts';

/** Read-only proof metadata. Reservation and spend authorization belong to scoped commands. */
export interface ProofQueries {
  getProofsByOperationId(mintUrl: string, operationId: string): Promise<CoreProof[]>;
  getProofsBySecrets(mintUrl: string, secrets: string[]): Promise<CoreProof[]>;
  getReservedProofs(): Promise<CoreProof[]>;
}
