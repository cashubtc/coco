import type { Mint, Proof } from '@cashu/cashu-ts';

export type MintInfo = Awaited<ReturnType<Mint['getInfo']>>;

export type ProofState = 'inflight' | 'ready' | 'spent';

export interface CoreProof extends Proof {
  mintUrl: string;
  state: ProofState;

  /**
   * ID of the operation that is using this proof as input.
   * When set, the proof is reserved and should not be used by other operations.
   */
  usedByOperationId?: string;

  /**
   * ID of the operation that created this proof as output.
   * Used for auditing and rollback purposes.
   */
  createdByOperationId?: string;
}
