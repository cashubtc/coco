import type { Amount, MeltQuoteBolt11Response, OutputDataLike, Proof } from '@cashu/cashu-ts';
import type {
  BasePrepareContext,
  CreateMeltQuoteContext,
  ExecuteContext,
  FetchRemoteMeltQuoteContext,
  FinalizeContext,
  FinalizeResult,
  PendingContext,
  RecoverExecutingContext,
} from '@core/operations/melt';
import {
  BaseQuoteMeltHandler,
  type BoltMeltQuoteState,
  type QuoteMeltResponse,
} from './BaseQuoteMeltHandler.ts';

export class MeltBolt11Handler extends BaseQuoteMeltHandler<'bolt11'> {
  protected readonly method = 'bolt11' as const;

  protected createRemoteQuote(
    ctx: CreateMeltQuoteContext<'bolt11'>,
  ): Promise<MeltQuoteBolt11Response> {
    const amountMsat =
      ctx.methodData.amountSats === undefined
        ? undefined
        : ctx.methodData.amountSats.multiplyBy(1000);
    return ctx.wallet.createMeltQuoteBolt11(ctx.methodData.invoice, amountMsat);
  }

  protected fetchRemoteMeltQuote(
    ctx: FetchRemoteMeltQuoteContext<'bolt11'>,
  ): Promise<MeltQuoteBolt11Response> {
    return ctx.mintAdapter.checkMeltQuote(ctx.quote.mintUrl, ctx.quote.quoteId);
  }

  protected executeMelt(
    ctx: ExecuteContext<'bolt11'>,
    proofsToMelt: Proof[],
    changeOutputs: OutputDataLike[],
    quoteId: string,
  ): Promise<QuoteMeltResponse<'bolt11'>> {
    return ctx.mintAdapter.customMeltBolt11(
      ctx.operation.mintUrl,
      proofsToMelt,
      changeOutputs,
      quoteId,
    );
  }

  protected checkMeltQuote(
    ctx: FinalizeContext<'bolt11'> | RecoverExecutingContext<'bolt11'>,
  ): Promise<QuoteMeltResponse<'bolt11'>> {
    return ctx.mintAdapter.checkMeltQuote(ctx.operation.mintUrl, ctx.operation.quoteId);
  }

  protected checkMeltQuoteState(
    ctx: PendingContext<'bolt11'> | RecoverExecutingContext<'bolt11'>,
  ): Promise<BoltMeltQuoteState> {
    return ctx.mintAdapter.checkMeltQuoteState(ctx.operation.mintUrl, ctx.operation.quoteId);
  }

  protected getFeeReserveForQuote(
    quote: MeltQuoteBolt11Response,
    _operation: BasePrepareContext<'bolt11'>['operation'],
  ): Amount {
    return quote.fee_reserve;
  }

  protected buildFinalizedData(
    response: QuoteMeltResponse<'bolt11'>,
  ): FinalizeResult<'bolt11'>['finalizedData'] {
    return response.payment_preimage == null ? undefined : { preimage: response.payment_preimage };
  }
}
