import type {
  ExecuteContext,
  FinalizeContext,
  PendingContext,
  PrepareContext,
  RecoverExecutingContext,
  RollbackContext,
  SendMethodHandler,
} from '../../../operations/send/SendMethodHandler.ts';

/** Lifecycle policy for standard unlocked token sends. */
export class DefaultSendHandler implements SendMethodHandler<'default'> {
  prepare(ctx: PrepareContext<'default'>) {
    return ctx.commit({ forceSwap: Boolean(ctx.operation.methodData.forceSwap) });
  }

  execute(ctx: ExecuteContext) {
    return ctx.operation.needsSwap ? ctx.executeSwap() : ctx.executeExact();
  }

  finalize(ctx: FinalizeContext) {
    return ctx.completePersistedSend();
  }

  rollback(ctx: RollbackContext) {
    if (ctx.operation.state === 'prepared') return ctx.cancelPrepared();
    if (ctx.operation.state === 'pending') return ctx.reclaimPendingDefault();
    throw new Error(`Cannot rollback operation in state ${ctx.operation.state}`);
  }

  checkPending(ctx: PendingContext) {
    return ctx.checkPersistedSend();
  }

  recoverExecuting(ctx: RecoverExecutingContext) {
    return ctx.recoverPersistedSend();
  }
}
