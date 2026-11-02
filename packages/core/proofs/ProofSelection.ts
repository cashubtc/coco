import {
  Amount,
  splitAmount,
  sumProofs,
  type KeyChain,
  type MintKeys,
  type Proof,
  type SelectProofs,
} from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError } from '@core/models/Error.ts';

/** Receiver net target and, when needed, the keys for planning new swap outputs. */
export interface ReceiverFeePolicy {
  amount: Amount;
  /** Omit when the gross amount and fixed outputs were already prepared before the transaction. */
  swapOutputKeys?: MintKeys;
}

export function selectProofInputs(
  operation: { amount: Amount; unit: string },
  available: Proof[],
  keyChain: KeyChain,
  selectProofs: SelectProofs,
  forceSwap: boolean,
  receiver?: ReceiverFeePolicy,
): { proofs: Proof[]; fee: Amount; needsSwap: boolean; sendAmount: Amount } {
  const unit = normalizeUnit(operation.unit);
  for (const proof of available) {
    assertSameUnit(normalizeUnit((proof as { unit?: string }).unit), unit, 'Send proof selection');
  }
  if (sumProofs(available).lessThan(receiver?.amount ?? operation.amount)) {
    throw new ProofValidationError('Not enough proofs to send');
  }

  if (!forceSwap) {
    const exact = selectProofs(
      available,
      receiver?.amount ?? operation.amount,
      keyChain,
      receiver !== undefined,
    ).send;
    const directAmount = receiver
      ? receiver.amount.add(calculateProofFee(exact, keyChain))
      : operation.amount;
    if (sumProofs(exact).equals(directAmount)) {
      return { proofs: exact, fee: Amount.zero(), needsSwap: false, sendAmount: directAmount };
    }
  }

  // Direct proofs use their own keysets. Only a swap needs a viable issuing-keyset fee plan.
  const sendAmount = receiver?.swapOutputKeys
    ? feeCoveredSendAmount(receiver.amount, receiver.swapOutputKeys, keyChain)
    : operation.amount;
  const selected = selectProofs(available, sendAmount, keyChain, true).send;
  const fee = calculateProofFee(selected, keyChain);
  if (selected.length > 0 && sumProofs(selected).greaterThanOrEqual(sendAmount.add(fee))) {
    return { proofs: selected, fee, needsSwap: true, sendAmount };
  }
  throw new ProofValidationError('Send amount is not sufficient after fees');
}

export function calculateProofFee(
  proofs: readonly Pick<Proof, 'id'>[],
  keyChain: KeyChain,
): Amount {
  const ppk = proofs.reduce((sum, proof) => {
    let fee: number;
    try {
      fee = keyChain.getKeyset(proof.id).fee;
    } catch {
      throw new ProofValidationError(`Missing fee preflight for keyset ${proof.id}`);
    }
    return sum + BigInt(fee);
  }, 0n);
  return Amount.from((ppk + 999n) / 1000n);
}

/** Plan gross outputs against their own denominations, without allocating any output positions. */
export function feeCoveredSendAmount(
  netAmount: Amount,
  activeKeys: MintKeys,
  keyChain: KeyChain,
): Amount {
  const largestDenomination = Object.keys(activeKeys.keys).reduce((largest, denomination) => {
    const value = BigInt(denomination);
    return value > largest ? value : largest;
  }, 0n);
  // If even the largest proof costs its full value to redeem, no output set can fund a
  // positive net amount. Reject before denomination arrays can grow with the allowance.
  if (BigInt(keyChain.getKeyset(activeKeys.id).fee) >= largestDenomination * 1000n) {
    throw new ProofValidationError('Unable to fund receiver input fees with this keyset');
  }
  let grossAmount = netAmount;
  // Increasing the allowance can change the proof count in either direction. Keep a sufficient
  // candidate rather than oscillating toward equality; pathological fee schedules reject finitely.
  for (let attempt = 0; attempt < 128; attempt++) {
    const outputs = splitAmount(grossAmount, activeKeys.keys).map(() => ({ id: activeKeys.id }));
    const required = netAmount.add(calculateProofFee(outputs, keyChain));
    if (grossAmount.greaterThanOrEqual(required)) return grossAmount;
    grossAmount = required;
  }
  throw new ProofValidationError('Unable to fund receiver input fees with this keyset');
}
