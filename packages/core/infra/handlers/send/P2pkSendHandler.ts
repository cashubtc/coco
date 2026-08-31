import {
  resolveP2pkOptions,
  type ExecuteContext,
  type FinalizeContext,
  type PendingContext,
  type PrepareContext,
  type RecoverExecutingContext,
  type RollbackContext,
  type SendMethodHandler,
} from '../../../operations/send/SendMethodHandler.ts';

/** Lifecycle policy for tokens locked to a recipient's NUT-11 P2PK condition. */
export class P2pkSendHandler implements SendMethodHandler<'p2pk'> {
  async prepare(ctx: PrepareContext<'p2pk'>) {
    const options = resolveP2pkOptions(ctx.operation.methodData);
    await ctx.assertNutSupported(11, 'P2PK send');
    const fixedSendOutputs = ctx.outputDataCreator.createP2PKData(
      options,
      ctx.operation.amount,
      ctx.activeKeys,
    );
    return ctx.commit({ forceSwap: true, fixedSendOutputs });
  }

  execute(ctx: ExecuteContext) {
    return ctx.executeSwap();
  }

  finalize(ctx: FinalizeContext) {
    return ctx.completePersistedSend();
  }

  rollback(ctx: RollbackContext) {
    if (ctx.operation.state === 'prepared') return ctx.cancelPrepared();
    throw new Error(`P2PK Send Operation in ${ctx.operation.state} state can not be rolled back.`);
  }

  checkPending(ctx: PendingContext) {
    return ctx.checkPersistedSend();
  }

  recoverExecuting(ctx: RecoverExecutingContext) {
    return ctx.recoverPersistedSend();
  }
}
