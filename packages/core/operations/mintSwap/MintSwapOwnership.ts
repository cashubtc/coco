import { MintSwapChildOperationError } from '../../models/Error.ts';
import type { MintQuoteRef, MeltQuoteRef } from '../../models/QuoteIdentity.ts';
import type { CoreTransaction } from '../../transactions/CoreTransaction.ts';

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

/** Ordinary coordinators call this in the same scope as authorization or mutation. */
export async function assertStandaloneOperation(
  tx: CoreTransaction,
  kind: 'mint' | 'melt',
  target: string | MintQuoteRef | MeltQuoteRef,
): Promise<void> {
  const parent = await findMintSwapOwner(tx, kind, target);
  if (parent) throw new MintSwapChildOperationError(parent.id);
}
