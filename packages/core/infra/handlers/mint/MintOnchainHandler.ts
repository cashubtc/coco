import { Amount, type Wallet } from '@cashu/cashu-ts';
import { assertSameUnit } from '@core/amounts';
import type { KeyRingService } from '@core/services';
import { deserializeOutputData, mapProofToCoreProof, serializeOutputData } from '@core/utils';
import { bytesToHex } from '@noble/curves/utils.js';
import { MintOperationError } from '../../../models/Error';
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
    const remoteQuote = await ctx.mintAdapter.checkMintQuote(
      ctx.quote.mintUrl,
      'onchain',
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

    if (ctx.operation.quoteId !== quote.quote) {
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
    const remoteQuote = await ctx.mintAdapter.checkMintQuote(
      ctx.operation.mintUrl,
      'onchain',
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

  async recoverExecuting(ctx: RecoverExecutingContext<'onchain'>): Promise<RecoverExecutingResult> {
    const restored = await this.recoverSignedOutputs(ctx);
    if (restored) {
      return restored;
    }

    const { operation } = ctx;
    const expectedPubkey = operation.pubkey;
    if (!expectedPubkey) {
      return {
        status: 'TERMINAL',
        error: `Recovered: onchain mint operation ${operation.id} is missing NUT-20 quote pubkey`,
      };
    }

    let remoteQuote: MintQuoteOnchainResponse;
    try {
      remoteQuote = await ctx.mintAdapter.checkMintQuote(
        operation.mintUrl,
        'onchain',
        operation.quoteId,
      );
    } catch (error) {
      ctx.logger?.warn('Failed to check onchain mint quote during recovery', {
        mintUrl: operation.mintUrl,
        quoteId: operation.quoteId,
        operationId: operation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'PENDING',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const validationError = this.getQuoteValidationError(
      remoteQuote,
      expectedPubkey,
      operation.unit,
    );
    if (validationError) {
      return {
        status: 'TERMINAL',
        error: validationError.message,
      };
    }

    if (this.isExpired(remoteQuote)) {
      return {
        status: 'TERMINAL',
        error: `Recovered: onchain quote ${operation.quoteId} expired while executing mint`,
      };
    }

    const quoteKey = await this.keyRingService.getMintQuoteKeyPair(expectedPubkey);
    if (!quoteKey) {
      return {
        status: 'TERMINAL',
        error: `Missing NUT-20 mint quote key for pubkey ${expectedPubkey}`,
      };
    }

    const available = this.getAvailableAmount(remoteQuote);
    if (available.lessThan(operation.amount)) {
      return {
        status: 'PENDING',
        error: `Recovered: onchain quote ${operation.quoteId} has ${available} available, requested ${operation.amount}`,
      };
    }

    const outputData = deserializeOutputData(operation.outputData);
    try {
      const proofs = await ctx.wallet.mintProofsOnchain(
        operation.amount,
        remoteQuote,
        bytesToHex(quoteKey.secretKey),
        undefined,
        { type: 'custom', data: outputData.keep },
      );

      await ctx.proofService.saveProofs(
        operation.mintUrl,
        mapProofToCoreProof(operation.mintUrl, 'ready', proofs, {
          unit: operation.unit,
          createdByOperationId: operation.id,
        }),
      );

      return { status: 'FINALIZED' };
    } catch (error) {
      if (this.isAlreadyIssuedError(error)) {
        return (
          (await this.recoverSignedOutputs(ctx)) ?? {
            status: 'PENDING',
            error: `Recovered: onchain quote ${operation.quoteId} was already issued but proofs were not recoverable`,
          }
        );
      }

      if (this.isExpiredMintError(error)) {
        return {
          status: 'TERMINAL',
          error: `Recovered: onchain quote ${operation.quoteId} expired while executing mint`,
        };
      }

      return {
        status: 'PENDING',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkPending(ctx: PendingContext<'onchain'>): Promise<PendingMintCheckResult<'onchain'>> {
    const { operation } = ctx;
    const observedRemoteStateAt = Date.now();
    const remoteQuote = await ctx.mintAdapter.checkMintQuote(
      operation.mintUrl,
      'onchain',
      operation.quoteId,
    );
    const expectedPubkey = operation.pubkey;

    if (!expectedPubkey) {
      return {
        observedRemoteStateAt,
        quoteSnapshot: remoteQuote,
        category: 'terminal',
        terminalFailure: {
          reason: `Onchain mint operation ${operation.id} is missing NUT-20 quote pubkey`,
          code: 'missing_quote_pubkey',
          retryable: false,
          observedAt: observedRemoteStateAt,
        },
      };
    }

    const validationError = this.getQuoteValidationError(
      remoteQuote,
      expectedPubkey,
      operation.unit,
    );
    if (validationError) {
      return {
        observedRemoteStateAt,
        category: 'terminal',
        terminalFailure: {
          reason: validationError.message,
          code: 'invalid_quote',
          retryable: false,
          observedAt: observedRemoteStateAt,
        },
      };
    }

    if (this.isExpired(remoteQuote)) {
      return {
        observedRemoteStateAt,
        quoteSnapshot: remoteQuote,
        category: 'terminal',
        terminalFailure: {
          reason: `Onchain mint quote ${operation.quoteId} expired before operation ${operation.id} could be minted`,
          code: 'quote_expired',
          retryable: false,
          observedAt: observedRemoteStateAt,
        },
      };
    }

    return {
      observedRemoteStateAt,
      quoteSnapshot: remoteQuote,
      category: this.getAvailableAmount(remoteQuote).greaterThanOrEqual(operation.amount)
        ? 'ready'
        : 'waiting',
    };
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

  private async recoverSignedOutputs(
    ctx: RecoverExecutingContext<'onchain'>,
  ): Promise<RecoverExecutingResult | null> {
    try {
      const recovered = await ctx.proofService.recoverProofsFromOutputData(
        ctx.operation.mintUrl,
        ctx.operation.outputData,
        {
          unit: ctx.operation.unit,
          createdByOperationId: ctx.operation.id,
        },
      );

      return recovered.length > 0 ? { status: 'FINALIZED' } : null;
    } catch (error) {
      ctx.logger?.warn('Failed to recover onchain mint outputs from output data', {
        mintUrl: ctx.operation.mintUrl,
        quoteId: ctx.operation.quoteId,
        operationId: ctx.operation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'PENDING',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getQuoteValidationError(
    quote: MintQuoteOnchainResponse,
    expectedPubkey: string,
    expectedUnit: string,
  ): Error | null {
    try {
      this.assertQuoteMatchesRequest(quote, expectedPubkey, expectedUnit);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  private getAvailableAmount(quote: MintQuoteOnchainResponse): Amount {
    return Amount.from(quote.amount_paid).subtract(Amount.from(quote.amount_issued));
  }

  private isExpired(quote: MintQuoteOnchainResponse): boolean {
    return quote.expiry !== null && quote.expiry * 1000 <= Date.now();
  }

  private isAlreadyIssuedError(error: unknown): boolean {
    if (error instanceof MintOperationError && (error.code === 20002 || error.code === 11003)) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /already (issued|signed)|outputs? already/i.test(message);
  }

  private isExpiredMintError(error: unknown): boolean {
    if (error instanceof MintOperationError && error.code === 20007) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /expired/i.test(message);
  }
}
