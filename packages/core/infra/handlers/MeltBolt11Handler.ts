import type { Proof, SerializedBlindedSignature, OutputConfig } from '@cashu/cashu-ts';
import type {
  BasePrepareContext,
  ExecuteContext,
  ExecutionResult,
  FinalizeContext,
  MeltMethodHandler,
  MeltMethodMeta,
  PendingCheckResult,
  PendingContext,
  PreparedMeltOperation,
  RecoverExecutingContext,
  RollbackContext,
} from '@core/operations/melt';
import {
  deserializeOutputData,
  serializeOutputData,
  mapProofToCoreProof,
  computeYHexForSecrets,
  type SerializedOutputData,
} from '@core/utils';
import {
  type MeltQuoteData,
  SWAP_THRESHOLD_RATIO,
  sumProofs,
  getSwapSendSecrets,
  buildPaidResult,
  buildPendingResult,
  buildFailedResult,
} from './MeltBolt11Handler.utils.ts';

export class MeltBolt11Handler implements MeltMethodHandler<'bolt11'> {
  // ============================================================================
  // Prepare Phase
  // ============================================================================

  /**
   * Prepare a bolt11 melt operation.
   *
   * This method:
   * 1. Creates a melt quote from the mint for the lightning invoice
   * 2. Selects proofs to cover the quote amount + fee reserve
   * 3. Determines if a pre-swap is needed (when selected amount >> required)
   * 4. Reserves the input proofs for this operation
   * 5. Creates blank outputs for receiving change
   *
   * @returns Prepared operation ready for execution
   */
  async prepare(
    ctx: BasePrepareContext<'bolt11'>,
  ): Promise<PreparedMeltOperation & MeltMethodMeta<'bolt11'>> {
    const { mintUrl, id: operationId } = ctx.operation;
    ctx.logger?.debug('Preparing bolt11 melt operation', { operationId, mintUrl });

    const quote = await ctx.wallet.createMeltQuote(ctx.operation.methodData.invoice);
    const { amount, fee_reserve } = quote;
    const totalAmount = amount + fee_reserve;

    ctx.logger?.debug('Melt quote created', {
      operationId,
      quoteId: quote.quote,
      amount,
      fee_reserve,
      totalAmount,
    });

    const selectedProofs = await ctx.proofService.selectProofsToSend(mintUrl, totalAmount, ctx.operation.unit, false);
    const selectedAmount = sumProofs(selectedProofs);
    const needsSwap = selectedAmount >= Math.floor(totalAmount * SWAP_THRESHOLD_RATIO);

    ctx.logger?.debug('Proofs selected for melt', {
      operationId,
      selectedAmount,
      proofCount: selectedProofs.length,
      needsSwap,
    });

    if (!needsSwap) {
      return this.prepareDirectMelt(ctx, quote, selectedProofs);
    }
    return this.prepareSwapThenMelt(ctx, quote, totalAmount);
  }

  /**
   * Prepare a direct melt (no swap needed).
   * Used when selected proofs are close to the required amount.
   */
  private async prepareDirectMelt(
    ctx: BasePrepareContext<'bolt11'>,
    quote: MeltQuoteData,
    selectedProofs: Proof[],
  ): Promise<PreparedMeltOperation & MeltMethodMeta<'bolt11'>> {
    const { mintUrl, id: operationId } = ctx.operation;
    const { amount, fee_reserve } = quote;
    const inputSecrets = selectedProofs.map((p) => p.secret);
    const selectedAmount = sumProofs(selectedProofs);

    ctx.logger?.debug('Preparing direct melt (no swap)', { operationId, selectedAmount });

    await ctx.proofService.reserveProofs(mintUrl, inputSecrets, operationId);

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
      changeOutputData: serializeOutputData({ keep: blankOutputs, send: [] }),
      needsSwap: false,
      amount,
      fee_reserve,
      inputAmount: selectedAmount,
      inputProofSecrets: inputSecrets,
      swap_fee: 0,
      state: 'prepared',
    };
  }

  /**
   * Prepare a swap-then-melt operation.
   * Used when selected proofs significantly exceed the required amount.
   */
  private async prepareSwapThenMelt(
    ctx: BasePrepareContext<'bolt11'>,
    quote: MeltQuoteData,
    totalAmount: number,
  ): Promise<PreparedMeltOperation & MeltMethodMeta<'bolt11'>> {
    const { mintUrl, id: operationId } = ctx.operation;
    const { amount, fee_reserve } = quote;

    ctx.logger?.debug('Preparing swap-then-melt', { operationId, totalAmount });

    // Re-select proofs including the swap fee
    const selectedProofs = await ctx.proofService.selectProofsToSend(mintUrl, totalAmount, ctx.operation.unit, true);
    const selectedAmount = sumProofs(selectedProofs);
    const inputSecrets = selectedProofs.map((p) => p.secret);

    const swapFee = ctx.wallet.getFeesForProofs(selectedProofs);
    const sendAmount = totalAmount;
    const keepAmount = selectedAmount - sendAmount - swapFee;

    ctx.logger?.debug('Swap amounts calculated', {
      operationId,
      selectedAmount,
      sendAmount,
      keepAmount,
      swapFee,
    });

    await ctx.proofService.reserveProofs(mintUrl, inputSecrets, operationId);

    const blankOutputs = await this.createChangeOutputs(amount, sendAmount, ctx);

    // Add additional fee calculation to the resulting outputs to cover the melts input fee
    const swapOutputData = await ctx.proofService.createOutputsAndIncrementCounters(
      mintUrl,
      {
        keep: keepAmount,
        send: sendAmount,
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
    quoteAmount: number,
    sendAmount: number,
    ctx: BasePrepareContext<'bolt11'>,
  ) {
    const changeDelta = sendAmount - quoteAmount;
    return ctx.proofService.createBlankOutputs(changeDelta, ctx.operation.mintUrl);
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
  async execute(ctx: ExecuteContext<'bolt11'>): Promise<ExecutionResult<'bolt11'>> {
    const {
      quoteId,
      mintUrl,
      changeOutputData: serializedChangeOutputData,
      id: operationId,
    } = ctx.operation;

    ctx.logger?.debug('Executing bolt11 melt', {
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
    const res = await ctx.mintAdapter.customMeltBolt11(
      mintUrl,
      proofsToMelt,
      changeOutputData.keep,
      quoteId,
    );

    ctx.logger?.info('Melt execution completed', { operationId, quoteId, state: res.state });

    return this.handleMeltResponse(ctx, res.state, proofsToMelt, res.change);
  }

  /**
   * Handle the melt response and return the appropriate execution result.
   */
  private async handleMeltResponse(
    ctx: ExecuteContext<'bolt11'>,
    state: 'PAID' | 'UNPAID' | 'PENDING',
    proofsToMelt: Proof[],
    change?: SerializedBlindedSignature[],
  ): Promise<ExecutionResult<'bolt11'>> {
    const { mintUrl } = ctx.operation;

    switch (state) {
      case 'PAID':
        await this.finalizeOperation(ctx, change);
        return buildPaidResult(ctx.operation);

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
  private async getInputProofs(ctx: ExecuteContext<'bolt11'>): Promise<Proof[]> {
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
  private async executeSwap(ctx: ExecuteContext<'bolt11'>, inputProofs: Proof[]): Promise<Proof[]> {
    const { swapOutputData, inputProofSecrets, id: operationId, mintUrl } = ctx.operation;

    if (!swapOutputData) {
      throw new Error('Swap is required, but swap output data is missing');
    }

    const swapData = deserializeOutputData(swapOutputData);
    const sendAmount = swapData.send.reduce((a, c) => a + c.blindedMessage.amount, 0);
    const { wallet } = await ctx.walletService.getWalletWithActiveKeysetId(mintUrl, ctx.operation.unit);

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
      ...mapProofToCoreProof(mintUrl, 'ready', keep, { createdByOperationId: operationId }),
      ...mapProofToCoreProof(mintUrl, 'inflight', send, { createdByOperationId: operationId }),
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
   */
  async finalize(ctx: FinalizeContext<'bolt11'>): Promise<void> {
    const { mintUrl, quoteId, id: operationId } = ctx.operation;

    ctx.logger?.debug('Finalizing pending melt operation', { operationId, quoteId });

    // Fetch current melt quote state from mint to get change signatures
    const res = await ctx.mintAdapter.checkMeltQuote(mintUrl, quoteId);

    if (res.state !== 'PAID') {
      throw new Error(`Cannot finalize: melt quote ${quoteId} is ${res.state}, expected PAID`);
    }

    await this.finalizeOperation(ctx, res.change);
  }

  /**
   * Finalize a melt operation by marking input proofs as spent and saving change proofs.
   * Called immediately when melt returns PAID, or later when a pending melt succeeds.
   */
  private async finalizeOperation(
    ctx: ExecuteContext<'bolt11'> | FinalizeContext<'bolt11'> | RecoverExecutingContext<'bolt11'>,
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
  async checkPending(ctx: PendingContext<'bolt11'>): Promise<PendingCheckResult> {
    const { mintUrl, quoteId, id: operationId } = ctx.operation;

    ctx.logger?.debug('Checking pending melt operation', { operationId, quoteId });

    const state = await ctx.mintAdapter.checkMeltQuoteState(mintUrl, quoteId);

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
  async rollback(ctx: RollbackContext<'bolt11'>): Promise<void> {
    const { id: operationId, mintUrl, needsSwap } = ctx.operation;
    ctx.logger?.debug('Rolling back bolt11 melt operation', { operationId, needsSwap });
    const secretsToRestore = this.getMeltInputSecrets(ctx.operation);

    // restoreProofsToReady sets state to 'ready' and clears usedByOperationId
    // This handles both 'ready' proofs (just clears reservation) and 'inflight' proofs
    await ctx.proofService.restoreProofsToReady(mintUrl, secretsToRestore);

    ctx.logger?.info('Melt operation rolled back, proofs restored', {
      operationId,
      needsSwap,
      proofCount: secretsToRestore.length,
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
  async recoverExecuting(
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
    const { operation } = ctx;
    const { mintUrl, quoteId, needsSwap, id: operationId } = operation;

    ctx.logger?.debug('Recovering executing bolt11 melt operation', {
      operationId,
      quoteId,
      needsSwap,
    });

    const state = await ctx.mintAdapter.checkMeltQuoteState(mintUrl, quoteId);

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
   */
  private async recoverExecutingPaidOperation(
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
    const { mintUrl, quoteId, id: operationId } = ctx.operation;

    ctx.logger?.debug('Recovering executing operation as paid, fetching change', {
      operationId,
      quoteId,
    });

    // Fetch melt quote to get any change signatures
    const res = await ctx.mintAdapter.checkMeltQuote(mintUrl, quoteId);

    // Finalize the operation (mark proofs spent, save change)
    await this.finalizeOperation(ctx, res.change);

    ctx.logger?.info('Recovered and finalized paid melt operation', {
      operationId,
      quoteId,
    });

    return buildPaidResult(ctx.operation);
  }

  /**
   * Recover an executing operation that is now pending.
   * Transitions to pending state for continued monitoring.
   */
  private async recoverExecutingPendingOperation(
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
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
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
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
    ctx: RecoverExecutingContext<'bolt11'>,
    swapSendProofs: Proof[],
  ): Promise<ExecutionResult<'bolt11'>> {
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
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
    const { operation } = ctx;
    const { swapOutputData, id: operationId, mintUrl } = operation;

    if (!swapOutputData) {
      throw new Error('Swap was required but swapOutputData is missing');
    }

    ctx.logger?.debug('Swap proofs not found locally, recovering from mint', { operationId });

    await ctx.proofService.recoverProofsFromOutputData(mintUrl, swapOutputData);

    try {
      await ctx.proofService.setProofState(mintUrl, operation.inputProofSecrets, 'spent');
    } catch {
      ctx.logger?.warn('Failed to mark input proofs as spent', { operationId });
    }

    ctx.logger?.info('Recovered proofs from mint after swap', { operationId });

    return buildFailedResult(operation, 'Recovered: Swap happened, proofs restored from mint');
  }

  /**
   * Recover when no swap occurred - release original proofs.
   */
  private async recoverExecutingWithoutSwap(
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
    const { operation } = ctx;
    const { mintUrl, inputProofSecrets, id: operationId } = operation;

    await ctx.proofService.releaseProofs(mintUrl, inputProofSecrets);

    ctx.logger?.info('Released proofs after failed melt (no swap occurred)', {
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
  private async checkSwapHappened(ctx: RecoverExecutingContext<'bolt11'>): Promise<boolean> {
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
  private async findLocalSwapSendProofs(ctx: RecoverExecutingContext<'bolt11'>): Promise<Proof[]> {
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
