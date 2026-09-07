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

export interface AllocateOutputsInput {
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
  allocate(input: AllocateOutputsInput): Promise<AllocatedOutputs>;
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

  async allocate(input: AllocateOutputsInput): Promise<AllocatedOutputs> {
    await this.assertActiveKeys(input.mintUrl, input.unit, input.activeKeys);
    const current =
      (await this.counters.getCounter(input.mintUrl, input.activeKeys.id))?.counter ?? 0;
    const keep = input.keepAmount.isZero()
      ? []
      : this.creator.createDeterministicData(
          input.keepAmount,
          input.seed,
          current,
          input.activeKeys,
        );
    const send = input.fixedSendOutputs
      ? [...input.fixedSendOutputs]
      : input.sendAmount.isZero()
        ? []
        : this.creator.createDeterministicData(
            input.sendAmount,
            input.seed,
            current + keep.length,
            input.activeKeys,
          );
    if (input.fixedSendOutputs && send.length === 0) {
      throw new ProofValidationError('Method preflight did not produce output data');
    }
    const positions = keep.length + (input.fixedSendOutputs ? 0 : send.length);
    const next = current + positions;
    if (!Number.isSafeInteger(next)) throw new ProofValidationError('Output counter exhausted');
    const counter =
      positions > 0
        ? { mintUrl: input.mintUrl, keysetId: input.activeKeys.id, counter: next }
        : undefined;
    if (counter) await this.counters.setCounter(counter.mintUrl, counter.keysetId, counter.counter);
    return { outputData: serializeOutputData({ keep, send }), counter };
  }
}
