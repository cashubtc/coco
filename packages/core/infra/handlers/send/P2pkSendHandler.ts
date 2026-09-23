import { ProofValidationError } from '@core/models/Error.ts';
import {
  resolveP2pkOptions,
  type PrepareContext,
  type SendMethodHandler,
  type SendPreparationPlan,
} from '@core/operations/send/SendMethodHandler.ts';

/** Local output policy for tokens locked to a recipient's NUT-11 P2PK condition. */
export class P2pkSendHandler implements SendMethodHandler<'p2pk'> {
  readonly canReclaim = false;

  prepare(ctx: PrepareContext<'p2pk'>): SendPreparationPlan {
    const options = resolveP2pkOptions(ctx.operation.methodData);
    if (ctx.mintInfo.nuts?.['11']?.supported !== true) {
      throw new ProofValidationError(
        `NUT-11 support is required for P2PK send but is not advertised by mint ${ctx.operation.mintUrl}`,
      );
    }
    return {
      forceSwap: true,
      fixedSendOutputs: ctx.outputDataCreator.createP2PKData(
        options,
        ctx.operation.amount,
        ctx.activeKeys,
      ),
    };
  }
}
