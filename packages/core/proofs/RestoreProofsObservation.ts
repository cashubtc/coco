import type { Proof } from '@cashu/cashu-ts';

export type RestoreProofsObservationStatus =
  | 'none'
  | 'complete-unspent'
  | 'complete-spent'
  | 'inconclusive';

/** Read-only evidence returned by the mint Restore endpoint for one exact output allocation. */
export interface RestoreProofsObservation {
  status: RestoreProofsObservationStatus;
  expectedOutputCount: number;
  restoredProofs: Proof[];
  unspentProofs: Proof[];
}
