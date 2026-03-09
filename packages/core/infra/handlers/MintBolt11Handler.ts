import type {
  ExecuteContext,
  MintMethodMeta,
  PrepareContext,
  MintMethodHandler,
  MintExecutionResult,
  PreparedMintOperation,
  RecoverExecutingResult,
  RecoverExecutingContext,
} from '@core/operations/mint';
import { MintOperationError } from '../../models/Error';
import { deserializeOutputData, mapProofToCoreProof, serializeOutputData } from '@core/utils';

interface MintQuoteLike {
  quote: string;
  amount?: number;
  state: string;
}

function isMintQuoteLike(value: unknown): value is MintQuoteLike {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybe = value as Partial<MintQuoteLike>;
  return typeof maybe.quote === 'string' && typeof maybe.state === 'string';
}

export class MintBolt11Handler implements MintMethodHandler<'bolt11'> {
  async prepare(
    ctx: PrepareContext<'bolt11'>,
  ): Promise<PreparedMintOperation & MintMethodMeta<'bolt11'>> {
    const quote = await ctx.mintQuoteRepository.getMintQuote(
      ctx.operation.mintUrl,
      ctx.operation.quoteId,
    );

    if (!quote) {
      throw new Error(`Mint quote ${ctx.operation.quoteId} not found`);
    }

    if (!quote.amount || quote.amount <= 0) {
      throw new Error(`Mint quote ${ctx.operation.quoteId} has invalid amount`);
    }

    const outputData = await ctx.proofService.createOutputsAndIncrementCounters(
      ctx.operation.mintUrl,
      {
        keep: quote.amount,
        send: 0,
      },
    );

    if (outputData.keep.length === 0) {
      throw new Error('Failed to create deterministic outputs for mint operation');
    }

    return {
      ...ctx.operation,
      amount: quote.amount,
      outputData: serializeOutputData({ keep: outputData.keep, send: [] }),
      state: 'prepared',
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
    let remoteQuote: unknown;
    try {
      remoteQuote = await ctx.mintAdapter.checkMintQuoteState(
        ctx.operation.mintUrl,
        ctx.operation.quoteId,
      );
    } catch {
      return { status: 'STAY_EXECUTING' };
    }

    if (!isMintQuoteLike(remoteQuote)) {
      return { status: 'STAY_EXECUTING' };
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
            createdByOperationId: ctx.operation.id,
          }),
        );

        return { status: 'FINALIZED' };
      } catch (err) {
        if (!(err instanceof MintOperationError && err.code === 20002)) {
          return { status: 'STAY_EXECUTING' };
        }
      }
    } else if (remoteQuote.state !== 'ISSUED') {
      return {
        status: 'ROLLED_BACK',
        error: `Recovered: quote ${ctx.operation.quoteId} not issued remotely (${remoteQuote.state})`,
      };
    }

    try {
      const recovered = await ctx.proofService.recoverProofsFromOutputData(
        ctx.operation.mintUrl,
        ctx.operation.outputData,
        {
          createdByOperationId: ctx.operation.id,
        },
      );
      if (recovered.length === 0) {
        return {
          status: 'ROLLED_BACK',
          error: `Recovered: quote ${ctx.operation.quoteId} issued remotely but proofs were not recoverable`,
        };
      }
      return { status: 'FINALIZED' };
    } catch {
      return { status: 'STAY_EXECUTING' };
    }
  }
}
