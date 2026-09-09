import type {
  CreateMintQuoteContext,
  FetchRemoteMintQuoteContext,
  MintMethodHandler,
} from '@core/operations/mint';
import { MintQuoteKeyError, MintQuoteValidationError } from '../../../models/Error';
import { mintQuoteFromBolt11Response, type MintQuote } from '../../../models/MintQuote';
import { mintQuoteObservationFromBolt11Response } from '../../../models/MintQuoteObservationFactory';
import type { KeyRingService } from '../../../services/KeyRingService';

export class MintBolt11Handler implements MintMethodHandler<'bolt11'> {
  constructor(private readonly keyRingService: KeyRingService) {}

  async createQuote(ctx: CreateMintQuoteContext<'bolt11'>): Promise<MintQuote<'bolt11'>> {
    const { amount, locked, ownedPubkey } = ctx.createQuoteData;
    const shouldLock = locked === true || ownedPubkey !== undefined;
    if (shouldLock) {
      await ctx.mintService.assertNutSupported(ctx.mintUrl, 20, 'locked BOLT11 mint quote');
    }
    const lockPubkey =
      shouldLock && !ownedPubkey
        ? (await this.keyRingService.generateMintQuoteKeyPair()).publicKeyHex
        : ownedPubkey;
    if (lockPubkey && ownedPubkey) {
      // TODO: Support third-party quote locks as a distinct flow. Coco currently expects to
      // redeem every created quote, so an explicitly supplied key must be locally owned.
      await this.requireQuoteKey(lockPubkey);
    }
    const remoteQuote = lockPubkey
      ? await ctx.wallet.createLockedMintQuote(amount.amount, lockPubkey)
      : await ctx.wallet.createMintQuoteBolt11(amount.amount);
    if (lockPubkey && remoteQuote.pubkey !== lockPubkey) {
      throw new MintQuoteValidationError(
        'Mint returned a BOLT11 quote with an unexpected NUT-20 public key',
      );
    }
    return mintQuoteFromBolt11Response(ctx.mintUrl, remoteQuote);
  }

  async fetchRemoteQuote(ctx: FetchRemoteMintQuoteContext<'bolt11'>): Promise<MintQuote<'bolt11'>> {
    const remoteQuote = await ctx.mintAdapter.checkMintQuote(
      ctx.quote.mintUrl,
      'bolt11',
      ctx.quote.quoteId,
    );
    return mintQuoteObservationFromBolt11Response(ctx.quote.mintUrl, remoteQuote);
  }

  async validateQuoteForPrepare(quote: MintQuote<'bolt11'>): Promise<void> {
    await this.requireQuoteKey(quote.pubkey);
  }

  private async requireQuoteKey(pubkey: string | undefined): Promise<void> {
    if (!pubkey) return;
    const key = await this.keyRingService.getMintQuoteKeyPair(pubkey);
    if (!key) {
      throw new MintQuoteKeyError('Missing NUT-20 mint quote key for locked BOLT11 quote');
    }
  }
}
