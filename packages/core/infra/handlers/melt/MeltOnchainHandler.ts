import type { MeltQuoteOnchainResponse, OutputDataLike, Proof } from '@cashu/cashu-ts';
import type {
  CreateMeltQuoteContext,
  ExecuteMeltContext,
  FetchRemoteMeltQuoteContext,
  MeltMethodFinalizedData,
} from '@core/operations/melt';
import { BaseQuoteMeltHandler, type QuoteMeltResponse } from './BaseQuoteMeltHandler.ts';

export class MeltOnchainHandler extends BaseQuoteMeltHandler<'onchain'> {
  protected readonly method = 'onchain' as const;

  protected createRemoteQuote(
    ctx: CreateMeltQuoteContext<'onchain'>,
  ): Promise<MeltQuoteOnchainResponse> {
    return ctx.wallet.createMeltQuoteOnchain(ctx.methodData.address, ctx.methodData.amountSats);
  }

  protected fetchRemoteMeltQuote(
    ctx: FetchRemoteMeltQuoteContext<'onchain'>,
  ): Promise<MeltQuoteOnchainResponse> {
    return ctx.mintAdapter.checkMeltQuoteOnchain(ctx.quote.mintUrl, ctx.quote.quoteId);
  }

  protected executeMelt(
    ctx: ExecuteMeltContext<'onchain'>,
    proofsToMelt: Proof[],
    changeOutputs: OutputDataLike[],
    quoteId: string,
  ): Promise<QuoteMeltResponse<'onchain'>> {
    const feeIndex = ctx.operation.methodData.feeIndex;
    if (feeIndex === undefined) {
      throw new Error(
        `Cannot execute onchain melt operation ${ctx.operation.id}: feeIndex missing`,
      );
    }

    return ctx.mintAdapter.customMeltOnchain(
      ctx.operation.mintUrl,
      proofsToMelt,
      changeOutputs,
      quoteId,
      feeIndex,
    );
  }

  protected buildFinalizedData(
    response: QuoteMeltResponse<'onchain'>,
  ): MeltMethodFinalizedData<'onchain'> | undefined {
    return response.outpoint == null ? undefined : { outpoint: response.outpoint };
  }
}
