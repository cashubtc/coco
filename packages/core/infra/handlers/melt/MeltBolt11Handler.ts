import type { MeltQuoteBolt11Response, OutputDataLike, Proof } from '@cashu/cashu-ts';
import type {
  CreateMeltQuoteContext,
  ExecuteMeltContext,
  FetchRemoteMeltQuoteContext,
  MeltMethodFinalizedData,
} from '@core/operations/melt';
import { BaseQuoteMeltHandler, type QuoteMeltResponse } from './BaseQuoteMeltHandler.ts';

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
    ctx: ExecuteMeltContext<'bolt11'>,
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

  protected buildFinalizedData(
    response: QuoteMeltResponse<'bolt11'>,
  ): MeltMethodFinalizedData<'bolt11'> | undefined {
    return response.payment_preimage == null ? undefined : { preimage: response.payment_preimage };
  }
}
