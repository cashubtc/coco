import type {
  ExecutingSendOperation,
  PreparedSendOperation,
} from '@core/operations/send/SendOperation.ts';
import type { CoreProof } from '@core/types.ts';
import type { CoreTransaction } from '../CoreTransaction.ts';

export async function getOwnedReadyInputs(
  transaction: CoreTransaction,
  operation: PreparedSendOperation | ExecutingSendOperation,
): Promise<CoreProof[]> {
  return transaction.proofs.getOwned({
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    operationId: operation.id,
    secrets: operation.inputProofSecrets,
    state: 'ready',
  });
}
