import { splitAmount, type Amount, type KeyChain, type MintKeys } from '@cashu/cashu-ts';
import { ProofValidationError } from '@core/models/Error.ts';
import { calculateProofFee } from '@core/proofs/ProofSelection.ts';

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
