import type { Proof } from '@cashu/cashu-ts';
import type { StoredBlindedMessage } from '../../utils.ts';

/** Lossless, internal storage format. Never expose or log request or receipt material. */
export interface MintRequestRecord {
  quote: string;
  outputs: StoredBlindedMessage[];
  signature?: string;
}

export interface MintIssuanceReceipt {
  B_: string;
  proof: Omit<Proof, 'amount'> & { amount: string };
  state: 'UNSPENT' | 'PENDING' | 'SPENT' | 'UNKNOWN';
}

export interface MintRecoveryRecord {
  version: 1;
  operationId: string;
  revision: number;
  /** Previously observed issuance outside the locally finalized operation totals. */
  issuanceBaseline?: string;
  /** Unknown legacy submissions reserve their full amount, including legacy pending rows. */
  provenance: 'prepared' | 'authorized' | 'legacy-unknown' | 'settled';
  request?: MintRequestRecord;
  legacySignature?: string;
  rejectedRequest?: MintRequestRecord;
  variant: 'current' | 'legacy';
  /** Only the authorizing caller may transmit; a restart reconciles without blind replay. */
  transmission?: 'authorized' | 'rejected' | 'ambiguous';
  receipts: MintIssuanceReceipt[];
}

export function newMintRecovery(operationId: string): MintRecoveryRecord {
  return {
    version: 1,
    operationId,
    revision: 0,
    provenance: 'prepared',
    variant: 'current',
    receipts: [],
  };
}
