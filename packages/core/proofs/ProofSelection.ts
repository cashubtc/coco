import { Amount, sumProofs, type KeyChain, type Proof, type SelectProofs } from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError } from '@core/models/Error.ts';

export function selectProofInputs(
  operation: { amount: Amount; unit: string; offline?: boolean },
  available: Proof[],
  keyChain: KeyChain,
  selectProofs: SelectProofs,
  forceSwap: boolean,
): { proofs: Proof[]; fee: Amount; needsSwap: boolean } {
  const unit = normalizeUnit(operation.unit);
  for (const proof of available) {
    assertSameUnit(normalizeUnit((proof as { unit?: string }).unit), unit, 'Send proof selection');
  }
  if (sumProofs(available).lessThan(operation.amount)) {
    throw new ProofValidationError('Not enough proofs to send');
  }

  if (!forceSwap) {
    if (operation.offline) {
      // Largest-first is exact for binary denominations; randomized selection can miss them.
      const sorted = [...available].sort((a, b) =>
        a.amount.equals(b.amount) ? 0 : a.amount.greaterThan(b.amount) ? -1 : 1,
      );
      const exact: Proof[] = [];
      let remaining = operation.amount;
      for (const proof of sorted) {
        if (remaining.isZero()) break;
        if (proof.amount.greaterThan(remaining)) continue;
        exact.push(proof);
        remaining = remaining.subtract(proof.amount);
      }
      if (remaining.isZero()) {
        // An exact transfer still requires known input keysets.
        for (const proof of exact) keyChain.getKeyset(proof.id);
        return { proofs: exact, fee: Amount.zero(), needsSwap: false };
      }
    }
    const exact = selectProofs(available, operation.amount, keyChain, false).send;
    if (sumProofs(exact).equals(operation.amount)) {
      return { proofs: exact, fee: Amount.zero(), needsSwap: false };
    }
  }

  const selected = selectProofs(available, operation.amount, keyChain, true).send;
  const fee = calculateProofFee(selected, keyChain);
  if (selected.length > 0 && sumProofs(selected).greaterThanOrEqual(operation.amount.add(fee))) {
    return { proofs: selected, fee, needsSwap: true };
  }
  throw new ProofValidationError('Send amount is not sufficient after fees');
}

export function calculateProofFee(proofs: readonly Proof[], keyChain: KeyChain): Amount {
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
