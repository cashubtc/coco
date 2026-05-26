import { Amount, type MintQuoteBolt12Response } from '@cashu/cashu-ts';
import type { PendingMintOperation } from '@core/operations/mint';

export function getBolt12AvailableMintAmount(quote: MintQuoteBolt12Response): Amount {
  if (quote.amount_paid.lessThanOrEqual(quote.amount_issued)) {
    return Amount.zero();
  }

  return quote.amount_paid.subtract(quote.amount_issued);
}

export function deriveBolt12MintQuoteState(
  quote: MintQuoteBolt12Response,
  operationAmount: Amount,
): 'UNPAID' | 'PAID' {
  if (quote.amount_paid.lessThanOrEqual(quote.amount_issued)) {
    return 'UNPAID';
  }

  const available = getBolt12AvailableMintAmount(quote);
  return available.greaterThanOrEqual(operationAmount) ? 'PAID' : 'UNPAID';
}

function compareBolt12AllocationPriority(
  a: PendingMintOperation<'bolt12'>,
  b: PendingMintOperation<'bolt12'>,
): number {
  const aAlreadyPaid = a.lastObservedRemoteState === 'PAID' ? 0 : 1;
  const bAlreadyPaid = b.lastObservedRemoteState === 'PAID' ? 0 : 1;
  if (aAlreadyPaid !== bAlreadyPaid) return aAlreadyPaid - bAlreadyPaid;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

export function allocateBolt12PaidMintOperationIds(
  quote: MintQuoteBolt12Response,
  operations: PendingMintOperation<'bolt12'>[],
): Set<string> {
  let remaining = getBolt12AvailableMintAmount(quote);
  const paidOperationIds = new Set<string>();

  for (const operation of [...operations].sort(compareBolt12AllocationPriority)) {
    if (operation.amount.isZero()) continue;
    if (!remaining.greaterThanOrEqual(operation.amount)) continue;

    paidOperationIds.add(operation.id);
    remaining = remaining.subtract(operation.amount);
  }

  return paidOperationIds;
}
