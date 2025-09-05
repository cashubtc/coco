import type { Proof } from '@cashu/cashu-ts';
import type { CoreProof, ProofState } from './types';
import type { Logger } from './logging/Logger.ts';

export function mapProofToCoreProof(
  mintUrl: string,
  state: ProofState,
  proofs: Proof[],
): CoreProof[] {
  return proofs.map((p) => ({
    ...p,
    mintUrl,
    state,
  }));
}

export function assertNonNegativeInteger(paramName: string, value: number, logger?: Logger): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    logger?.warn('Invalid numeric value', { [paramName]: value });
    throw new Error(`${paramName} must be a non-negative integer`);
  }
}
