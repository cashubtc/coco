import type { Amount, MeltQuoteBolt12Response, OutputDataLike, Proof } from '@cashu/cashu-ts';
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

export class MeltBolt12Handler extends BaseQuoteMeltHandler<'bolt12'> {
  protected readonly method = 'bolt12' as const;

  protected createRemoteQuote(
    ctx: CreateMeltQuoteContext<'bolt12'>,
  ): Promise<MeltQuoteBolt12Response> {
    const amountMsat =
      ctx.methodData.amountSats === undefined
        ? undefined
        : ctx.methodData.amountSats.multiplyBy(1000);
    return ctx.wallet.createMeltQuoteBolt12(ctx.methodData.offer, amountMsat);
  }

  protected fetchRemoteMeltQuote(
    ctx: FetchRemoteMeltQuoteContext<'bolt12'>,
  ): Promise<MeltQuoteBolt12Response> {
    return ctx.mintAdapter.checkMeltQuoteBolt12(ctx.quote.mintUrl, ctx.quote.quoteId);
  }

  protected executeMelt(
    ctx: ExecuteContext<'bolt12'>,
    proofsToMelt: Proof[],
    changeOutputs: OutputDataLike[],
    quoteId: string,
  ): Promise<QuoteMeltResponse<'bolt12'>> {
    return ctx.mintAdapter.customMeltBolt12(
      ctx.operation.mintUrl,
      proofsToMelt,
      changeOutputs,
      quoteId,
    );
  }

  protected checkMeltQuote(
    ctx: FinalizeContext<'bolt12'> | RecoverExecutingContext<'bolt12'>,
  ): Promise<QuoteMeltResponse<'bolt12'>> {
    return ctx.mintAdapter.checkMeltQuoteBolt12(ctx.operation.mintUrl, ctx.operation.quoteId);
  }

  protected checkMeltQuoteState(
    ctx: PendingContext<'bolt12'> | RecoverExecutingContext<'bolt12'>,
  ): Promise<BoltMeltQuoteState> {
    return ctx.mintAdapter.checkMeltQuoteBolt12State(ctx.operation.mintUrl, ctx.operation.quoteId);
  }

  protected getFeeReserveForQuote(
    quote: MeltQuoteBolt12Response,
    _operation: BasePrepareContext<'bolt12'>['operation'],
  ): Amount {
    return quote.fee_reserve;
  }

  protected buildFinalizedData(
    response: QuoteMeltResponse<'bolt12'>,
  ): FinalizeResult<'bolt12'>['finalizedData'] {
    return response.payment_preimage == null ? undefined : { preimage: response.payment_preimage };
  }
}
