import type {
  ListMintSwapInput,
  MintSwapOperation,
  MintSwapOperationService,
  PrepareMintSwapInput,
} from '../operations/mintSwap/index.ts';
import type { EventBus, CoreEvents } from '../events/index.ts';
import type { MintSwapOperationState } from '../operations/mintSwap/index.ts';

export interface WaitForMintSwapOptions {
  states?: readonly MintSwapOperationState[];
  timeoutMs?: number;
}

/** Public operation-oriented API for exact-receive cross-mint swaps. */
export class MintSwapOpsApi {
  readonly recovery;
  readonly diagnostics;

  constructor(
    private readonly service: MintSwapOperationService,
    private readonly eventBus?: EventBus<CoreEvents>,
  ) {
    let recoveryPromise: Promise<void> | undefined;
    this.recovery = {
      run: async () => {
        if (recoveryPromise) return recoveryPromise;
        recoveryPromise = (async () => {
          const active = await this.service.listActive();
          await Promise.allSettled(active.map((operation) => this.service.refresh(operation.id)));
        })();
        try {
          await recoveryPromise;
        } finally {
          recoveryPromise = undefined;
        }
      },
      inProgress: () => recoveryPromise !== undefined,
    };
    this.diagnostics = {
      isLocked: (operationId: string) => this.service.isOperationLocked(operationId),
    };
  }

  prepare(input: PrepareMintSwapInput): Promise<MintSwapOperation> {
    return this.service.prepare(input);
  }

  execute(operationOrId: MintSwapOperation | string): Promise<MintSwapOperation> {
    return this.service.execute(
      typeof operationOrId === 'string' ? operationOrId : operationOrId.id,
    );
  }

  get(operationId: string): Promise<MintSwapOperation | null> {
    return this.service.get(operationId);
  }

  list(input?: ListMintSwapInput): Promise<MintSwapOperation[]> {
    return this.service.list(input);
  }

  listActive(): Promise<MintSwapOperation[]> {
    return this.service.listActive();
  }

  refresh(operationId: string): Promise<MintSwapOperation> {
    return this.service.refresh(operationId);
  }

  retry(operationId: string): Promise<MintSwapOperation> {
    return this.service.retry(operationId);
  }

  cancel(operationId: string, reason?: string): Promise<MintSwapOperation> {
    return this.service.cancel(operationId, reason);
  }

  async waitFor(
    operationId: string,
    options: WaitForMintSwapOptions = {},
  ): Promise<MintSwapOperation> {
    const states = new Set<MintSwapOperationState>(
      options.states ?? ['completed', 'cancelled', 'failed', 'needs_attention'],
    );
    const initial = await this.service.get(operationId);
    if (!initial) throw new Error(`Mint swap ${operationId} not found`);
    if (states.has(initial.state)) return initial;
    if (!this.eventBus) throw new Error('Mint swap event waiting is unavailable');

    return new Promise<MintSwapOperation>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const offs: Array<() => void> = [];
      const cleanup = () => {
        for (const off of offs) off();
        if (timeout) clearTimeout(timeout);
      };
      const finish = (operation: MintSwapOperation) => {
        if (settled || !states.has(operation.state)) return;
        settled = true;
        cleanup();
        resolve(operation);
      };
      const observe = async (payload: { operationId: string }) => {
        if (payload.operationId !== operationId || settled) return;
        const operation = await this.service.get(operationId);
        if (operation) finish(operation);
      };
      const events = [
        'mint-swap-op:prepared',
        'mint-swap-op:source-inflight',
        'mint-swap-op:destination-funded',
        'mint-swap-op:issuing',
        'mint-swap-op:completed',
        'mint-swap-op:cancelled',
        'mint-swap-op:failed',
        'mint-swap-op:needs-attention',
      ] as const;
      for (const event of events) offs.push(this.eventBus!.on(event, observe));
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Timed out waiting for mint swap ${operationId}`));
        }, options.timeoutMs);
      }
      void this.service
        .get(operationId)
        .then((operation) => {
          if (operation) finish(operation);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
    });
  }
}
