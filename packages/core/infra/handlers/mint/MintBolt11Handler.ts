import { Amount } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { assertSameUnit } from '@core/amounts';
import type {
  CreateMintQuoteContext,
  ExecuteContext,
  MintMethodMeta,
  PrepareContext,
  MintMethodHandler,
  MintExecutionResult,
  PendingMintOperation,
  RecoverExecutingResult,
  RecoverExecutingContext,
  PendingContext,
  PendingMintCheckResult,
  FetchRemoteMintQuoteContext,
} from '@core/operations/mint';
import { deserializeOutputData, mapProofToCoreProof, serializeOutputData } from '@core/utils';
import { redactSensitiveValue } from '../../../logging/redaction';
import { MintOperationError } from '../../../models/Error';
import type { KeyRingService } from '../../../services/KeyRingService';
import {
  getMintQuoteRemoteState,
  mintQuoteFromBolt11Response,
  type AccountingMintQuoteBolt11Response,
  type MintQuote,
} from '../../../models/MintQuote';

export class MintBolt11Handler implements MintMethodHandler<'bolt11'> {
  constructor(private readonly keyRingService: KeyRingService) {}

  async createQuote(ctx: CreateMintQuoteContext<'bolt11'>): Promise<MintQuote<'bolt11'>> {
    const { amount, pubkey } = ctx.createQuoteData;
    if (pubkey) {
      await ctx.mintService.assertNutSupported(ctx.mintUrl, 20, 'locked BOLT11 mint quote');
    }
    const remoteQuote = pubkey
      ? await ctx.wallet.createLockedMintQuote(amount.amount, pubkey)
      : await ctx.wallet.createMintQuoteBolt11(amount.amount);
    if (pubkey && remoteQuote.pubkey !== pubkey) {
      throw new Error('Mint returned a BOLT11 quote with an unexpected NUT-20 public key');
    }
    return mintQuoteFromBolt11Response(ctx.mintUrl, remoteQuote);
  }

  async fetchRemoteQuote(ctx: FetchRemoteMintQuoteContext<'bolt11'>): Promise<MintQuote<'bolt11'>> {
    const remoteQuote = await ctx.mintAdapter.checkMintQuote(
      ctx.quote.mintUrl,
      'bolt11',
      ctx.quote.quoteId,
    );
    return mintQuoteFromBolt11Response(ctx.quote.mintUrl, remoteQuote);
  }

  async prepare(
    ctx: PrepareContext<'bolt11'>,
  ): Promise<PendingMintOperation<'bolt11'> & MintMethodMeta<'bolt11'>> {
    const quote = ctx.importedQuote;
    if (!quote) {
      throw new Error('BOLT11 mint quote was not provided');
    }
    const quoteRef = redactSensitiveValue(quote.quote);

    if (!quote.amount || quote.amount.isZero()) {
      throw new Error(`Mint quote ${quoteRef} has invalid amount`);
    }

    if (ctx.operation.quoteId !== quote.quote) {
      throw new Error(`Mint quote ${quoteRef} does not match the operation quote`);
    }

    if (!quote.amount.equals(ctx.operation.amount)) {
      throw new Error(
        `Mint quote ${quoteRef} amount ${quote.amount} does not match requested amount ${ctx.operation.amount}`,
      );
    }

    assertSameUnit(quote.unit, ctx.operation.unit, `Mint quote ${quoteRef}`);
    await this.requireQuoteKey(quote.pubkey);

    const outputData = await ctx.proofService.createOutputsAndIncrementCounters(
      ctx.operation.mintUrl,
      {
        keep: { amount: quote.amount, unit: ctx.operation.unit },
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
      amount: quote.amount,
      unit: ctx.operation.unit,
      request: quote.request,
      expiry: quote.expiry,
      pubkey: quote.pubkey,
      outputData: serializeOutputData({ keep: outputData.keep, send: [] }),
      state: 'pending',
    };
  }

  async execute(ctx: ExecuteContext<'bolt11'>): Promise<MintExecutionResult> {
    const outputData = deserializeOutputData(ctx.operation.outputData);
    const mintConfig = await this.getMintConfig(ctx.operation.pubkey);

    try {
      const proofs = await ctx.wallet.mintProofsBolt11(
        ctx.operation.amount,
        ctx.operation.quoteId,
        mintConfig,
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

  async recoverExecuting(ctx: RecoverExecutingContext<'bolt11'>): Promise<RecoverExecutingResult> {
    const { mintUrl, quoteId } = ctx.operation;
    const quoteRef = redactSensitiveValue(quoteId);
    let remoteQuote: AccountingMintQuoteBolt11Response;
    try {
      remoteQuote = await ctx.mintAdapter.checkMintQuote(mintUrl, 'bolt11', quoteId);
    } catch (error) {
      ctx.logger?.warn('Failed to check mint quote state during recovery', {
        mintUrl,
        quoteRef,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'PENDING',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (ctx.operation.pubkey && remoteQuote.pubkey !== ctx.operation.pubkey) {
      return {
        status: 'TERMINAL',
        error: `Recovered: BOLT11 mint operation ${ctx.operation.id} has mismatched NUT-20 quote ownership`,
      };
    }

    const canonicalRemoteQuote = mintQuoteFromBolt11Response(mintUrl, remoteQuote);
    const remoteState = getMintQuoteRemoteState(canonicalRemoteQuote);
    if (remoteState === 'PAID') {
      const outputData = deserializeOutputData(ctx.operation.outputData);
      try {
        const mintConfig = await this.getMintConfig(ctx.operation.pubkey);
        const proofs = await ctx.wallet.mintProofsBolt11(
          ctx.operation.amount,
          ctx.operation.quoteId,
          mintConfig,
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
            // Quote already issued; fall through to proof recovery
          } else if (err.code === 20007) {
            return {
              status: 'TERMINAL',
              error: `Recovered: quote ${quoteRef} expired while executing mint`,
            };
          } else {
            return {
              status: 'PENDING',
              error: err.message,
            };
          }
        } else {
          return {
            status: 'PENDING',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    } else if (remoteState === 'UNPAID') {
      return {
        status: 'PENDING',
        error: `Recovered: quote ${quoteRef} is still UNPAID`,
      };
    } else if (remoteState !== 'ISSUED') {
      return {
        status: 'PENDING',
        error: `Recovered: quote ${quoteRef} remains in remote state ${String(remoteState)}`,
      };
    }

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
          error: `Recovered: quote ${quoteRef} issued remotely but proofs were not recoverable`,
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

  async checkPending(ctx: PendingContext<'bolt11'>): Promise<PendingMintCheckResult<'bolt11'>> {
    const { mintUrl, quoteId } = ctx.operation;
    const quoteRef = redactSensitiveValue(quoteId);
    ctx.logger?.info('Checking pending mint operation', { mintUrl, quoteRef });

    const quote = await ctx.mintAdapter.checkMintQuote(mintUrl, 'bolt11', quoteId);
    const canonicalQuote = mintQuoteFromBolt11Response(mintUrl, quote);
    const remoteState = getMintQuoteRemoteState(canonicalQuote);
    ctx.logger?.info('Pending mint quote state', { mintUrl, quoteRef, state: remoteState });
    const observedRemoteStateAt = Date.now();

    switch (remoteState) {
      case 'UNPAID':
        return {
          observedRemoteState: remoteState,
          observedRemoteStateAt,
          quoteSnapshot: quote,
          category: 'waiting',
        };
      case 'PAID':
        return {
          observedRemoteState: remoteState,
          observedRemoteStateAt,
          quoteSnapshot: quote,
          category: 'ready',
        };
      case 'ISSUED':
        return {
          observedRemoteState: remoteState,
          observedRemoteStateAt,
          quoteSnapshot: quote,
          category: 'completed',
        };
      default:
        throw new Error(
          `Unexpected mint quote state: ${String(remoteState)} for quote ${quoteRef} at mint ${mintUrl}`,
        );
    }
  }

  async validateQuoteForPrepare(quote: MintQuote<'bolt11'>): Promise<void> {
    await this.requireQuoteKey(quote.pubkey);
  }

  private async requireQuoteKey(pubkey: string | undefined): Promise<void> {
    if (!pubkey) return;
    const key = await this.keyRingService.getMintQuoteKeyPair(pubkey);
    if (!key) {
      throw new Error('Missing NUT-20 mint quote key for locked BOLT11 quote');
    }
  }

  private async getMintConfig(
    pubkey: string | undefined,
  ): Promise<{ privkey: string } | undefined> {
    if (!pubkey) return undefined;
    const key = await this.keyRingService.getMintQuoteKeyPair(pubkey);
    if (!key) {
      throw new Error('Missing NUT-20 mint quote key for locked BOLT11 quote');
    }
    return { privkey: bytesToHex(key.secretKey) };
  }
}
