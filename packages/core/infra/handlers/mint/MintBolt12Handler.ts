import { Amount, type MintQuoteBolt12Response } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { assertSameUnit } from '@core/amounts';
import { MintOperationError } from '@core/models';
import type { KeyRingService } from '@core/services/KeyRingService';
import { deserializeOutputData, mapProofToCoreProof, serializeOutputData } from '@core/utils';
import type {
  CreateMintQuoteContext,
  ExecuteContext,
  FetchRemoteMintQuoteContext,
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
import type { MintQuote } from '../../../models/MintQuote.ts';
import { deriveBolt12MintQuoteState } from './Bolt12MintQuoteAccounting.ts';

export class MintBolt12Handler implements MintMethodHandler<'bolt12'> {
  async createQuote(ctx: CreateMintQuoteContext<'bolt12'>): Promise<MintQuote<'bolt12'>> {
    const { amountless, description } = ctx.methodData;
    const keypair = await this.requireKeyRing(ctx).generateNewKeyPair();
    const remoteQuote = await ctx.wallet.createMintQuoteBolt12(keypair.publicKeyHex, {
      amount: amountless ? undefined : ctx.intent.amount,
      description,
    });
    return this.toCanonicalQuote(ctx.mintUrl, remoteQuote);
  }

  async fetchRemoteQuote(ctx: FetchRemoteMintQuoteContext<'bolt12'>): Promise<MintQuote<'bolt12'>> {
    const remoteQuote = await ctx.mintAdapter.checkMintQuoteBolt12(
      ctx.quote.mintUrl,
      ctx.quote.quoteId,
    );
    return this.toCanonicalQuote(ctx.quote.mintUrl, remoteQuote);
  }

  async prepare(
    ctx: PrepareContext<'bolt12'>,
  ): Promise<PendingMintOperation<'bolt12'> & MintMethodMeta<'bolt12'>> {
    const quote = ctx.importedQuote;
    if (!quote) {
      throw new Error(`Mint quote ${ctx.operation.quoteId ?? '(missing)'} was not provided`);
    }

    assertSameUnit(quote.unit, ctx.operation.unit, `Mint quote ${quote.quote}`);
    this.assertQuoteMatchesOperation(ctx.operation, quote);
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
      lastObservedRemoteState: deriveBolt12MintQuoteState(quote, ctx.operation.amount),
      lastObservedRemoteStateAt: Date.now(),
      outputData: serializeOutputData({ keep: outputData.keep, send: [] }),
      state: 'pending',
    };
  }

  private toCanonicalQuote(mintUrl: string, quote: MintQuoteBolt12Response): MintQuote<'bolt12'> {
    const now = Date.now();
    return {
      mintUrl,
      method: 'bolt12',
      quoteId: quote.quote,
      quote: quote.quote,
      request: quote.request,
      amount: quote.amount ?? Amount.zero(),
      unit: quote.unit,
      expiry: quote.expiry,
      pubkey: quote.pubkey,
      state: deriveBolt12MintQuoteState(quote, quote.amount ?? Amount.zero()),
      lastObservedRemoteState: deriveBolt12MintQuoteState(quote, quote.amount ?? Amount.zero()),
      lastObservedRemoteStateAt: now,
      reusable: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  async execute(ctx: ExecuteContext<'bolt12'>): Promise<MintExecutionResult> {
    const quote = await ctx.mintAdapter.checkMintQuoteBolt12(
      ctx.operation.mintUrl,
      ctx.operation.quoteId,
    );
    this.assertQuotePubkeyMatchesOperation(ctx.operation, quote.pubkey);
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

    const pubkeyMismatch = this.getQuotePubkeyMismatchError(ctx.operation, remoteQuote.pubkey);
    if (pubkeyMismatch) {
      return {
        status: 'TERMINAL',
        error: pubkeyMismatch.message,
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
    const observedRemoteState = deriveBolt12MintQuoteState(quote, amount);
    const observedRemoteStateAt = Date.now();

    return {
      observedRemoteState,
      observedRemoteStateAt,
      category: observedRemoteState === 'PAID' ? 'ready' : 'waiting',
    };
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
    if (!ctx.operation.methodData.amountless && (!quote.amount || quote.amount.isZero())) {
      throw new Error(`Mint quote ${quote.quote} is amountless but a fixed quote was requested`);
    }
  }

  private assertQuoteMatchesOperation(
    operation: PrepareContext<'bolt12'>['operation'],
    quote: MintQuoteBolt12Response,
  ): void {
    if (operation.quoteId && operation.quoteId !== quote.quote) {
      throw new Error(
        `Mint quote ${quote.quote} does not match operation quote ${operation.quoteId}`,
      );
    }
  }

  private assertQuotePubkeyMatchesOperation(
    operation:
      | ExecuteContext<'bolt12'>['operation']
      | RecoverExecutingContext<'bolt12'>['operation'],
    pubkey: string,
  ): void {
    const mismatch = this.getQuotePubkeyMismatchError(operation, pubkey);
    if (mismatch) {
      throw mismatch;
    }
  }

  private getQuotePubkeyMismatchError(
    operation:
      | ExecuteContext<'bolt12'>['operation']
      | RecoverExecutingContext<'bolt12'>['operation'],
    pubkey: string,
  ): Error | null {
    if (!operation.pubkey) {
      return new Error(`BOLT12 mint operation ${operation.id} is missing quote pubkey`);
    }

    if (operation.pubkey !== pubkey) {
      return new Error(
        `BOLT12 mint quote ${operation.quoteId} pubkey changed from ${operation.pubkey} to ${pubkey}`,
      );
    }

    return null;
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
