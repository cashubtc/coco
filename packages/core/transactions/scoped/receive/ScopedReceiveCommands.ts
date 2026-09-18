import { Amount, sumProofs } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError, ReceiveOperationConflictError } from '@core/models/Error.ts';
import type {
  ReceiveOperation,
  PreparedOrLaterOperation,
  PreparedReceiveOperation,
  ExecutingReceiveOperation,
  FinalizedReceiveOperation,
  RolledBackReceiveOperation,
} from '@core/operations/receive/ReceiveOperation.ts';
import type { ReceiveOperationRepository } from '@core/repositories';
import type { CoreProof } from '@core/types.ts';
import { getSecretsFromSerializedOutputData } from '@core/utils.ts';
import type {
  PrepareReceiveInput,
  ReceiveOperationInput,
  ClaimReceiveRecoveryInput,
  ApplyReceiveResultInput,
  FailReceiveInput,
  AppliedReceiveResult,
  PreparedReceiveResult,
} from '../../receive/types.ts';
import type { ScopedMintMetadataCommands } from '../mints/ScopedMintMetadataCommands.ts';
import type { ScopedOutputCommands } from '../outputs/ScopedOutputCommands.ts';
import type { ScopedProofCommands } from '../proofs/ScopedProofCommands.ts';

export interface ScopedReceiveCommands {
  prepare(input: PrepareReceiveInput): Promise<PreparedReceiveResult>;
  beginExecution(input: ReceiveOperationInput): Promise<ExecutingReceiveOperation>;
  claimRecovery(input: ClaimReceiveRecoveryInput): Promise<ExecutingReceiveOperation>;
  applyResult(input: ApplyReceiveResultInput): Promise<AppliedReceiveResult | null>;
  failExecution(input: FailReceiveInput): Promise<RolledBackReceiveOperation>;
  cancel(
    input: ReceiveOperationInput & { reason: string },
  ): Promise<RolledBackReceiveOperation | null>;
  cleanupLegacyInit(operationId: string): Promise<void>;
}

/** Owns Receive invariants; every dependency is bound to the same adapter transaction. */
export class RepositoryReceiveCommands implements ScopedReceiveCommands {
  constructor(
    private readonly receives: ReceiveOperationRepository,
    private readonly proofs: ScopedProofCommands,
    private readonly outputs: ScopedOutputCommands,
    private readonly mints: Pick<ScopedMintMetadataCommands, 'assertTrusted'>,
  ) {}

  async prepare(input: PrepareReceiveInput) {
    const stored = await this.receives.getById(input.operation.id);
    if (stored && stored.state !== 'init') throw new ReceiveOperationConflictError(stored.id);
    // A legacy init row, when present, is authoritative over a caller's draft.
    const operation = stored ?? input.operation;
    if (
      operation.inputProofs.length === 0 ||
      new Set(operation.inputProofs.map((proof) => proof.secret)).size !==
        operation.inputProofs.length ||
      operation.inputProofs.some((proof) => !proof.secret || Amount.from(proof.amount).isZero()) ||
      !sumProofs(operation.inputProofs).equals(operation.amount)
    )
      throw new ProofValidationError('Receive operation has invalid input proofs');
    await this.mints.assertTrusted(operation.mintUrl);
    const fee = await this.proofs.getFee(operation.mintUrl, operation.unit, operation.inputProofs);
    if (operation.amount.lessThanOrEqual(fee)) {
      throw new ProofValidationError('Receive amount is not sufficient after fees');
    }
    const allocation = await this.outputs.allocate({
      mintUrl: operation.mintUrl,
      unit: operation.unit,
      activeKeys: input.activeKeys,
      seed: input.seed,
      keepAmount: operation.amount.subtract(fee),
      sendAmount: Amount.zero(),
    });
    if (!allocation.counter) throw new ProofValidationError('Receive outputs were not allocated');
    const prepared: PreparedReceiveOperation = {
      ...operation,
      state: 'prepared',
      fee,
      outputData: allocation.outputData,
      revision: stored ? (stored.revision ?? 0) + 1 : 0,
      updatedAt: input.updatedAt,
    };
    assertRequest(prepared);
    if (stored) await this.transition(stored, prepared);
    else await this.receives.create(prepared);
    return { operation: prepared, counter: allocation.counter };
  }

  async beginExecution(input: ReceiveOperationInput): Promise<ExecutingReceiveOperation> {
    const current = await this.require(input.operationId);
    if (current.state !== 'prepared')
      throw new ReceiveOperationConflictError(
        current.id,
        `Cannot execute Receive in state '${current.state}'`,
      );
    assertRequest(current);
    const executing: ExecutingReceiveOperation = {
      ...current,
      state: 'executing',
      revision: (current.revision ?? 0) + 1,
      updatedAt: input.updatedAt,
    };
    await this.transition(current, executing);
    return executing;
  }

  async claimRecovery(input: ClaimReceiveRecoveryInput): Promise<ExecutingReceiveOperation> {
    const current = await this.require(input.operationId);
    if (current.state !== 'executing' || (current.revision ?? 0) !== input.expectedRevision) {
      throw new ReceiveOperationConflictError(current.id);
    }
    assertRequest(current);
    const claimed = {
      ...current,
      revision: input.expectedRevision + 1,
      updatedAt: input.updatedAt,
    };
    await this.transition(current, claimed);
    return claimed;
  }

  async applyResult(input: ApplyReceiveResultInput): Promise<AppliedReceiveResult | null> {
    const current = await this.require(input.operationId);
    if (current.state !== 'executing' && current.state !== 'finalized')
      throw new ReceiveOperationConflictError(current.id);
    const plan = assertRequest(current);
    const candidates = new Map(input.proofs.map((proof) => [proof.secret, proof]));
    if (candidates.size !== input.proofs.length)
      throw new ProofValidationError('Duplicate Receive result proofs');
    for (const proof of input.proofs) {
      assertProof(current, plan, proof);
      if (proof.createdByOperationId !== current.id || !['ready', 'spent'].includes(proof.state)) {
        throw new ProofValidationError('Invalid Receive result ownership or state');
      }
    }
    // Terminal replay never recreates proofs that were subsequently spent or removed.
    if (current.state === 'finalized')
      return { operation: current, committed: false, savedProofs: [], spentSecrets: [] };

    const stored = await this.proofs.getProofsBySecrets(current.mintUrl, [...plan.keys()]);
    const existing = new Map(stored.map((proof) => [proof.secret, proof]));
    const complete: CoreProof[] = [];
    for (const secret of plan.keys()) {
      const candidate = candidates.get(secret);
      const local = existing.get(secret);
      if (local) {
        assertProof(current, plan, local);
        if (local.createdByOperationId != null && local.createdByOperationId !== current.id) {
          throw new ProofValidationError('Receive output belongs to another operation');
        }
      }
      // An unowned Restore proof requires matching remote evidence before it can complete Receive.
      const proof = candidate ?? (local?.createdByOperationId === current.id ? local : undefined);
      if (!proof) return null;
      complete.push(proof);
    }
    const changes = await this.proofs.reconcileIssued({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      proofs: complete,
    });
    const finalized: FinalizedReceiveOperation = {
      ...current,
      state: 'finalized',
      revision: (current.revision ?? 0) + 1,
      updatedAt: input.updatedAt,
    };
    await this.transition(current, finalized);
    return { operation: finalized, committed: true, ...changes };
  }

  async failExecution(input: FailReceiveInput): Promise<RolledBackReceiveOperation> {
    const current = await this.require(input.operationId);
    if (current.state !== 'executing' || (current.revision ?? 0) !== input.expectedRevision) {
      throw new ReceiveOperationConflictError(current.id);
    }
    const plan = assertRequest(current);
    if ((await this.proofs.getProofsBySecrets(current.mintUrl, [...plan.keys()])).length > 0) {
      throw new ReceiveOperationConflictError(current.id, 'Receive has locally persisted outputs');
    }
    const failed: RolledBackReceiveOperation = {
      ...current,
      state: 'rolled_back',
      revision: input.expectedRevision + 1,
      updatedAt: input.updatedAt,
      error: input.error,
    };
    await this.transition(current, failed);
    return failed;
  }

  async cancel(
    input: ReceiveOperationInput & { reason: string },
  ): Promise<RolledBackReceiveOperation | null> {
    const current = await this.require(input.operationId);
    if (current.state === 'init') {
      await this.receives.delete(current.id);
      return null;
    }
    if (current.state !== 'prepared')
      throw new ReceiveOperationConflictError(
        current.id,
        `Cannot rollback operation in state ${current.state}`,
      );
    const cancelled: RolledBackReceiveOperation = {
      ...current,
      state: 'rolled_back',
      revision: (current.revision ?? 0) + 1,
      updatedAt: input.updatedAt,
      error: input.reason,
    };
    await this.transition(current, cancelled);
    return cancelled;
  }

  async cleanupLegacyInit(operationId: string): Promise<void> {
    const current = await this.receives.getById(operationId);
    if (current?.state === 'init') await this.receives.delete(operationId);
  }

  private async require(operationId: string): Promise<ReceiveOperation> {
    const current = await this.receives.getById(operationId);
    if (!current)
      throw new ReceiveOperationConflictError(operationId, `Operation ${operationId} not found`);
    return current;
  }

  private async transition(current: ReceiveOperation, next: ReceiveOperation): Promise<void> {
    if (
      !(await this.receives.transition({
        operationId: current.id,
        expectedState: current.state,
        expectedRevision: current.revision ?? 0,
        next,
      }))
    ) {
      throw new ReceiveOperationConflictError(current.id);
    }
  }
}

function assertRequest(operation: PreparedOrLaterOperation) {
  const { keepSecrets, sendSecrets } = getSecretsFromSerializedOutputData(operation.outputData);
  const outputs = operation.outputData.keep;
  if (
    !operation.inputProofs.length ||
    new Set(operation.inputProofs.map((proof) => proof.secret)).size !==
      operation.inputProofs.length ||
    !sumProofs(operation.inputProofs).equals(operation.amount) ||
    !outputs.length ||
    new Set(outputs.map((output) => output.blindedMessage.B_)).size !== outputs.length ||
    outputs.some(
      (output) =>
        !output.blindedMessage.B_ ||
        !output.blindedMessage.id ||
        Amount.from(output.blindedMessage.amount).isZero() ||
        output.blindedMessage.id !== outputs[0]!.blindedMessage.id,
    ) ||
    sendSecrets.length ||
    new Set(keepSecrets).size !== outputs.length ||
    !Amount.sum(outputs.map((output) => output.blindedMessage.amount)).equals(
      operation.amount.subtract(operation.fee),
    )
  )
    throw new ProofValidationError('Invalid persisted Receive request');
  return new Map(outputs.map((output, i) => [keepSecrets[i]!, output.blindedMessage]));
}

function assertProof(
  operation: PreparedOrLaterOperation,
  plan: ReturnType<typeof assertRequest>,
  proof: CoreProof,
) {
  const output = plan.get(proof.secret);
  if (
    !output ||
    output.id !== proof.id ||
    !Amount.from(output.amount).equals(proof.amount) ||
    !proof.C ||
    proof.mintUrl !== operation.mintUrl ||
    normalizeUnit(proof.unit) !== normalizeUnit(operation.unit)
  ) {
    throw new ProofValidationError('Receive proof does not match its persisted output allocation');
  }
}
