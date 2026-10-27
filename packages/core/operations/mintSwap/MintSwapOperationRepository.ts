import type { MintQuoteRef, MeltQuoteRef } from '../../models/QuoteIdentity.ts';
import type { MintSwapOperation, MintSwapOperationState } from './MintSwapOperation.ts';

/**
 * Required Mint Swap persistence, bound to the active Wallet transaction's handle and lifetime.
 * A scoped handle must share parent/child/proof commit and rollback, including parent revisions.
 */
export interface MintSwapPersistence {
  operationRepository: MintSwapOperationRepository;
}

export interface MintSwapOperationRepository {
  /** Parse and create at revision zero; all five identities stay unique for all time. */
  create(operation: MintSwapOperation): Promise<void>;
  /** Hydrate through the parser and return an independent snapshot. */
  getById(id: string): Promise<MintSwapOperation | null>;
  /** Durable ownership, including terminal and needs_attention parents; return independent snapshots. */
  getByChild(kind: 'mint' | 'melt', operationId: string): Promise<MintSwapOperation | null>;
  /** Normalize the mint URL; ownership survives completion and does not depend on child presence. */
  getByQuote(
    kind: 'mint' | 'melt',
    quote: MintQuoteRef | MeltQuoteRef,
  ): Promise<MintSwapOperation | null>;
  /**
   * Atomically match ID/state/revision. A missing row or stale guard returns false without mutation.
   * On a match, assign expectedRevision + 1 regardless of next.revision, then parse and validate
   * immutable facts and the transition. Invalid candidates throw without mutation.
   */
  transition(command: {
    operationId: string;
    expectedState: MintSwapOperationState;
    expectedRevision: number;
    next: MintSwapOperation;
  }): Promise<boolean>;
  /** All nonterminal records, including prepared and needs_attention; order by createdAt, then ID. */
  listActive(): Promise<MintSwapOperation[]>;
  /** Automatic states due at/before now; order by nextAttemptAt, createdAt, then ID. Limit 0 is a no-op. */
  listDue(now: number, limit: number): Promise<MintSwapOperation[]>;
}
