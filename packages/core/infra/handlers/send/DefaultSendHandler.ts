import type {
  PrepareContext,
  SendMethodHandler,
  SendPreparationPlan,
} from '@core/operations/send/SendMethodHandler.ts';

/** Local policy for standard unlocked token sends. */
export class DefaultSendHandler implements SendMethodHandler<'default'> {
  readonly canReclaim = true;

  prepare(ctx: PrepareContext<'default'>): SendPreparationPlan {
    return { forceSwap: Boolean(ctx.operation.methodData.forceSwap) };
  }
}
