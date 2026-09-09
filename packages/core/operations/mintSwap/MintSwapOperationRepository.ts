import type { MintSwapOperation, MintSwapOperationState } from './MintSwapOperation.ts';

/**
 * Feature-owned persistence; ordinary Coco repository bags do not require this capability.
 * #417 binds this same contract to the active Wallet transaction's physical handle and lifetime.
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
