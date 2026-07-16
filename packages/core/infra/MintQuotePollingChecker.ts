import type { MintMethod, MintMethodQuoteSnapshot } from '../operations/mint/MintMethodHandler.ts';

export interface MintQuotePollingCheckResult {
  attemptedQuoteIds: string[];
  observations: MintMethodQuoteSnapshot[];
}

/** Canonical quote-check seam used by the polling scheduler. */
export interface MintQuotePollingChecker {
  checkMintQuotesForPolling(
    mintUrl: string,
    method: MintMethod,
    quoteIds: string[],
  ): Promise<MintQuotePollingCheckResult>;
}
