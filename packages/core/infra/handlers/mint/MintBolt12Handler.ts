import { Amount, type MintQuoteBolt12Response, type Wallet } from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnitAmount } from '@core/amounts';
import type { KeyRingService } from '@core/services';
import { MintQuoteKeyError, MintQuoteValidationError } from '../../../models/Error';
import { mintQuoteFromBolt12Response, type MintQuote } from '../../../models/MintQuote';
import { mintQuoteObservationFromBolt12Response } from '../../../models/MintQuoteObservationFactory';
import type {
  CreateMintQuoteContext,
  FetchRemoteMintQuoteContext,
  MintMethodHandler,
} from '../../../operations/mint';

export class MintBolt12Handler implements MintMethodHandler<'bolt12'> {
  constructor(private readonly keyRingService: KeyRingService) {}

  async createQuote(ctx: CreateMintQuoteContext<'bolt12'>): Promise<MintQuote<'bolt12'>> {
    const quoteKey = await this.keyRingService.generateMintQuoteKeyPair();
    const amount = ctx.createQuoteData.amount
      ? normalizeUnitAmount(ctx.createQuoteData.amount).amount
      : undefined;
    const remoteQuote = await this.createRemoteQuote(ctx.wallet, {
      pubkey: quoteKey.publicKeyHex,
      unit: ctx.createQuoteData.unit,
      amount,
      description: ctx.createQuoteData.description,
    });

    this.assertQuoteMatchesRequest(
      remoteQuote,
      quoteKey.publicKeyHex,
      ctx.createQuoteData.unit,
      amount,
    );

    return mintQuoteFromBolt12Response(ctx.mintUrl, remoteQuote);
  }

  async fetchRemoteQuote(ctx: FetchRemoteMintQuoteContext<'bolt12'>): Promise<MintQuote<'bolt12'>> {
    const remoteQuote = await ctx.mintAdapter.checkMintQuote(
      ctx.quote.mintUrl,
      'bolt12',
      ctx.quote.quoteId,
    );

    this.assertQuoteMatchesRequest(
      remoteQuote,
      ctx.quote.quoteData.pubkey,
      ctx.quote.unit,
      ctx.quote.quoteData.amount,
    );

    return mintQuoteObservationFromBolt12Response(ctx.quote.mintUrl, remoteQuote);
  }

  async validateQuoteForPrepare(quote: MintQuote<'bolt12'>): Promise<void> {
    await this.requireQuoteKey(quote.quoteData.pubkey);
  }

  private async createRemoteQuote(
    wallet: Wallet,
    payload: {
      pubkey: string;
      unit: string;
      amount?: Amount;
      description?: string;
    },
  ): Promise<MintQuoteBolt12Response> {
    const quote = await wallet.createMintQuoteBolt12(payload.pubkey, {
      amount: payload.amount,
      description: payload.description,
    });
    assertSameUnit(quote.unit, payload.unit, `BOLT12 mint quote ${quote.quote}`);
    return quote;
  }

  private async requireQuoteKey(pubkey: string): Promise<void> {
    const quoteKey = await this.keyRingService.getMintQuoteKeyPair(pubkey);
    if (!quoteKey) {
      throw new MintQuoteKeyError(`Missing NUT-20 mint quote key for pubkey ${pubkey}`);
    }
  }

  private assertQuoteMatchesRequest(
    quote: MintQuoteBolt12Response,
    expectedPubkey: string,
    expectedUnit: string,
    expectedAmount?: Amount,
  ): void {
    if (quote.pubkey !== expectedPubkey) {
      throw new MintQuoteValidationError(
        `BOLT12 mint quote ${quote.quote} returned pubkey ${quote.pubkey} instead of requested pubkey ${expectedPubkey}`,
      );
    }

    assertSameUnit(quote.unit, expectedUnit, `BOLT12 mint quote ${quote.quote}`);
    this.assertQuoteAmount(quote, expectedAmount);
  }

  private assertQuoteAmount(quote: MintQuoteBolt12Response, expectedAmount?: Amount): void {
    if (expectedAmount === undefined) {
      return;
    }

    if (!quote.amount || !quote.amount.equals(expectedAmount)) {
      const observedAmount = quote.amount ?? '(missing)';
      throw new MintQuoteValidationError(
        `Mint quote ${quote.quote} amount ${observedAmount} ` +
          `does not match requested amount ${expectedAmount}`,
      );
    }
  }
}
