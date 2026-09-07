import { Amount, sumProofs } from '@cashu/cashu-ts';
import { ProofValidationError, ReceiveOperationConflictError } from '@core/models/Error.ts';
import type {
  ExecutingReceiveOperation,
  FinalizedReceiveOperation,
  PreparedReceiveOperation,
  RolledBackReceiveOperation,
} from '@core/operations/receive/ReceiveOperation.ts';
import type { ReceiveOperationRepository } from '@core/repositories';
import type { CoreProof } from '@core/types.ts';
import { getSecretsFromSerializedOutputData } from '@core/utils.ts';
import { assertOutputProofs } from '@core/proofs/OutputProofs.ts';
import { sameCoreProofSet } from '@core/proofs/ProofIdentity.ts';
import type { ScopedProofCommands } from '../proofs/ScopedProofCommands.ts';
import type { ScopedOutputCommands } from '../outputs/ScopedOutputCommands.ts';
import type { ScopedMintMetadataCommands } from '../mints/ScopedMintMetadataCommands.ts';
import type {
  PrepareReceiveCommand,
  PreparedReceiveResult,
  BeginReceiveExecutionCommand,
  BegunReceiveExecution,
  ApplyReceiveResultCommand,
  AppliedReceiveResult,
  FailReceiveExecutionCommand,
  FailedReceiveExecution,
  CancelPreparedReceiveCommand,
} from '../../receive/types.ts';

export interface ScopedReceiveCommands {
  prepare(command: PrepareReceiveCommand): Promise<PreparedReceiveResult>;
  beginExecution(command: BeginReceiveExecutionCommand): Promise<BegunReceiveExecution>;
  applyResult(command: ApplyReceiveResultCommand): Promise<AppliedReceiveResult>;
  failExecution(command: FailReceiveExecutionCommand): Promise<FailedReceiveExecution>;
  cancelPrepared(command: CancelPreparedReceiveCommand): Promise<FailedReceiveExecution>;
  /** Compatibility seam for cleanup of Receive init rows persisted by older Coco versions. */
  deleteLegacyInit(operationId: string): Promise<void>;
}

export class RepositoryReceiveCommands implements ScopedReceiveCommands {
  constructor(
    private readonly receives: ReceiveOperationRepository,
    private readonly proofs: ScopedProofCommands,
    private readonly outputs: ScopedOutputCommands,
    private readonly mints: Pick<ScopedMintMetadataCommands, 'assertTrusted'>,
  ) {}

  async prepare(command: PrepareReceiveCommand): Promise<PreparedReceiveResult> {
    const operation = command.operation;
    if (
      operation.inputProofs.length === 0 ||
      new Set(operation.inputProofs.map((proof) => proof.secret)).size !==
        operation.inputProofs.length ||
      !sumProofs(operation.inputProofs).equals(operation.amount)
    ) {
      throw new ProofValidationError('Receive operation has invalid input proofs');
    }
    const existing = await this.receives.getById(operation.id);
    if (existing)
      throw new ReceiveOperationConflictError(
        operation.id,
        `Receive operation id ${operation.id} already exists`,
      );
    await this.mints.assertTrusted(operation.mintUrl);
    const fee = await this.proofs.getFee(operation.mintUrl, operation.unit, operation.inputProofs);
    if (operation.amount.lessThanOrEqual(fee))
      throw new ProofValidationError('Receive amount is not sufficient after fees');
    const allocation = await this.outputs.allocate({
      mintUrl: operation.mintUrl,
      unit: operation.unit,
      activeKeys: command.activeKeys,
      seed: command.seed,
      keepAmount: operation.amount.subtract(fee),
      sendAmount: Amount.zero(),
    });
    if (!allocation.counter || allocation.outputData.keep.length === 0) {
      throw new ProofValidationError('Failed to create deterministic outputs for receive');
    }
    const prepared: PreparedReceiveOperation = {
      ...operation,
      state: 'prepared',
      revision: 0,
      fee,
      outputData: allocation.outputData,
    };
    await this.receives.create(prepared);
    return { operation: prepared, counter: allocation.counter };
  }

  async beginExecution(command: BeginReceiveExecutionCommand): Promise<BegunReceiveExecution> {
    const current = await this.receives.getById(command.operationId);
    if (!current) {
      throw new ReceiveOperationConflictError(command.operationId, 'Receive operation not found');
    }
    if (current.state !== 'prepared') {
      throw new ReceiveOperationConflictError(
        command.operationId,
        `Cannot begin Receive execution in state ${current.state}`,
      );
    }
    assertExactReceiveRequest(current);
    const revision = current.revision ?? 0;
    const executing: ExecutingReceiveOperation = {
      ...current,
      state: 'executing',
      revision: revision + 1,
      updatedAt: command.updatedAt,
    };
    const transitioned = await this.receives.transition({
      operationId: current.id,
      expectedState: 'prepared',
      expectedRevision: revision,
      next: executing,
    });
    if (!transitioned) {
      throw new ReceiveOperationConflictError(
        current.id,
        'Receive execution lost a prepared-state or revision conflict',
      );
    }

    return {
      operation: executing,
      request: {
        mintUrl: executing.mintUrl,
        unit: executing.unit,
        inputProofs: executing.inputProofs,
        outputData: executing.outputData,
      },
    };
  }

  async applyResult(command: ApplyReceiveResultCommand): Promise<AppliedReceiveResult> {
    const current = await this.receives.getById(command.operationId);
    if (!current) {
      throw new ReceiveOperationConflictError(command.operationId, 'Receive operation not found');
    }
    if (current.state === 'finalized') {
      assertReceiveResult(current, command.proofs);
      const persisted = await this.getOperationProofs(current);
      if (!sameCoreProofSet(persisted, command.proofs)) {
        throw new ReceiveOperationConflictError(
          command.operationId,
          'Receive result conflicts with the persisted finalized proofs',
        );
      }
      return { operation: current, savedProofs: [], committed: false };
    }
    if (current.state !== 'executing') {
      throw new ReceiveOperationConflictError(
        command.operationId,
        `Cannot apply Receive result in state ${current.state}`,
      );
    }
    const revision = current.revision ?? 0;
    assertReceiveResult(current, command.proofs);
    const missing = await this.proofs.reconcileIssued({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      proofs: command.proofs,
    });

    const finalized: FinalizedReceiveOperation = {
      ...current,
      state: 'finalized',
      revision: revision + 1,
      updatedAt: command.updatedAt,
    };
    const transitioned = await this.receives.transition({
      operationId: current.id,
      expectedState: 'executing',
      expectedRevision: revision,
      next: finalized,
    });
    if (!transitioned) {
      throw new ReceiveOperationConflictError(
        current.id,
        'Receive result lost an executing-state or revision conflict',
      );
    }

    return { operation: finalized, savedProofs: missing, committed: true };
  }

  async failExecution(command: FailReceiveExecutionCommand): Promise<FailedReceiveExecution> {
    const current = await this.receives.getById(command.operationId);
    if (!current) {
      throw new ReceiveOperationConflictError(command.operationId, 'Receive operation not found');
    }
    if (current.state === 'rolled_back' && current.error === command.error) {
      return { operation: current, committed: false };
    }
    if (current.state !== 'executing') {
      throw new ReceiveOperationConflictError(
        command.operationId,
        'Receive failure lost an executing-state or revision conflict',
      );
    }

    const revision = current.revision ?? 0;
    const rolledBack: RolledBackReceiveOperation = {
      ...current,
      state: 'rolled_back',
      revision: revision + 1,
      updatedAt: command.updatedAt,
      error: command.error,
    };
    const transitioned = await this.receives.transition({
      operationId: current.id,
      expectedState: 'executing',
      expectedRevision: revision,
      next: rolledBack,
    });
    if (!transitioned) {
      throw new ReceiveOperationConflictError(
        current.id,
        'Receive failure lost an executing-state or revision conflict',
      );
    }
    return { operation: rolledBack, committed: true };
  }

  async cancelPrepared(command: CancelPreparedReceiveCommand): Promise<FailedReceiveExecution> {
    const current = await this.receives.getById(command.operationId);
    if (!current) {
      throw new ReceiveOperationConflictError(command.operationId, 'Receive operation not found');
    }
    if (current.state === 'rolled_back' && current.error === command.error) {
      return { operation: current, committed: false };
    }
    if (current.state !== 'prepared') {
      throw new ReceiveOperationConflictError(
        command.operationId,
        'Receive cancellation lost a prepared-state or revision conflict',
      );
    }

    const revision = current.revision ?? 0;
    const rolledBack: RolledBackReceiveOperation = {
      ...current,
      state: 'rolled_back',
      revision: revision + 1,
      updatedAt: command.updatedAt,
      error: command.error,
    };
    const transitioned = await this.receives.transition({
      operationId: current.id,
      expectedState: 'prepared',
      expectedRevision: revision,
      next: rolledBack,
    });
    if (!transitioned) {
      throw new ReceiveOperationConflictError(
        current.id,
        'Receive cancellation lost a prepared-state or revision conflict',
      );
    }
    return { operation: rolledBack, committed: true };
  }

  async deleteLegacyInit(operationId: string): Promise<void> {
    const current = await this.receives.getById(operationId);
    if (current?.state === 'init') {
      await this.receives.delete(operationId);
    }
  }

  private async getOperationProofs(operation: FinalizedReceiveOperation): Promise<CoreProof[]> {
    const expectedSecrets = getSecretsFromSerializedOutputData(operation.outputData).keepSecrets;
    return this.proofs.getProofsBySecrets(operation.mintUrl, expectedSecrets);
  }
}

function assertExactReceiveRequest(
  operation: PreparedReceiveOperation | ExecutingReceiveOperation | FinalizedReceiveOperation,
): void {
  const { keepSecrets, sendSecrets } = getSecretsFromSerializedOutputData(operation.outputData);
  if (
    operation.inputProofs.length === 0 ||
    new Set(operation.inputProofs.map((proof) => proof.secret)).size !==
      operation.inputProofs.length ||
    keepSecrets.length === 0 ||
    new Set(keepSecrets).size !== keepSecrets.length ||
    sendSecrets.length !== 0
  ) {
    throw new ProofValidationError(`Receive operation ${operation.id} has invalid request data`);
  }
}

function assertReceiveResult(
  operation: ExecutingReceiveOperation | FinalizedReceiveOperation,
  proofs: CoreProof[],
): void {
  assertExactReceiveRequest(operation);
  assertOutputProofs({
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    outputData: operation.outputData,
    kind: 'keep',
    state: ['ready', 'spent'],
    createdByOperationId: operation.id,
    proofs,
  });
  if (!sumProofs(proofs).equals(operation.amount.subtract(operation.fee))) {
    throw new ProofValidationError('Receive proof amount does not match the prepared operation');
  }
}
