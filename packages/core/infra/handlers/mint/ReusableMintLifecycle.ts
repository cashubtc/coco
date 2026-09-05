import { Amount, type OutputData, type Proof, type Wallet } from '@cashu/cashu-ts';
import { assertSameUnit } from '@core/amounts';
import type { KeyRingService } from '@core/services';
import { deserializeOutputData, mapProofToCoreProof, serializeOutputData } from '@core/utils';
import { bytesToHex } from '@noble/curves/utils.js';
import {
  MintOperationError,
  MintQuoteKeyError,
  MintQuoteValidationError,
} from '../../../models/Error';
import type { MintQuote } from '../../../models/MintQuote';
import { assessMintQuoteClaimability } from '../../../models/MintQuoteClaimability.ts';
import { getReusableMintQuoteValidationError } from './ReusableMintQuoteValidation.ts';
import type {
  ExecuteContext,
  MintExecutionResult,
  MintMethodQuoteSnapshot,
  PendingContext,
  PendingMintObservationResult,
  PendingMintOperation,
  PrepareContext,
  RecoverExecutingContext,
  RecoverExecutingResult,
} from '../../../operations/mint';

type ReusableMintMethod = 'bolt12' | 'onchain';

interface ReusableMintAdapter<M extends ReusableMintMethod> {
  readonly method: M;
  readonly quoteLabel: string;
  readonly recoveryLabel: string;
  /**
   * BOLT12 returns ALREADY_ISSUED; onchain throws into Operation Recovery. These lead to
   * different durable outcomes when Restore is empty, so keep this compatibility policy explicit.
   */
  readonly initialAlreadyIssued: 'return' | 'throw';
  assertQuoteMatchesRequest(
    quote: MintMethodQuoteSnapshot<M>,
    expectedPubkey: string,
    expectedUnit: string,
  ): void;
  toObservation(mintUrl: string, quote: MintMethodQuoteSnapshot<M>): MintQuote<M>;
  mintProofs(
    wallet: Wallet,
    amount: Amount,
    quote: MintMethodQuoteSnapshot<M>,
    secretKey: string,
    outputs: OutputData[],
  ): Promise<Proof[]>;
}

/**
 * Shared standalone Mint lifecycle for reusable quotes. Creation stays method-specific.
 * This retains the handlers' existing effects; transaction ownership stays with the owning
 * workflow and is migrated separately under ADR-0011.
 */
export class ReusableMintLifecycle<M extends ReusableMintMethod> {
  constructor(
    private readonly keyRingService: Pick<KeyRingService, 'getMintQuoteKeyPair'>,
    private readonly adapter: ReusableMintAdapter<M>,
  ) {}

  async validateQuoteForPrepare(quote: MintQuote<M>): Promise<void> {
    await this.requireQuoteKey(quote.quoteData.pubkey);
  }

  async prepare(ctx: PrepareContext<M>): Promise<PendingMintOperation<M>> {
    const quote = ctx.importedQuote;
    if (!quote) {
      throw new Error(`Mint quote ${ctx.operation.quoteId ?? '(missing)'} was not provided`);
    }

    if (ctx.operation.quoteId !== quote.quote) {
      throw new MintQuoteValidationError(
        `Mint quote ${quote.quote} does not match operation quote ${ctx.operation.quoteId}`,
      );
    }

    assertSameUnit(
      quote.unit,
      ctx.operation.unit,
      `${this.adapter.quoteLabel} mint quote ${quote.quote}`,
    );
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
      throw new Error(
        `Failed to create deterministic outputs for ${this.adapter.recoveryLabel} mint operation`,
      );
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

  async execute(ctx: ExecuteContext<M>): Promise<MintExecutionResult> {
    const quoteKey = await this.keyRingService.getMintQuoteKeyPair(ctx.operation.pubkey ?? '');
    if (!quoteKey) {
      throw new MintQuoteKeyError(
        `Missing NUT-20 mint quote key for pubkey ${ctx.operation.pubkey ?? '(missing)'}`,
      );
    }

    const outputData = deserializeOutputData(ctx.operation.outputData);
    const remoteQuote = await ctx.mintAdapter.checkMintQuote(
      ctx.operation.mintUrl,
      this.adapter.method,
      ctx.operation.quoteId,
    );
    this.adapter.assertQuoteMatchesRequest(
      remoteQuote,
      ctx.operation.pubkey ?? '',
      ctx.operation.unit,
    );
    const assessment = assessMintQuoteClaimability(
      this.adapter.toObservation(ctx.operation.mintUrl, remoteQuote),
      { requestedAmount: ctx.operation.amount },
    );
    if (assessment.status === 'invalid') {
      throw new MintQuoteValidationError(
        `${this.adapter.quoteLabel} mint quote ${ctx.operation.quoteId} is not claimable: ${assessment.status}`,
      );
    }

    try {
      const proofs = await this.adapter.mintProofs(
        ctx.wallet,
        ctx.operation.amount,
        remoteQuote,
        bytesToHex(quoteKey.secretKey),
        outputData.keep,
      );

      return { status: 'ISSUED', proofs };
    } catch (error) {
      if (this.adapter.initialAlreadyIssued === 'return' && this.isAlreadyIssuedError(error)) {
        return { status: 'ALREADY_ISSUED' };
      }
      throw error;
    }
  }

  async recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<RecoverExecutingResult> {
    const restored = await this.recoverSignedOutputs(ctx);
    if (restored) {
      return restored;
    }

    const { operation } = ctx;
    const expectedPubkey = operation.pubkey;
    if (!expectedPubkey) {
      return {
        status: 'TERMINAL',
        error: `Recovered: ${this.adapter.recoveryLabel} mint operation ${operation.id} is missing NUT-20 quote pubkey`,
      };
    }

    let remoteQuote: MintMethodQuoteSnapshot<M>;
    try {
      remoteQuote = await ctx.mintAdapter.checkMintQuote(
        operation.mintUrl,
        this.adapter.method,
        operation.quoteId,
      );
    } catch (error) {
      ctx.logger?.warn(`Failed to check ${this.adapter.recoveryLabel} mint quote during recovery`, {
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

    const quoteKey = await this.keyRingService.getMintQuoteKeyPair(expectedPubkey);
    if (!quoteKey) {
      return {
        status: 'TERMINAL',
        error: `Missing NUT-20 mint quote key for pubkey ${expectedPubkey}`,
      };
    }

    const assessment = assessMintQuoteClaimability(
      this.adapter.toObservation(operation.mintUrl, remoteQuote),
      { ...ctx.localClaimabilityFacts, requestedAmount: operation.amount },
    );
    if (assessment.status === 'invalid') {
      return {
        status: 'TERMINAL',
        error: `Recovered: ${this.adapter.recoveryLabel} quote ${operation.quoteId} has invalid claimability accounting`,
      };
    }
    if (assessment.status !== 'claimable') {
      return {
        status: 'PENDING',
        error: `Recovered: ${this.adapter.recoveryLabel} quote ${operation.quoteId} has ${assessment.remoteAvailable} remotely available, requested ${operation.amount}`,
      };
    }

    const outputData = deserializeOutputData(operation.outputData);
    try {
      const proofs = await this.adapter.mintProofs(
        ctx.wallet,
        operation.amount,
        remoteQuote,
        bytesToHex(quoteKey.secretKey),
        outputData.keep,
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
            error: `Recovered: ${this.adapter.recoveryLabel} quote ${operation.quoteId} was already issued but proofs were not recoverable`,
          }
        );
      }

      if (error instanceof MintOperationError && error.code === 20007) {
        return {
          status: 'TERMINAL',
          error: `Recovered: ${this.adapter.recoveryLabel} quote ${operation.quoteId} expired while executing mint`,
        };
      }

      return {
        status: 'PENDING',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkPending(ctx: PendingContext<M>): Promise<PendingMintObservationResult<M>> {
    const { operation } = ctx;
    const observedAt = Date.now();
    const remoteQuote = await ctx.mintAdapter.checkMintQuote(
      operation.mintUrl,
      this.adapter.method,
      operation.quoteId,
    );
    const expectedPubkey = operation.pubkey;

    const validationError = getReusableMintQuoteValidationError(remoteQuote, operation);
    if (validationError) {
      return {
        observedAt,
        validationFailure: {
          reason: validationError.message,
          code: 'invalid_quote',
          retryable: false,
          observedAt,
        },
      };
    }

    if (!expectedPubkey) {
      return {
        observedAt,
        quoteSnapshot: remoteQuote,
        validationFailure: {
          reason: `${this.adapter.quoteLabel} mint operation ${operation.id} is missing NUT-20 quote pubkey`,
          code: 'missing_quote_pubkey',
          retryable: false,
          observedAt,
        },
      };
    }

    return {
      observedAt,
      quoteSnapshot: remoteQuote,
    };
  }

  private async requireQuoteKey(pubkey: string): Promise<void> {
    const quoteKey = await this.keyRingService.getMintQuoteKeyPair(pubkey);
    if (!quoteKey) {
      throw new MintQuoteKeyError(`Missing NUT-20 mint quote key for pubkey ${pubkey}`);
    }
  }

  private async recoverSignedOutputs(
    ctx: RecoverExecutingContext<M>,
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
      ctx.logger?.warn(
        `Failed to recover ${this.adapter.recoveryLabel} mint outputs from output data`,
        {
          mintUrl: ctx.operation.mintUrl,
          quoteId: ctx.operation.quoteId,
          operationId: ctx.operation.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return {
        status: 'PENDING',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getQuoteValidationError(
    quote: MintMethodQuoteSnapshot<M>,
    expectedPubkey: string,
    expectedUnit: string,
  ): Error | null {
    try {
      this.adapter.assertQuoteMatchesRequest(quote, expectedPubkey, expectedUnit);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  private isAlreadyIssuedError(error: unknown): boolean {
    if (error instanceof MintOperationError && (error.code === 20002 || error.code === 11003)) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /already (issued|signed)|outputs? already/i.test(message);
  }
}
