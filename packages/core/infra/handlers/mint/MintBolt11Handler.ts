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
import { MintOperationError } from '../../../models/Error';
import { assertSameUnit } from '@core/amounts';
import { deserializeOutputData, mapProofToCoreProof, serializeOutputData } from '@core/utils';
import { Amount, type MintQuoteBolt11Response } from '@cashu/cashu-ts';
import { mintQuoteFromBolt11Response, type MintQuote } from '../../../models/MintQuote';

export class MintBolt11Handler implements MintMethodHandler<'bolt11'> {
  async createQuote(ctx: CreateMintQuoteContext<'bolt11'>): Promise<MintQuote<'bolt11'>> {
    const remoteQuote = await ctx.wallet.createMintQuoteBolt11(ctx.createQuoteData.amount.amount);
    return mintQuoteFromBolt11Response(ctx.mintUrl, remoteQuote);
  }

  async fetchRemoteQuote(ctx: FetchRemoteMintQuoteContext<'bolt11'>): Promise<MintQuote<'bolt11'>> {
    const remoteQuote = await ctx.mintAdapter.checkMintQuoteState(
      ctx.quote.mintUrl,
      ctx.quote.quoteId,
    );
    return mintQuoteFromBolt11Response(ctx.quote.mintUrl, remoteQuote);
  }

  async prepare(
    ctx: PrepareContext<'bolt11'>,
  ): Promise<PendingMintOperation<'bolt11'> & MintMethodMeta<'bolt11'>> {
    const quote = ctx.importedQuote;
    if (!quote) {
      throw new Error(`Mint quote ${ctx.operation.quoteId ?? '(missing)'} was not provided`);
    }

    if (!quote.amount || quote.amount.isZero()) {
      throw new Error(`Mint quote ${quote.quote} has invalid amount`);
    }

    if (ctx.operation.quoteId && ctx.operation.quoteId !== quote.quote) {
      throw new Error(
        `Mint quote ${quote.quote} does not match operation quote ${ctx.operation.quoteId}`,
      );
    }

    if (!quote.amount.equals(ctx.operation.amount)) {
      throw new Error(
        `Mint quote ${quote.quote} amount ${quote.amount} does not match requested amount ${ctx.operation.amount}`,
      );
    }

    assertSameUnit(quote.unit, ctx.operation.unit, `Mint quote ${quote.quote}`);

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
      lastObservedRemoteState: quote.state,
      lastObservedRemoteStateAt: Date.now(),
      outputData: serializeOutputData({ keep: outputData.keep, send: [] }),
      state: 'pending',
    };
  }

  async execute(ctx: ExecuteContext<'bolt11'>): Promise<MintExecutionResult> {
    const outputData = deserializeOutputData(ctx.operation.outputData);

    try {
      const proofs = await ctx.wallet.mintProofsBolt11(
        ctx.operation.amount,
        ctx.operation.quoteId,
        undefined,
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
      throw err;
    }
  }

  async recoverExecuting(ctx: RecoverExecutingContext<'bolt11'>): Promise<RecoverExecutingResult> {
    const { mintUrl, quoteId } = ctx.operation;
    let remoteQuote: MintQuoteBolt11Response;
    try {
      remoteQuote = await ctx.mintAdapter.checkMintQuoteState(mintUrl, quoteId);
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

    if (remoteQuote.state === 'PAID') {
      const outputData = deserializeOutputData(ctx.operation.outputData);
      try {
        const proofs = await ctx.wallet.mintProofsBolt11(
          ctx.operation.amount,
          ctx.operation.quoteId,
          undefined,
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
          } else if (err.code === 20007) {
            return {
              status: 'TERMINAL',
              error: `Recovered: quote ${quoteId} expired while executing mint`,
            };
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
    } else if (remoteQuote.state === 'UNPAID') {
      return {
        status: 'PENDING',
        error: `Recovered: quote ${quoteId} is still UNPAID`,
      };
    } else if (remoteQuote.state !== 'ISSUED') {
      return {
        status: 'PENDING',
        error: `Recovered: quote ${quoteId} remains in remote state ${remoteQuote.state}`,
      };
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

    const quote = await ctx.mintAdapter.checkMintQuoteState(mintUrl, quoteId);
    ctx.logger?.info('Pending mint quote state', { mintUrl, quoteId, state: quote.state });
    const observedRemoteStateAt = Date.now();

    switch (quote.state) {
      case 'UNPAID':
        return {
          observedRemoteState: quote.state,
          observedRemoteStateAt,
          category: 'waiting',
        };
      case 'PAID':
        return {
          observedRemoteState: quote.state,
          observedRemoteStateAt,
          category: 'ready',
        };
      case 'ISSUED':
        return {
          observedRemoteState: quote.state,
          observedRemoteStateAt,
          category: 'completed',
        };
      default:
        throw new Error(
          `Unexpected mint quote state: ${quote.state} for quote ${quoteId} at mint ${mintUrl}`,
        );
    }
  }
}
