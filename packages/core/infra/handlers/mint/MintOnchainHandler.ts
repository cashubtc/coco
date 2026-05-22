import { Amount, type Wallet } from '@cashu/cashu-ts';
import { assertSameUnit } from '@core/amounts';
import type { KeyRingService } from '@core/services';
import {
  mintQuoteFromOnchainResponse,
  type MintQuote,
  type MintQuoteOnchainResponse,
} from '../../../models/MintQuote';
import type {
  CreateMintQuoteContext,
  ExecuteContext,
  FetchRemoteMintQuoteContext,
  MintExecutionResult,
  MintMethodHandler,
  PendingContext,
  PendingMintCheckResult,
  PendingMintOperation,
  PrepareContext,
  RecoverExecutingContext,
  RecoverExecutingResult,
} from '../../../operations/mint';

export class MintOnchainHandler implements MintMethodHandler<'onchain'> {
  constructor(private readonly keyRingService: KeyRingService) {}

  async createQuote(ctx: CreateMintQuoteContext<'onchain'>): Promise<MintQuote<'onchain'>> {
    const quoteKey = await this.keyRingService.generateMintQuoteKeyPair();
    const remoteQuote = await this.createRemoteQuote(ctx.wallet, {
      pubkey: quoteKey.publicKeyHex,
      unit: ctx.createQuoteData.unit,
    });

    this.assertQuoteMatchesRequest(remoteQuote, quoteKey.publicKeyHex, ctx.createQuoteData.unit);

    return mintQuoteFromOnchainResponse(ctx.mintUrl, remoteQuote);
  }

  async fetchRemoteQuote(
    ctx: FetchRemoteMintQuoteContext<'onchain'>,
  ): Promise<MintQuote<'onchain'>> {
    const remoteQuote = await ctx.mintAdapter.checkMintQuote<MintQuoteOnchainResponse>(
      ctx.quote.mintUrl,
      'onchain',
      ctx.quote.quoteId,
    );

    this.assertQuoteMatchesRequest(remoteQuote, ctx.quote.quoteData.pubkey, ctx.quote.unit);

    return mintQuoteFromOnchainResponse(ctx.quote.mintUrl, remoteQuote);
  }

  async prepare(_ctx: PrepareContext<'onchain'>): Promise<PendingMintOperation<'onchain'>> {
    throw new Error('Onchain mint operation preparation is not implemented yet');
  }

  async execute(_ctx: ExecuteContext<'onchain'>): Promise<MintExecutionResult> {
    throw new Error('Onchain mint operation execution is not implemented yet');
  }

  async recoverExecuting(
    _ctx: RecoverExecutingContext<'onchain'>,
  ): Promise<RecoverExecutingResult> {
    throw new Error('Onchain mint operation recovery is not implemented yet');
  }

  async checkPending(_ctx: PendingContext<'onchain'>): Promise<PendingMintCheckResult<'onchain'>> {
    throw new Error('Onchain mint operation polling is not implemented yet');
  }

  private async createRemoteQuote(
    wallet: Wallet,
    payload: { pubkey: string; unit: string },
  ): Promise<MintQuoteOnchainResponse> {
    const genericWallet = wallet as Wallet & {
      createMintQuote<TRes>(method: string, payload: Record<string, unknown>): Promise<TRes>;
    };

    return genericWallet.createMintQuote<MintQuoteOnchainResponse>('onchain', payload);
  }

  private assertQuoteMatchesRequest(
    quote: MintQuoteOnchainResponse,
    expectedPubkey: string,
    expectedUnit: string,
  ): void {
    if (quote.pubkey !== expectedPubkey) {
      throw new Error(
        `Onchain mint quote ${quote.quote} returned pubkey ${quote.pubkey} instead of requested pubkey ${expectedPubkey}`,
      );
    }

    assertSameUnit(quote.unit, expectedUnit, `Onchain mint quote ${quote.quote}`);

    if (Amount.from(quote.amount_paid).lessThan(Amount.from(quote.amount_issued))) {
      throw new Error(
        `Onchain mint quote ${quote.quote} has amount_issued greater than amount_paid`,
      );
    }
  }
}
