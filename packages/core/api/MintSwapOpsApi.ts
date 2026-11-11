import { parseUnitAmount, type UnitAmountLike } from '../amounts.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { CoreEvents } from '../events/types.ts';
import type { MintSwapOperation } from '../operations/mintSwap/MintSwapOperation.ts';
import type { MintSwapOperationService } from '../operations/mintSwap/MintSwapOperationService.ts';
import {
  waitForMintSwapOutcome,
  type MintSwapOutcome,
  type MintSwapWaitOptions,
} from './MintSwapOutcome.ts';

export type { MintSwapOutcome, MintSwapWaitOptions } from './MintSwapOutcome.ts';

export interface PrepareMintSwapInput {
  /** Stable caller ID. Reusing it with a changed intent is an error. */
  id: string;
  sourceMintUrl: string;
  destinationMintUrl: string;
  /** Exact destination receipt; BOLT11/sat only. */
  destinationAmount: UnitAmountLike;
  /**
   * Optional maximum total source debit in sat, including the destination amount and fees.
   * Must be at least destinationAmount. Preparation checks the conservative
   * sourceDebitBounds.maximum; exceeding this cap fails the operation with
   * source_debit_cap_exceeded before payment. Actual debit can be lower after change
   * is returned. Omit to apply no caller-specified cap.
   */
  sourceDebitCap?: UnitAmountLike;
}

/** Explicit Mint Swap commands, available independently of automatic background processing. */
export class MintSwapOpsApi {
  readonly recovery = {
    /** Immediately reconcile active parents, without initiating an untouched prepared source. */
    run: (): Promise<void> => this.service.recoverActive(),
  };

  constructor(
    private readonly service: MintSwapOperationService,
    private readonly events: EventBus<CoreEvents>,
    private readonly disposed: AbortSignal,
  ) {}

  /** Prepare without payment. Reusing an ID requires the same normalized intent. */
  async prepare(input: PrepareMintSwapInput): Promise<MintSwapOperation> {
    return this.service.prepare({
      ...input,
      destinationAmount: parseUnitAmount(input.destinationAmount, { explicitUnit: 'sat' }).amount,
      sourceDebitCap:
        input.sourceDebitCap === undefined
          ? undefined
          : parseUnitAmount(input.sourceDebitCap, { explicitUnit: 'sat' }).amount,
    });
  }

  /** Authorize source payment explicitly, or recover an already-authorized swap. */
  execute(id: string): Promise<MintSwapOperation> {
    return this.service.execute(id);
  }

  /** Local read of the persisted operation. */
  get(id: string): Promise<MintSwapOperation | null> {
    return this.service.getOperation(id);
  }

  /** All unfinished parents, including those needing attention. */
  listActive(): Promise<MintSwapOperation[]> {
    return this.service.listActive();
  }

  /** Recover existing work immediately; may redeem funded value, but never starts a new payment. */
  refresh(id: string): Promise<MintSwapOperation> {
    return this.service.reconcile(id);
  }

  /** Request cancellation. An ambiguous source remains pending; paid value recovers forward. */
  cancel(id: string): Promise<MintSwapOperation> {
    return this.service.cancel(id);
  }

  /** Observe durable outcomes with polling fallback. Does not execute or recover the operation. */
  waitForOutcome(id: string, options?: MintSwapWaitOptions): Promise<MintSwapOutcome> {
    return waitForMintSwapOutcome(
      id,
      (operationId) => this.get(operationId),
      this.events,
      this.disposed,
      options,
    );
  }
}
