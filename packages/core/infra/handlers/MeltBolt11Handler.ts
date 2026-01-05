import type { Proof } from '@cashu/cashu-ts';
import type {
  BasePrepareContext,
  ExecuteContext,
  ExecutionResult,
  MeltMethodHandler,
  MeltMethodMeta,
  PreparedMeltOperation,
  RecoverExecutingContext,
  RollbackContext,
} from '@core/operations/melt';
import {
  deserializeOutputData,
  serializeOutputData,
  mapProofToCoreProof,
  computeYHexForSecrets,
} from '@core/utils';
import { bytesToHex } from '@noble/hashes/utils.js';

const SWAP_THRESHOLD_RATIO = 1.1;

export class MeltBolt11Handler implements MeltMethodHandler<'bolt11'> {
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

    const selectedProofs = await ctx.proofService.selectProofsToSend(mintUrl, totalAmount, false);
    const selectedAmount = this.sumProofs(selectedProofs);
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

  private async prepareDirectMelt(
    ctx: BasePrepareContext<'bolt11'>,
    quote: { quote: string; amount: number; fee_reserve: number },
    selectedProofs: Proof[],
  ): Promise<PreparedMeltOperation & MeltMethodMeta<'bolt11'>> {
    const { mintUrl, id: operationId } = ctx.operation;
    const { amount, fee_reserve } = quote;
    const inputSecrets = selectedProofs.map((p) => p.secret);
    const selectedAmount = this.sumProofs(selectedProofs);

    ctx.logger?.debug('Preparing direct melt (no swap)', { operationId, selectedAmount });

    await ctx.proofService.reserveProofs(mintUrl, inputSecrets, operationId);

    const blankOutputs = await this.getChangeOutputs(amount, selectedAmount, ctx);

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

  private async prepareSwapThenMelt(
    ctx: BasePrepareContext<'bolt11'>,
    quote: { quote: string; amount: number; fee_reserve: number },
    totalAmount: number,
  ): Promise<PreparedMeltOperation & MeltMethodMeta<'bolt11'>> {
    const { mintUrl, id: operationId } = ctx.operation;
    const { amount, fee_reserve } = quote;

    ctx.logger?.debug('Preparing swap-then-melt', { operationId, totalAmount });

    // Re-select proofs including the swap fee
    const selectedProofs = await ctx.proofService.selectProofsToSend(mintUrl, totalAmount, true);
    const selectedAmount = this.sumProofs(selectedProofs);
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

    const blankOutputs = await this.getChangeOutputs(amount, sendAmount, ctx);

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

  private async getChangeOutputs(
    quoteAmount: number,
    sendAmount: number,
    ctx: BasePrepareContext<'bolt11'>,
  ) {
    const changeDelta = sendAmount - quoteAmount;
    return ctx.proofService.createBlankOutputs(changeDelta, ctx.operation.mintUrl);
  }

  async execute(ctx: ExecuteContext<'bolt11'>): Promise<ExecutionResult<'bolt11'>> {
    const { quoteId, mintUrl, changeOutputData: serializedChangeOutputData, id: operationId } =
      ctx.operation;

    ctx.logger?.debug('Executing bolt11 melt', {
      operationId,
      quoteId,
      needsSwap: ctx.operation.needsSwap,
    });

    const inputProofs = await this.getInputProofs(ctx);
    const proofsToMelt = ctx.operation.needsSwap
      ? await this.executeSwap(ctx, inputProofs)
      : inputProofs;

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

    return this.buildExecutionResult(ctx.operation, res.state);
  }

  private async getInputProofs(ctx: ExecuteContext<'bolt11'>): Promise<Proof[]> {
    const { mintUrl, id: operationId } = ctx.operation;
    const proofs = await ctx.proofRepository.getProofsByOperationId(mintUrl, operationId);
    if (proofs.length !== ctx.operation.inputProofSecrets.length) {
      throw new Error('Could not find all input proofs');
    }
    return proofs;
  }

  private async executeSwap(ctx: ExecuteContext<'bolt11'>, inputProofs: Proof[]): Promise<Proof[]> {
    const { swapOutputData, inputProofSecrets, id: operationId, mintUrl } = ctx.operation;

    if (!swapOutputData) {
      throw new Error('Swap is required, but swap output data is missing');
    }

    const swapData = deserializeOutputData(swapOutputData);
    const sendAmount = swapData.send.reduce((a, c) => a + c.blindedMessage.amount, 0);
    const { wallet } = await ctx.walletService.getWalletWithActiveKeysetId(mintUrl);

    ctx.logger?.debug('Executing pre-melt swap', {
      operationId,
      sendAmount,
      inputProofCount: inputProofs.length,
    });

    await ctx.proofService.setProofState(mintUrl, inputProofSecrets, 'inflight');
    const swap = await wallet.swap(sendAmount, inputProofs, { outputData: swapData });
    await ctx.proofService.setProofState(mintUrl, inputProofSecrets, 'spent');

    const newProofs = [
      ...mapProofToCoreProof(mintUrl, 'ready', swap.keep, { createdByOperationId: operationId }),
      ...mapProofToCoreProof(mintUrl, 'inflight', swap.send, { createdByOperationId: operationId }),
    ];
    await ctx.proofService.saveProofs(mintUrl, newProofs);

    ctx.logger?.debug('Pre-melt swap completed', {
      operationId,
      keepCount: swap.keep.length,
      sendCount: swap.send.length,
    });

    return swap.send;
  }

  private buildExecutionResult(
    operation: ExecuteContext<'bolt11'>['operation'],
    state: 'PAID' | 'PENDING' | 'UNPAID',
  ): ExecutionResult<'bolt11'> {
    if (state === 'PAID') {
      return {
        status: 'PAID',
        finalized: { ...operation, state: 'finalized', updatedAt: Date.now() },
      };
    }
    if (state === 'PENDING') {
      return {
        status: 'PENDING',
        pending: { ...operation, state: 'pending', updatedAt: Date.now() },
      };
    }
    throw new Error(`Unexpected melt response state: ${state} for quote ${operation.quoteId}`);
  }

  async rollback(ctx: RollbackContext<'bolt11'>): Promise<void> {
    const { id: operationId, state, mintUrl } = ctx.operation;
    ctx.logger?.debug('Rolling back bolt11 melt operation', { operationId, state });

    if (state === 'prepared') {
      await ctx.proofService.releaseProofs(mintUrl, ctx.operation.inputProofSecrets);
      ctx.logger?.info('Melt operation rolled back, proofs released', { operationId });
    }
  }

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
      case 'UNPAID': {
        const swapHappened = needsSwap && (await this.checkSwapHappened(ctx));
        ctx.logger?.debug('Unpaid quote recovery path', { operationId, swapHappened });
        if (swapHappened) {
          return this.recoverSwapProofsAndFail(ctx);
        } else {
          return this.releaseProofsAndFail(ctx);
        }
      }
      default:
        throw new Error(`Unexpected melt response state: ${state} for quote ${quoteId}`);
    }
  }

  private async recoverExecutingPaidOperation(
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
    ctx.logger?.info('Recovered executing operation as paid', {
      operationId: ctx.operation.id,
      quoteId: ctx.operation.quoteId,
    });
    return {
      status: 'PAID',
      finalized: {
        ...ctx.operation,
        state: 'finalized',
        updatedAt: Date.now(),
      },
    };
  }

  private async recoverExecutingPendingOperation(
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
    ctx.logger?.info('Recovered executing operation as pending', {
      operationId: ctx.operation.id,
      quoteId: ctx.operation.quoteId,
    });
    return {
      status: 'PENDING',
      pending: {
        ...ctx.operation,
        state: 'pending',
        updatedAt: Date.now(),
      },
    };
  }

  private async recoverSwapProofsAndFail(
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
    const { operation } = ctx;
    const { swapOutputData, id: operationId, mintUrl } = operation;
    if (!swapOutputData) {
      throw new Error('Swap was required, but no output data was found');
    }

    ctx.logger?.debug('Recovering swap proofs after failed melt', { operationId });

    const deserializedSwapOutputData = deserializeOutputData(swapOutputData);
    const operationProofs = await ctx.proofRepository.getProofsByOperationId(mintUrl, operationId);
    const swapSendProofSecrets = deserializedSwapOutputData.send.map((o) => bytesToHex(o.secret));
    const swapSendProofs = operationProofs.filter((operationProof) =>
      swapSendProofSecrets.includes(operationProof.secret),
    );
    if (swapSendProofs.length > 0) {
      const swappedSecrets = swapSendProofs.map((p) => p.secret);
      // Swap happened but melt either failed or was not initiated
      // -> Unreserve proofs
      await ctx.proofService.setProofState(mintUrl, swappedSecrets, 'ready');
      ctx.logger?.info('Recovered swap proofs, melt failed', {
        operationId,
        recoveredProofCount: swapSendProofs.length,
      });
      return {
        status: 'FAILED',
        failed: {
          ...operation,
          state: 'failed',
          updatedAt: Date.now(),
          error: 'Recovered: Swap happened but melt failed / never executed',
        },
      };
    } else {
      // Swap happened, but resulting proofs were not saved. We need to recover
      ctx.logger?.debug('Swap proofs not found locally, recovering from mint', { operationId });
      await ctx.proofService.recoverProofsFromOutputData(mintUrl, swapOutputData);
      try {
        await ctx.proofService.setProofState(mintUrl, operation.inputProofSecrets, 'spent');
      } catch {
        ctx.logger?.warn('Failed to mark input proofs as spent', { operationId });
      }
      ctx.logger?.info('Recovered proofs from mint after swap', { operationId });
      return {
        status: 'FAILED',
        failed: {
          ...operation,
          state: 'failed',
          updatedAt: Date.now(),
          error: 'Recovered: Swap happened, proofs restored from mint',
        },
      };
    }
  }

  private async releaseProofsAndFail(
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
    const { operation } = ctx;
    const { mintUrl, inputProofSecrets, id: operationId } = operation;
    await ctx.proofService.releaseProofs(mintUrl, inputProofSecrets);
    ctx.logger?.info('Released proofs after failed melt (no swap occurred)', {
      operationId,
      proofCount: inputProofSecrets.length,
    });
    return {
      status: 'FAILED',
      failed: {
        ...operation,
        state: 'failed',
        updatedAt: Date.now(),
        error: 'Recovered: Swap never executed, released original proofs',
      },
    };
  }

  private async checkSwapHappened(ctx: RecoverExecutingContext<'bolt11'>): Promise<boolean> {
    const { operation, mintAdapter } = ctx;
    const { inputProofSecrets, mintUrl } = operation;
    const Ys = computeYHexForSecrets(inputProofSecrets);
    const proofStates = await mintAdapter.checkProofStates(mintUrl, Ys);
    // We use some, because generally we assume that proofs are spent together
    return proofStates.some((proofState) => proofState.state === 'SPENT');
  }

  private sumProofs(proofs: Proof[]): number {
    return proofs.reduce((sum, p) => sum + p.amount, 0);
  }
}
