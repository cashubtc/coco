/** Durable reference to the Mint Swap Operation that owns a Mint or Melt Operation. */
export interface MintSwapOperationParent {
  kind: 'mint-swap';
  id: string;
}

/** Return whether an unknown persisted value is a valid Mint Swap parent reference. */
export function isMintSwapOperationParent(value: unknown): value is MintSwapOperationParent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { kind?: unknown; id?: unknown };
  return (
    candidate.kind === 'mint-swap' &&
    typeof candidate.id === 'string' &&
    candidate.id.trim().length > 0
  );
}

/** Validate an untrusted or persisted Mint Swap parent reference. */
export function assertMintSwapOperationParent(
  value: unknown,
): asserts value is MintSwapOperationParent {
  if (!isMintSwapOperationParent(value)) {
    throw new Error('Mint Swap operation parent must have kind mint-swap and a non-empty id');
  }
}

/** Create a validated Mint Swap parent reference for a dedicated child operation. */
export function createMintSwapOperationParent(id: string): MintSwapOperationParent {
  const parent: MintSwapOperationParent = { kind: 'mint-swap', id };
  assertMintSwapOperationParent(parent);
  return parent;
}
