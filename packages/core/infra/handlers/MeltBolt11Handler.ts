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
import { deserializeOutputData, serializeOutputData, mapProofToCoreProof } from '@core/utils';

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
    if (totalAvailable < amount) {
      throw new Error('Insufficient balance');
    }
    // check for an exact match
    const selectedProofs = await ctx.proofService.selectProofsToSend(
      ctx.operation.mintUrl,
      totalAmount,
      false,
    );
    const selectedAmount = selectedProofs.reduce((acc, p) => acc + p.amount, 0);
    if (selectedAmount < Math.floor(totalAmount * 1.1)) {
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
        outputData: serializeOutputData({ keep: blankOutputs, send: [] }),
        needsSwap: false,
        amount,
        fee_reserve,
        inputAmount: selectedAmount,
        inputProofSecrets: inputSecrets,
        swap_fee: 0,
        state: 'prepared',
      };
    } else {
      // TODO: select proofs to melt
      throw new Error('Not implemented');
    }
  }

  async execute(ctx: ExecuteContext<'bolt11'>): Promise<ExecutionResult<'bolt11'>> {
    const { quoteId, id: operationId, mintUrl, outputData: serializedOutputData } = ctx.operation;
    const proofsToSend = await ctx.proofRepository.getProofsByOperationId(mintUrl, operationId);
    const outputData = deserializeOutputData(serializedOutputData);

    const res = await ctx.mintAdapter.customMeltBolt11(
      mintUrl,
      proofsToSend,
      outputData.keep,
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
    const state = await ctx.mintAdapter.checkMeltQuoteState(operation.mintUrl, operation.quoteId);
    if (state === 'PAID') {
      return {
        status: 'PAID',
        finalized: {
          ...operation,
          state: 'finalized',
        },
      };
    } else if (state === 'PENDING') {
      return {
        status: 'PENDING',
        pending: {
          ...operation,
          state: 'pending',
        },
      };
    } else if (state === 'UNPAID') {
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
    } else {
      throw new Error(`Unexpected melt response state: ${state} for quote ${operation.quoteId}`);
    }
  }
}
