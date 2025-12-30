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

/** If selected proofs exceed required amount by more than this ratio, a swap is needed */
const SWAP_THRESHOLD_RATIO = 1.1;

export class MeltBolt11Handler implements MeltMethodHandler<'bolt11'> {
  async prepare(
    ctx: BasePrepareContext<'bolt11'>,
  ): Promise<PreparedMeltOperation & MeltMethodMeta<'bolt11'>> {
    const { mintUrl } = ctx.operation;
    const quote = await ctx.wallet.createMeltQuote(ctx.operation.methodData.invoice);
    const { amount, fee_reserve } = quote;
    const totalAmount = amount + fee_reserve;

    await this.ensureSufficientBalance(ctx, totalAmount);

    const selectedProofs = await ctx.proofService.selectProofsToSend(mintUrl, totalAmount, false);
    const selectedAmount = this.sumProofs(selectedProofs);
    const needsSwap = selectedAmount >= Math.floor(totalAmount * SWAP_THRESHOLD_RATIO);

    if (!needsSwap) {
      return this.prepareDirectMelt(ctx, quote, selectedProofs);
    }
    return this.prepareSwapThenMelt(ctx, quote, totalAmount);
  }

  private async ensureSufficientBalance(
    ctx: BasePrepareContext<'bolt11'>,
    requiredAmount: number,
  ): Promise<void> {
    const availableProofs = await ctx.proofRepository.getAvailableProofs(ctx.operation.mintUrl);
    const totalAvailable = this.sumProofs(availableProofs);
    if (totalAvailable < requiredAmount) {
      throw new Error('Insufficient balance');
    }
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

    await ctx.proofRepository.reserveProofs(mintUrl, inputSecrets, operationId);

    const changeDelta = selectedAmount - amount;
    const blankOutputs = await ctx.proofService.createBlankOutputs(changeDelta, mintUrl);

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

    // Re-select proofs allowing inclusion of smaller denominations for better fit
    const selectedProofs = await ctx.proofService.selectProofsToSend(mintUrl, totalAmount, true);
    const selectedAmount = this.sumProofs(selectedProofs);
    const inputSecrets = selectedProofs.map((p) => p.secret);

    const swapFee = ctx.wallet.getFeesForProofs(selectedProofs);
    const sendAmount = totalAmount + swapFee;
    const keepAmount = selectedAmount - sendAmount;
    const changeDelta = selectedAmount - totalAmount;

    await ctx.proofRepository.reserveProofs(mintUrl, inputSecrets, operationId);

    const blankOutputs = await ctx.proofService.createBlankOutputs(changeDelta, mintUrl);
    const swapOutputData = await ctx.proofService.createOutputsAndIncrementCounters(mintUrl, {
      keep: keepAmount,
      send: sendAmount,
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

  async execute(ctx: ExecuteContext<'bolt11'>): Promise<ExecutionResult<'bolt11'>> {
    const { quoteId, mintUrl, changeOutputData: serializedChangeOutputData } = ctx.operation;

    const inputProofs = await this.getInputProofs(ctx);
    const proofsToMelt = ctx.operation.needsSwap
      ? await this.executeSwap(ctx, inputProofs)
      : inputProofs;

    const changeOutputData = deserializeOutputData(serializedChangeOutputData);
    const res = await ctx.mintAdapter.customMeltBolt11(
      mintUrl,
      proofsToMelt,
      changeOutputData.keep,
      quoteId,
    );

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

    await ctx.proofService.setProofState(mintUrl, inputProofSecrets, 'inflight');
    const swap = await wallet.swap(sendAmount, inputProofs, { outputData: swapData });
    await ctx.proofService.setProofState(mintUrl, inputProofSecrets, 'spent');

    const newProofs = [
      ...mapProofToCoreProof(mintUrl, 'ready', swap.keep, { createdByOperationId: operationId }),
      ...mapProofToCoreProof(mintUrl, 'inflight', swap.send, { createdByOperationId: operationId }),
    ];
    await ctx.proofService.saveProofs(mintUrl, newProofs);

    return swap.send;
  }

  private buildExecutionResult(
    operation: ExecuteContext<'bolt11'>['operation'],
    state: string,
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
    if (ctx.operation.state === 'prepared') {
      await ctx.proofRepository.releaseProofs(
        ctx.operation.mintUrl,
        ctx.operation.inputProofSecrets,
      );
    }
  }

  async recoverExecuting(
    ctx: RecoverExecutingContext<'bolt11'>,
  ): Promise<ExecutionResult<'bolt11'>> {
    const { operation } = ctx;
    const { mintUrl, quoteId, inputProofSecrets, swapOutputData, id: operationId } = operation;
    const state = await ctx.mintAdapter.checkMeltQuoteState(mintUrl, quoteId);
    if (state === 'PAID') {
      // Melt was started, is done, we can finalize the operation
      return {
        status: 'PAID',
        finalized: {
          ...operation,
          state: 'finalized',
        },
      };
    } else if (state === 'PENDING') {
      // Melt was started, is not done, we can wait for it to be done
      return {
        status: 'PENDING',
        pending: {
          ...operation,
          state: 'pending',
        },
      };
    } else if (state === 'UNPAID') {
      // Melt was prepared, but not started, we need to check if the swap happened and reclaim
      if (ctx.operation.needsSwap) {
        // Swap was required. We need to check whether it happened
        // First we check with the mint whether the input proofs are spent (swap happened)

        const swapHappened = await this.checkSwapHappened(ctx, inputProofSecrets, mintUrl);
        if (swapHappened) {
          // We check whether we have the swap proofs in our DB
          const operationProofs = await ctx.proofRepository.getProofsByOperationId(
            mintUrl,
            operationId,
          );
          if (!swapOutputData || swapOutputData.send.length < 1) {
            throw new Error('Swap was required, but no output data was found');
          }
          const swapSendProofSecrets = swapOutputData.send.map((o) => o.secret);
          const swapSendProofs = operationProofs.filter((operationProof) =>
            swapSendProofSecrets.includes(operationProof.secret),
          );
          if (swapSendProofs.length > 0) {
            const swappedSecrets = swapSendProofs.map((p) => p.secret);
            // Swap happened but melt either failed or was not initiated
            // -> Unreserve proofs
            await ctx.proofService.setProofState(mintUrl, swappedSecrets, 'ready');
          } else {
            // Swap happened, but resulting proofs were not saved. We need to recover
            // TODO: Implement recovery
          }
        }
      } else {
        // Swap was not required, we can reclaim safely
        const reclaimOutputs = await ctx.proofService.createOutputsAndIncrementCounters(
          operation.mintUrl,
          { keep: operation.amount, send: 0 },
        );
        const inputProofs = await ctx.proofRepository.getProofsByOperationId(
          operation.mintUrl,
          operation.id,
        );
        if (inputProofs.length !== operation.inputProofSecrets.length) {
          ctx.logger?.warn('Could not find all input proofs for recovery!', {
            operationId: operation.id,
            mintUrl: operation.mintUrl,
            inputProofSecrets: operation.inputProofSecrets,
            inputProofs: inputProofs.length,
          });
        }
        const { wallet } = await ctx.walletService.getWalletWithActiveKeysetId(operation.mintUrl);
        const newProofs = await wallet.receive(
          { mint: operation.mintUrl, proofs: inputProofs },
          { outputData: reclaimOutputs.keep },
        );
        await ctx.proofService.saveProofs(
          operation.mintUrl,
          mapProofToCoreProof(operation.mintUrl, 'ready', newProofs),
        );
        return {
          status: 'FAILED',
          failed: {
            ...operation,
            state: 'failed',
            updatedAt: Date.now(),
            error: 'Recovered: no mint interaction, operation never executed',
          },
        };
      }
    } else {
      throw new Error(`Unexpected melt response state: ${state} for quote ${operation.quoteId}`);
    }
  }

  private async checkSwapHappened(
    ctx: RecoverExecutingContext<'bolt11'>,
    secrets: string[],
    mintUrl: string,
  ): Promise<boolean> {
    const Ys = computeYHexForSecrets(secrets);
    const proofStates = await ctx.mintAdapter.checkProofStates(mintUrl, Ys);
    return proofStates.some((proofState) => proofState.state === 'SPENT');
  }

  private sumProofs(proofs: Proof[]): number {
    return proofs.reduce((sum, p) => sum + p.amount, 0);
  }
}
