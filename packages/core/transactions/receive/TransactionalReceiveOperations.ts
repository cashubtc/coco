import {
  Amount,
  OutputData,
  sumProofs,
  type MintKeys,
  type OutputDataCreator,
  type Proof,
} from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError, ReceiveOperationConflictError } from '@core/models/Error.ts';
import type {
  ExecutingReceiveOperation,
  FinalizedReceiveOperation,
  InitReceiveOperation,
  PreparedReceiveOperation,
  ReceiveOperation,
  RolledBackReceiveOperation,
} from '@core/operations/receive/ReceiveOperation.ts';
import type {
  CounterRepository,
  KeysetRepository,
  ProofRepository,
  ReceiveOperationRepository,
} from '@core/repositories';
import type { CoreProof } from '@core/types.ts';
import {
  getSecretsFromSerializedOutputData,
  serializeOutputData,
  type SerializedOutputData,
} from '@core/utils.ts';

export interface PrepareReceiveCommand {
  /** Exact signed request assembled during asynchronous preflight. */
  operation: InitReceiveOperation;
  /** Active output keys and seed loaded before entering the transaction. */
  activeKeys: MintKeys;
  seed: Uint8Array;
  fee: Amount;
}

export interface PreparedReceiveResult {
  operation: PreparedReceiveOperation;
  counter: { mintUrl: string; keysetId: string; counter: number };
}

export interface BeginReceiveExecutionCommand {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
}

/** Exact durable request submitted to the mint outside the transaction. */
export interface ReceiveTransportRequest {
  mintUrl: string;
  unit: string;
  inputProofs: Proof[];
  outputData: SerializedOutputData;
}

export interface BegunReceiveExecution {
  operation: ExecutingReceiveOperation;
  request: ReceiveTransportRequest;
}

export interface ApplyReceiveResultCommand {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
  proofs: CoreProof[];
}

export interface AppliedReceiveResult {
  operation: FinalizedReceiveOperation;
  /** Proofs inserted by this call; empty for an idempotent duplicate. */
  savedProofs: CoreProof[];
  committed: boolean;
}

export interface FailReceiveExecutionCommand {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
  error: string;
}

export interface CancelPreparedReceiveCommand {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
  error: string;
}

export interface FailedReceiveExecution {
  operation: RolledBackReceiveOperation;
  committed: boolean;
}

export interface TransactionalReceiveOperations {
  prepare(command: PrepareReceiveCommand): Promise<PreparedReceiveResult>;
  beginExecution(command: BeginReceiveExecutionCommand): Promise<BegunReceiveExecution>;
  applyResult(command: ApplyReceiveResultCommand): Promise<AppliedReceiveResult>;
  failExecution(command: FailReceiveExecutionCommand): Promise<FailedReceiveExecution>;
  cancelPrepared(command: CancelPreparedReceiveCommand): Promise<FailedReceiveExecution>;
  /** Compatibility seam for cleanup of Receive init rows persisted by older Coco versions. */
  deleteLegacyInit(operationId: string): Promise<void>;
}

export class RepositoryTransactionalReceiveOperations implements TransactionalReceiveOperations {
  constructor(
    private readonly proofs: ProofRepository,
    private readonly counters: CounterRepository,
    private readonly keysets: KeysetRepository,
    private readonly receives: ReceiveOperationRepository,
    private readonly outputDataCreator: OutputDataCreator = OutputData,
  ) {}

  async prepare(command: PrepareReceiveCommand): Promise<PreparedReceiveResult> {
    const operation = command.operation;
    if (operation.inputProofs.length === 0) {
      throw new ProofValidationError('Receive operation has no input proofs');
    }
    if (operation.amount.lessThanOrEqual(command.fee)) {
      throw new ProofValidationError('Receive amount is not sufficient after fees');
    }

    const keysets = await this.keysets.getKeysetsByMintUrl(operation.mintUrl);
    assertCurrentActiveKeys(operation, command.activeKeys, keysets);

    const currentCounter =
      (await this.counters.getCounter(operation.mintUrl, command.activeKeys.id))?.counter ?? 0;
    const outputs = this.outputDataCreator.createDeterministicData(
      operation.amount.subtract(command.fee),
      command.seed,
      currentCounter,
      command.activeKeys,
    );
    if (outputs.length === 0) {
      throw new ProofValidationError('Failed to create deterministic outputs for receive');
    }

    const counter = currentCounter + outputs.length;
    await this.counters.setCounter(operation.mintUrl, command.activeKeys.id, counter);
    const prepared: PreparedReceiveOperation = {
      ...operation,
      state: 'prepared',
      revision: 0,
      fee: command.fee,
      outputData: serializeOutputData({ keep: outputs, send: [] }),
    };

    const existing = await this.receives.getById(operation.id);
    if (!existing) {
      await this.receives.create(prepared);
    } else {
      assertSameLegacyIntent(existing, operation);
      const revision = existing.revision ?? 0;
      const transitioned = await this.receives.transition({
        operationId: operation.id,
        expectedState: 'init',
        expectedRevision: revision,
        next: prepared,
      });
      if (!transitioned) {
        throw new ReceiveOperationConflictError(
          operation.id,
          'Receive preparation lost a state or revision conflict',
        );
      }
      prepared.revision = revision + 1;
    }

    return {
      operation: prepared,
      counter: { mintUrl: operation.mintUrl, keysetId: command.activeKeys.id, counter },
    };
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
    if ((current.revision ?? 0) !== command.expectedRevision) {
      throw new ReceiveOperationConflictError(
        command.operationId,
        'Receive preparation revision changed before execution',
      );
    }

    assertExactReceiveRequest(current);
    const executing: ExecutingReceiveOperation = {
      ...current,
      state: 'executing',
      revision: command.expectedRevision + 1,
      updatedAt: command.updatedAt,
    };
    const transitioned = await this.receives.transition({
      operationId: current.id,
      expectedState: 'prepared',
      expectedRevision: command.expectedRevision,
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
      if ((current.revision ?? 0) !== command.expectedRevision + 1) {
        throw new ReceiveOperationConflictError(
          command.operationId,
          'Receive result conflicts with the finalized operation revision',
        );
      }
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
    if ((current.revision ?? 0) !== command.expectedRevision) {
      throw new ReceiveOperationConflictError(
        command.operationId,
        'Receive execution revision changed before applying its result',
      );
    }

    assertReceiveResult(current, command.proofs);
    const existing = await this.proofs.getProofsBySecrets(
      current.mintUrl,
      command.proofs.map((proof) => proof.secret),
    );
    const commandBySecret = new Map(command.proofs.map((proof) => [proof.secret, proof]));
    for (const proof of existing) {
      const resultProof = commandBySecret.get(proof.secret);
      if (!resultProof || !sameCoreProof(proof, resultProof)) {
        throw new ReceiveOperationConflictError(
          current.id,
          `Receive output ${proof.secret} conflicts with an existing proof`,
        );
      }
    }
    const existingSecrets = new Set(existing.map((proof) => proof.secret));
    const missing = command.proofs.filter((proof) => !existingSecrets.has(proof.secret));
    if (missing.length > 0) {
      await this.proofs.saveProofs(current.mintUrl, missing);
    }
    const restoredSpentSecrets = existing
      .filter((proof) => commandBySecret.get(proof.secret)?.state === 'spent')
      .map((proof) => proof.secret);
    if (restoredSpentSecrets.length > 0) {
      // A complete Restore response proves these exact outputs were issued. Preserve that
      // authoritative spent observation when recovering a legacy partially-applied result.
      await this.proofs.setProofState(current.mintUrl, restoredSpentSecrets, 'spent');
    }

    const finalized: FinalizedReceiveOperation = {
      ...current,
      state: 'finalized',
      revision: command.expectedRevision + 1,
      updatedAt: command.updatedAt,
    };
    const transitioned = await this.receives.transition({
      operationId: current.id,
      expectedState: 'executing',
      expectedRevision: command.expectedRevision,
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
    if (
      current.state === 'rolled_back' &&
      (current.revision ?? 0) === command.expectedRevision + 1 &&
      current.error === command.error
    ) {
      return { operation: current, committed: false };
    }
    if (current.state !== 'executing' || (current.revision ?? 0) !== command.expectedRevision) {
      throw new ReceiveOperationConflictError(
        command.operationId,
        'Receive failure lost an executing-state or revision conflict',
      );
    }

    const rolledBack: RolledBackReceiveOperation = {
      ...current,
      state: 'rolled_back',
      revision: command.expectedRevision + 1,
      updatedAt: command.updatedAt,
      error: command.error,
    };
    const transitioned = await this.receives.transition({
      operationId: current.id,
      expectedState: 'executing',
      expectedRevision: command.expectedRevision,
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
    if (
      current.state === 'rolled_back' &&
      (current.revision ?? 0) === command.expectedRevision + 1 &&
      current.error === command.error
    ) {
      return { operation: current, committed: false };
    }
    if (current.state !== 'prepared' || (current.revision ?? 0) !== command.expectedRevision) {
      throw new ReceiveOperationConflictError(
        command.operationId,
        'Receive cancellation lost a prepared-state or revision conflict',
      );
    }

    const rolledBack: RolledBackReceiveOperation = {
      ...current,
      state: 'rolled_back',
      revision: command.expectedRevision + 1,
      updatedAt: command.updatedAt,
      error: command.error,
    };
    const transitioned = await this.receives.transition({
      operationId: current.id,
      expectedState: 'prepared',
      expectedRevision: command.expectedRevision,
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
  const expectedSecrets = getSecretsFromSerializedOutputData(operation.outputData).keepSecrets;
  if (
    proofs.length !== expectedSecrets.length ||
    new Set(proofs.map((proof) => proof.secret)).size !== proofs.length
  ) {
    throw new ProofValidationError('Receive proofs do not match the allocated outputs');
  }
  const expected = new Map(
    operation.outputData.keep.map((output, index) => [
      expectedSecrets[index]!,
      {
        id: output.blindedMessage.id,
        amount: Amount.from(output.blindedMessage.amount),
      },
    ]),
  );
  for (const proof of proofs) {
    const output = expected.get(proof.secret);
    if (
      !output ||
      proof.id !== output.id ||
      !Amount.from(proof.amount).equals(output.amount) ||
      proof.mintUrl !== operation.mintUrl ||
      normalizeUnit(proof.unit) !== normalizeUnit(operation.unit) ||
      (proof.state !== 'ready' && proof.state !== 'spent') ||
      proof.createdByOperationId !== operation.id
    ) {
      throw new ProofValidationError('Receive proofs do not match the allocated outputs');
    }
  }
  if (!sumProofs(proofs).equals(operation.amount.subtract(operation.fee))) {
    throw new ProofValidationError('Receive proof amount does not match the prepared operation');
  }
}

function sameCoreProofSet(left: CoreProof[], right: CoreProof[]): boolean {
  if (left.length !== right.length) return false;
  const rightBySecret = new Map(right.map((proof) => [proof.secret, proof]));
  return left.every((proof) => {
    const candidate = rightBySecret.get(proof.secret);
    return candidate ? sameCoreProof(proof, candidate) : false;
  });
}

function sameCoreProof(left: CoreProof, right: CoreProof): boolean {
  return (
    left.id === right.id &&
    left.secret === right.secret &&
    left.C === right.C &&
    Amount.from(left.amount).equals(Amount.from(right.amount)) &&
    left.witness === right.witness &&
    JSON.stringify(left.dleq) === JSON.stringify(right.dleq) &&
    left.mintUrl === right.mintUrl &&
    normalizeUnit(left.unit) === normalizeUnit(right.unit) &&
    left.createdByOperationId === right.createdByOperationId
  );
}

function assertCurrentActiveKeys(
  operation: InitReceiveOperation,
  activeKeys: MintKeys,
  keysets: Awaited<ReturnType<KeysetRepository['getKeysetsByMintUrl']>>,
): void {
  const keyset = keysets.find((candidate) => candidate.id === activeKeys.id);
  const sameKeys =
    keyset &&
    JSON.stringify(Object.entries(keyset.keypairs).sort()) ===
      JSON.stringify(Object.entries(activeKeys.keys).sort());
  if (
    !keyset ||
    !keyset.active ||
    normalizeUnit(keyset.unit) !== normalizeUnit(operation.unit) ||
    normalizeUnit(activeKeys.unit) !== normalizeUnit(operation.unit) ||
    !sameKeys
  ) {
    throw new ReceiveOperationConflictError(
      operation.id,
      `Active keyset ${activeKeys.id} changed after Receive preflight`,
    );
  }
}

function assertSameLegacyIntent(
  existing: ReceiveOperation,
  requested: InitReceiveOperation,
): asserts existing is InitReceiveOperation {
  if (
    existing.state !== 'init' ||
    existing.mintUrl !== requested.mintUrl ||
    normalizeUnit(existing.unit) !== normalizeUnit(requested.unit) ||
    !existing.amount.equals(requested.amount) ||
    JSON.stringify(existing.inputProofs) !== JSON.stringify(requested.inputProofs) ||
    JSON.stringify(existing.source) !== JSON.stringify(requested.source)
  ) {
    throw new ReceiveOperationConflictError(
      requested.id,
      `Receive operation id ${requested.id} already exists with a different intent`,
    );
  }
}
