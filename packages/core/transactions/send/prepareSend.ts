import { sumProofs } from '@cashu/cashu-ts';
import { SendOperationConflictError } from '@core/models/Error.ts';
import type { PreparedSendOperation } from '@core/operations/send/SendOperation.ts';
import type { PrepareSendInput, PreparedSendResult } from './types.ts';
import type { CoreTransaction } from '../CoreTransaction.ts';
import { trackTransactionWork } from '../TransactionLifetime.ts';

/** Reserve inputs and persist their output allocation and prepared Send together. */
export function prepareSend(
  transaction: CoreTransaction,
  input: PrepareSendInput,
): Promise<PreparedSendResult> {
  return trackTransactionWork(transaction, async () => {
    const operation = input.operation;
    const existing = await transaction.sendOperations.getById(operation.id);
    if (existing) {
      throw new SendOperationConflictError(
        operation.id,
        `Send operation id ${operation.id} already exists`,
      );
    }

    await transaction.mintMetadata.assertTrusted(operation.mintUrl);
    const selected = await transaction.proofs.selectAndReserve({
      mintUrl: operation.mintUrl,
      unit: operation.unit,
      operationId: operation.id,
      amount: operation.amount,
      forceSwap: input.forceSwap,
    });
    const inputAmount = sumProofs(selected.proofs);
    const inputProofSecrets = selected.proofs.map((proof) => proof.secret);

    let outputData: PreparedSendOperation['outputData'];
    let counterUpdate: PreparedSendResult['counter'];
    if (selected.needsSwap) {
      const allocation = await transaction.outputs.allocate({
        mintUrl: operation.mintUrl,
        unit: operation.unit,
        activeKeys: input.activeKeys,
        seed: input.seed,
        keepAmount: inputAmount.subtract(operation.amount.add(selected.fee)),
        sendAmount: operation.amount,
        fixedSendOutputs: input.fixedSendOutputs,
      });
      outputData = allocation.outputData;
      counterUpdate = allocation.counter;
    } else {
      await transaction.outputs.assertActiveKeys(
        operation.mintUrl,
        operation.unit,
        input.activeKeys,
      );
    }

    const prepared: PreparedSendOperation = {
      ...operation,
      state: 'prepared',
      revision: 0,
      updatedAt: operation.updatedAt,
      needsSwap: selected.needsSwap,
      fee: selected.fee,
      inputAmount,
      inputProofSecrets,
      outputData,
    };
    await transaction.sendOperations.create(prepared);

    return {
      operation: prepared,
      reservation: {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        secrets: inputProofSecrets,
        amount: inputAmount,
        unit: operation.unit,
      },
      counter: counterUpdate,
    };
  });
}
