import type { MeltQuoteBolt12Response, OutputDataLike, Proof } from '@cashu/cashu-ts';
import type {
  CreateMeltQuoteContext,
  ExecuteMeltContext,
  FetchRemoteMeltQuoteContext,
  MeltMethodFinalizedData,
} from '@core/operations/melt';
import { BaseQuoteMeltHandler, type QuoteMeltResponse } from './BaseQuoteMeltHandler.ts';

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
    ctx: ExecuteMeltContext<'bolt12'>,
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

  protected buildFinalizedData(
    response: QuoteMeltResponse<'bolt12'>,
  ): MeltMethodFinalizedData<'bolt12'> | undefined {
    return response.payment_preimage == null ? undefined : { preimage: response.payment_preimage };
  }
}
