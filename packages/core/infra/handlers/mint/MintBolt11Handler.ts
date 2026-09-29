import { Amount, type MintQuoteBolt11Response } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { assertSameUnit } from '@core/amounts';
import type {
  CreateMintQuoteContext,
  ExecuteContext,
  MintMethodHandler,
  MintExecutionResult,
  PendingMintOperation,
  RecoverExecutingResult,
  RecoverExecutingContext,
  PendingContext,
  PendingMintObservationResult,
  FetchRemoteMintQuoteContext,
} from '@core/operations/mint';
import { deserializeOutputData } from '@core/utils';
import {
  MintOperationError,
  MintQuoteKeyError,
  MintQuoteValidationError,
} from '../../../models/Error';
import type { KeyRingService } from '../../../services/KeyRingService';
import { mintQuoteFromBolt11Response, type MintQuote } from '../../../models/MintQuote';
import { mintQuoteObservationFromBolt11Response } from '../../../models/MintQuoteObservationFactory';
import { assessMintQuoteClaimability } from '../../../models/MintQuoteClaimability.ts';

export class MintBolt11Handler implements MintMethodHandler<'bolt11'> {
  constructor(private readonly keyRingService: KeyRingService) {}

  async createQuote(ctx: CreateMintQuoteContext<'bolt11'>): Promise<MintQuote<'bolt11'>> {
    const { amount, locked, ownedPubkey } = ctx.createQuoteData;
    const shouldLock = locked === true || ownedPubkey !== undefined;
    if (shouldLock) {
      await ctx.mintService.assertNutSupported(ctx.mintUrl, 20, 'locked BOLT11 mint quote');
    }
    const lockPubkey =
      shouldLock && !ownedPubkey
        ? (await this.keyRingService.generateMintQuoteKeyPair()).publicKeyHex
        : ownedPubkey;
    if (lockPubkey && ownedPubkey) {
      // TODO: Support third-party quote locks as a distinct flow. Coco currently expects to
      // redeem every created quote, so an explicitly supplied key must be locally owned.
      await this.requireQuoteKey(lockPubkey);
    }
    const remoteQuote = lockPubkey
      ? await ctx.wallet.createLockedMintQuote(amount.amount, lockPubkey)
      : await ctx.wallet.createMintQuoteBolt11(amount.amount);
    if (lockPubkey && remoteQuote.pubkey !== lockPubkey) {
      throw new MintQuoteValidationError(
        'Mint returned a BOLT11 quote with an unexpected NUT-20 public key',
      );
    }
    return mintQuoteFromBolt11Response(ctx.mintUrl, remoteQuote);
  }

  async fetchRemoteQuote(ctx: FetchRemoteMintQuoteContext<'bolt11'>): Promise<MintQuote<'bolt11'>> {
    const remoteQuote = await ctx.mintAdapter.checkMintQuote(
      ctx.quote.mintUrl,
      'bolt11',
      ctx.quote.quoteId,
    );
    return mintQuoteObservationFromBolt11Response(ctx.quote.mintUrl, remoteQuote);
  }

  async execute(ctx: ExecuteContext<'bolt11'>): Promise<MintExecutionResult> {
    const outputData = deserializeOutputData(ctx.operation.outputData);
    const signingOptions = await this.getMintQuoteSigningOptions(ctx.operation.pubkey);

    try {
      const proofs = await ctx.wallet.mintProofsBolt11(
        ctx.operation.amount,
        ctx.operation.quoteId,
        { ...signingOptions, keysetId: outputData.keep[0]!.blindedMessage.id },
        {
          type: 'custom',
          data: outputData.keep,
        },
      );

      return { status: 'ISSUED', proofs };
    } catch (err) {
      if (err instanceof MintOperationError && err.code === 20002) {
        return { status: 'ALREADY_ISSUED' };
      }
      if (ctx.operation.pubkey) {
        if (err instanceof MintOperationError) {
          throw err;
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        const message = `Locked BOLT11 mint failed: ${errorMessage}`;
        throw new Error(message, { cause: err });
      }
      throw err;
    }
  }

  async recoverExecuting(ctx: RecoverExecutingContext<'bolt11'>): Promise<RecoverExecutingResult> {
    const { mintUrl, quoteId } = ctx.operation;
    let remoteQuote: MintQuoteBolt11Response;
    try {
      remoteQuote = await ctx.mintAdapter.checkMintQuote(mintUrl, 'bolt11', quoteId);
    } catch (error) {
      ctx.logger?.warn('Failed to check mint quote state during recovery', {
        mintUrl,
        quoteId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'UNRESOLVED',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (
      (ctx.operation.pubkey !== undefined || remoteQuote.pubkey !== undefined) &&
      remoteQuote.pubkey !== ctx.operation.pubkey
    ) {
      return {
        status: 'UNRESOLVED',
        error: 'Recovered BOLT11 mint operation has mismatched NUT-20 quote ownership',
      };
    }

    try {
      this.assertQuoteMatchesOperation(remoteQuote, ctx.operation);
    } catch (error) {
      return {
        status: 'UNRESOLVED',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const quote = mintQuoteObservationFromBolt11Response(mintUrl, remoteQuote);
    await ctx.recordQuoteSnapshot(remoteQuote);

    const assessment = assessMintQuoteClaimability(quote, {
      ...ctx.localClaimabilityFacts,
      requestedAmount: ctx.operation.amount,
    });

    if (assessment.status === 'invalid') {
      return {
        status: 'UNRESOLVED',
        error: `Recovered: quote ${quoteId} has invalid claimability accounting`,
      };
    }

    if (assessment.status === 'waiting') {
      return {
        status: 'UNRESOLVED',
        error: `Recovered: quote ${quoteId} is not yet claimable`,
      };
    }

    if (assessment.status === 'claimable') {
      const outputData = deserializeOutputData(ctx.operation.outputData);
      try {
        const signingOptions = await this.getMintQuoteSigningOptions(ctx.operation.pubkey);
        const proofs = await ctx.wallet.mintProofsBolt11(
          ctx.operation.amount,
          ctx.operation.quoteId,
          { ...signingOptions, keysetId: outputData.keep[0]!.blindedMessage.id },
          {
            type: 'custom',
            data: outputData.keep,
          },
        );

        return { status: 'ISSUED', proofs };
      } catch (err) {
        if (err instanceof MintOperationError) {
          if (err.code === 20002) {
            // Quote already issued; fall through to proof recovery
          } else if (err.code === 20007) {
            return {
              status: 'REJECTED',
              error: `Recovered: quote ${quoteId} expired while executing mint`,
            };
          } else {
            return {
              status: 'UNRESOLVED',
              error: err.message,
            };
          }
        } else {
          return {
            status: 'UNRESOLVED',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    try {
      const recovered = await ctx.restoreOutputs();
      if (recovered.length === 0) {
        return {
          status: 'UNRESOLVED',
          error: `Recovered: quote ${quoteId} issued remotely but proofs were not recoverable`,
        };
      }
      return { status: 'ISSUED', proofs: recovered };
    } catch (error) {
      return {
        status: 'UNRESOLVED',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkPending(
    ctx: PendingContext<'bolt11'>,
  ): Promise<PendingMintObservationResult<'bolt11'>> {
    const { mintUrl, quoteId } = ctx.operation;
    ctx.logger?.info('Checking pending mint operation', { mintUrl, quoteId });

    const quote = await ctx.mintAdapter.checkMintQuote(mintUrl, 'bolt11', quoteId);
    const observedAt = Date.now();
    try {
      this.assertQuoteMatchesOperation(quote, ctx.operation);
    } catch (error) {
      return {
        observedAt,
        validationFailure: {
          reason: error instanceof Error ? error.message : String(error),
          code: 'invalid_quote',
          retryable: false,
          observedAt,
        },
      };
    }

    return {
      observedAt,
      quoteSnapshot: quote,
    };
  }

  async validateQuoteForPrepare(quote: MintQuote<'bolt11'>): Promise<void> {
    await this.requireQuoteKey(quote.pubkey);
  }

  private assertQuoteMatchesOperation(
    quote: MintQuoteBolt11Response,
    operation: Pick<
      PendingMintOperation<'bolt11'>,
      'quoteId' | 'request' | 'unit' | 'amount' | 'pubkey'
    >,
  ): void {
    if (quote.quote !== operation.quoteId || quote.request !== operation.request) {
      throw new MintQuoteValidationError(
        `Polled BOLT11 mint quote ${quote.quote} conflicts with pending operation identity`,
      );
    }
    assertSameUnit(quote.unit, operation.unit, `Polled BOLT11 mint quote ${quote.quote}`);
    if (!Amount.from(quote.amount).equals(operation.amount)) {
      throw new MintQuoteValidationError(
        `Polled BOLT11 mint quote ${quote.quote} conflicts with pending operation amount`,
      );
    }
    if ((quote.pubkey ?? undefined) !== (operation.pubkey ?? undefined)) {
      throw new MintQuoteValidationError(
        `Polled BOLT11 mint quote ${quote.quote} conflicts with pending operation ownership`,
      );
    }
  }

  private async requireQuoteKey(pubkey: string | undefined): Promise<void> {
    if (!pubkey) return;
    const key = await this.keyRingService.getMintQuoteKeyPair(pubkey);
    if (!key) {
      throw new MintQuoteKeyError('Missing NUT-20 mint quote key for locked BOLT11 quote');
    }
  }

  private async getMintQuoteSigningOptions(
    pubkey: string | undefined,
  ): Promise<{ privkey: string } | undefined> {
    if (!pubkey) return undefined;
    const key = await this.keyRingService.getMintQuoteKeyPair(pubkey);
    if (!key) {
      throw new MintQuoteKeyError('Missing NUT-20 mint quote key for locked BOLT11 quote');
    }
    return { privkey: bytesToHex(key.secretKey) };
  }
}
