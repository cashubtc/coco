import type { MintMethod } from '../operations/mint/MintMethodHandler.ts';

/** Stable identity for one normalized mint/method check cohort. */
export function mintQuoteGroupKey(mintUrl: string, method: MintMethod): string {
  return JSON.stringify([mintUrl, method]);
}

/** Stable identity for identical work on one canonical mint quote. */
export function mintQuoteWorkKey(mintUrl: string, method: MintMethod, quoteId: string): string {
  return JSON.stringify([mintUrl, method, quoteId]);
}
