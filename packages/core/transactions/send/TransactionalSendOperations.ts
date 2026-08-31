import {
  Amount,
  KeyChain,
  OutputData,
  selectProofsRGLI,
  sumProofs,
  type KeyChainCache,
  type MintKeys,
  type OutputDataCreator,
  type OutputDataLike,
  type Proof,
  type SelectProofs,
  type Token,
} from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnit } from '@core/amounts.ts';
import { SendOperationConflictError, ProofValidationError } from '@core/models/Error.ts';
import type {
  ExecutingSendOperation,
  InitSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  RolledBackSendOperation,
  SendOperation,
} from '@core/operations/send/SendOperation.ts';
import type {
  CounterRepository,
  KeysetRepository,
  ProofRepository,
  SendOperationRepository,
} from '@core/repositories';
import type { CoreProof } from '@core/types.ts';
import {
  getSecretsFromSerializedOutputData,
  serializeOutputData,
  type SerializedOutputData,
} from '@core/utils.ts';

export interface PrepareSendCommand {
  operation: InitSendOperation;
  /** Active keys and seed loaded before entering the transaction. */
  activeKeys: MintKeys;
  seed: Uint8Array;
  /** P2PK outputs are randomized once during preflight and fixed across transaction retries. */
  p2pkSendOutputs?: readonly OutputDataLike[];
}

export interface PreparedSendResult {
  operation: PreparedSendOperation;
  reservation: {
    mintUrl: string;
    operationId: string;
    secrets: string[];
    amount: Amount;
    unit: string;
  };
  counter?: { mintUrl: string; keysetId: string; counter: number };
}

export interface ExecuteExactSendCommand {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
  memo?: string;
}

export interface ExecuteExactSendResult {
  operation: PendingSendOperation & { token: Token };
  token: Token;
  /** False when an equivalent pending result had already committed. */
  committed: boolean;
}

export interface BeginSwapExecutionCommand {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
  /** Normalized before entering the retried transaction. */
  memo?: string;
}

export interface SwapTransportRequest {
  mintUrl: string;
  unit: string;
  amount: Amount;
  inputProofs: Proof[];
  outputData: SerializedOutputData;
}

export interface BegunSwapExecution {
  operation: ExecutingSendOperation;
  request: SwapTransportRequest;
}

export interface ApplySwapResultCommand {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
  keepProofs: CoreProof[];
  sendProofs: CoreProof[];
  token: Token;
}

export interface AppliedSwapResult {
  operation: PendingSendOperation;
  savedProofs: CoreProof[];
  spentInputSecrets: string[];
  /** False when an equivalent result had already committed. */
  committed: boolean;
}

export interface FailSwapExecutionCommand {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
  error: string;
}

export interface FailedSwapExecution {
  operation: RolledBackSendOperation;
  releasedInputSecrets: string[];
  /** False when the same terminal failure had already committed. */
  committed: boolean;
}

export interface TransactionalSendOperations {
  prepare(command: PrepareSendCommand): Promise<PreparedSendResult>;
  executeExact(command: ExecuteExactSendCommand): Promise<ExecuteExactSendResult>;
  beginExecution(command: BeginSwapExecutionCommand): Promise<BegunSwapExecution>;
  applyResult(command: ApplySwapResultCommand): Promise<AppliedSwapResult>;
  failExecution(command: FailSwapExecutionCommand): Promise<FailedSwapExecution>;
  updateLegacy(operation: SendOperation): Promise<void>;
  deleteLegacy(operationId: string): Promise<void>;
}

export class RepositoryTransactionalSendOperations implements TransactionalSendOperations {
  constructor(
    private readonly proofs: ProofRepository,
    private readonly counters: CounterRepository,
    private readonly keysets: KeysetRepository,
    private readonly sends: SendOperationRepository,
    private readonly outputDataCreator: OutputDataCreator = OutputData,
    private readonly selectProofs: SelectProofs = selectProofsRGLI,
  ) {}

  async prepare(command: PrepareSendCommand): Promise<PreparedSendResult> {
    const operation = command.operation;
    const available = await this.proofs.getAvailableProofs(operation.mintUrl, {
      unit: operation.unit,
    });
    const keysets = await this.keysets.getKeysetsByMintUrl(operation.mintUrl);
    assertCurrentActiveKeys(operation, command.activeKeys, keysets);
    const keyChain = KeyChain.fromCache(operation.mintUrl, operation.unit, {
      mintUrl: operation.mintUrl,
      keysets: keysets.map((keyset) => ({
        id: keyset.id,
        unit: keyset.unit,
        active: keyset.active,
        input_fee_ppk: keyset.feePpk,
        keys: keyset.keypairs,
      })),
    } satisfies KeyChainCache);
    const selected = selectInputs(operation, available, keyChain, this.selectProofs);
    const inputAmount = sumProofs(selected.proofs);
    const inputProofSecrets = selected.proofs.map((proof) => proof.secret);

    let outputData: PreparedSendOperation['outputData'];
    let counterUpdate: PreparedSendResult['counter'];
    if (selected.needsSwap) {
      const currentCounter =
        (await this.counters.getCounter(operation.mintUrl, command.activeKeys.id))?.counter ?? 0;
      const keepAmount = inputAmount.subtract(operation.amount.add(selected.fee));
      const keep = keepAmount.isZero()
        ? []
        : this.outputDataCreator.createDeterministicData(
            keepAmount,
            command.seed,
            currentCounter,
            command.activeKeys,
          );
      const send =
        operation.method === 'p2pk'
          ? [...(command.p2pkSendOutputs ?? [])]
          : this.outputDataCreator.createDeterministicData(
              operation.amount,
              command.seed,
              currentCounter + keep.length,
              command.activeKeys,
            );
      if (operation.method === 'p2pk' && send.length === 0) {
        throw new ProofValidationError('P2PK Send preflight did not produce output data');
      }
      const allocatedPositions = keep.length + (operation.method === 'default' ? send.length : 0);
      if (allocatedPositions > 0) {
        const counter = currentCounter + allocatedPositions;
        await this.counters.setCounter(operation.mintUrl, command.activeKeys.id, counter);
        counterUpdate = { mintUrl: operation.mintUrl, keysetId: command.activeKeys.id, counter };
      }
      outputData = serializeOutputData({ keep, send });
    }

    await this.proofs.reserveProofs(operation.mintUrl, inputProofSecrets, operation.id);

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
    const existing = await this.sends.getById(operation.id);
    if (!existing) {
      await this.sends.create(prepared);
    } else {
      assertSameLegacyIntent(existing, operation);
      const transitioned = await this.sends.transition({
        operationId: operation.id,
        expectedState: 'init',
        expectedRevision: existing.revision ?? 0,
        next: prepared,
      });
      if (!transitioned) {
        throw new SendOperationConflictError(
          operation.id,
          'Send preparation lost a state conflict',
        );
      }
      prepared.revision = (existing.revision ?? 0) + 1;
    }

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
  }

  async executeExact(command: ExecuteExactSendCommand): Promise<ExecuteExactSendResult> {
    const current = await this.sends.getById(command.operationId);
    const idempotent = getIdempotentExactResult(current, command);
    if (idempotent) return idempotent;

    if (
      !current ||
      current.state !== 'prepared' ||
      (current.revision ?? 0) !== command.expectedRevision
    ) {
      throw new SendOperationConflictError(
        command.operationId,
        'Exact Send execution lost a state or revision conflict',
      );
    }
    if (current.needsSwap || current.method !== 'default') {
      throw new ProofValidationError(`Send operation ${command.operationId} requires a mint swap`);
    }

    const proofs = await loadOwnedReadyProofs(this.proofs, current);
    const normalizedMemo = normalizeMemo(command.memo);
    const token: Token = {
      mint: current.mintUrl,
      proofs,
      unit: current.unit,
      ...(normalizedMemo ? { memo: normalizedMemo } : {}),
    };
    const pending: ExecuteExactSendResult['operation'] = {
      ...current,
      state: 'pending',
      updatedAt: command.updatedAt,
      token,
    };

    await this.proofs.setProofState(current.mintUrl, current.inputProofSecrets, 'inflight');
    const transitioned = await this.sends.transition({
      operationId: current.id,
      expectedState: 'prepared',
      expectedRevision: command.expectedRevision,
      next: pending,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Exact Send execution lost a state or revision conflict',
      );
    }
    pending.revision = command.expectedRevision + 1;

    return { operation: pending, token, committed: true };
  }

  async beginExecution(command: BeginSwapExecutionCommand): Promise<BegunSwapExecution> {
    const current = await this.sends.getById(command.operationId);
    if (!current) {
      throw new SendOperationConflictError(command.operationId, 'Send operation not found');
    }
    if (current.state !== 'prepared') {
      throw new SendOperationConflictError(
        command.operationId,
        `Cannot begin Send execution in state ${current.state}`,
      );
    }
    if ((current.revision ?? 0) !== command.expectedRevision) {
      throw new SendOperationConflictError(
        command.operationId,
        'Send preparation revision changed before execution',
      );
    }
    if (!current.needsSwap || !current.outputData) {
      throw new SendOperationConflictError(
        command.operationId,
        'Swap execution requires a prepared swap request',
      );
    }

    const inputProofs = await this.getOwnedReadyInputs(current);
    const executing: ExecutingSendOperation = {
      ...current,
      state: 'executing',
      revision: (current.revision ?? 0) + 1,
      updatedAt: command.updatedAt,
      executionMemo: command.memo,
    };
    const transitioned = await this.sends.transition({
      operationId: current.id,
      expectedState: 'prepared',
      expectedRevision: command.expectedRevision,
      next: executing,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Send execution lost a prepared-state conflict',
      );
    }

    return {
      operation: executing,
      request: {
        mintUrl: executing.mintUrl,
        unit: executing.unit,
        amount: executing.amount,
        inputProofs,
        outputData: current.outputData,
      },
    };
  }

  async applyResult(command: ApplySwapResultCommand): Promise<AppliedSwapResult> {
    const current = await this.sends.getById(command.operationId);
    if (!current) {
      throw new SendOperationConflictError(command.operationId, 'Send operation not found');
    }
    if (current.state === 'pending') {
      if (
        !current.needsSwap ||
        !current.outputData ||
        current.revision !== command.expectedRevision + 1 ||
        !current.token ||
        !sameToken(current.token, command.token)
      ) {
        throw new SendOperationConflictError(
          command.operationId,
          'Send result conflicts with the persisted pending token',
        );
      }
      assertSwapResult(current, command);
      const persistedProofs = (
        await this.proofs.getProofsByOperationId(current.mintUrl, current.id)
      ).filter((proof) => proof.createdByOperationId === current.id);
      if (!sameCoreProofSet(persistedProofs, [...command.keepProofs, ...command.sendProofs])) {
        throw new SendOperationConflictError(
          command.operationId,
          'Send result conflicts with the persisted pending proofs',
        );
      }
      return {
        operation: current,
        savedProofs: [],
        spentInputSecrets: [],
        committed: false,
      };
    }
    if (current.state !== 'executing' || !current.needsSwap || !current.outputData) {
      throw new SendOperationConflictError(
        command.operationId,
        `Cannot apply Send result in state ${current.state}`,
      );
    }
    if ((current.revision ?? 0) !== command.expectedRevision) {
      throw new SendOperationConflictError(
        command.operationId,
        'Send execution revision changed before applying its result',
      );
    }

    await this.getOwnedReadyInputs(current);
    assertSwapResult(current, command);
    const savedProofs = [...command.keepProofs, ...command.sendProofs];
    if (savedProofs.length > 0) {
      await this.proofs.saveProofs(current.mintUrl, savedProofs);
    }
    await this.proofs.setProofState(current.mintUrl, current.inputProofSecrets, 'spent');

    const pending: PendingSendOperation = {
      ...current,
      state: 'pending',
      revision: (current.revision ?? 0) + 1,
      updatedAt: command.updatedAt,
      token: command.token,
    };
    const transitioned = await this.sends.transition({
      operationId: current.id,
      expectedState: 'executing',
      expectedRevision: command.expectedRevision,
      next: pending,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Send result lost an executing-state conflict',
      );
    }

    return {
      operation: pending,
      savedProofs,
      spentInputSecrets: [...current.inputProofSecrets],
      committed: true,
    };
  }

  async failExecution(command: FailSwapExecutionCommand): Promise<FailedSwapExecution> {
    const current = await this.sends.getById(command.operationId);
    if (!current) {
      throw new SendOperationConflictError(command.operationId, 'Send operation not found');
    }
    if (
      current.state === 'rolled_back' &&
      current.revision === command.expectedRevision + 1 &&
      current.error === command.error
    ) {
      return {
        operation: current,
        releasedInputSecrets: [],
        committed: false,
      };
    }
    if (current.state !== 'executing' || !current.needsSwap) {
      throw new SendOperationConflictError(
        command.operationId,
        `Cannot fail Send execution in state ${current.state}`,
      );
    }
    if ((current.revision ?? 0) !== command.expectedRevision) {
      throw new SendOperationConflictError(
        command.operationId,
        'Send execution revision changed before applying its failure',
      );
    }

    await this.getOwnedReadyInputs(current);
    await this.proofs.releaseProofs(current.mintUrl, current.inputProofSecrets);
    const failed: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: (current.revision ?? 0) + 1,
      updatedAt: command.updatedAt,
      error: command.error,
    };
    const transitioned = await this.sends.transition({
      operationId: current.id,
      expectedState: 'executing',
      expectedRevision: command.expectedRevision,
      next: failed,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Send failure lost an executing-state conflict',
      );
    }

    return {
      operation: failed,
      releasedInputSecrets: [...current.inputProofSecrets],
      committed: true,
    };
  }

  private async getOwnedReadyInputs(
    operation: PreparedSendOperation | ExecutingSendOperation,
  ): Promise<CoreProof[]> {
    const proofs = await this.proofs.getProofsBySecrets(
      operation.mintUrl,
      operation.inputProofSecrets,
    );
    const bySecret = new Map(proofs.map((proof) => [proof.secret, proof]));
    if (bySecret.size !== operation.inputProofSecrets.length) {
      throw new ProofValidationError('Could not find all reserved Send proofs');
    }
    return operation.inputProofSecrets.map((secret) => {
      const proof = bySecret.get(secret);
      if (
        !proof ||
        proof.state !== 'ready' ||
        proof.usedByOperationId !== operation.id ||
        proof.mintUrl !== operation.mintUrl ||
        normalizeUnit(proof.unit) !== normalizeUnit(operation.unit)
      ) {
        throw new ProofValidationError(`Send proof ${secret} is not ready and owned by operation`);
      }
      return proof;
    });
  }

  updateLegacy(operation: SendOperation) {
    return this.sends.update(operation);
  }

  deleteLegacy(operationId: string) {
    return this.sends.delete(operationId);
  }
}

function getIdempotentExactResult(
  current: SendOperation | null,
  command: ExecuteExactSendCommand,
): ExecuteExactSendResult | undefined {
  if (!current || current.state !== 'pending' || current.needsSwap || !current.token) {
    return undefined;
  }
  const revision = current.revision ?? 0;
  const revisionMatchesCommittedCommand =
    revision === command.expectedRevision || revision === command.expectedRevision + 1;
  if (
    !revisionMatchesCommittedCommand ||
    !isEquivalentExactToken(current, current.token, command)
  ) {
    throw new SendOperationConflictError(
      command.operationId,
      'Exact Send result differs from the already committed operation',
    );
  }
  return {
    operation: current as ExecuteExactSendResult['operation'],
    token: current.token,
    committed: false,
  };
}

function isEquivalentExactToken(
  operation: PendingSendOperation,
  token: Token,
  command: ExecuteExactSendCommand,
): boolean {
  return (
    token.mint === operation.mintUrl &&
    normalizeUnit(token.unit) === normalizeUnit(operation.unit) &&
    normalizeMemo(token.memo) === normalizeMemo(command.memo) &&
    token.proofs.length === operation.inputProofSecrets.length &&
    token.proofs.every((proof, index) => proof.secret === operation.inputProofSecrets[index])
  );
}

async function loadOwnedReadyProofs(
  proofs: ProofRepository,
  operation: PreparedSendOperation,
): Promise<Proof[]> {
  const uniqueSecrets = new Set(operation.inputProofSecrets);
  if (uniqueSecrets.size !== operation.inputProofSecrets.length) {
    throw new ProofValidationError(`Send operation ${operation.id} contains duplicate inputs`);
  }
  const stored = await proofs.getProofsBySecrets(operation.mintUrl, operation.inputProofSecrets);
  const bySecret = new Map(stored.map((proof) => [proof.secret, proof]));
  const ordered = operation.inputProofSecrets.map((secret) => bySecret.get(secret));
  for (const proof of ordered) {
    if (
      !proof ||
      proof.mintUrl !== operation.mintUrl ||
      normalizeUnit(proof.unit) !== normalizeUnit(operation.unit) ||
      proof.state !== 'ready' ||
      proof.usedByOperationId !== operation.id
    ) {
      throw new ProofValidationError(
        `Send operation ${operation.id} does not own every ready input proof`,
      );
    }
  }
  const resolved = ordered as Proof[];
  if (
    !sumProofs(resolved).equals(operation.amount) ||
    !operation.inputAmount.equals(operation.amount) ||
    !operation.fee.isZero()
  ) {
    throw new ProofValidationError(`Send operation ${operation.id} is not an exact proof match`);
  }
  return resolved;
}

function normalizeMemo(memo: string | undefined): string | undefined {
  const trimmed = memo?.trim();
  return trimmed ? trimmed : undefined;
}

function assertSwapResult(
  operation: ExecutingSendOperation | PendingSendOperation,
  command: ApplySwapResultCommand,
): void {
  const outputSecrets = getSecretsFromSerializedOutputData(operation.outputData!);
  assertProofSet(operation, command.keepProofs, outputSecrets.keepSecrets, 'ready', 'keep');
  assertProofSet(operation, command.sendProofs, outputSecrets.sendSecrets, 'inflight', 'send');

  if (
    command.token.mint !== operation.mintUrl ||
    normalizeUnit(command.token.unit) !== normalizeUnit(operation.unit) ||
    command.token.memo !== operation.executionMemo ||
    !sameProofSet(command.token.proofs, command.sendProofs)
  ) {
    throw new ProofValidationError('Swap token does not match the persisted Send request');
  }
}

function assertProofSet(
  operation: ExecutingSendOperation | PendingSendOperation,
  proofs: CoreProof[],
  expectedSecrets: string[],
  state: CoreProof['state'],
  kind: string,
): void {
  if (
    new Set(expectedSecrets).size !== expectedSecrets.length ||
    new Set(proofs.map((proof) => proof.secret)).size !== proofs.length ||
    proofs.length !== expectedSecrets.length
  ) {
    throw new ProofValidationError(`Swap ${kind} proofs do not match allocated outputs`);
  }
  const expected = new Set(expectedSecrets);
  for (const proof of proofs) {
    if (
      !expected.has(proof.secret) ||
      proof.mintUrl !== operation.mintUrl ||
      normalizeUnit(proof.unit) !== normalizeUnit(operation.unit) ||
      proof.state !== state ||
      proof.createdByOperationId !== operation.id
    ) {
      throw new ProofValidationError(`Swap ${kind} proofs do not match allocated outputs`);
    }
  }
}

function sameToken(left: Token, right: Token): boolean {
  return (
    left.mint === right.mint &&
    normalizeUnit(left.unit) === normalizeUnit(right.unit) &&
    left.memo === right.memo &&
    sameProofSet(left.proofs, right.proofs)
  );
}

function sameCoreProofSet(left: CoreProof[], right: CoreProof[]): boolean {
  return (
    sameProofSet(left, right) &&
    left.every((proof) => {
      const candidate = right.find((item) => item.secret === proof.secret);
      return (
        candidate?.mintUrl === proof.mintUrl &&
        normalizeUnit(candidate.unit) === normalizeUnit(proof.unit) &&
        candidate.createdByOperationId === proof.createdByOperationId
      );
    })
  );
}

function sameProofSet(left: Proof[], right: Proof[]): boolean {
  if (
    left.length !== right.length ||
    new Set(left.map((proof) => proof.secret)).size !== left.length ||
    new Set(right.map((proof) => proof.secret)).size !== right.length
  ) {
    return false;
  }
  const rightBySecret = new Map(right.map((proof) => [proof.secret, proof]));
  return left.every((proof) => {
    const candidate = rightBySecret.get(proof.secret);
    return candidate ? sameProof(proof, candidate) : false;
  });
}

function sameProof(left: Proof, right: Proof): boolean {
  return (
    left.id === right.id &&
    left.secret === right.secret &&
    left.C === right.C &&
    Amount.from(left.amount).equals(Amount.from(right.amount)) &&
    left.witness === right.witness &&
    JSON.stringify(left.dleq) === JSON.stringify(right.dleq)
  );
}

function assertCurrentActiveKeys(
  operation: InitSendOperation,
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
    throw new SendOperationConflictError(
      operation.id,
      `Active keyset ${activeKeys.id} changed after Send preflight`,
    );
  }
}

function selectInputs(
  operation: InitSendOperation,
  available: Proof[],
  keyChain: KeyChain,
  selectProofs: SelectProofs,
): { proofs: Proof[]; fee: Amount; needsSwap: boolean } {
  const unit = normalizeUnit(operation.unit);
  for (const proof of available) {
    assertSameUnit(normalizeUnit((proof as { unit?: string }).unit), unit, 'Send proof selection');
  }
  if (sumProofs(available).lessThan(operation.amount)) {
    throw new ProofValidationError('Not enough proofs to send');
  }

  const forceSwap =
    operation.method === 'p2pk' ||
    (operation.method === 'default' &&
      Boolean((operation.methodData as { forceSwap?: boolean }).forceSwap));
  if (!forceSwap) {
    const exact = selectProofs(available, operation.amount, keyChain, false).send;
    if (sumProofs(exact).equals(operation.amount)) {
      return { proofs: exact, fee: Amount.zero(), needsSwap: false };
    }
  }

  const selected = selectProofs(available, operation.amount, keyChain, true).send;
  const fee = calculateFee(selected, keyChain);
  if (selected.length > 0 && sumProofs(selected).greaterThanOrEqual(operation.amount.add(fee))) {
    return { proofs: selected, fee, needsSwap: true };
  }
  throw new ProofValidationError('Send amount is not sufficient after fees');
}

function calculateFee(proofs: readonly Proof[], keyChain: KeyChain): Amount {
  const ppk = proofs.reduce((sum, proof) => {
    let fee: number;
    try {
      fee = keyChain.getKeyset(proof.id).fee;
    } catch {
      throw new ProofValidationError(`Missing fee preflight for keyset ${proof.id}`);
    }
    return sum + BigInt(fee);
  }, 0n);
  return Amount.from((ppk + 999n) / 1000n);
}

function assertSameLegacyIntent(existing: SendOperation, operation: InitSendOperation): void {
  if (
    existing.state !== 'init' ||
    existing.mintUrl !== operation.mintUrl ||
    !existing.amount.equals(operation.amount) ||
    existing.unit !== operation.unit ||
    existing.method !== operation.method ||
    JSON.stringify(existing.methodData) !== JSON.stringify(operation.methodData)
  ) {
    throw new SendOperationConflictError(operation.id, 'Send operation id already exists');
  }
}
