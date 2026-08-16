import type { EventBus, CoreEvents } from '../events';
import type {
  ListMintSwapInput,
  MintSwapOperationService,
  PrepareMintSwapInput,
} from '../operations/mintSwap/MintSwapOperationService.ts';
import type { MintSwapOperation } from '../operations/mintSwap/MintSwapOperation.ts';
import {
  waitForMintSwapSettlement,
  type WaitForMintSwapSettlementOptions,
} from '../operations/mintSwap/MintSwapWaiter.ts';

const CAPABILITY_ERROR = 'Mint Swap requires the optional durable repository capability';

/** Public API for durable cross-mint swaps. */
export class MintSwapOpsApi {
  readonly diagnostics = {
    isAvailable: (): boolean => this.service !== undefined,
  };

  readonly recovery = {
    run: (): Promise<void> => this.runRecovery(),
    inProgress: (): boolean => this.recoveryPromise !== undefined,
  };

  private recoveryPromise?: Promise<void>;

  constructor(
    private readonly service: MintSwapOperationService | undefined,
    private readonly eventBus: EventBus<CoreEvents>,
  ) {}

  prepare(input: PrepareMintSwapInput): Promise<MintSwapOperation> {
    return this.requireService().prepare(input);
  }

  execute(operationOrId: MintSwapOperation | string): Promise<MintSwapOperation> {
    return this.requireService().execute(this.operationId(operationOrId));
  }

  get(operationId: string): Promise<MintSwapOperation | null> {
    return this.requireService().get(operationId);
  }

  list(input: ListMintSwapInput = {}): Promise<MintSwapOperation[]> {
    return this.requireService().list(input);
  }

  listActive(): Promise<MintSwapOperation[]> {
    return this.requireService().listActive();
  }

  reconcile(operationId: string): Promise<MintSwapOperation> {
    return this.requireService().reconcile(operationId);
  }

  cancel(operationId: string, reason?: string): Promise<MintSwapOperation> {
    return this.requireService().cancel(operationId, reason);
  }

  waitFor(
    operationId: string,
    options?: WaitForMintSwapSettlementOptions,
  ): Promise<MintSwapOperation> {
    return waitForMintSwapSettlement(this.requireService(), this.eventBus, operationId, options);
  }

  private runRecovery(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    const service = this.requireService();
    this.recoveryPromise = (async () => {
      const operations = await service.listActive();
      await Promise.allSettled(operations.map((operation) => service.reconcile(operation.id)));
    })().finally(() => {
      this.recoveryPromise = undefined;
    });
    return this.recoveryPromise;
  }

  private requireService(): MintSwapOperationService {
    if (!this.service) throw new Error(CAPABILITY_ERROR);
    return this.service;
  }

  private operationId(operationOrId: MintSwapOperation | string): string {
    return typeof operationOrId === 'string' ? operationOrId : operationOrId.id;
  }
}
