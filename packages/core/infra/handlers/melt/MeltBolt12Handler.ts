import type { OutputData, Proof } from '@cashu/cashu-ts';
import type {
  ExecuteContext,
  FinalizeContext,
  PendingContext,
  RecoverExecutingContext,
} from '@core/operations/melt';
import {
  BaseBoltMeltHandler,
  type BoltMeltQuoteResponse,
  type BoltMeltQuoteState,
} from './BaseBoltMeltHandler.ts';

export class MeltBolt12Handler extends BaseBoltMeltHandler<'bolt12'> {
  protected readonly method = 'bolt12' as const;

  protected executeMelt(
    ctx: ExecuteContext<'bolt12'>,
    proofsToMelt: Proof[],
    changeOutputs: OutputData[],
    quoteId: string,
  ): Promise<BoltMeltQuoteResponse> {
    return ctx.mintAdapter.customMeltBolt12(
      ctx.operation.mintUrl,
      proofsToMelt,
      changeOutputs,
      quoteId,
    );
  }

  protected checkMeltQuote(
    ctx: FinalizeContext<'bolt12'> | RecoverExecutingContext<'bolt12'>,
  ): Promise<BoltMeltQuoteResponse> {
    return ctx.mintAdapter.checkMeltQuoteBolt12(ctx.operation.mintUrl, ctx.operation.quoteId);
  }

  protected checkMeltQuoteState(
    ctx: PendingContext<'bolt12'> | RecoverExecutingContext<'bolt12'>,
  ): Promise<BoltMeltQuoteState> {
    return ctx.mintAdapter.checkMeltQuoteBolt12State(ctx.operation.mintUrl, ctx.operation.quoteId);
  }
}
