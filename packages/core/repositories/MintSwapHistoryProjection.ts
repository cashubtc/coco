import type {
  MintSwapHistoryChild,
  MintSwapHistoryEntry,
  MintSwapHistoryProgress,
} from '../models/History.ts';
import { operationHistoryId } from '../models/History.ts';
import type { MeltOperation } from '../operations/melt/MeltOperation.ts';
import type { MintOperation } from '../operations/mint/MintOperation.ts';
import type { MintSwapOperation } from '../operations/mintSwap/MintSwapOperation.ts';

/** Project one persisted Mint Swap parent and its exact children into a sanitized history row. */
export function projectMintSwapHistoryEntry(
  parent: MintSwapOperation,
  sourceChild: MeltOperation | null,
  destinationChild: MintOperation | null,
): MintSwapHistoryEntry {
  assertExactChild('source', parent.sourceOperationId, sourceChild?.id);
  assertExactChild('destination', parent.destinationOperationId, destinationChild?.id);

  const source = projectChild(parent.sourceOperationId, sourceChild);
  const destination = projectChild(parent.destinationOperationId, destinationChild);
  const updatedAt = Math.max(
    parent.updatedAt,
    source.present ? source.updatedAt : parent.updatedAt,
    destination.present ? destination.updatedAt : parent.updatedAt,
  );

  return {
    id: operationHistoryId('mint-swap', parent.id),
    source: 'operation',
    type: 'mint-swap',
    operationId: parent.id,
    createdAt: parent.createdAt,
    updatedAt,
    parentUpdatedAt: parent.updatedAt,
    parentRevision: parent.revision,
    state: parent.state,
    stateEnteredAt: parent.stateEnteredAt,
    mintUrl: parent.destinationMintUrl,
    amount: parent.destinationAmount,
    unit: 'sat',
    sourceMintUrl: parent.sourceMintUrl,
    destinationMintUrl: parent.destinationMintUrl,
    destinationAmount: parent.destinationAmount,
    ...(parent.sourceDebitCap !== undefined ? { sourceDebitCap: parent.sourceDebitCap } : {}),
    sourceOperationId: parent.sourceOperationId,
    destinationOperationId: parent.destinationOperationId,
    progress: projectProgress(parent),
    ...(parent.cancellationRequestedAt !== undefined
      ? { cancellationRequestedAt: parent.cancellationRequestedAt }
      : {}),
    ...('valueNeutral' in parent ? { valueNeutral: parent.valueNeutral } : {}),
    ...('failure' in parent ? { failure: parent.failure, failedAt: parent.failedAt } : {}),
    ...('attention' in parent
      ? { attention: parent.attention, attentionAt: parent.attentionAt }
      : {}),
    ...('completedAt' in parent ? { completedAt: parent.completedAt } : {}),
    ...('cancelledAt' in parent ? { cancelledAt: parent.cancelledAt } : {}),
    sourceChild: source,
    destinationChild: destination,
  };
}

function projectProgress(parent: MintSwapOperation): MintSwapHistoryProgress {
  if (
    parent.state === 'cancelled' ||
    parent.state === 'failed' ||
    parent.state === 'needs_attention'
  ) {
    return { provenance: 'last_safe', ...parent.lastSafe };
  }

  switch (parent.state) {
    case 'preparing':
      return {
        provenance: 'current',
        state: parent.state,
        stateEnteredAt: parent.stateEnteredAt,
      };
    case 'prepared':
      return {
        provenance: 'current',
        state: parent.state,
        stateEnteredAt: parent.stateEnteredAt,
        sourceDebitBounds: parent.sourceDebitBounds,
      };
    case 'source_pending':
      return {
        provenance: 'current',
        state: parent.state,
        stateEnteredAt: parent.stateEnteredAt,
        sourceDebitBounds: parent.sourceDebitBounds,
        sourceStartedAt: parent.sourceStartedAt,
      };
    case 'destination_funded':
      return {
        provenance: 'current',
        state: parent.state,
        stateEnteredAt: parent.stateEnteredAt,
        sourceDebitBounds: parent.sourceDebitBounds,
        sourceStartedAt: parent.sourceStartedAt,
        sourceSettlement: parent.sourceSettlement,
      };
    case 'destination_pending':
      return {
        provenance: 'current',
        state: parent.state,
        stateEnteredAt: parent.stateEnteredAt,
        sourceDebitBounds: parent.sourceDebitBounds,
        sourceStartedAt: parent.sourceStartedAt,
        sourceSettlement: parent.sourceSettlement,
        destinationStartedAt: parent.destinationStartedAt,
      };
    case 'completed':
      return {
        provenance: 'current',
        state: parent.state,
        stateEnteredAt: parent.stateEnteredAt,
        sourceDebitBounds: parent.sourceDebitBounds,
        sourceStartedAt: parent.sourceStartedAt,
        sourceSettlement: parent.sourceSettlement,
        destinationStartedAt: parent.destinationStartedAt,
        destinationCompletion: parent.destinationCompletion,
      };
  }
}

function projectChild<S extends string>(
  operationId: string,
  child: { state: S; updatedAt: number } | null,
): MintSwapHistoryChild<S> {
  return child
    ? { operationId, present: true, state: child.state, updatedAt: child.updatedAt }
    : { operationId, present: false };
}

function assertExactChild(
  leg: 'source' | 'destination',
  expectedId: string,
  actualId: string | undefined,
): void {
  if (actualId !== undefined && actualId !== expectedId) {
    throw new Error(
      `Mint Swap history ${leg} child mismatch: expected ${expectedId}, received ${actualId}`,
    );
  }
}
