import type { MintQuoteRef, MeltQuoteRef } from '../../models/QuoteIdentity.ts';
import type { CoreTransaction } from '../../transactions/CoreTransaction.ts';
import { MintSwapChildOperationError } from './MintSwapErrors.ts';
import { isMintSwapQuiescentState, type MintSwapOperation } from './MintSwapOperation.ts';

/**
 * `resolve` covers recovery, release and issuance into this Wallet. `effect` authorizes a new
 * source payment: Melt preparation against a quote or execution of a prepared Melt.
 */
export type OrdinaryChildAuthority = 'resolve' | 'effect';

/** Look up immutable parent identities, including historical and terminal records. */
export async function findMintSwapOwner(
  tx: CoreTransaction,
  kind: 'mint' | 'melt',
  target: string | MintQuoteRef | MeltQuoteRef,
) {
  if (typeof target !== 'string') return tx.mintSwapOperations.getByQuote(kind, target);
  const parent = await tx.mintSwapOperations.getByChild(kind, target);
  if (parent) return parent;
  const operation = await (kind === 'mint' ? tx.mintOperations : tx.meltOperations).getById(target);
  // Quote ownership also excludes historical sibling operations and new automatic claims.
  return operation?.quoteId
    ? tx.mintSwapOperations.getByQuote(kind, {
        mintUrl: operation.mintUrl,
        method: operation.method,
        quoteId: operation.quoteId,
      })
    : null;
}

/**
 * An active parent excludes all ordinary work. A quiescent parent can never act again, so its
 * children return to ordinary resolution; its source payment stays blocked because a stopped
 * parent may have recorded evidence against paying it.
 */
export function allowsOrdinaryWork(
  parent: MintSwapOperation | null,
  authority: OrdinaryChildAuthority,
): boolean {
  if (!parent) return true;
  return authority === 'resolve' && isMintSwapQuiescentState(parent.state);
}

/** Ordinary coordinators call this in the same scope as authorization or mutation. */
export async function assertOrdinaryWork(
  tx: CoreTransaction,
  kind: 'mint' | 'melt',
  target: string | MintQuoteRef | MeltQuoteRef,
  authority: OrdinaryChildAuthority,
): Promise<void> {
  const parent = await findMintSwapOwner(tx, kind, target);
  if (parent && !allowsOrdinaryWork(parent, authority))
    throw new MintSwapChildOperationError(parent.id, isMintSwapQuiescentState(parent.state));
}
