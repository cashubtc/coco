import {
  Amount,
  OutputData,
  sumProofs,
  type MeltQuoteBolt11Response,
  type MeltQuoteBolt12Response,
  type OutputConfig,
  type Proof,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts';
import { MintOperationError, ProofValidationError } from '@core/models';
import type {
  BasePrepareContext,
  CreateMeltQuoteContext,
  ExecuteContext,
  ExecutionResult,
  FetchRemoteMeltQuoteContext,
  FinalizeContext,
  FinalizeResult,
  MeltMethodHandler,
  MeltMethodMeta,
  MeltMethod,
  MeltMethodQuoteSnapshot,
  MeltMethodRemoteState,
  PendingCheckResult,
  PendingContext,
  PreparedMeltOperation,
  RecoverExecutingContext,
  RollbackContext,
} from '@core/operations/melt';
import {
  computeYHexForSecrets,
  deserializeOutputData,
  mapProofToCoreProof,
  serializeOutputData,
  type SerializedOutputData,
} from '@core/utils';
import {
  SWAP_THRESHOLD_DENOMINATOR,
  SWAP_THRESHOLD_NUMERATOR,
  buildFailedResult,
  buildPaidResult,
  buildPendingResult,
  getSwapSendSecrets,
  type MeltQuoteData,
} from './QuoteMeltHandler.utils.ts';
import { assertSameUnit } from '@core/amounts';
import {
  meltQuoteFromBolt11Response,
  meltQuoteFromBolt12Response,
  meltQuoteFromOnchainResponse,
  type MeltQuote,
} from '../../../models/MeltQuote.ts';

export type BoltMeltQuoteState = 'UNPAID' | 'PENDING' | 'PAID';

export interface QuoteMeltResponse<M extends MeltMethod = MeltMethod> {
  state: MeltMethodRemoteState<M>;
  change?: SerializedBlindedSignature[];
  payment_preimage?: string | null;
  outpoint?: string | null;
}

export abstract class BaseQuoteMeltHandler<M extends MeltMethod> implements MeltMethodHandler<M> {
  protected abstract readonly method: M;

  protected abstract createRemoteQuote(
    ctx: CreateMeltQuoteContext<M>,
  ): Promise<MeltMethodQuoteSnapshot<M>>;

  protected abstract fetchRemoteMeltQuote(
    ctx: FetchRemoteMeltQuoteContext<M>,
  ): Promise<MeltMethodQuoteSnapshot<M>>;

  protected abstract executeMelt(
    ctx: ExecuteContext<M>,
    proofsToMelt: Proof[],
    changeOutputs: OutputData[],
    quoteId: string,
  ): Promise<QuoteMeltResponse<M>>;

  protected abstract checkMeltQuote(
    ctx: FinalizeContext<M> | RecoverExecutingContext<M>,
  ): Promise<QuoteMeltResponse<M>>;

  protected abstract checkMeltQuoteState(
    ctx: PendingContext<M> | RecoverExecutingContext<M>,
  ): Promise<MeltMethodRemoteState<M>>;

  protected abstract getFeeReserveForQuote(
    quote: MeltMethodQuoteSnapshot<M>,
    operation: BasePrepareContext<M>['operation'],
  ): Amount;

  protected abstract buildFinalizedData(
    response: QuoteMeltResponse<M>,
  ): FinalizeResult<M>['finalizedData'];

  async createQuote(ctx: CreateMeltQuoteContext<M>): Promise<MeltQuote<M>> {
    return this.toCanonicalQuote(ctx.mintUrl, await this.createRemoteQuote(ctx));
  }

  async fetchRemoteQuote(ctx: FetchRemoteMeltQuoteContext<M>): Promise<MeltQuote<M>> {
    return this.toCanonicalQuote(ctx.quote.mintUrl, await this.fetchRemoteMeltQuote(ctx));
  }

  private toCanonicalQuote(mintUrl: string, quote: MeltMethodQuoteSnapshot<M>): MeltQuote<M> {
    switch (this.method) {
      case 'bolt11':
        return meltQuoteFromBolt11Response(
          mintUrl,
          quote as MeltQuoteBolt11Response,
        ) as MeltQuote<M>;
      case 'bolt12':
        return meltQuoteFromBolt12Response(
          mintUrl,
          quote as MeltQuoteBolt12Response,
        ) as MeltQuote<M>;
      case 'onchain':
        return meltQuoteFromOnchainResponse(
          mintUrl,
          quote as MeltMethodQuoteSnapshot<'onchain'>,
        ) as MeltQuote<M>;
      default:
        throw new Error(`Unsupported melt method ${String(this.method)}`);
    }
  }

  // ============================================================================
  // Helper Functions
  // ============================================================================

  /**
   * Calculate change amount and effective fee from melt operation results.
   * These values are derived from the actual melt settlement, not from the quote.
   *
   * changeAmount: Sum of amounts from change proofs returned by the mint
   * effectiveFee: Actual fee paid = meltInputAmount - amount - changeAmount
   */
  private calculateSettlementAmounts(
    meltInputAmount: Amount,
    meltAmount: Amount,
    changeProofs?: SerializedBlindedSignature[],
  ): { changeAmount: Amount; effectiveFee: Amount } {
    const changeAmount = Amount.sum(changeProofs?.map((p) => p.amount) ?? []);
    const effectiveFee = meltInputAmount.subtract(meltAmount).subtract(changeAmount);
    return { changeAmount, effectiveFee };
  }

  private getPersistedSettlementResponse(quote?: MeltQuote<M>): QuoteMeltResponse<M> | null {
    if (!quote || quote.state !== 'PAID') {
      return null;
    }

    const change = quote.change ?? [];

    if (quote.method === 'onchain') {
      return {
        state: quote.state,
        change,
        outpoint: quote.outpoint ?? null,
      } as QuoteMeltResponse<M>;
    }

    return {
      state: quote.state,
      change,
      payment_preimage: quote.payment_preimage ?? null,
    } as QuoteMeltResponse<M>;
  }

  /**
   * Returns the amount of proofs that were actually sent to the melt call.
   * For swap melts this excludes proofs kept locally after the pre-swap.
   */
  private getMeltInputAmount(operation: {
    needsSwap: boolean;
    inputAmount: Amount;
    swapOutputData?: SerializedOutputData;
  }): Amount {
    if (!operation.needsSwap) {
      return operation.inputAmount;
    }

    if (!operation.swapOutputData) {
      throw new Error('Swap was required but swapOutputData is missing');
    }

    return OutputData.sumOutputAmounts(deserializeOutputData(operation.swapOutputData).send);
  }

  // ============================================================================
  // Prepare Phase
  // ============================================================================

  /**
   * Prepare a bolt-backed melt operation.
   *
   * This method:
   * 1. Uses the canonical melt quote supplied by the quote lifecycle
   * 2. Selects proofs to cover the quote amount + fee reserve with input fees
   * 3. Determines if a pre-swap is needed (when selected amount >> required)
   * 4. Reserves the input proofs for this operation
   * 5. Creates blank outputs for receiving change
   *
   * @returns Prepared operation ready for execution
   */
  async prepare(ctx: BasePrepareContext<M>): Promise<PreparedMeltOperation & MeltMethodMeta<M>> {
    const { mintUrl, id: operationId } = ctx.operation;
    ctx.logger?.debug(`Preparing ${this.method} melt operation`, { operationId, mintUrl });

    const quote = ctx.quote;
    assertSameUnit(quote.unit, ctx.operation.unit, `Melt quote ${quote.quote}`);
    const { amount } = quote;
    const fee_reserve = this.getFeeReserveForQuote(quote, ctx.operation);
    const quoteData: MeltQuoteData = {
      quote: quote.quote,
      amount,
      fee_reserve,
      unit: quote.unit,
    };
    const totalAmount = amount.add(fee_reserve);

    ctx.logger?.debug('Melt quote created', {
      operationId,
      quoteId: quote.quote,
      amount,
      fee_reserve,
      totalAmount,
    });

    const selectedProofs = await ctx.proofService.selectProofsToSend(
      mintUrl,
      {
        amount: totalAmount,
        unit: ctx.operation.unit,
      },
      true,
    );
    const selectedAmount = sumProofs(selectedProofs);
    if (selectedAmount.lessThan(totalAmount)) {
      throw new ProofValidationError('Melt amount is not sufficient after fees');
    }
    const swapThreshold = totalAmount.scaledBy(
      SWAP_THRESHOLD_NUMERATOR,
      SWAP_THRESHOLD_DENOMINATOR,
    );
    const needsSwap = selectedAmount.greaterThanOrEqual(swapThreshold);

    ctx.logger?.debug('Proofs selected for melt', {
      operationId,
      selectedAmount,
      swapThreshold,
      proofCount: selectedProofs.length,
      needsSwap,
    });

    if (!needsSwap) {
      return this.prepareDirectMelt(ctx, quoteData, selectedProofs);
    }
    return this.prepareSwapThenMelt(ctx, quoteData, totalAmount);
  }

  /**
   * Prepare a direct melt (no swap needed).
   * Used when selected proofs are close to the required amount.
   */
  private async prepareDirectMelt(
    ctx: BasePrepareContext<M>,
    quote: MeltQuoteData,
    selectedProofs: Proof[],
  ): Promise<PreparedMeltOperation & MeltMethodMeta<M>> {
    const { mintUrl, id: operationId } = ctx.operation;
    const { amount, fee_reserve } = quote;
    const inputSecrets = selectedProofs.map((p) => p.secret);
    const selectedAmount = sumProofs(selectedProofs);

    ctx.logger?.debug('Preparing direct melt (no swap)', { operationId, selectedAmount });

    await ctx.proofService.reserveProofs(mintUrl, inputSecrets, operationId, {
      unit: ctx.operation.unit,
    });

    const blankOutputs = await this.createChangeOutputs(amount, selectedAmount, ctx);

    ctx.logger?.info('Direct melt prepared', {
      operationId,
      quoteId: quote.quote,
      amount,
      fee_reserve,
      inputAmount: selectedAmount,
    });

    return {
      ...ctx.operation,
      ...ctx.operation.methodData,
      quoteId: quote.quote,
      unit: ctx.operation.unit,
      changeOutputData: serializeOutputData({ keep: blankOutputs, send: [] }),
      needsSwap: false,
      amount,
      fee_reserve,
      inputAmount: selectedAmount,
      inputProofSecrets: inputSecrets,
      swap_fee: Amount.zero(),
      state: 'prepared',
    };
  }

  /**
   * Prepare a swap-then-melt operation.
   * Used when selected proofs significantly exceed the required amount.
   */
  private async prepareSwapThenMelt(
    ctx: BasePrepareContext<M>,
    quote: MeltQuoteData,
    totalAmount: Amount,
  ): Promise<PreparedMeltOperation & MeltMethodMeta<M>> {
    const { mintUrl, id: operationId } = ctx.operation;
    const { amount, fee_reserve } = quote;

    ctx.logger?.debug('Preparing swap-then-melt', { operationId, totalAmount });

    // Re-select proofs including the swap fee
    const selectedProofs = await ctx.proofService.selectProofsToSend(
      mintUrl,
      {
        amount: totalAmount,
        unit: ctx.operation.unit,
      },
      true,
    );
    const selectedAmount = sumProofs(selectedProofs);
    const inputSecrets = selectedProofs.map((p) => p.secret);

    const swapFee = ctx.wallet.getFeesForProofs(selectedProofs);
    const sendAmount = totalAmount;
    const requiredAmount = sendAmount.add(swapFee);
    if (selectedAmount.lessThan(requiredAmount)) {
      throw new ProofValidationError('Melt amount is not sufficient after fees');
    }
    const keepAmount = selectedAmount.subtract(requiredAmount);

    ctx.logger?.debug('Swap amounts calculated', {
      operationId,
      selectedAmount,
      sendAmount,
      keepAmount,
      swapFee,
    });

    await ctx.proofService.reserveProofs(mintUrl, inputSecrets, operationId, {
      unit: ctx.operation.unit,
    });

    const blankOutputs = await this.createChangeOutputs(amount, sendAmount, ctx);

    // FIXME: This relies on the 10% swap threshold buffer to cover the future melt input fee.
    // Pathological fee/output combinations can still make the fee-inflated send side exceed
    // the amount validated above.
    const swapOutputData = await ctx.proofService.createOutputsAndIncrementCounters(
      mintUrl,
      {
        keep: { amount: keepAmount, unit: ctx.operation.unit },
        send: { amount: sendAmount, unit: ctx.operation.unit },
      },
      { includeFees: true },
    );

    ctx.logger?.info('Swap-then-melt prepared', {
      operationId,
      quoteId: quote.quote,
      amount,
      fee_reserve,
      inputAmount: selectedAmount,
      swapFee,
    });

    return {
      ...ctx.operation,
      ...ctx.operation.methodData,
      quoteId: quote.quote,
      unit: ctx.operation.unit,
      swapOutputData: serializeOutputData(swapOutputData),
      changeOutputData: serializeOutputData({ keep: blankOutputs, send: [] }),
      needsSwap: true,
      swap_fee: swapFee,
      amount,
      fee_reserve,
      inputAmount: selectedAmount,
      inputProofSecrets: inputSecrets,
      state: 'prepared',
    };
  }

  /**
   * Create blank outputs to receive change from the melt operation.
   * The change is the difference between what we send and the quote amount.
   */
  private async createChangeOutputs(
    quoteAmount: Amount,
    sendAmount: Amount,
    ctx: BasePrepareContext<M>,
  ) {
    const changeDelta = sendAmount.subtract(quoteAmount);
    return ctx.proofService.createBlankOutputs(ctx.operation.mintUrl, {
      amount: changeDelta,
      unit: ctx.operation.unit,
    });
  }

  // ============================================================================
  // Execute Phase
  // ============================================================================

  /**
   * Execute the bolt11 melt operation.
   *
   * This method:
   * 1. Retrieves the reserved input proofs
   * 2. If swap is needed, performs the swap first to get exact-amount proofs
   * 3. Sends the melt request to the mint
   * 4. Handles the response (PAID → finalize, PENDING → wait, UNPAID → restore proofs)
   */
  async execute(ctx: ExecuteContext<M>): Promise<ExecutionResult<M>> {
    const {
      quoteId,
      mintUrl,
      changeOutputData: serializedChangeOutputData,
      id: operationId,
    } = ctx.operation;

    ctx.logger?.debug(`Executing ${this.method} melt`, {
      operationId,
      quoteId,
      needsSwap: ctx.operation.needsSwap,
    });

    const inputProofs = await this.getInputProofs(ctx);
    const proofsToMelt = ctx.operation.needsSwap
      ? await this.executeSwap(ctx, inputProofs)
      : inputProofs;

    // For direct melt, set proofs to inflight before sending to mint
    // (For swap path, swap send proofs are already saved as inflight in executeSwap)
    if (!ctx.operation.needsSwap) {
      await ctx.proofService.setProofState(mintUrl, ctx.operation.inputProofSecrets, 'inflight');
    }

    ctx.logger?.debug('Sending melt request to mint', {
      operationId,
      quoteId,
      proofCount: proofsToMelt.length,
    });

    const changeOutputData = deserializeOutputData(serializedChangeOutputData);
    const res = await this.executeMelt(ctx, proofsToMelt, changeOutputData.keep, quoteId);

    ctx.logger?.info('Melt execution completed', { operationId, quoteId, state: res.state });

    return this.handleMeltResponse(ctx, res, proofsToMelt);
  }

  /**
   * Handle the melt response and return the appropriate execution result.
   */
  private async handleMeltResponse(
    ctx: ExecuteContext<M>,
    response: {
      state: 'PAID' | 'UNPAID' | 'PENDING';
      change?: SerializedBlindedSignature[];
      payment_preimage?: string | null;
      outpoint?: string | null;
    },
    proofsToMelt: Proof[],
  ): Promise<ExecutionResult<M>> {
    const { mintUrl } = ctx.operation;
    const { state, change } = response;

    switch (state) {
      case 'PAID': {
        const { amount: meltAmount } = ctx.operation;
        const meltInputAmount = this.getMeltInputAmount(ctx.operation);
        const { changeAmount, effectiveFee } = this.calculateSettlementAmounts(
          meltInputAmount,
          meltAmount,
          change,
        );
        await this.finalizeOperation(ctx, change);
        return buildPaidResult(ctx.operation, {
          changeAmount,
          effectiveFee,
          finalizedData: this.buildFinalizedData(response),
        });
      }

      case 'PENDING':
        // Proofs stay inflight, finalize will be called later via checkPending -> finalize
        return buildPendingResult(ctx.operation);

      case 'UNPAID':
        // Melt failed so we release proofs
        await ctx.proofService.restoreProofsToReady(
          mintUrl,
          proofsToMelt.map((p) => p.secret),
        );
        return buildFailedResult(ctx.operation);

      default:
        throw new Error(
          `Unexpected melt response state: ${state} for quote ${ctx.operation.quoteId}`,
        );
    }
  }

  /**
   * Retrieve the input proofs reserved for this operation.
   */
  private async getInputProofs(ctx: ExecuteContext<M>): Promise<Proof[]> {
    const { mintUrl, id: operationId } = ctx.operation;
    const proofs = await ctx.proofRepository.getProofsByOperationId(mintUrl, operationId);
    if (proofs.length !== ctx.operation.inputProofSecrets.length) {
      throw new Error('Could not find all input proofs');
    }
    return proofs;
  }

  /**
   * Execute the pre-melt swap to get exact-amount proofs.
   * Returns the "send" proofs from the swap which will be used for the melt.
   */
  private async executeSwap(ctx: ExecuteContext<M>, inputProofs: Proof[]): Promise<Proof[]> {
    const { swapOutputData, inputProofSecrets, id: operationId, mintUrl } = ctx.operation;

    if (!swapOutputData) {
      throw new Error('Swap is required, but swap output data is missing');
    }

    const swapData = deserializeOutputData(swapOutputData);
    const sendAmount = OutputData.sumOutputAmounts(swapData.send);
    const { wallet } = await ctx.walletService.getWalletWithActiveKeysetId(
      mintUrl,
      ctx.operation.unit,
    );

    ctx.logger?.debug('Executing pre-melt swap', {
      operationId,
      sendAmount,
      inputProofCount: inputProofs.length,
    });

    await ctx.proofService.setProofState(mintUrl, inputProofSecrets, 'inflight');
    const outputConfig: OutputConfig = {
      send: { type: 'custom', data: swapData.send },
      keep: { type: 'custom', data: swapData.keep },
    };
    const { send, keep } = await wallet.send(sendAmount, inputProofs, undefined, outputConfig);
    await ctx.proofService.setProofState(mintUrl, inputProofSecrets, 'spent');

    const newProofs = [
      ...mapProofToCoreProof(mintUrl, 'ready', keep, {
        unit: ctx.operation.unit,
        createdByOperationId: operationId,
      }),
      ...mapProofToCoreProof(mintUrl, 'inflight', send, {
        unit: ctx.operation.unit,
        createdByOperationId: operationId,
      }),
    ];
    await ctx.proofService.saveProofs(mintUrl, newProofs);

    ctx.logger?.debug('Pre-melt swap completed', {
      operationId,
      keepCount: keep.length,
      sendCount: send.length,
    });

    return send;
  }

  // ============================================================================
  // Finalize Phase
  // ============================================================================

  /**
   * Finalize a pending melt operation that has succeeded.
   * Called by MeltOperationService when checkPending returns 'finalize'.
   * Returns settlement amounts for accurate accounting.
   */
  async finalize(ctx: FinalizeContext<M>): Promise<FinalizeResult<M>> {
    const { quoteId, id: operationId, amount: meltAmount } = ctx.operation;

    ctx.logger?.debug('Finalizing pending melt operation', { operationId, quoteId });

    const res =
      this.getPersistedSettlementResponse(ctx.canonicalQuote) ?? (await this.checkMeltQuote(ctx));

    if (res.state !== 'PAID') {
      throw new Error(`Cannot finalize: melt quote ${quoteId} is ${res.state}, expected PAID`);
    }

    const meltInputAmount = this.getMeltInputAmount(ctx.operation);

    // Calculate actual settlement amounts from the mint response
    const { changeAmount, effectiveFee } = this.calculateSettlementAmounts(
      meltInputAmount,
      meltAmount,
      res.change,
    );

    await this.finalizeOperation(ctx, res.change);

    ctx.logger?.info('Pending melt operation finalized with settlement amounts', {
      operationId,
      quoteId,
      changeAmount,
      effectiveFee,
    });

    return {
      changeAmount,
      effectiveFee,
      finalizedData: this.buildFinalizedData(res),
    };
  }

  /**
   * Finalize a melt operation by marking input proofs as spent and saving change proofs.
   * Called immediately when melt returns PAID, or later when a pending melt succeeds.
   */
  private async finalizeOperation(
    ctx: ExecuteContext<M> | FinalizeContext<M> | RecoverExecutingContext<M>,
    change?: SerializedBlindedSignature[],
  ): Promise<void> {
    const {
      mintUrl,
      id: operationId,
      changeOutputData: serializedChangeOutputData,
    } = ctx.operation;
    const meltInputSecrets = this.getMeltInputSecrets(ctx.operation);

    // Mark melt input proofs as spent
    await ctx.proofService.setProofState(mintUrl, meltInputSecrets, 'spent');

    // Handle change proofs if any
    if (change && change.length > 0) {
      const changeOutputData = deserializeOutputData(serializedChangeOutputData).keep;
      await ctx.proofService.unblindAndSaveChangeProofs(mintUrl, changeOutputData, change, {
        unit: ctx.operation.unit,
        createdByOperationId: operationId,
      });
    }

    ctx.logger?.info('Melt operation finalized', {
      operationId,
      spentProofCount: meltInputSecrets.length,
      changeProofCount: change?.length ?? 0,
    });
  }

  // ============================================================================
  // Pending & Rollback
  // ============================================================================

  /**
   * Check the state of a pending melt operation.
   * Returns 'finalize' if paid, 'stay_pending' if still pending, 'rollback' if unpaid/failed.
   */
  async checkPending(ctx: PendingContext<M>): Promise<PendingCheckResult> {
    const { quoteId, id: operationId } = ctx.operation;

    ctx.logger?.debug('Checking pending melt operation', { operationId, quoteId });

    const state = ctx.canonicalQuote?.state ?? (await this.checkMeltQuoteState(ctx));

    ctx.logger?.debug('Pending melt quote state', { operationId, quoteId, state });

    switch (state) {
      case 'PAID':
        return 'finalize';
      case 'PENDING':
        return 'stay_pending';
      case 'UNPAID':
        return 'rollback';
      default:
        throw new Error(`Unexpected melt quote state: ${state} for quote ${quoteId}`);
    }
  }

  /**
   * Rollback a melt operation by restoring input proofs to ready state.
   */
  async rollback(ctx: RollbackContext<M>): Promise<void> {
    const { id: operationId, mintUrl, needsSwap } = ctx.operation;
    ctx.logger?.debug(`Rolling back ${this.method} melt operation`, { operationId, needsSwap });

    if (needsSwap) {
      // Restore swap send proofs (inflight → ready). No-op if swap wasn't executed yet.
      const swapSendSecrets = getSwapSendSecrets(ctx.operation.swapOutputData!);
      await ctx.proofService.restoreProofsToReady(mintUrl, swapSendSecrets);

      // Release original input proofs (clear usedByOperationId only, don't change state).
      // Pre-execute: proofs are "ready" + reserved → released.
      // Post-execute: proofs are "spent" → clearing usedByOperationId is harmless
      // since spent proofs are never returned by getReadyProofs().
      await ctx.proofService.releaseProofs(mintUrl, ctx.operation.inputProofSecrets);
    } else {
      await ctx.proofService.restoreProofsToReady(mintUrl, ctx.operation.inputProofSecrets);
    }

    ctx.logger?.info('Melt operation rolled back, proofs restored', {
      operationId,
      needsSwap,
      proofCount: ctx.operation.inputProofSecrets.length,
    });
  }

  // ============================================================================
  // Recovery
  // ============================================================================

  /**
   * Recover an executing operation after a crash/restart.
   *
   * Recovery logic:
   * - PAID: Finalize the operation (mark proofs spent, save change)
   * - PENDING: Transition to pending state for continued monitoring
   * - UNPAID: Determine what happened and restore/recover proofs appropriately
   *   - If no swap was needed or swap never happened: release original proofs
   *   - If swap happened and proofs exist locally: restore them to ready
   *   - If swap happened but proofs missing: recover from mint
   */
  async recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<ExecutionResult<M>> {
    const { operation } = ctx;
    const { quoteId, needsSwap, id: operationId } = operation;

    ctx.logger?.debug(`Recovering executing ${this.method} melt operation`, {
      operationId,
      quoteId,
      needsSwap,
    });

    let state: string;
    try {
      state = await this.checkMeltQuoteState(ctx);
    } catch (err) {
      if (err instanceof MintOperationError && err.code === 20007) {
        ctx.logger?.info('Melt quote expired during recovery, treating as UNPAID', {
          operationId,
          quoteId,
        });
        return this.recoverExecutingUnpaidOperation(ctx);
      }
      throw err;
    }

    ctx.logger?.debug('Melt quote state checked during recovery', { operationId, quoteId, state });

    switch (state) {
      case 'PAID':
        return this.recoverExecutingPaidOperation(ctx);

      case 'PENDING':
        return this.recoverExecutingPendingOperation(ctx);

      case 'UNPAID':
        return this.recoverExecutingUnpaidOperation(ctx);

      default:
        throw new Error(`Unexpected melt response state: ${state} for quote ${quoteId}`);
    }
  }

  /**
   * Recover an executing operation that was actually paid.
   * Fetches change signatures and finalizes the operation.
   * Returns execution result with actual settlement amounts.
   */
  private async recoverExecutingPaidOperation(
    ctx: RecoverExecutingContext<M>,
  ): Promise<ExecutionResult<M>> {
    const { quoteId, id: operationId, amount: meltAmount } = ctx.operation;

    ctx.logger?.debug('Recovering executing operation as paid, fetching change', {
      operationId,
      quoteId,
    });

    // Fetch melt quote to get any change signatures
    const res = await this.checkMeltQuote(ctx);

    const meltInputAmount = this.getMeltInputAmount(ctx.operation);

    // Calculate actual settlement amounts from the mint response
    const { changeAmount, effectiveFee } = this.calculateSettlementAmounts(
      meltInputAmount,
      meltAmount,
      res.change,
    );

    // Finalize the operation (mark proofs spent, save change)
    await this.finalizeOperation(ctx, res.change);

    ctx.logger?.info('Recovered and finalized paid melt operation', {
      operationId,
      quoteId,
      changeAmount,
      effectiveFee,
    });

    return buildPaidResult(ctx.operation, {
      changeAmount,
      effectiveFee,
      finalizedData: this.buildFinalizedData(res),
    });
  }

  /**
   * Recover an executing operation that is now pending.
   * Transitions to pending state for continued monitoring.
   */
  private async recoverExecutingPendingOperation(
    ctx: RecoverExecutingContext<M>,
  ): Promise<ExecutionResult<M>> {
    ctx.logger?.info('Recovered executing operation as pending', {
      operationId: ctx.operation.id,
      quoteId: ctx.operation.quoteId,
    });
    return buildPendingResult(ctx.operation);
  }

  /**
   * Recover an executing operation that is unpaid.
   * Determines the appropriate recovery path based on whether a swap occurred.
   */
  private async recoverExecutingUnpaidOperation(
    ctx: RecoverExecutingContext<M>,
  ): Promise<ExecutionResult<M>> {
    const { needsSwap, id: operationId } = ctx.operation;

    // If no swap was needed, or swap never happened, release original proofs
    if (!needsSwap || !(await this.checkSwapHappened(ctx))) {
      ctx.logger?.debug('Unpaid quote recovery: no swap occurred', { operationId });
      return this.recoverExecutingWithoutSwap(ctx);
    }

    // Swap happened - check if proofs exist locally
    ctx.logger?.debug('Unpaid quote recovery: swap occurred, checking local proofs', {
      operationId,
    });
    const localSwapProofs = await this.findLocalSwapSendProofs(ctx);

    if (localSwapProofs.length > 0) {
      return this.recoverExecutingWithLocalSwapProofs(ctx, localSwapProofs);
    }
    return this.recoverExecutingSwapProofsFromMint(ctx);
  }

  /**
   * Recover when swap happened and proofs exist locally.
   * Restores the swap send proofs to ready state.
   */
  private async recoverExecutingWithLocalSwapProofs(
    ctx: RecoverExecutingContext<M>,
    swapSendProofs: Proof[],
  ): Promise<ExecutionResult<M>> {
    const { operation } = ctx;
    const { mintUrl, id: operationId } = operation;

    const swappedSecrets = swapSendProofs.map((p) => p.secret);
    // Swap happened but melt either failed or was not initiated
    // -> Restore proofs to ready and clear reservation
    await ctx.proofService.restoreProofsToReady(mintUrl, swappedSecrets);

    ctx.logger?.info('Recovered swap proofs, melt failed', {
      operationId,
      recoveredProofCount: swapSendProofs.length,
    });

    return buildFailedResult(
      operation,
      'Recovered: Swap happened but melt failed / never executed',
    );
  }

  /**
   * Recover when swap happened but proofs weren't saved locally.
   * This can happen if the app crashed after the swap but before saving proofs.
   * Recovers proofs from the mint using the swap output data.
   */
  private async recoverExecutingSwapProofsFromMint(
    ctx: RecoverExecutingContext<M>,
  ): Promise<ExecutionResult<M>> {
    const { operation } = ctx;
    const { swapOutputData, id: operationId, mintUrl } = operation;

    if (!swapOutputData) {
      throw new Error('Swap was required but swapOutputData is missing');
    }

    ctx.logger?.debug('Swap proofs not found locally, recovering from mint', { operationId });

    await ctx.proofService.recoverProofsFromOutputData(mintUrl, swapOutputData, {
      unit: operation.unit,
      createdByOperationId: operationId,
    });

    try {
      await ctx.proofService.setProofState(mintUrl, operation.inputProofSecrets, 'spent');
    } catch {
      ctx.logger?.warn('Failed to mark input proofs as spent', { operationId });
    }

    ctx.logger?.info('Recovered proofs from mint after swap', { operationId });

    return buildFailedResult(operation, 'Recovered: Swap happened, proofs restored from mint');
  }

  /**
   * Recover when no swap occurred - restore original proofs to ready.
   */
  private async recoverExecutingWithoutSwap(
    ctx: RecoverExecutingContext<M>,
  ): Promise<ExecutionResult<M>> {
    const { operation } = ctx;
    const { mintUrl, inputProofSecrets, id: operationId } = operation;

    await ctx.proofService.restoreProofsToReady(mintUrl, inputProofSecrets);

    ctx.logger?.info('Restored proofs after failed melt (no swap occurred)', {
      operationId,
      proofCount: inputProofSecrets.length,
    });

    return buildFailedResult(operation, 'Recovered: Swap never executed, released original proofs');
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Check if the swap was executed by verifying if input proofs are spent.
   */
  private async checkSwapHappened(ctx: RecoverExecutingContext<M>): Promise<boolean> {
    const { operation, mintAdapter } = ctx;
    const { inputProofSecrets, mintUrl } = operation;
    const Ys = computeYHexForSecrets(inputProofSecrets);
    const proofStates = await mintAdapter.checkProofStates(mintUrl, Ys);
    // We use some, because generally we assume that proofs are spent together
    return proofStates.some((proofState) => proofState.state === 'SPENT');
  }

  /**
   * Find swap send proofs that were saved locally during the swap.
   * Returns empty array if proofs don't exist (crash before save).
   */
  private async findLocalSwapSendProofs(ctx: RecoverExecutingContext<M>): Promise<Proof[]> {
    const { swapOutputData, id: operationId, mintUrl } = ctx.operation;
    if (!swapOutputData) return [];

    const swapSendSecrets = getSwapSendSecrets(swapOutputData);
    const operationProofs = await ctx.proofRepository.getProofsByOperationId(mintUrl, operationId);

    return operationProofs.filter((p) => swapSendSecrets.includes(p.secret));
  }

  /**
   * Get the secrets of proofs that were sent to the melt operation.
   * For direct melt: these are the original input proofs.
   * For swap-then-melt: these are the swap send proofs (derived from swapOutputData).
   */
  private getMeltInputSecrets(operation: {
    needsSwap: boolean;
    inputProofSecrets: string[];
    swapOutputData?: SerializedOutputData;
  }): string[] {
    if (!operation.needsSwap) {
      return operation.inputProofSecrets;
    }
    if (!operation.swapOutputData) {
      throw new Error('Swap was required but swapOutputData is missing');
    }
    return getSwapSendSecrets(operation.swapOutputData);
  }
}
