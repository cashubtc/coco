import type { Amount, Mint, Proof } from '@cashu/cashu-ts';

export type MintInfo = Awaited<ReturnType<Mint['getInfo']>>;

export type ProofState = 'inflight' | 'ready' | 'spent';

export interface BalanceSnapshot {
  spendable: Amount;
  reserved: Amount;
  total: Amount;
  unit: string;
}

export type BalancesByMint = { [mintUrl: string]: BalanceSnapshot };

export type BalancesByMintAndUnit = {
  [mintUrl: string]: {
    [unit: string]: BalanceSnapshot;
  };
};

export type BalancesByUnit = { [unit: string]: BalanceSnapshot };

export interface BalanceQuery {
  mintUrls?: string[];
  units?: string[];
  trustedOnly?: boolean;
}

/**
 * @deprecated Use BalanceSnapshot instead.
 */
export interface BalanceBreakdown {
  ready: Amount;
  reserved: Amount;
  total: Amount;
}

/**
 * @deprecated Use BalancesByMint instead.
 */
export type BalancesBreakdownByMint = { [mintUrl: string]: BalanceBreakdown };

export interface CoreProof extends Proof {
  mintUrl: string;
  unit: string;
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

  /** Mint Issuance Attempt that produced this proof as part of an aggregate output set. */
  createdByMintIssuanceAttemptId?: string;
}
