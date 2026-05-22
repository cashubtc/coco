import { Amount, type Wallet } from '@cashu/cashu-ts';
import { assertSameUnit } from '@core/amounts';
import type { KeyRingService } from '@core/services';
import { deserializeOutputData, serializeOutputData } from '@core/utils';
import { bytesToHex } from '@noble/curves/utils.js';
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
    const remoteQuote = await ctx.mintAdapter.checkMintQuoteOnchain(
      ctx.quote.mintUrl,
      ctx.quote.quoteId,
    );

    this.assertQuoteMatchesRequest(remoteQuote, ctx.quote.quoteData.pubkey, ctx.quote.unit);

    return mintQuoteFromOnchainResponse(ctx.quote.mintUrl, remoteQuote);
  }

  async validateQuoteForPrepare(quote: MintQuote<'onchain'>): Promise<void> {
    await this.requireQuoteKey(quote.quoteData.pubkey);
  }

  async prepare(ctx: PrepareContext<'onchain'>): Promise<PendingMintOperation<'onchain'>> {
    const quote = ctx.importedQuote;
    if (!quote) {
      throw new Error(`Mint quote ${ctx.operation.quoteId ?? '(missing)'} was not provided`);
    }

    if (ctx.operation.quoteId && ctx.operation.quoteId !== quote.quote) {
      throw new Error(
        `Mint quote ${quote.quote} does not match operation quote ${ctx.operation.quoteId}`,
      );
    }

    assertSameUnit(quote.unit, ctx.operation.unit, `Onchain mint quote ${quote.quote}`);
    await this.requireQuoteKey(quote.pubkey);

    const outputData = await ctx.proofService.createOutputsAndIncrementCounters(
      ctx.operation.mintUrl,
      {
        keep: { amount: ctx.operation.amount, unit: ctx.operation.unit },
        send: { amount: Amount.zero(), unit: ctx.operation.unit },
      },
      {},
    );

    if (outputData.keep.length === 0) {
      throw new Error('Failed to create deterministic outputs for onchain mint operation');
    }

    return {
      ...ctx.operation,
      quoteId: quote.quote,
      request: quote.request,
      expiry: quote.expiry,
      pubkey: quote.pubkey,
      outputData: serializeOutputData({ keep: outputData.keep, send: [] }),
      state: 'pending',
    };
  }

  async execute(ctx: ExecuteContext<'onchain'>): Promise<MintExecutionResult> {
    const quoteKey = await this.keyRingService.getMintQuoteKeyPair(ctx.operation.pubkey ?? '');
    if (!quoteKey) {
      throw new Error(
        `Missing NUT-20 mint quote key for pubkey ${ctx.operation.pubkey ?? '(missing)'}`,
      );
    }

    const outputData = deserializeOutputData(ctx.operation.outputData);
    const remoteQuote = await ctx.mintAdapter.checkMintQuoteOnchain(
      ctx.operation.mintUrl,
      ctx.operation.quoteId,
    );
    this.assertQuoteMatchesRequest(remoteQuote, ctx.operation.pubkey ?? '', ctx.operation.unit);

    const proofs = await ctx.wallet.mintProofsOnchain(
      ctx.operation.amount,
      remoteQuote,
      bytesToHex(quoteKey.secretKey),
      undefined,
      { type: 'custom', data: outputData.keep },
    );

    return { status: 'ISSUED', proofs };
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
    const quote = await wallet.createMintQuoteOnchain(payload.pubkey);
    assertSameUnit(quote.unit, payload.unit, `Onchain mint quote ${quote.quote}`);
    return quote;
  }

  private async requireQuoteKey(pubkey: string): Promise<void> {
    const quoteKey = await this.keyRingService.getMintQuoteKeyPair(pubkey);
    if (!quoteKey) {
      throw new Error(`Missing NUT-20 mint quote key for pubkey ${pubkey}`);
    }
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
