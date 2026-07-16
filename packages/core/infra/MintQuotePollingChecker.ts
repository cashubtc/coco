import type { MintMethod, MintMethodQuoteSnapshot } from '../operations/mint/MintMethodHandler.ts';

/** Outcome of one coordinated mint-quote polling opportunity. */
export interface MintQuotePollingCheckResult {
  /** Quote IDs sent through either a batch request or isolated fallback request. */
  attemptedQuoteIds: string[];
  /** Valid, attributable observations persisted for this opportunity. */
  observations: MintMethodQuoteSnapshot[];
  /** Quote-specific protocol failures isolated without discarding healthy peers. */
  errorsByQuoteId?: Map<string, Error>;
  /** A later split branch failed after earlier branches produced usable partial results. */
  partialFailure?: { error: unknown };
}

/** Canonical quote-check seam used by the polling scheduler. */
export interface MintQuotePollingChecker {
  checkMintQuotesForPolling(
    mintUrl: string,
    method: MintMethod,
    quoteIds: string[],
  ): Promise<MintQuotePollingCheckResult>;
}
