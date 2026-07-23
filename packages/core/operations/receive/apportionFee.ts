import { Amount } from '@cashu/cashu-ts';

export interface ApportionableReceive {
  /** Operation id the share is keyed by */
  id: string;

  /** The operation's input amount */
  amount: Amount;
}

export interface ApportionedReceiveShare {
  /** Portion of the batch fee charged to this operation */
  feeShare: Amount;

  /** Output value kept for this operation (amount - feeShare) */
  keepAmount: Amount;
}

/**
 * Deterministically apportion a single batched swap fee across member
 * operations. A batch swap pays one ceil'd fee for all inputs combined
 * (NUT-02), so members cannot each subtract their own solo fee; instead the
 * batch fee is charged to the largest members first, letting small (dust)
 * members keep their full value whenever possible.
 *
 * Guarantees, independent of input order:
 * - every share satisfies 0 <= feeShare <= amount (no Amount underflow)
 * - sum(feeShare) === fee
 * - sum(keepAmount) === sum(amount) - fee
 *
 * Throws when the fee exceeds the combined amount; callers must check batch
 * viability (total > fee) before apportioning.
 */
export function apportionReceiveFee(
  operations: ApportionableReceive[],
  fee: Amount,
): Map<string, ApportionedReceiveShare> {
  const shares = new Map<string, ApportionedReceiveShare>();
  if (operations.length === 0) {
    if (!fee.isZero()) {
      throw new Error('Cannot apportion a non-zero fee across zero operations');
    }
    return shares;
  }

  const total = Amount.sum(operations.map((op) => op.amount));
  if (total.lessThan(fee)) {
    throw new Error(
      `Batch fee (${fee.toString()}) exceeds combined receive amount (${total.toString()})`,
    );
  }

  const sorted = [...operations].sort((a, b) => {
    const byAmountDesc = b.amount.compareTo(a.amount);
    if (byAmountDesc !== 0) {
      return byAmountDesc;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let remainingFee = fee;
  for (const op of sorted) {
    const feeShare = remainingFee.lessThanOrEqual(op.amount) ? remainingFee : op.amount;
    remainingFee = remainingFee.subtract(feeShare);
    shares.set(op.id, { feeShare, keepAmount: op.amount.subtract(feeShare) });
  }

  return shares;
}
