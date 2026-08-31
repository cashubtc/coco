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
} from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnit } from '@core/amounts.ts';
import { SendOperationConflictError, ProofValidationError } from '@core/models/Error.ts';
import type {
  InitSendOperation,
  PreparedSendOperation,
  SendOperation,
} from '@core/operations/send/SendOperation.ts';
import type {
  CounterRepository,
  KeysetRepository,
  ProofRepository,
  SendOperationRepository,
} from '@core/repositories';
import { serializeOutputData } from '@core/utils.ts';

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

export interface TransactionalSendOperations {
  prepare(command: PrepareSendCommand): Promise<PreparedSendResult>;
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

  updateLegacy(operation: SendOperation) {
    return this.sends.update(operation);
  }

  deleteLegacy(operationId: string) {
    return this.sends.delete(operationId);
  }
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
