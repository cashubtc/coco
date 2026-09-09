import { Amount } from '@cashu/cashu-ts';
import type { MintOperation } from './MintOperation.ts';

/** Existing standalone policy: executing siblings reserve value; pending preparations do not. */
export function mintLocalClaimabilityFacts(
  siblings: MintOperation[],
  targetOperationId?: string,
): { finalizedAmount: Amount; reservedAmount: Amount } {
  return {
    finalizedAmount: Amount.sum(
      siblings
        .filter((operation) => operation.state === 'finalized')
        .map((operation) => operation.amount),
    ),
    reservedAmount: Amount.sum(
      siblings
        .filter(
          (operation) => operation.state === 'executing' && operation.id !== targetOperationId,
        )
        .map((operation) => operation.amount),
    ),
  };
}
