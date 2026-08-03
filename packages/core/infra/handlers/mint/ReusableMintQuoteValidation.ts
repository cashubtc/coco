import type { MintQuoteBolt12Response, MintQuoteOnchainResponse } from '@cashu/cashu-ts';
import { assertSameUnit } from '@core/amounts';
import type { PendingMintOperation } from '@core/operations/mint';
import { MintQuoteValidationError } from '../../../models/Error';

type ReusableMintQuoteResponse = MintQuoteBolt12Response | MintQuoteOnchainResponse;
type ReusablePendingMintOperation = PendingMintOperation<'bolt12' | 'onchain'>;

/**
 * Returns a validation error when a reusable quote response is not attributable to an operation.
 */
export function getReusableMintQuoteValidationError(
  quote: ReusableMintQuoteResponse,
  operation: ReusablePendingMintOperation,
): Error | null {
  const identityLabel = operation.method === 'bolt12' ? 'BOLT12' : 'onchain';
  const quoteLabel = operation.method === 'bolt12' ? 'BOLT12' : 'Onchain';

  try {
    if (quote.quote !== operation.quoteId || quote.request !== operation.request) {
      throw new MintQuoteValidationError(
        `Polled ${identityLabel} mint quote ${quote.quote} ` +
          'conflicts with pending operation identity',
      );
    }
    assertSameUnit(quote.unit, operation.unit, `${quoteLabel} mint quote ${quote.quote}`);
    if (operation.pubkey !== undefined && quote.pubkey !== operation.pubkey) {
      throw new MintQuoteValidationError(
        `${quoteLabel} mint quote ${quote.quote} returned pubkey ${quote.pubkey} ` +
          `instead of requested pubkey ${operation.pubkey}`,
      );
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error), { cause: error });
  }
}
