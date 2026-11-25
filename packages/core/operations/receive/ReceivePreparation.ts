import type { CoreEvents } from '@core/events/types.ts';
import { ProofValidationError } from '@core/models/Error.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import { MintScopedLock } from '../MintScopedLock.ts';
import type { InitReceiveOperation, RolledBackReceiveOperation } from './ReceiveOperation.ts';
import type { ReceiveOperationServiceDependencies } from './ReceiveOperationService.ts';
import type { PrepareReceiveInput, PrepareReceiveResult } from './ReceiveTransitionTypes.ts';

type Dependencies = Pick<
  ReceiveOperationServiceDependencies,
  'mintMetadataRefresh' | 'loadSeed' | 'mintScopedLock' | 'eventBus' | 'logger'
>;

/** Both coordinators load keys and seed before opening their own wallet transaction. */
export class ReceivePreparation {
  private readonly lock: MintScopedLock;

  constructor(private readonly deps: Dependencies) {
    this.lock = deps.mintScopedLock ?? new MintScopedLock();
  }

  async withInput<T>(
    operation: InitReceiveOperation,
    commit: (input: PrepareReceiveInput) => Promise<T>,
  ): Promise<T> {
    const metadata = await this.deps.mintMetadataRefresh.refreshAndCommitIfStale(operation.mintUrl);
    const activeKeys = createKeyChain(operation.mintUrl, operation.unit, metadata.keysets)
      .getCheapestKeyset()
      .toMintKeys();
    if (!activeKeys) throw new ProofValidationError('Active keyset is missing mint keys');
    const seed = await this.deps.loadSeed();
    const release = await this.lock.acquire(operation.mintUrl);
    try {
      return await commit({ operation, activeKeys, seed, updatedAt: Date.now() });
    } finally {
      release();
    }
  }

  async publishRollback(operation: RolledBackReceiveOperation): Promise<void> {
    await emitReceiveEvent(this.deps, 'receive-op:rolled-back', {
      mintUrl: operation.mintUrl,
      operationId: operation.id,
      operation,
    });
  }

  async publish({ operation, counter }: PrepareReceiveResult): Promise<void> {
    await emitReceiveEvent(this.deps, 'counter:updated', counter);
    await emitReceiveEvent(this.deps, 'receive-op:prepared', {
      mintUrl: operation.mintUrl,
      operationId: operation.id,
      operation,
    });
  }
}

export async function emitReceiveEvent<K extends keyof CoreEvents>(
  deps: Pick<Dependencies, 'eventBus' | 'logger'>,
  event: K,
  payload: CoreEvents[K],
): Promise<void> {
  try {
    await deps.eventBus.emit(event, payload, { throwOnError: true });
  } catch (error) {
    deps.logger?.warn('Receive event listener failed after commit', { event, error });
  }
}
