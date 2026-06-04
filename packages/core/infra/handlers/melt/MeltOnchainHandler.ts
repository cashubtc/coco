import type { Amount, MeltQuoteOnchainResponse, OutputData, Proof } from '@cashu/cashu-ts';
import type {
  CreateMeltQuoteContext,
  BasePrepareContext,
  ExecuteContext,
  FetchRemoteMeltQuoteContext,
  FinalizeContext,
  FinalizeResult,
  PendingContext,
  RecoverExecutingContext,
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
    ctx: ExecuteContext<'onchain'>,
    proofsToMelt: Proof[],
    changeOutputs: OutputData[],
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

  protected checkMeltQuote(
    ctx: FinalizeContext<'onchain'> | RecoverExecutingContext<'onchain'>,
  ): Promise<QuoteMeltResponse<'onchain'>> {
    return ctx.mintAdapter.checkMeltQuoteOnchain(ctx.operation.mintUrl, ctx.operation.quoteId);
  }

  protected checkMeltQuoteState(
    ctx: PendingContext<'onchain'> | RecoverExecutingContext<'onchain'>,
  ): Promise<MeltQuoteOnchainResponse['state']> {
    return ctx.mintAdapter.checkMeltQuoteOnchainState(ctx.operation.mintUrl, ctx.operation.quoteId);
  }

  protected getFeeReserveForQuote(
    quote: MeltQuoteOnchainResponse,
    operation: BasePrepareContext<'onchain'>['operation'],
  ): Amount {
    const feeIndex = operation.methodData.feeIndex;
    if (feeIndex === undefined) {
      throw new Error(`Onchain melt operation ${operation.id} does not include feeIndex`);
    }

    const feeOption = quote.fee_options.find((option) => option.fee_index === feeIndex);
    if (!feeOption) {
      throw new Error(`Onchain melt quote ${quote.quote} does not include fee option ${feeIndex}`);
    }

    return feeOption.fee_reserve;
  }

  protected buildFinalizedData(
    response: QuoteMeltResponse<'onchain'>,
  ): FinalizeResult<'onchain'>['finalizedData'] {
    return response.outpoint == null ? undefined : { outpoint: response.outpoint };
  }
}
