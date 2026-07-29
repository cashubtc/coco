import { Amount, type MintQuoteBolt11Response } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { assertSameUnit } from '@core/amounts';
import type {
  CreateMintQuoteContext,
  ExecuteContext,
  MintMethodMeta,
  PrepareContext,
  MintMethodHandler,
  MintExecutionResult,
  PendingMintOperation,
  RecoverExecutingResult,
  RecoverExecutingContext,
  PendingContext,
  PendingMintCheckResult,
  FetchRemoteMintQuoteContext,
} from '@core/operations/mint';
import { deserializeOutputData, mapProofToCoreProof, serializeOutputData } from '@core/utils';
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
    // TODO: Reserve mint-quote derivation indexes atomically in the upstream key service;
    // concurrent quote creation can otherwise reuse the same derived key.
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

  async prepare(
    ctx: PrepareContext<'bolt11'>,
  ): Promise<PendingMintOperation<'bolt11'> & MintMethodMeta<'bolt11'>> {
    const quote = ctx.importedQuote;
    if (!quote) {
      throw new Error(`Mint quote ${ctx.operation.quoteId ?? '(missing)'} was not provided`);
    }

    if (!quote.amount || quote.amount.isZero()) {
      throw new MintQuoteValidationError(`Mint quote ${quote.quote} has invalid amount`);
    }

    if (ctx.operation.quoteId !== quote.quote) {
      throw new MintQuoteValidationError(
        `Mint quote ${quote.quote} does not match operation quote ${ctx.operation.quoteId}`,
      );
    }

    if (!quote.amount.equals(ctx.operation.amount)) {
      throw new MintQuoteValidationError(
        `Mint quote ${quote.quote} amount ${quote.amount} does not match requested amount ${ctx.operation.amount}`,
      );
    }

    assertSameUnit(quote.unit, ctx.operation.unit, `Mint quote ${quote.quote}`);
    await this.requireQuoteKey(quote.pubkey);

    const outputData = await ctx.proofService.createOutputsAndIncrementCounters(
      ctx.operation.mintUrl,
      {
        keep: { amount: quote.amount, unit: ctx.operation.unit },
        send: { amount: Amount.zero(), unit: ctx.operation.unit },
      },
      {},
    );

    if (outputData.keep.length === 0) {
      throw new Error('Failed to create deterministic outputs for mint operation');
    }

    return {
      ...ctx.operation,
      quoteId: quote.quote,
      amount: quote.amount,
      unit: ctx.operation.unit,
      request: quote.request,
      expiry: quote.expiry,
      pubkey: quote.pubkey,
      outputData: serializeOutputData({ keep: outputData.keep, send: [] }),
      state: 'pending',
    };
  }

  async execute(ctx: ExecuteContext<'bolt11'>): Promise<MintExecutionResult> {
    const outputData = deserializeOutputData(ctx.operation.outputData);
    const signingOptions = await this.getMintQuoteSigningOptions(ctx.operation.pubkey);

    try {
      const proofs = await ctx.wallet.mintProofsBolt11(
        ctx.operation.amount,
        ctx.operation.quoteId,
        signingOptions,
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
        status: 'PENDING',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (
      (ctx.operation.pubkey !== undefined || remoteQuote.pubkey !== undefined) &&
      remoteQuote.pubkey !== ctx.operation.pubkey
    ) {
      return {
        status: 'PENDING',
        error: 'Recovered BOLT11 mint operation has mismatched NUT-20 quote ownership',
      };
    }

    const quote = mintQuoteObservationFromBolt11Response(mintUrl, remoteQuote);
    const assessment = assessMintQuoteClaimability(quote, {
      ...ctx.localClaimabilityFacts,
      requestedAmount: ctx.operation.amount,
    });

    if (assessment.status === 'invalid') {
      return {
        status: 'TERMINAL',
        error: `Recovered: quote ${quoteId} has invalid claimability accounting`,
      };
    }

    if (assessment.status === 'waiting') {
      return {
        status: 'PENDING',
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
          signingOptions,
          {
            type: 'custom',
            data: outputData.keep,
          },
        );

        await ctx.proofService.saveProofs(
          ctx.operation.mintUrl,
          mapProofToCoreProof(ctx.operation.mintUrl, 'ready', proofs, {
            unit: ctx.operation.unit,
            createdByOperationId: ctx.operation.id,
          }),
        );

        return { status: 'FINALIZED' };
      } catch (err) {
        if (err instanceof MintOperationError) {
          if (err.code === 20002) {
            // Quote already issued; fall through to proof recovery
          } else {
            return {
              status: 'PENDING',
              error: err.message,
            };
          }
        } else {
          return {
            status: 'PENDING',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    try {
      const recovered = await ctx.proofService.recoverProofsFromOutputData(
        ctx.operation.mintUrl,
        ctx.operation.outputData,
        {
          unit: ctx.operation.unit,
          createdByOperationId: ctx.operation.id,
        },
      );
      if (recovered.length === 0) {
        return {
          status: 'PENDING',
          error: `Recovered: quote ${quoteId} issued remotely but proofs were not recoverable`,
        };
      }
      return { status: 'FINALIZED' };
    } catch (error) {
      return {
        status: 'PENDING',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkPending(ctx: PendingContext<'bolt11'>): Promise<PendingMintCheckResult<'bolt11'>> {
    const { mintUrl, quoteId } = ctx.operation;
    ctx.logger?.info('Checking pending mint operation', { mintUrl, quoteId });

    const quote = await ctx.mintAdapter.checkMintQuote(mintUrl, 'bolt11', quoteId);
    this.assertPendingQuoteMatchesOperation(quote, ctx.operation);
    const observedRemoteStateAt = Date.now();
    const canonicalQuote = mintQuoteObservationFromBolt11Response(mintUrl, quote, {
      now: observedRemoteStateAt,
    });
    const assessment = assessMintQuoteClaimability(canonicalQuote, {
      requestedAmount: ctx.operation.amount,
    });
    ctx.logger?.info('Pending mint quote claimability assessed', {
      mintUrl,
      status: assessment.status,
    });

    if (assessment.status === 'invalid') {
      return {
        observedRemoteStateAt,
        quoteSnapshot: quote,
        category: 'terminal',
        terminalFailure: {
          reason: `BOLT11 mint quote ${quoteId} has invalid claimability accounting`,
          code: 'invalid_quote',
          retryable: false,
          observedAt: observedRemoteStateAt,
        },
      };
    }

    return {
      observedRemoteStateAt,
      quoteSnapshot: quote,
      category:
        assessment.status === 'claimable'
          ? 'ready'
          : assessment.status === 'complete'
            ? 'completed'
            : 'waiting',
    };
  }

  async validateQuoteForPrepare(quote: MintQuote<'bolt11'>): Promise<void> {
    await this.requireQuoteKey(quote.pubkey);
  }

  private assertPendingQuoteMatchesOperation(
    quote: MintQuoteBolt11Response,
    operation: PendingMintOperation<'bolt11'>,
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
