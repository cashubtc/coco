import { type Wallet } from '@cashu/cashu-ts';
import { assertSameUnit } from '@core/amounts';
import type { KeyRingService } from '@core/services';
import { MintQuoteKeyError, MintQuoteValidationError } from '../../../models/Error';
import {
  mintQuoteFromOnchainResponse,
  type MintQuote,
  type MintQuoteOnchainResponse,
} from '../../../models/MintQuote';
import { mintQuoteObservationFromOnchainResponse } from '../../../models/MintQuoteObservationFactory';
import type {
  CreateMintQuoteContext,
  FetchRemoteMintQuoteContext,
  MintMethodHandler,
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
    const remoteQuote = await ctx.mintAdapter.checkMintQuote(
      ctx.quote.mintUrl,
      'onchain',
      ctx.quote.quoteId,
    );

    this.assertQuoteMatchesRequest(remoteQuote, ctx.quote.quoteData.pubkey, ctx.quote.unit);

    return mintQuoteObservationFromOnchainResponse(ctx.quote.mintUrl, remoteQuote);
  }

  async validateQuoteForPrepare(quote: MintQuote<'onchain'>): Promise<void> {
    await this.requireQuoteKey(quote.quoteData.pubkey);
  }

  private async createRemoteQuote(
    wallet: Wallet,
    payload: { pubkey: string; unit: string },
  ): Promise<MintQuoteOnchainResponse> {
    const quote = await wallet.createMintQuoteOnchain(payload.pubkey);
    assertSameUnit(quote.unit, payload.unit, `Onchain mint quote ${quote.quote}`);
    return quote;
  }

  private async requireQuoteKey(pubkey: string): Promise<void> {
    const quoteKey = await this.keyRingService.getMintQuoteKeyPair(pubkey);
    if (!quoteKey) {
      throw new MintQuoteKeyError(`Missing NUT-20 mint quote key for pubkey ${pubkey}`);
    }
  }

  private assertQuoteMatchesRequest(
    quote: MintQuoteOnchainResponse,
    expectedPubkey: string,
    expectedUnit: string,
  ): void {
    if (quote.pubkey !== expectedPubkey) {
      throw new MintQuoteValidationError(
        `Onchain mint quote ${quote.quote} returned pubkey ${quote.pubkey} instead of requested pubkey ${expectedPubkey}`,
      );
    }

    assertSameUnit(quote.unit, expectedUnit, `Onchain mint quote ${quote.quote}`);
  }
}
