import { Amount } from '@cashu/cashu-ts';
import type {
  MeltQuoteBolt11Response,
  MeltQuoteBolt12Response,
  OutputConfig,
  OutputDataLike,
  Proof,
  SerializedBlindedSignature,
} from '@cashu/cashu-ts';
import type {
  CreateMeltQuoteContext,
  ExecuteMeltContext,
  FetchRemoteMeltQuoteContext,
  MeltMethod,
  MeltMethodFinalizedData,
  MeltMethodHandler,
  MeltMethodQuoteSnapshot,
  MeltMethodRemoteState,
  MeltRemoteResult,
  SwapMeltContext,
} from '@core/operations/melt';
import { deserializeOutputData } from '@core/utils';
import {
  meltQuoteFromBolt11Response,
  meltQuoteFromBolt12Response,
  meltQuoteFromOnchainResponse,
  type MeltQuote,
} from '../../../models/MeltQuote.ts';

export type BoltMeltQuoteState = 'UNPAID' | 'PENDING' | 'PAID';

export interface QuoteMeltResponse<M extends MeltMethod = MeltMethod> {
  state: MeltMethodRemoteState<M>;
  change?: SerializedBlindedSignature[];
  payment_preimage?: string | null;
  outpoint?: string | null;
}

/** Protocol effects only. Candidate proofs and settlement data are persisted by Melt transitions. */
export abstract class BaseQuoteMeltHandler<M extends MeltMethod> implements MeltMethodHandler<M> {
  protected abstract readonly method: M;

  protected abstract createRemoteQuote(
    ctx: CreateMeltQuoteContext<M>,
  ): Promise<MeltMethodQuoteSnapshot<M>>;

  protected abstract fetchRemoteMeltQuote(
    ctx: FetchRemoteMeltQuoteContext<M>,
  ): Promise<MeltMethodQuoteSnapshot<M>>;

  protected abstract executeMelt(
    ctx: ExecuteMeltContext<M>,
    proofsToMelt: Proof[],
    changeOutputs: OutputDataLike[],
    quoteId: string,
  ): Promise<QuoteMeltResponse<M>>;

  protected abstract buildFinalizedData(
    response: QuoteMeltResponse<M>,
  ): MeltMethodFinalizedData<M> | undefined;

  async createQuote(ctx: CreateMeltQuoteContext<M>): Promise<MeltQuote<M>> {
    return this.toCanonicalQuote(ctx.mintUrl, await this.createRemoteQuote(ctx));
  }

  async fetchRemoteQuote(ctx: FetchRemoteMeltQuoteContext<M>): Promise<MeltQuote<M>> {
    return this.toCanonicalQuote(ctx.quote.mintUrl, await this.fetchRemoteMeltQuote(ctx));
  }

  async swap(ctx: SwapMeltContext<M>): Promise<{ keep: Proof[]; send: Proof[] }> {
    if (!ctx.operation.needsSwap || !ctx.operation.swapOutputData) {
      throw new Error(`Melt operation ${ctx.operation.id} has no pre-swap plan`);
    }
    const outputData = deserializeOutputData(ctx.operation.swapOutputData);
    const keysetId = outputData.send[0]?.blindedMessage.id;
    if (!keysetId || outputData.send.some((output) => output.blindedMessage.id !== keysetId)) {
      throw new Error('Melt pre-swap send outputs require one keyset');
    }
    const outputConfig: OutputConfig = {
      send: { type: 'custom', data: outputData.send },
      keep: { type: 'custom', data: outputData.keep },
    };
    const sendAmount = outputData.send.reduce(
      (sum, output) => sum.add(output.blindedMessage.amount),
      Amount.zero(),
    );
    return ctx.wallet.send(sendAmount, ctx.inputProofs, { keysetId }, outputConfig);
  }

  async melt(ctx: ExecuteMeltContext<M>): Promise<MeltRemoteResult<M>> {
    const changeOutputs = deserializeOutputData(ctx.operation.changeOutputData).keep;
    const response = await this.executeMelt(
      ctx,
      ctx.inputProofs,
      changeOutputs,
      ctx.operation.quoteId,
    );
    return {
      status: response.state,
      change: response.change,
      finalizedData: this.buildFinalizedData(response),
    };
  }

  private toCanonicalQuote(mintUrl: string, quote: MeltMethodQuoteSnapshot<M>): MeltQuote<M> {
    switch (this.method) {
      case 'bolt11':
        return meltQuoteFromBolt11Response(
          mintUrl,
          quote as MeltQuoteBolt11Response,
        ) as MeltQuote<M>;
      case 'bolt12':
        return meltQuoteFromBolt12Response(
          mintUrl,
          quote as MeltQuoteBolt12Response,
        ) as MeltQuote<M>;
      case 'onchain':
        return meltQuoteFromOnchainResponse(
          mintUrl,
          quote as MeltMethodQuoteSnapshot<'onchain'>,
        ) as MeltQuote<M>;
      default:
        throw new Error(`Unsupported melt method ${String(this.method)}`);
    }
  }
}
