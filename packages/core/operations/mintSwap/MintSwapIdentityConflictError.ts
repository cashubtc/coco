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
