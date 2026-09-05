import type { Wallet } from '@cashu/cashu-ts';
import { assertSameUnit } from '@core/amounts';
import type { KeyRingService } from '@core/services';
import { MintQuoteValidationError } from '../../../models/Error';
import {
  mintQuoteFromOnchainResponse,
  type MintQuote,
  type MintQuoteOnchainResponse,
} from '../../../models/MintQuote';
import { mintQuoteObservationFromOnchainResponse } from '../../../models/MintQuoteObservationFactory';
import { ReusableMintLifecycle } from './ReusableMintLifecycle';
import type {
  CreateMintQuoteContext,
  ExecuteContext,
  FetchRemoteMintQuoteContext,
  MintExecutionResult,
  MintMethodHandler,
  PendingContext,
  PendingMintObservationResult,
  PendingMintOperation,
  PrepareContext,
  RecoverExecutingContext,
  RecoverExecutingResult,
} from '../../../operations/mint';

export class MintOnchainHandler implements MintMethodHandler<'onchain'> {
  private readonly lifecycle: ReusableMintLifecycle<'onchain'>;

  constructor(private readonly keyRingService: KeyRingService) {
    this.lifecycle = new ReusableMintLifecycle(keyRingService, {
      method: 'onchain',
      quoteLabel: 'Onchain',
      recoveryLabel: 'onchain',
      initialAlreadyIssued: 'throw',
      assertQuoteMatchesRequest: (quote, pubkey, unit) =>
        this.assertQuoteMatchesRequest(quote, pubkey, unit),
      toObservation: mintQuoteObservationFromOnchainResponse,
      mintProofs: (wallet, amount, quote, secretKey, outputs) =>
        wallet.mintProofsOnchain(amount, quote, secretKey, undefined, {
          type: 'custom',
          data: outputs,
        }),
    });
  }

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
    return this.lifecycle.validateQuoteForPrepare(quote);
  }

  async prepare(ctx: PrepareContext<'onchain'>): Promise<PendingMintOperation<'onchain'>> {
    return this.lifecycle.prepare(ctx);
  }

  async execute(ctx: ExecuteContext<'onchain'>): Promise<MintExecutionResult> {
    return this.lifecycle.execute(ctx);
  }

  async recoverExecuting(ctx: RecoverExecutingContext<'onchain'>): Promise<RecoverExecutingResult> {
    return this.lifecycle.recoverExecuting(ctx);
  }

  async checkPending(
    ctx: PendingContext<'onchain'>,
  ): Promise<PendingMintObservationResult<'onchain'>> {
    return this.lifecycle.checkPending(ctx);
  }

  private async createRemoteQuote(
    wallet: Wallet,
    payload: { pubkey: string; unit: string },
  ): Promise<MintQuoteOnchainResponse> {
    const quote = await wallet.createMintQuoteOnchain(payload.pubkey);
    assertSameUnit(quote.unit, payload.unit, `Onchain mint quote ${quote.quote}`);
    return quote;
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
