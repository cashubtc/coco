import type { MintMethod, MintMethodQuoteSnapshot } from '../operations/mint/MintMethodHandler.ts';

/** Outcome of one coordinated mint-quote polling opportunity. */
export interface MintQuotePollingCheckResult {
  /** Quote IDs sent through either a batch request or isolated fallback request. */
  attemptedQuoteIds: string[];
  /** Valid, attributable observations persisted for this opportunity. */
  observations: MintMethodQuoteSnapshot[];
  /** Quote-specific protocol failures isolated without discarding healthy peers. */
  errorsByQuoteId?: Map<string, Error>;
}

/** Supplies queued watcher interests that can share an explicit quote-check batch. */
export interface MintQuotePollingInterestProvider {
  /**
   * Returns eligible quote IDs in scheduler order for one normalized mint/method cohort.
   * IDs under backoff or no longer queued must be omitted.
   */
  getQueuedMintQuoteIds(mintUrl: string, method: MintMethod): string[];
}

/** Canonical quote-check seam used by the polling scheduler. */
export interface MintQuotePollingChecker {
  checkMintQuotesForPolling(
    mintUrl: string,
    method: MintMethod,
    quoteIds: string[],
  ): Promise<MintQuotePollingCheckResult>;
  /** Registers queued watcher interests and returns an idempotent cleanup callback. */
  registerMintQuotePollingInterestProvider?(provider: MintQuotePollingInterestProvider): () => void;
}
