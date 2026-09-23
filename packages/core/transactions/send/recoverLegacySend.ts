import { SendOperationConflictError } from '@core/models/Error.ts';
import {
  isTerminalOperation,
  type RolledBackSendOperation,
} from '@core/operations/send/SendOperation.ts';
import type { CoreProof } from '@core/types.ts';
import type {
  RecoverLegacyExactSendInput,
  RecoveredLegacyExactSend,
  CleanupLegacyInitResult,
  CleanupOrphanedSendReservationsResult,
} from './types.ts';
import type { CoreTransaction } from '../CoreTransaction.ts';
import { trackTransactionWork } from '../TransactionLifetime.ts';
import { assertExactInputs } from './validation.ts';

export function recoverLegacyExactSend(
  transaction: CoreTransaction,
  input: RecoverLegacyExactSendInput,
): Promise<RecoveredLegacyExactSend> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(input.operationId);
    // New exact Sends never enter executing. Legacy rows normalize their absent revision to zero.
    if (
      !current ||
      current.state !== 'executing' ||
      (current.revision ?? 0) !== 0 ||
      current.method !== 'default' ||
      current.needsSwap ||
      current.outputData ||
      ('token' in current && current.token)
    ) {
      throw new SendOperationConflictError(
        input.operationId,
        'Legacy exact Send recovery lost a state or revision conflict',
      );
    }
    const inputs = await transaction.proofs.getOwned({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
      state: ['ready', 'inflight'],
    });
    assertExactInputs(inputs, current);
    // The old exact path returned a token only after persisting pending and never submitted inputs.
    await transaction.proofs.releaseUnsubmitted({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
    });
    const operation: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: 1,
      updatedAt: input.updatedAt,
      error: 'Recovered legacy exact Send interrupted before token delivery',
    };
    if (
      !(await transaction.sendOperations.transition({
        operationId: current.id,
        expectedState: 'executing',
        expectedRevision: 0,
        next: operation,
      }))
    ) {
      throw new SendOperationConflictError(current.id, 'Legacy exact Send recovery conflicted');
    }
    return {
      operation,
      readyProofSecrets: inputs
        .filter((proof) => proof.state === 'inflight')
        .map((proof) => proof.secret),
      releasedInputSecrets: [...current.inputProofSecrets],
      committed: true,
    };
  });
}

export function cleanupLegacySendInit(
  transaction: CoreTransaction,
  operationId: string,
): Promise<CleanupLegacyInitResult> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(operationId);
    if (!current || current.state !== 'init') {
      throw new SendOperationConflictError(operationId, 'Legacy Send init operation not found');
    }
    const operationProofs = await transaction.proofs.getProofsByOperationId(
      current.mintUrl,
      current.id,
    );
    const ownedSecrets = operationProofs
      .filter((proof) => proof.usedByOperationId === current.id)
      .map((proof) => proof.secret);
    if (ownedSecrets.length > 0) {
      await transaction.proofs.releaseOwned(current.mintUrl, current.id, ownedSecrets);
    }
    await transaction.sendOperations.delete(current.id);
    return {
      operationId: current.id,
      mintUrl: current.mintUrl,
      releasedProofSecrets: ownedSecrets,
    };
  });
}

export function cleanupOrphanedSendReservations(
  transaction: CoreTransaction,
): Promise<CleanupOrphanedSendReservationsResult> {
  return trackTransactionWork(transaction, async () => {
    const reservedProofs = await transaction.proofs.getReservedProofs();
    const reservedByMint = new Map<string, CoreProof[]>();
    for (const proof of reservedProofs) {
      if (!proof.usedByOperationId) continue;
      const proofs = reservedByMint.get(proof.mintUrl) ?? [];
      proofs.push(proof);
      reservedByMint.set(proof.mintUrl, proofs);
    }

    const released: CleanupOrphanedSendReservationsResult['released'] = [];
    for (const [mintUrl, reserved] of reservedByMint) {
      const operations = await transaction.sendOperations.getByMintUrl(mintUrl);
      const operationById = new Map(operations.map((operation) => [operation.id, operation]));
      const secrets = reserved
        .filter((proof) => {
          const operation = operationById.get(proof.usedByOperationId!);
          // A missing Send record does not establish ownership: Melt and future
          // workflows also reserve proofs. Only clean up known terminal Sends.
          return operation !== undefined && isTerminalOperation(operation);
        })
        .map((proof) => proof.secret);
      if (secrets.length > 0) released.push({ mintUrl, secrets });
    }
    for (const group of released) {
      const reserved = reservedByMint.get(group.mintUrl)!;
      const owners = new Set(
        reserved
          .filter((proof) => group.secrets.includes(proof.secret))
          .map((proof) => proof.usedByOperationId!),
      );
      for (const owner of owners) {
        await transaction.proofs.releaseOwned(
          group.mintUrl,
          owner,
          reserved
            .filter(
              (proof) => proof.usedByOperationId === owner && group.secrets.includes(proof.secret),
            )
            .map((proof) => proof.secret),
        );
      }
    }
    return {
      released,
      count: released.reduce((count, group) => count + group.secrets.length, 0),
    };
  });
}
