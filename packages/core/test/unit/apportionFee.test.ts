import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import {
  apportionReceiveFee,
  type ApportionableReceive,
} from '../../operations/receive/apportionFee';

describe('apportionReceiveFee', () => {
  const op = (id: string, amount: number): ApportionableReceive => ({
    id,
    amount: Amount.from(amount),
  });

  const sumShares = (shares: Map<string, { feeShare: Amount; keepAmount: Amount }>) => ({
    fee: Amount.sum([...shares.values()].map((share) => share.feeShare)),
    keep: Amount.sum([...shares.values()].map((share) => share.keepAmount)),
  });

  it('charges a single operation the whole fee', async () => {
    const shares = apportionReceiveFee([op('a', 10)], Amount.from(1));

    expect(shares.get('a')?.feeShare).toEqual(Amount.from(1));
    expect(shares.get('a')?.keepAmount).toEqual(Amount.from(9));
  });

  it('charges the largest member first (queued dust + incoming token)', async () => {
    // The user scenario from issue #46: a queued 1-sat dust proof batched with
    // an incoming 32-sat token at a combined fee of 1 sat.
    const shares = apportionReceiveFee([op('dust', 1), op('incoming', 32)], Amount.from(1));

    expect(shares.get('incoming')?.feeShare).toEqual(Amount.from(1));
    expect(shares.get('incoming')?.keepAmount).toEqual(Amount.from(31));
    expect(shares.get('dust')?.feeShare).toEqual(Amount.from(0));
    expect(shares.get('dust')?.keepAmount).toEqual(Amount.from(1));
  });

  it('spreads a fee larger than the largest member across several members', async () => {
    const shares = apportionReceiveFee([op('a', 3), op('b', 2), op('c', 2)], Amount.from(4));

    expect(shares.get('a')?.feeShare).toEqual(Amount.from(3));
    expect(shares.get('b')?.feeShare).toEqual(Amount.from(1));
    expect(shares.get('c')?.feeShare).toEqual(Amount.from(0));

    const { fee, keep } = sumShares(shares);
    expect(fee).toEqual(Amount.from(4));
    expect(keep).toEqual(Amount.from(3));
  });

  it('allows members to keep zero when the fee consumes them', async () => {
    const shares = apportionReceiveFee([op('a', 1), op('b', 1)], Amount.from(1));

    expect(shares.get('a')?.keepAmount).toEqual(Amount.from(0));
    expect(shares.get('b')?.keepAmount).toEqual(Amount.from(1));
  });

  it('preserves the invariants for many dust members', async () => {
    const ops = Array.from({ length: 10 }, (_, i) => op(`dust-${i}`, 1));
    const shares = apportionReceiveFee(ops, Amount.from(1));

    const { fee, keep } = sumShares(shares);
    expect(fee).toEqual(Amount.from(1));
    expect(keep).toEqual(Amount.from(9));
    for (const share of shares.values()) {
      expect(share.feeShare.lessThanOrEqual(Amount.from(1))).toBe(true);
    }
  });

  it('is deterministic under input reordering', async () => {
    const ops = [op('b', 2), op('a', 2), op('c', 7)];
    const shares = apportionReceiveFee(ops, Amount.from(3));
    const reordered = apportionReceiveFee([...ops].reverse(), Amount.from(3));

    for (const [id, share] of shares) {
      expect(reordered.get(id)?.feeShare).toEqual(share.feeShare);
      expect(reordered.get(id)?.keepAmount).toEqual(share.keepAmount);
    }
    // Ties on amount are broken by id: 'a' pays before 'b'.
    expect(shares.get('c')?.feeShare).toEqual(Amount.from(3));
    expect(shares.get('a')?.feeShare).toEqual(Amount.from(0));
  });

  it('throws when the fee exceeds the combined amount', async () => {
    expect(() => apportionReceiveFee([op('a', 1), op('b', 1)], Amount.from(3))).toThrow(
      'exceeds combined receive amount',
    );
  });

  it('handles a zero fee and empty input', async () => {
    const shares = apportionReceiveFee([op('a', 5)], Amount.zero());
    expect(shares.get('a')?.keepAmount).toEqual(Amount.from(5));

    expect(apportionReceiveFee([], Amount.zero()).size).toBe(0);
    expect(() => apportionReceiveFee([], Amount.from(1))).toThrow(
      'across zero operations',
    );
  });
});
