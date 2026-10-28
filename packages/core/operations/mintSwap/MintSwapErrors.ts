import { ProofValidationError } from '../../models/Error.ts';
import type { MintSwapAttention } from './MintSwapOperation.ts';

export class MintSwapDebitCapError extends ProofValidationError {
  constructor() {
    super('Mint Swap source debit exceeds caller cap');
  }
}

export type MintSwapIdentityKind =
  | 'parent'
  | 'source_quote'
  | 'destination_quote'
  | 'source_child'
  | 'destination_child';

/** A non-sensitive persistence conflict for one all-time Mint Swap identity. */
export class MintSwapIdentityConflictError extends Error {
  constructor(readonly kind: MintSwapIdentityKind) {
    super(`Mint Swap ${kind.replace('_', ' ')} already exists`);
    this.name = 'MintSwapIdentityConflictError';
  }
}

export class MintSwapIntentConflictError extends Error {
  constructor() {
    super('Mint Swap ID belongs to a different intent');
    this.name = 'MintSwapIntentConflictError';
  }
}

export class MintSwapInvariantError extends Error {
  constructor(
    readonly invariant: MintSwapAttention['invariant'],
    readonly code: MintSwapAttention['evidence']['code'],
    readonly leg: 'source' | 'destination',
  ) {
    super(`Mint Swap ${leg} ${invariant}: ${code}`);
    this.name = 'MintSwapInvariantError';
  }
  evidence(now: number): MintSwapAttention {
    return {
      reason: [
        'child_missing',
        'quote_missing',
        'key_missing',
        'outputs_missing',
        'proofs_missing',
      ].includes(this.code)
        ? 'missing_recovery_material'
        : 'contradictory_evidence',
      invariant: this.invariant,
      evidence: { code: this.code, leg: this.leg, observedAt: now },
    };
  }
}

/**
 * Ordinary child commands must be routed through an active Mint Swap parent. After the parent
 * stops, only its source payment remains rejected; `parentStopped` distinguishes that case.
 */
export class MintSwapChildOperationError extends Error {
  constructor(
    readonly parentOperationId: string,
    readonly parentStopped = false,
  ) {
    super(
      parentStopped
        ? `This operation or quote belongs to stopped Mint Swap ${parentOperationId}; its source payment cannot be authorized.`
        : `This operation or quote belongs to Mint Swap ${parentOperationId}; use ops.mintSwap with that parent ID.`,
    );
    this.name = 'MintSwapChildOperationError';
  }
}
