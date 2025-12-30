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

export class MeltBolt11Handler implements MeltMethodHandler<'bolt11'> {
  async prepare(
    ctx: BasePrepareContext<'bolt11'>,
  ): Promise<PreparedMeltOperation & MeltMethodMeta<'bolt11'>> {
    const quote = await ctx.wallet.createMeltQuote(ctx.operation.methodData.invoice);
    const amount = quote.amount;
    const fee_reserve = quote.fee_reserve;
    const totalAmount = amount + fee_reserve;

    const availableProofs = await ctx.proofRepository.getAvailableProofs(ctx.operation.mintUrl);
    const totalAvailable = availableProofs.reduce((acc, p) => acc + p.amount, 0);
    if (totalAvailable < totalAmount) {
      throw new Error('Insufficient balance');
    }
    // check for an exact match
    let selectedProofs = await ctx.proofService.selectProofsToSend(
      ctx.operation.mintUrl,
      totalAmount,
      false,
    );
    let selectedAmount = selectedProofs.reduce((acc, p) => acc + p.amount, 0);
    if (selectedAmount < Math.floor(totalAmount * 1.1)) {
      // The selected amount is either exact or less than 10% over the total amount, so we can use it directly
      const inputSecrets = selectedProofs.map((p) => p.secret);
      await ctx.proofRepository.reserveProofs(
        ctx.operation.mintUrl,
        inputSecrets,
        ctx.operation.id,
      );
      const delta = selectedAmount - amount;
      const blankOutputs = await ctx.proofService.createBlankOutputs(delta, ctx.operation.mintUrl);
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
    } else {
      // The selected amount exceeds the total amount by more than 10%, so we need to swap proofs
      selectedProofs = await ctx.proofService.selectProofsToSend(
        ctx.operation.mintUrl,
        totalAmount,
        true,
      );
      selectedAmount = selectedProofs.reduce((acc, p) => acc + p.amount, 0);
      const swapFees = ctx.wallet.getFeesForProofs(selectedProofs);
      const totalSendAmount = totalAmount + swapFees;
      const keepAmount = selectedAmount - totalSendAmount;
      const changeDelta = selectedAmount - totalAmount;
      const blankOutputs = await ctx.proofService.createBlankOutputs(
        changeDelta,
        ctx.operation.mintUrl,
      );
      await ctx.proofRepository.reserveProofs(
        ctx.operation.mintUrl,
        selectedProofs.map((p) => p.secret),
        ctx.operation.id,
      );
      const outputData = await ctx.proofService.createOutputsAndIncrementCounters(
        ctx.operation.mintUrl,
        { keep: keepAmount, send: totalSendAmount },
      );
      return {
        ...ctx.operation,
        ...ctx.operation.methodData,
        quoteId: quote.quote,
        swapOutputData: serializeOutputData({ keep: outputData.keep, send: outputData.send }),
        changeOutputData: serializeOutputData({ keep: blankOutputs, send: [] }),
        needsSwap: true,
        swap_fee: swapFees,
        amount,
        fee_reserve,
        inputAmount: selectedAmount,
        inputProofSecrets: selectedProofs.map((p) => p.secret),
        state: 'prepared',
      };
    }
  }

  async execute(ctx: ExecuteContext<'bolt11'>): Promise<ExecutionResult<'bolt11'>> {
    const {
      quoteId,
      id: operationId,
      mintUrl,
      changeOutputData: serializedChangeOutputData,
      swapOutputData,
      inputProofSecrets,
    } = ctx.operation;
    const proofsToSend = await ctx.proofRepository.getProofsByOperationId(mintUrl, operationId);
    if (proofsToSend.length !== ctx.operation.inputProofSecrets.length) {
      throw new Error('Could not find all input proofs');
    }
    let proofsToMelt: Proof[] = [];
    if (!ctx.operation.needsSwap) {
      proofsToMelt = proofsToSend;
    } else {
      if (!swapOutputData) {
        throw new Error('Swap is required, but swap output data is missing');
      }
      const swapData = deserializeOutputData(swapOutputData);
      const sendAmount = swapData.send.reduce((a, c) => a + c.blindedMessage.amount, 0);
      const { wallet } = await ctx.walletService.getWalletWithActiveKeysetId(mintUrl);
      await ctx.proofService.setProofState(mintUrl, inputProofSecrets, 'inflight');
      const swap = await wallet.swap(sendAmount, proofsToSend, { outputData: swapData });
      await ctx.proofService.setProofState(mintUrl, inputProofSecrets, 'spent');
      const newProofs = [
        ...mapProofToCoreProof(mintUrl, 'ready', swap.keep, { createdByOperationId: operationId }),
        ...mapProofToCoreProof(mintUrl, 'inflight', swap.send, {
          createdByOperationId: operationId,
        }),
      ];
      await ctx.proofService.saveProofs(mintUrl, newProofs);
      proofsToMelt = swap.send;
    }
    const changeOutputData = deserializeOutputData(serializedChangeOutputData);

    const res = await ctx.mintAdapter.customMeltBolt11(
      mintUrl,
      proofsToMelt,
      changeOutputData.keep,
      quoteId,
    );
    if (res.state === 'PAID') {
      return {
        status: 'PAID',
        finalized: {
          ...ctx.operation,
          state: 'finalized',
          updatedAt: Date.now(),
        },
      };
    } else if (res.state === 'PENDING') {
      return {
        status: 'PENDING',
        pending: {
          ...ctx.operation,
          state: 'pending',
          updatedAt: Date.now(),
        },
      };
    }
    throw new Error(`Unexpected melt response state: ${res.state} for quote ${quoteId}`);
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

        const swapHappened = await this.swapHappened(inputProofSecrets, mintUrl, ctx);
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
        // Swap was either not required or did not happen. We can reclaim savely
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

  private async swapHappened(
    input: string[] | Proof[],
    mintUrl: string,
    ctx: RecoverExecutingContext<'bolt11'>,
  ) {
    const secrets = input.map((i) => (typeof i === 'string' ? i : i.secret));
    const Ys = computeYHexForSecrets(secrets);
    const proofStates = await ctx.mintAdapter.checkProofStates(mintUrl, Ys);
    return proofStates.some((proofState) => proofState.state === 'SPENT');
  }
}
