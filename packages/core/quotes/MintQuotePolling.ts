import type { MintQuote } from '../models/MintQuote.ts';
import type { QuoteIdentity } from '../models/QuoteIdentity.ts';

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
