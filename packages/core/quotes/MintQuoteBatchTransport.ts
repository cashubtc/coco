import type { EventBus } from '../events/EventBus.ts';
import type { CoreEvents } from '../events/types.ts';
import type { MintAdapter } from '../infra/MintAdapter.ts';
import { mintQuoteGroupKey } from '../infra/MintQuotePollingKey.ts';
import type { Logger } from '../logging/Logger.ts';
import {
  HttpResponseError,
  MintOperationError,
  NetworkError,
  ProofValidationError,
} from '../models/Error.ts';
import type { MintMethod } from '../operations/mint/MintMethodHandler.ts';
import { normalizeMintUrl } from '../utils.ts';

const MINT_METHODS: MintMethod[] = ['bolt11', 'bolt12', 'onchain'];
const AUTHENTICATION_ERROR_CODE_MIN = 30_000;

/** Returns whether current mint metadata advertises NUT-29 for the requested mint method. */
export function supportsNut29MintQuoteCheck(mintInfo: unknown, method: MintMethod): boolean {
  if (!mintInfo || typeof mintInfo !== 'object') return false;
  const nuts = (mintInfo as { nuts?: unknown }).nuts;
  if (!nuts || typeof nuts !== 'object') return false;
  const settings = (nuts as Record<string, unknown>)['29'];
  if (!settings || typeof settings !== 'object') return false;
  const methods = (settings as { methods?: unknown }).methods;
  if (methods !== undefined) return Array.isArray(methods) && methods.includes(method);

  const nut4 = (nuts as Record<string, unknown>)['4'];
  const mintMethods =
    nut4 && typeof nut4 === 'object' ? (nut4 as { methods?: unknown }).methods : undefined;
  return (
    Array.isArray(mintMethods) &&
    mintMethods.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        (entry as { method?: unknown }).method === method,
    )
  );
}

/** Resolves Coco's bounded NUT-29 check limit, or null when the metadata is incompatible. */
export function getNut29MintQuoteCheckLimit(mintInfo: unknown, method: MintMethod): number | null {
  if (!supportsNut29MintQuoteCheck(mintInfo, method)) return null;
  const nuts = (mintInfo as { nuts: Record<string, unknown> }).nuts;
  const settings = nuts['29'] as { max_batch_size?: unknown };
  const advertised = settings.max_batch_size;
  if (advertised === undefined) return 100;
  if (!Number.isSafeInteger(advertised) || Number(advertised) < 1) return null;
  return Math.min(Number(advertised), 100);
}

type MintQuoteBatchRequestResult =
  | { kind: 'single'; attemptedQuoteIds: [string] }
  | {
      kind: 'batch';
      attemptedQuoteIds: string[];
      response: unknown[];
      errorsByQuoteId: Map<string, MintOperationError>;
    };

/**
 * Owns NUT-29 request policy: capability fallback, bounded retries, effective-limit
 * downshifts, atomic validation-error isolation, and incompatibility reset on mint refresh.
 */
export class MintQuoteBatchTransport {
  private readonly effectiveLimit = new Map<string, number>();
  private readonly incompatibleGroups = new Set<string>();

  constructor(
    private readonly mintAdapter: MintAdapter,
    eventBus: EventBus<CoreEvents>,
    private readonly logger?: Logger,
  ) {
    eventBus.on('mint:updated', ({ mint }) => {
      const mintUrl = normalizeMintUrl(mint.mintUrl);
      for (const method of MINT_METHODS) {
        const groupKey = mintQuoteGroupKey(mintUrl, method);
        this.incompatibleGroups.delete(groupKey);
        this.effectiveLimit.delete(groupKey);
      }
    });
  }

  /** Runs one batch transport opportunity without interpreting or persisting observations. */
  async check(
    mintUrl: string,
    method: MintMethod,
    quoteIds: string[],
    limit: number | null,
  ): Promise<MintQuoteBatchRequestResult> {
    const groupKey = mintQuoteGroupKey(mintUrl, method);
    if (limit === null || this.incompatibleGroups.has(groupKey)) {
      return { kind: 'single', attemptedQuoteIds: [quoteIds[0]!] };
    }

    let attemptedQuoteIds = quoteIds.slice(
      0,
      Math.min(limit, this.effectiveLimit.get(groupKey) ?? limit),
    );
    while (true) {
      try {
        const isolated = await this.checkWithIsolation(mintUrl, method, attemptedQuoteIds);
        return { kind: 'batch', attemptedQuoteIds, ...isolated };
      } catch (error) {
        if (
          error instanceof HttpResponseError &&
          (error.status === 404 || error.status === 405 || error.status === 501)
        ) {
          this.incompatibleGroups.add(groupKey);
          return { kind: 'single', attemptedQuoteIds: [attemptedQuoteIds[0]!] };
        }
        if (!(error instanceof MintOperationError) || error.code !== 11017) throw error;
        if (attemptedQuoteIds.length <= 1) {
          this.incompatibleGroups.add(groupKey);
          return { kind: 'single', attemptedQuoteIds: [attemptedQuoteIds[0]!] };
        }
        const loweredLimit = Math.max(1, Math.floor(attemptedQuoteIds.length / 2));
        this.effectiveLimit.set(groupKey, loweredLimit);
        attemptedQuoteIds = attemptedQuoteIds.slice(0, loweredLimit);
      }
    }
  }

  private async checkWithIsolation(
    mintUrl: string,
    method: MintMethod,
    quoteIds: string[],
  ): Promise<{
    response: unknown[];
    errorsByQuoteId: Map<string, MintOperationError>;
  }> {
    try {
      const response = await this.requestWithRetry(mintUrl, method, quoteIds);
      if (!Array.isArray(response)) {
        throw new ProofValidationError('Mint quote batch check returned a non-array response');
      }
      return { response, errorsByQuoteId: new Map() };
    } catch (error) {
      if (!this.isConfirmedValidationRejection(error)) throw error;
      if (quoteIds.length === 1) {
        this.logger?.warn('Isolated invalid mint quote during NUT-29 batch check', {
          mintUrl,
          method,
          quoteId: quoteIds[0],
          code: error.code,
        });
        return { response: [], errorsByQuoteId: new Map([[quoteIds[0]!, error]]) };
      }

      const midpoint = Math.floor(quoteIds.length / 2);
      const left = await this.checkWithIsolation(mintUrl, method, quoteIds.slice(0, midpoint));
      const right = await this.checkWithIsolation(mintUrl, method, quoteIds.slice(midpoint));
      return {
        response: [...left.response, ...right.response],
        errorsByQuoteId: new Map([...left.errorsByQuoteId, ...right.errorsByQuoteId]),
      };
    }
  }

  private async requestWithRetry(
    mintUrl: string,
    method: MintMethod,
    quoteIds: string[],
  ): Promise<unknown> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.mintAdapter.checkMintQuoteBatch(mintUrl, method, quoteIds);
      } catch (error) {
        const transient =
          error instanceof NetworkError ||
          (error instanceof HttpResponseError && (error.status === 429 || error.status >= 500));
        if (!transient || attempt === maxAttempts) throw error;
        const delayMs = 10 * 2 ** (attempt - 1);
        this.logger?.warn('Transient NUT-29 quote check failed; retrying', {
          mintUrl,
          method,
          quoteCount: quoteIds.length,
          attempt,
          delayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw new Error('Unreachable NUT-29 quote check retry state');
  }

  private isConfirmedValidationRejection(error: unknown): error is MintOperationError {
    return (
      error instanceof MintOperationError &&
      error.code !== 11017 &&
      error.code < AUTHENTICATION_ERROR_CODE_MIN
    );
  }
}
