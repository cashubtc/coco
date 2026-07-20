import { ParentOwnedOperationError } from '../../models/Error.ts';

export interface ParentOwnedChildOperation {
  id: string;
  parentSwapOperationId?: string;
}

/** Verify that a child is standalone or is being advanced by its recorded parent. */
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
