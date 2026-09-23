import { Amount, sumProofs } from '@cashu/cashu-ts';
import { assertOutputProofs } from '@core/proofs/OutputProofs.ts';
import { SendOperationConflictError, ProofValidationError } from '@core/models/Error.ts';
import {
  getSendProofSecrets,
  getKeepProofSecrets,
  type RollingBackSendOperation,
  type RolledBackSendOperation,
} from '@core/operations/send/SendOperation.ts';
import type {
  BeginReclaimInput,
  BegunReclaim,
  CompleteReclaimInput,
  CompletedReclaim,
} from './types.ts';
import type { CoreTransaction } from '../CoreTransaction.ts';
import { trackTransactionWork } from '../TransactionLifetime.ts';

export function beginSendReclaim(
  transaction: CoreTransaction,
  input: BeginReclaimInput,
): Promise<BegunReclaim> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(input.operationId);
    if (!current || current.state !== 'pending' || current.method !== 'default') {
      throw new SendOperationConflictError(
        input.operationId,
        'Pending Send reclaim lost a state or revision conflict',
      );
    }
    const sendSecrets = getSendProofSecrets(current);
    const associated = await transaction.proofs.getProofsByOperationId(current.mintUrl, current.id);
    const secrets = associated
      .filter((proof) => sendSecrets.includes(proof.secret) && proof.state === 'inflight')
      .map((proof) => proof.secret);
    const inputProofs = await transaction.proofs.getOwned({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets,
      state: 'inflight',
      ownership: current.needsSwap ? 'created' : 'used',
    });
    const total = sumProofs(inputProofs);
    const fee = await transaction.proofs.getFee(current.mintUrl, current.unit, inputProofs);
    const skippedForFees = inputProofs.length > 0 && total.lessThanOrEqual(fee);
    const allocation =
      inputProofs.length > 0 && !skippedForFees
        ? await transaction.outputs.allocate({
            mintUrl: current.mintUrl,
            unit: current.unit,
            activeKeys: input.activeKeys,
            seed: input.seed,
            keepAmount: total.subtract(fee),
            sendAmount: Amount.zero(),
          })
        : undefined;
    const revision = current.revision ?? 0;
    const rollingBack: RollingBackSendOperation = {
      ...current,
      state: 'rolling_back',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      // Keep the original Send request intact. Reclaim has a separate Output Allocation.
      reclaimData: allocation
        ? { inputProofSecrets: secrets, outputData: allocation.outputData }
        : undefined,
    };
    const transitioned = await transaction.sendOperations.transition({
      operationId: current.id,
      expectedState: 'pending',
      expectedRevision: revision,
      next: rollingBack,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Pending Send reclaim lost a state or revision conflict',
      );
    }
    return { operation: rollingBack, inputProofs, counter: allocation?.counter, skippedForFees };
  });
}

export function completeSendReclaim(
  transaction: CoreTransaction,
  input: CompleteReclaimInput,
): Promise<CompletedReclaim> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(input.operationId);
    if (!current || current.state !== 'rolling_back') {
      throw new SendOperationConflictError(
        input.operationId,
        'Pending Send reclaim completion lost a state or revision conflict',
      );
    }
    const allocation = current.reclaimData;
    const spentProofSecrets = allocation?.inputProofSecrets ?? [];
    if (allocation) {
      assertOutputProofs({
        mintUrl: current.mintUrl,
        unit: current.unit,
        outputData: allocation.outputData,
        kind: 'keep',
        state: 'ready',
        proofs: input.proofs,
      });
      await transaction.proofs.settleSpend({
        mintUrl: current.mintUrl,
        unit: current.unit,
        operationId: current.id,
        secrets: spentProofSecrets,
        state: ['inflight', 'spent'],
        ownership: current.needsSwap ? 'created' : 'used',
        outputs: input.proofs,
      });
    } else if (input.proofs.length > 0) {
      throw new ProofValidationError('Reclaimed proofs have no committed output plan');
    }
    const associated = await transaction.proofs.getProofsByOperationId(current.mintUrl, current.id);
    const releaseCandidates = new Set([
      ...current.inputProofSecrets,
      ...getKeepProofSecrets(current),
    ]);
    const releasedProofSecrets = associated
      .filter(
        (proof) => proof.usedByOperationId === current.id && releaseCandidates.has(proof.secret),
      )
      .map((proof) => proof.secret);
    await transaction.proofs.releaseOwned(current.mintUrl, current.id, releasedProofSecrets);
    const revision = current.revision ?? 0;
    const rolledBack: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      error: input.reason,
    };
    const transitioned = await transaction.sendOperations.transition({
      operationId: current.id,
      expectedState: 'rolling_back',
      expectedRevision: revision,
      next: rolledBack,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Pending Send reclaim completion lost a state or revision conflict',
      );
    }
    return {
      operation: rolledBack,
      savedProofs: input.proofs,
      spentProofSecrets,
      releasedProofSecrets,
    };
  });
}
