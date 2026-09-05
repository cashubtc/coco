import { Amount } from '@cashu/cashu-ts';
import type { MintOperation } from './MintOperation.ts';
import type { MintRecoveryRecord } from './MintRecovery.ts';

/** Missing provenance on a legacy pending row must not silently release an old submission. */
export function mintLocalFacts(
  operations: MintOperation[],
  records: ReadonlyMap<string, MintRecoveryRecord>,
  targetOperationId?: string,
): { finalizedAmount: Amount; reservedAmount: Amount } {
  let finalizedAmount = Amount.zero();
  let reservedAmount = Amount.zero();
  for (const operation of operations) {
    if (operation.state === 'finalized') finalizedAmount = finalizedAmount.add(operation.amount);
    else if (
      operation.id !== targetOperationId &&
      (operation.state === 'executing' ||
        (operation.state === 'pending' && records.get(operation.id)?.provenance !== 'prepared'))
    )
      reservedAmount = reservedAmount.add(operation.amount);
  }
  let baseline = Amount.zero();
  for (const record of records.values()) {
    const value = Amount.from(record.issuanceBaseline ?? '0');
    if (value.greaterThan(baseline)) baseline = value;
  }
  return { finalizedAmount: finalizedAmount.add(baseline), reservedAmount };
}

/** These codes reject this transmission before issuance, not any earlier ambiguous request. */
export function isDefinitiveMintRejection(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    [20001, 20007, 20008].includes(Number(error.code))
  );
}
