import { ParentOwnedOperationError } from '../../models/Error.ts';
import type { MeltOperation } from '../melt/MeltOperation.ts';
import type { MintOperation } from '../mint/MintOperation.ts';

export interface ParentOwnedChildOperation {
  id: string;
  parentSwapOperationId?: string;
}

/**
 * Verify that a child is standalone or is being advanced by its recorded parent.
 *
 * The parent id is a composition guard, not an authentication mechanism. Parent-owned command
 * methods remain internal service seams.
 */
export function assertChildOperationAccess(
  operation: ParentOwnedChildOperation,
  expectedParentSwapOperationId?: string,
): void {
  const owner = operation.parentSwapOperationId;
  if (!owner) {
    if (expectedParentSwapOperationId) {
      throw new Error(
        `Operation ${operation.id} is not owned by mint swap ${expectedParentSwapOperationId}`,
      );
    }
    return;
  }

  if (owner !== expectedParentSwapOperationId) {
    throw new ParentOwnedOperationError(operation.id, owner);
  }
}

/** Validate the durable authorization phase carried by a parent-owned melt child. */
export function assertParentOwnedMeltOperationInvariant(operation: MeltOperation): void {
  const owner = operation.parentSwapOperationId;
  const phase = operation.parentExecutionPhase;
  if (!owner) {
    if (phase !== undefined) {
      throw new Error(`Standalone melt operation ${operation.id} cannot have a parent phase`);
    }
    return;
  }

  if (operation.state === 'executing') {
    if (phase === undefined) {
      throw new Error(`Parent-owned executing melt operation ${operation.id} requires a phase`);
    }
  } else if (
    operation.state === 'pending' ||
    operation.state === 'failed' ||
    operation.state === 'finalized'
  ) {
    if (phase !== 'melt_authorized') {
      throw new Error(
        `Parent-owned settled melt operation ${operation.id} requires melt authorization`,
      );
    }
  } else if (phase !== undefined) {
    throw new Error(
      `Melt operation ${operation.id} cannot retain a parent phase in ${operation.state}`,
    );
  }

  if (phase === 'pre_swap_authorized') {
    if (
      operation.state !== 'executing' ||
      !operation.needsSwap ||
      operation.swapOutputData === undefined
    ) {
      throw new Error(`Melt operation ${operation.id} has an invalid pre-swap authorization`);
    }
  }
}

/** Ensure a persisted parent-owned destination child is locked BOLT11/sat work. */
export function assertParentOwnedMintOperationInvariant(operation: MintOperation): void {
  if (!operation.parentSwapOperationId) return;
  if (
    operation.state === 'init' ||
    operation.method !== 'bolt11' ||
    operation.unit !== 'sat' ||
    operation.pubkey === undefined
  ) {
    throw new Error(`Parent-owned mint operation ${operation.id} must be locked BOLT11/sat work`);
  }
}
