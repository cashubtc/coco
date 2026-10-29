import { Amount } from '@cashu/cashu-ts';
import type { MintOperationRepository } from '@core/repositories';
import type { MintQuoteRef } from '../../models/QuoteIdentity.ts';
import type { BatchMintOperation } from '../../operations/batchMint/BatchMintOperation.ts';
import type { BatchMintOperationRepository } from '../../operations/batchMint/BatchMintOperationRepository.ts';
import type { MintOperation } from '../../operations/mint/MintOperation.ts';
import { normalizeMintUrl } from '../../utils.ts';

/** Local facts about one Mint Quote's claims across Mint Operations and Batch Mint Operations. */
export interface MintQuoteClaimFacts {
  /** Local issuance: finalized Mint Operations plus finalized Batch Mint Members. */
  finalizedAmount: Amount;
  /**
   * Active Mint Quote Reservations: executing Mint Operations plus executing Batch Mint Members,
   * excluding the operation being assessed.
   */
  reservedAmount: Amount;
  /**
   * Every standalone Mint Operation for the quote, ordered by createdAt then ID. Nonterminal ones
   * keep claiming the quote; fixed-amount quotes admit no second standalone operation at all.
   */
  standaloneOperations: MintOperation[];
  /** Every Batch Mint Operation with a member for the quote, ordered by createdAt then ID. */
  batchMintOperations: BatchMintOperation[];
}

export interface MintQuoteClaimFactsOptions {
  /** Mint or Batch Mint Operation whose own reservation must not count against itself. */
  excludeOperationId?: string;
}

/**
 * The single source of local Mint Quote claim facts. Every claimability decision reads them here,
 * inside the transaction that authorizes it or a read transaction for informational checks.
 */
export interface ScopedMintQuoteClaims {
  getFacts(quote: MintQuoteRef, options?: MintQuoteClaimFactsOptions): Promise<MintQuoteClaimFacts>;
}

export class RepositoryScopedMintQuoteClaims implements ScopedMintQuoteClaims {
  constructor(
    private readonly mintOperations: Pick<MintOperationRepository, 'getByQuoteId'>,
    private readonly batchMintOperations: Pick<BatchMintOperationRepository, 'listByQuote'>,
  ) {}

  async getFacts(
    quote: MintQuoteRef,
    options: MintQuoteClaimFactsOptions = {},
  ): Promise<MintQuoteClaimFacts> {
    const mintUrl = normalizeMintUrl(quote.mintUrl);
    const standaloneOperations = await this.mintOperations.getByQuoteId(
      mintUrl,
      quote.method,
      quote.quoteId,
    );
    const batchMintOperations = (
      await this.batchMintOperations.listByQuote({ mintUrl, quoteId: quote.quoteId })
    ).filter((operation) => operation.method === quote.method);

    let finalizedAmount = Amount.zero();
    let reservedAmount = Amount.zero();
    const count = (operation: MintOperation | BatchMintOperation, amount: Amount) => {
      if (operation.state === 'finalized') finalizedAmount = finalizedAmount.add(amount);
      else if (operation.state === 'executing' && operation.id !== options.excludeOperationId)
        reservedAmount = reservedAmount.add(amount);
    };
    for (const operation of standaloneOperations) count(operation, operation.amount);
    for (const operation of batchMintOperations) {
      for (const member of operation.members) {
        if (member.quoteId === quote.quoteId) count(operation, member.amount);
      }
    }
    return { finalizedAmount, reservedAmount, standaloneOperations, batchMintOperations };
  }
}
