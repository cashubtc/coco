import type { CoreEvents, EventBus } from '../../events';
import type { MintSwapOperationService } from './MintSwapOperationService.ts';
import type { MintSwapOperation } from './MintSwapOperation.ts';

export type MintSwapSettlementState = 'completed' | 'cancelled' | 'failed' | 'needs_attention';

export class MintSwapSettlementError extends Error {
  constructor(
    readonly operation: MintSwapOperation,
    readonly outcome: Exclude<MintSwapSettlementState, 'completed'>,
  ) {
    super(`Mint swap ${operation.id} settled as ${outcome}`);
    this.name = 'MintSwapSettlementError';
  }
}

export interface WaitForMintSwapSettlementOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const SETTLING_EVENTS = [
  'mint-swap-op:completed',
  'mint-swap-op:cancelled',
  'mint-swap-op:failed',
  'mint-swap-op:needs-attention',
] as const;

export function waitForMintSwapSettlement(
  service: Pick<MintSwapOperationService, 'get'>,
  bus: EventBus<CoreEvents>,
  operationId: string,
  options: WaitForMintSwapSettlementOptions = {},
): Promise<MintSwapOperation> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let highestRevision = -1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const offs: Array<() => void> = [];

    const cleanup = () => {
      for (const off of offs.splice(0)) off();
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (operation: MintSwapOperation) => {
      if (settled || operation.id !== operationId || operation.revision < highestRevision) return;
      highestRevision = operation.revision;
      if (!isSettling(operation.state)) return;
      settled = true;
      cleanup();
      if (operation.state === 'completed') resolve(operation);
      else reject(new MintSwapSettlementError(operation, operation.state));
    };
    const read = async (minimumRevision = -1) => {
      if (settled || minimumRevision < highestRevision) return;
      try {
        const operation = await service.get(operationId);
        if (operation && operation.revision >= minimumRevision) finish(operation);
      } catch (error) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(options.signal?.reason ?? new Error('Mint swap waiter aborted'));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    for (const event of SETTLING_EVENTS) {
      offs.push(
        bus.on(event, (payload) => {
          if (payload.operationId === operationId) void read(payload.revision);
        }),
      );
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Timed out waiting for mint swap ${operationId}`));
      }, options.timeoutMs);
    }
    void read();
  });
}

function isSettling(state: MintSwapOperation['state']): state is MintSwapSettlementState {
  return (
    state === 'completed' ||
    state === 'cancelled' ||
    state === 'failed' ||
    state === 'needs_attention'
  );
}
