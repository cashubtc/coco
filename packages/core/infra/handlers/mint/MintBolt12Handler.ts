import { Amount, type MintQuoteBolt12Response } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { assertSameUnit } from '@core/amounts';
import { MintOperationError } from '@core/models';
import type { KeyRingService } from '@core/services/KeyRingService';
import { deserializeOutputData, mapProofToCoreProof, serializeOutputData } from '@core/utils';
import type {
  ExecuteContext,
  MintExecutionResult,
  MintMethodHandler,
  MintMethodMeta,
  PendingContext,
  PendingMintCheckResult,
  PendingMintOperation,
  PrepareContext,
  RecoverExecutingContext,
  RecoverExecutingResult,
} from '@core/operations/mint';

export class MintBolt12Handler implements MintMethodHandler<'bolt12'> {
  async prepare(
    ctx: PrepareContext<'bolt12'>,
  ): Promise<PendingMintOperation<'bolt12'> & MintMethodMeta<'bolt12'>> {
    const { amountless, description } = ctx.operation.methodData;
    const pubkey = await this.resolveQuotePubkey(ctx);
    const quote =
      ctx.importedQuote ??
      (await ctx.wallet.createMintQuoteBolt12(pubkey, {
        amount: amountless ? undefined : ctx.operation.amount,
        description,
      }));

    assertSameUnit(quote.unit, ctx.operation.unit, `Mint quote ${quote.quote}`);
    await this.assertQuoteKeyIsAvailable(ctx, quote.pubkey);
    this.assertQuoteAmount(ctx, quote);

    const outputData = await ctx.proofService.createOutputsAndIncrementCounters(
      ctx.operation.mintUrl,
      {
        keep: { amount: ctx.operation.amount, unit: ctx.operation.unit },
        send: { amount: Amount.zero(), unit: ctx.operation.unit },
      },
      {},
    );

    if (outputData.keep.length === 0) {
      throw new Error('Failed to create deterministic outputs for mint operation');
    }

    return {
      ...ctx.operation,
      quoteId: quote.quote,
      amount: ctx.operation.amount,
      unit: ctx.operation.unit,
      request: quote.request,
      expiry: quote.expiry,
      pubkey: quote.pubkey,
      lastObservedRemoteState: this.deriveQuoteState(quote, ctx.operation.amount),
      lastObservedRemoteStateAt: Date.now(),
      outputData: serializeOutputData({ keep: outputData.keep, send: [] }),
      state: 'pending',
    };
  }

  async execute(ctx: ExecuteContext<'bolt12'>): Promise<MintExecutionResult> {
    const quote = await ctx.mintAdapter.checkMintQuoteBolt12(
      ctx.operation.mintUrl,
      ctx.operation.quoteId,
    );
    const outputData = deserializeOutputData(ctx.operation.outputData);

    try {
      const proofs = await ctx.wallet.mintProofsBolt12(
        ctx.operation.amount,
        quote,
        await this.getPrivateKeyHex(ctx, quote.pubkey),
        undefined,
        {
          type: 'custom',
          data: outputData.keep,
        },
      );

      return { status: 'ISSUED', proofs };
    } catch (err) {
      if (err instanceof MintOperationError && err.code === 20002) {
        return { status: 'ALREADY_ISSUED' };
      }
      throw err;
    }
  }

  async recoverExecuting(ctx: RecoverExecutingContext<'bolt12'>): Promise<RecoverExecutingResult> {
    const { mintUrl, quoteId } = ctx.operation;
    let remoteQuote: MintQuoteBolt12Response;
    try {
      remoteQuote = await ctx.mintAdapter.checkMintQuoteBolt12(mintUrl, quoteId);
    } catch (error) {
      ctx.logger?.warn('Failed to check bolt12 mint quote during recovery', {
        mintUrl,
        quoteId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'PENDING',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const outputData = deserializeOutputData(ctx.operation.outputData);
    try {
      const proofs = await ctx.wallet.mintProofsBolt12(
        ctx.operation.amount,
        remoteQuote,
        await this.getPrivateKeyHex(ctx, remoteQuote.pubkey),
        undefined,
        {
          type: 'custom',
          data: outputData.keep,
        },
      );

      await ctx.proofService.saveProofs(
        ctx.operation.mintUrl,
        mapProofToCoreProof(ctx.operation.mintUrl, 'ready', proofs, {
          unit: ctx.operation.unit,
          createdByOperationId: ctx.operation.id,
        }),
      );

      return { status: 'FINALIZED' };
    } catch (err) {
      if (err instanceof MintOperationError) {
        if (err.code === 20002) {
          return this.recoverFromOutputs(ctx);
        }
        if (err.code === 20007) {
          return {
            status: 'TERMINAL',
            error: `Recovered: quote ${quoteId} expired while executing mint`,
          };
        }
        return { status: 'PENDING', error: err.message };
      }

      return {
        status: 'PENDING',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async checkPending(ctx: PendingContext<'bolt12'>): Promise<PendingMintCheckResult<'bolt12'>> {
    const { mintUrl, quoteId, amount } = ctx.operation;
    ctx.logger?.info('Checking pending bolt12 mint operation', { mintUrl, quoteId });

    const quote = await ctx.mintAdapter.checkMintQuoteBolt12(mintUrl, quoteId);
    const observedRemoteState = this.deriveQuoteState(quote, amount);
    const observedRemoteStateAt = Date.now();

    return {
      observedRemoteState,
      observedRemoteStateAt,
      category: observedRemoteState === 'PAID' ? 'ready' : 'waiting',
    };
  }

  private async resolveQuotePubkey(ctx: PrepareContext<'bolt12'>): Promise<string> {
    if (ctx.importedQuote) {
      await this.assertQuoteKeyIsAvailable(ctx, ctx.importedQuote.pubkey);
      return ctx.importedQuote.pubkey;
    }

    const keypair = await this.requireKeyRing(ctx).generateNewKeyPair();
    return keypair.publicKeyHex;
  }

  private async assertQuoteKeyIsAvailable(
    ctx: Pick<PrepareContext<'bolt12'>, 'keyRingService'>,
    pubkey: string,
  ): Promise<void> {
    const keypair = await this.requireKeyRing(ctx).getKeyPair(pubkey);
    if (!keypair) {
      throw new Error(`BOLT12 mint quote key ${pubkey} is not available in keyring`);
    }
  }

  private assertQuoteAmount(ctx: PrepareContext<'bolt12'>, quote: MintQuoteBolt12Response): void {
    if (quote.amount && !quote.amount.equals(ctx.operation.amount)) {
      throw new Error(
        `Mint quote ${quote.quote} amount ${quote.amount} does not match requested amount ${ctx.operation.amount}`,
      );
    }

    if (!ctx.operation.methodData.amountless && !quote.amount) {
      throw new Error(`Mint quote ${quote.quote} is amountless but a fixed quote was requested`);
    }
  }

  private async getPrivateKeyHex(
    ctx: ExecuteContext<'bolt12'> | RecoverExecutingContext<'bolt12'>,
    pubkey: string,
  ): Promise<string> {
    const keypair = await this.requireKeyRing(ctx).getKeyPair(pubkey);
    if (!keypair) {
      throw new Error(`BOLT12 mint quote key ${pubkey} is not available in keyring`);
    }
    return bytesToHex(keypair.secretKey);
  }

  private requireKeyRing(ctx: { keyRingService?: KeyRingService }): KeyRingService {
    if (!ctx.keyRingService) {
      throw new Error('BOLT12 mint operations require a keyring service');
    }
    return ctx.keyRingService;
  }

  private deriveQuoteState(
    quote: MintQuoteBolt12Response,
    operationAmount: Amount,
  ): 'UNPAID' | 'PAID' {
    if (quote.amount_paid.lessThanOrEqual(quote.amount_issued)) {
      return 'UNPAID';
    }

    const available = quote.amount_paid.subtract(quote.amount_issued);
    return available.greaterThanOrEqual(operationAmount) ? 'PAID' : 'UNPAID';
  }

  private async recoverFromOutputs(
    ctx: RecoverExecutingContext<'bolt12'>,
  ): Promise<RecoverExecutingResult> {
    try {
      const recovered = await ctx.proofService.recoverProofsFromOutputData(
        ctx.operation.mintUrl,
        ctx.operation.outputData,
        {
          unit: ctx.operation.unit,
          createdByOperationId: ctx.operation.id,
        },
      );
      if (recovered.length === 0) {
        return {
          status: 'PENDING',
          error: `Recovered: quote ${ctx.operation.quoteId} issued remotely but proofs were not recoverable`,
        };
      }
      return { status: 'FINALIZED' };
    } catch (error) {
      return {
        status: 'PENDING',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
