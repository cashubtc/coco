import { Amount, OutputData, type MintKeys, type OutputDataCreator } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError, ReceiveOperationConflictError } from '@core/models/Error.ts';
import type {
  InitReceiveOperation,
  PreparedReceiveOperation,
  ReceiveOperation,
} from '@core/operations/receive/ReceiveOperation.ts';
import type {
  CounterRepository,
  KeysetRepository,
  ReceiveOperationRepository,
} from '@core/repositories';
import { serializeOutputData } from '@core/utils.ts';

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

export interface TransactionalReceiveOperations {
  prepare(command: PrepareReceiveCommand): Promise<PreparedReceiveResult>;

  /** Compatibility seam for lifecycle writes migrated by the next Receive ticket. */
  updateLegacyOperation(operation: ReceiveOperation): Promise<void>;
  /** Compatibility seam for cleanup of Receive init rows persisted by older Coco versions. */
  deleteLegacyInit(operationId: string): Promise<void>;
}

export class RepositoryTransactionalReceiveOperations implements TransactionalReceiveOperations {
  constructor(
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

  async updateLegacyOperation(operation: ReceiveOperation): Promise<void> {
    await this.receives.update(operation);
  }

  async deleteLegacyInit(operationId: string): Promise<void> {
    const current = await this.receives.getById(operationId);
    if (current?.state === 'init') {
      await this.receives.delete(operationId);
    }
  }
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
