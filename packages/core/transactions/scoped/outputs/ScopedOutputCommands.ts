import {
  OutputData,
  type Amount,
  type MintKeys,
  type OutputDataCreator,
  type OutputDataLike,
} from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import type { Counter } from '@core/models/Counter.ts';
import { ProofValidationError } from '@core/models/Error.ts';
import type { CounterRepository, KeysetRepository } from '@core/repositories';
import { serializeOutputData, type SerializedOutputData } from '@core/utils.ts';

export interface AllocateOutputs {
  mintUrl: string;
  unit: string;
  activeKeys: MintKeys;
  seed: Uint8Array;
  keepAmount: Amount;
  sendAmount: Amount;
  fixedSendOutputs?: readonly OutputDataLike[];
}

export interface AllocatedOutputs {
  outputData: SerializedOutputData;
  counter?: Counter;
}

export interface ScopedOutputCommands {
  assertActiveKeys(mintUrl: string, unit: string, activeKeys: MintKeys): Promise<void>;
  /** The caller must persist the returned output plan in this same transaction. */
  allocate(command: AllocateOutputs): Promise<AllocatedOutputs>;
}

/** Shared deterministic Output Allocation. Only the owning transition may commit its plan. */
export class RepositoryOutputCommands implements ScopedOutputCommands {
  constructor(
    private readonly counters: CounterRepository,
    private readonly keysets: KeysetRepository,
    private readonly creator: OutputDataCreator = OutputData,
  ) {}

  async assertActiveKeys(mintUrl: string, unit: string, activeKeys: MintKeys): Promise<void> {
    const keyset = await this.keysets.getKeysetById(mintUrl, activeKeys.id);
    if (
      !keyset ||
      !keyset.active ||
      normalizeUnit(keyset.unit) !== normalizeUnit(unit) ||
      normalizeUnit(activeKeys.unit) !== normalizeUnit(unit) ||
      JSON.stringify(Object.entries(keyset.keypairs).sort()) !==
        JSON.stringify(Object.entries(activeKeys.keys).sort())
    ) {
      throw new ProofValidationError(`Active keyset ${activeKeys.id} changed after preflight`);
    }
  }

  async allocate(command: AllocateOutputs): Promise<AllocatedOutputs> {
    await this.assertActiveKeys(command.mintUrl, command.unit, command.activeKeys);
    const current =
      (await this.counters.getCounter(command.mintUrl, command.activeKeys.id))?.counter ?? 0;
    const keep = command.keepAmount.isZero()
      ? []
      : this.creator.createDeterministicData(
          command.keepAmount,
          command.seed,
          current,
          command.activeKeys,
        );
    const send = command.fixedSendOutputs
      ? [...command.fixedSendOutputs]
      : command.sendAmount.isZero()
        ? []
        : this.creator.createDeterministicData(
            command.sendAmount,
            command.seed,
            current + keep.length,
            command.activeKeys,
          );
    if (command.fixedSendOutputs && send.length === 0) {
      throw new ProofValidationError('Method preflight did not produce output data');
    }
    const positions = keep.length + (command.fixedSendOutputs ? 0 : send.length);
    const next = current + positions;
    if (!Number.isSafeInteger(next)) throw new ProofValidationError('Output counter exhausted');
    const counter =
      positions > 0
        ? { mintUrl: command.mintUrl, keysetId: command.activeKeys.id, counter: next }
        : undefined;
    if (counter) await this.counters.setCounter(counter.mintUrl, counter.keysetId, counter.counter);
    return { outputData: serializeOutputData({ keep, send }), counter };
  }
}
