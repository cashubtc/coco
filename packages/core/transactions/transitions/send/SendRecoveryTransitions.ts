import { SendOperationConflictError } from '@core/models/Error.ts';
import {
  isTerminalOperation,
  type RolledBackSendOperation,
  type ExecutingSendOperation,
} from '@core/operations/send/SendOperation.ts';
import type { CoreProof } from '@core/types.ts';
import type { CoreTransaction } from '../../CoreTransaction.ts';
import { trackTransactionWork } from '../../TransactionLifetime.ts';
import type {
  ClaimSendRecoveryResult,
  ClaimSendRecoveryInput,
  CleanupLegacySendInitResult,
  CleanupOrphanedSendReservationsResult,
  RecoverLegacyExactSendInput,
  RecoverLegacyExactSendResult,
} from './SendTransitionTypes.ts';
import { assertExactInputs } from './SendValidation.ts';

export function claimSendRecovery(
  tx: CoreTransaction,
  input: ClaimSendRecoveryInput,
): Promise<ClaimSendRecoveryResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
    if (
      !current ||
      current.state !== 'executing' ||
      !current.needsSwap ||
      !current.outputData ||
      (current.revision ?? 0) !== input.expectedRevision
    ) {
      throw new SendOperationConflictError(
        input.operationId,
        'Send recovery lost an executing-state or revision conflict',
      );
    }
    // Legacy handlers spent inputs before persisting pending. A recovery claim never releases them.
    const inputProofs = await tx.proofs.getOwned({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
      state: ['ready', 'spent'],
    });
    const claimed: ExecutingSendOperation = {
      ...current,
      revision: input.expectedRevision + 1,
      updatedAt: input.updatedAt,
    };
    const transitioned = await tx.sendOperations.transition({
      operationId: current.id,
      expectedState: 'executing',
      expectedRevision: input.expectedRevision,
      next: claimed,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Send recovery lost an executing-state or revision conflict',
      );
    }
    return {
      operation: claimed,
      request: {
        mintUrl: claimed.mintUrl,
        unit: claimed.unit,
        amount: claimed.amount,
        inputProofs,
        outputData: claimed.outputData!,
      },
    };
  });
}

export function recoverLegacyExactSend(
  tx: CoreTransaction,
  input: RecoverLegacyExactSendInput,
): Promise<RecoverLegacyExactSendResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
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
    const inputs = await tx.proofs.getOwned({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
      state: ['ready', 'inflight'],
    });
    assertExactInputs(inputs, current);
    // The old exact path returned a token only after persisting pending and never submitted inputs.
    await tx.proofs.releaseUnsubmitted({
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
      !(await tx.sendOperations.transition({
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
      changed: true,
    };
  });
}

export function cleanupLegacySendInit(
  tx: CoreTransaction,
  operationId: string,
): Promise<CleanupLegacySendInitResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(operationId);
    if (!current || current.state !== 'init') {
      throw new SendOperationConflictError(operationId, 'Legacy Send init operation not found');
    }
    const operationProofs = await tx.proofs.getProofsByOperationId(current.mintUrl, current.id);
    const ownedSecrets = operationProofs
      .filter((proof) => proof.usedByOperationId === current.id)
      .map((proof) => proof.secret);
    if (ownedSecrets.length > 0) {
      await tx.proofs.releaseOwned(current.mintUrl, current.id, ownedSecrets);
    }
    await tx.sendOperations.delete(current.id);
    return {
      operationId: current.id,
      mintUrl: current.mintUrl,
      releasedProofSecrets: ownedSecrets,
    };
  });
}

export function cleanupOrphanedSendReservations(
  tx: CoreTransaction,
): Promise<CleanupOrphanedSendReservationsResult> {
  return trackTransactionWork(tx, async () => {
    const reservedProofs = await tx.proofs.getReservedProofs();
    const reservedByMint = new Map<string, CoreProof[]>();
    for (const proof of reservedProofs) {
      if (!proof.usedByOperationId) continue;
      const proofs = reservedByMint.get(proof.mintUrl) ?? [];
      proofs.push(proof);
      reservedByMint.set(proof.mintUrl, proofs);
    }

    const released: CleanupOrphanedSendReservationsResult['released'] = [];
    for (const [mintUrl, reserved] of reservedByMint) {
      const operations = await tx.sendOperations.getByMintUrl(mintUrl);
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
        await tx.proofs.releaseOwned(
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
