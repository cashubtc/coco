import type { MintQuote } from '../models/MintQuote.ts';
import type { QuoteIdentity } from '../models/QuoteIdentity.ts';
import type { MintMethod } from '../operations/mint/MintMethodHandler.ts';

export type MintQuotePollingFailureCategory =
  | 'network'
  | 'authentication'
  | 'rate-limit'
  | 'server'
  | 'incompatibility'
  | 'batch-size'
  | 'malformed-response'
  | 'validation';

export interface MintQuotePollingFailure {
  category: MintQuotePollingFailureCategory;
  error: Error;
  responseIndex?: number;
  responseQuoteId?: string;
}

export type MintQuotePollingOutcome =
  | {
      status: 'updated';
      identity: QuoteIdentity;
      quote: MintQuote;
    }
  | {
      status: 'failed';
      identity: QuoteIdentity;
      failure: MintQuotePollingFailure;
    };

export interface MintQuotePollingResult {
  outcomes: MintQuotePollingOutcome[];
  responseFailures: MintQuotePollingFailure[];
}

/** Batch-aware quote lifecycle boundary used by Background Watcher polling. */
export interface MintQuotePollingOperation {
  getMintQuotePollingLimit(mintUrl: string, method: MintMethod): Promise<number>;
  checkMintQuotesForPolling(
    method: MintMethod,
    identities: readonly QuoteIdentity[],
  ): Promise<MintQuotePollingResult>;
}
