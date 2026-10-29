import type { Logger } from '../../logging/Logger.ts';
import { BatchMintAdmissionError } from '../../models/Error.ts';
import type { MintQuoteRef } from '../../models/QuoteIdentity.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import type { MintService } from '../../services/MintService.ts';
import type { CoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { assessMintQuoteClaim } from '../../transactions/mintQuoteClaims/ScopedMintQuoteClaims.ts';
import { normalizeMintUrl } from '../../utils.ts';
import { mintQuoteLockKey } from '../MintScopedLock.ts';
import { isTerminalOperation } from '../mint/MintOperation.ts';
import type { MintMethod } from '../mint/MintMethodHandler.ts';
import type { MintOperationService } from '../mint/MintOperationService.ts';
import type { BatchMintOperation } from './BatchMintOperation.ts';
import type { BatchMintOperationService } from './BatchMintOperationService.ts';

export interface BatchMintQuoteClaimsDependencies {
  /** Standalone claims, and whether an active Mint Swap coordinates a quote. */
  mintOperations: Pick<MintOperationService, 'claimMintQuote' | 'canResolve'>;
  batchMintOperations: Pick<BatchMintOperationService, 'execute' | 'isBatchMintUnavailable'>;
  quoteLifecycle: Pick<QuoteLifecycle, 'getMintQuote' | 'getPendingMintQuotes'>;
  mintService: Pick<MintService, 'isTrustedMint' | 'getNut29BatchMintLimit'>;
  /** Informational claim-fact reads only; admission rereads them in its own scope. */
  transactionRunner: CoreTransactionRunner;
  logger?: Logger;
}

/**
 * Automatic claiming of paid Mint Quotes through Batch Mint Operations, used by the Mint Operation
 * Processor's processing turns and startup sweep when `batchMintQuotes` is on.
 *
 * Quotes that are claimable, have no nonterminal Mint Operation, and whose mint advertises NUT-29
 * batch minting for the method are grouped by mint, method and unit in the given order, and each
 * chunk of two or more within the batch limit is claimed as one Batch Mint Operation. Everything
 * else is claimed as a standalone Mint Operation, as are the still-claimable members of a batch
 * that was rejected or failed. A failure for one quote or chunk is logged and does not stop the
 * others.
 */
export class BatchMintQuoteClaims {
  constructor(private readonly dependencies: BatchMintQuoteClaimsDependencies) {}

  /**
   * The startup sweep. `onCoordinatedQuote` receives quotes skipped because an active Mint Swap
   * coordinates them, so the processor can resume them once the parent stops.
   */
  async claimPendingMintQuotes(onCoordinatedQuote?: (quote: MintQuoteRef) => void): Promise<void> {
    const refs: MintQuoteRef[] = [];
    for (const quote of await this.dependencies.quoteLifecycle.getPendingMintQuotes()) {
      const ref = { mintUrl: quote.mintUrl, method: quote.method, quoteId: quote.quoteId };
      if (!(await this.dependencies.mintOperations.canResolve(ref))) {
        onCoordinatedQuote?.(ref);
        continue;
      }
      if (!(await this.dependencies.mintService.isTrustedMint(quote.mintUrl))) {
        this.dependencies.logger?.debug('Skipping pending mint quote for untrusted mint', {
          mintUrl: quote.mintUrl,
          method: quote.method,
        });
        continue;
      }
      refs.push(ref);
    }
    await this.claimMintQuotes(refs);
  }

  async claimMintQuotes(refs: readonly MintQuoteRef[]): Promise<void> {
    const seen = new Set<string>();
    const standalone: MintQuoteRef[] = [];
    const groups = new Map<
      string,
      { mintUrl: string; method: MintMethod; limit: number; quoteIds: string[] }
    >();
    const limits = new Map<string, Promise<number>>();
    for (const ref of refs) {
      const target = {
        mintUrl: normalizeMintUrl(ref.mintUrl),
        method: ref.method,
        quoteId: ref.quoteId,
      };
      const key = mintQuoteLockKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      const eligibility = await this.batchEligibility(target, limits);
      if (!eligibility) {
        standalone.push(target);
        continue;
      }
      const groupKey = `${target.mintUrl}::${target.method}::${eligibility.unit}`;
      const group = groups.get(groupKey) ?? { ...target, limit: eligibility.limit, quoteIds: [] };
      group.quoteIds.push(target.quoteId);
      groups.set(groupKey, group);
    }

    for (const { mintUrl, method, limit, quoteIds } of groups.values()) {
      for (let start = 0; start < quoteIds.length; start += limit) {
        const chunk = quoteIds
          .slice(start, start + limit)
          .map((quoteId) => ({ mintUrl, method, quoteId }));
        if (chunk.length === 1) await this.claimEach(chunk);
        else await this.claimChunk(chunk, true);
      }
    }
    await this.claimEach(standalone);
  }

  /**
   * Informational pre-check for automatic batching; admission rereads everything under the quote
   * locks and rejects a group whose member changed.
   */
  private async batchEligibility(
    ref: MintQuoteRef,
    limits: Map<string, Promise<number>>,
  ): Promise<{ unit: string; limit: number } | undefined> {
    if (this.dependencies.batchMintOperations.isBatchMintUnavailable(ref.mintUrl, ref.method))
      return undefined;
    try {
      const quote = await this.dependencies.quoteLifecycle.getMintQuote(
        ref.mintUrl,
        ref.method,
        ref.quoteId,
      );
      if (!quote) return undefined;
      const facts = await this.dependencies.transactionRunner.run((tx) =>
        tx.mintQuoteClaims.getFacts(ref),
      );
      if (facts.standaloneOperations.some((operation) => !isTerminalOperation(operation)))
        return undefined;
      const assessment = assessMintQuoteClaim(quote, facts);
      if (
        assessment.status !== 'claimable' ||
        !assessment.claimAmount ||
        assessment.claimAmount.isZero()
      )
        return undefined;
      const limitKey = `${ref.mintUrl}::${ref.method}`;
      let limit = limits.get(limitKey);
      if (!limit) {
        limit = this.dependencies.mintService.getNut29BatchMintLimit(ref.mintUrl, ref.method);
        limits.set(limitKey, limit);
      }
      const resolvedLimit = await limit;
      return resolvedLimit < 2 ? undefined : { unit: quote.unit, limit: resolvedLimit };
    } catch (error) {
      this.dependencies.logger?.debug('Mint quote batching eligibility could not be assessed', {
        ...ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Claim one chunk as a Batch Mint Operation. When admission rejects a named member, the chunk is
   * retried once without it if at least two members remain; that member and anything left over
   * are claimed standalone.
   */
  private async claimChunk(chunk: MintQuoteRef[], retryWithoutRejected: boolean): Promise<void> {
    const { mintUrl, method } = chunk[0]!;
    let operation: BatchMintOperation | undefined;
    let rejected: MintQuoteRef | undefined;
    try {
      operation = await this.dependencies.batchMintOperations.execute({
        mintUrl,
        method,
        members: chunk.map(({ quoteId }) => ({ quoteId })),
      });
    } catch (error) {
      this.dependencies.logger?.warn('Automatic Batch Mint claim was not admitted', {
        mintUrl,
        method,
        quoteIds: chunk.map(({ quoteId }) => quoteId),
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof BatchMintAdmissionError && error.quoteId)
        rejected = chunk.find(({ quoteId }) => quoteId === error.quoteId);
    }
    // An executing batch keeps its reservations for recovery. A rejected or failed one holds
    // nothing, so its members are reassessed and claimed with fresh outputs of their own.
    if (operation && operation.state !== 'failed') return;
    if (!rejected || !retryWithoutRejected) return this.claimEach(chunk);
    const rest = chunk.filter((ref) => ref !== rejected);
    if (rest.length >= 2) await this.claimChunk(rest, false);
    else await this.claimEach(rest);
    await this.claimEach([rejected]);
  }

  private async claimEach(refs: readonly MintQuoteRef[]): Promise<void> {
    for (const { mintUrl, method, quoteId } of refs) {
      try {
        await this.dependencies.mintOperations.claimMintQuote(mintUrl, method, quoteId, {
          autoClaimRemaining: true,
        });
      } catch (error) {
        this.dependencies.logger?.warn('Failed to claim mint quote', {
          mintUrl,
          method,
          quoteId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
