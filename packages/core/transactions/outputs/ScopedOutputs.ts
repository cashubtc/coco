import {
  Amount,
  OutputData,
  splitAmount,
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
  /** Increase deterministic send outputs to cover the fee charged when they are spent. */
  includeSendFees?: boolean;
  fixedSendOutputs?: readonly OutputDataLike[];
}

export interface AllocateOutputsResult {
  outputData: SerializedOutputData;
  counter?: Counter;
}

export interface AllocateBlankOutputsInput {
  mintUrl: string;
  unit: string;
  activeKeys: MintKeys;
  seed: Uint8Array;
  /** Maximum change value the blank outputs must be able to represent. */
  amount: Amount;
}

/** Output allocation within an existing transaction; never opens or commits a transaction. */
export interface ScopedOutputs {
  getCounter(mintUrl: string, keysetId: string): Promise<Counter | null>;
  assertActiveKeys(mintUrl: string, unit: string, activeKeys: MintKeys): Promise<void>;
  /** Calculate the proof amount whose spendable value covers `amount` after input fees. */
  includeInputFees(input: {
    mintUrl: string;
    unit: string;
    activeKeys: MintKeys;
    amount: Amount;
  }): Promise<Amount>;
  /** The caller must persist the returned output plan in this same transaction. */
  allocate(input: AllocateOutputsInput): Promise<AllocateOutputsResult>;
  /** The caller must persist the returned NUT-08 plan in this same transaction. */
  allocateBlank(input: AllocateBlankOutputsInput): Promise<AllocateOutputsResult>;
}

/** Shared deterministic Output Allocation. The owning transition persists its plan in the same scope. */
export class RepositoryScopedOutputs implements ScopedOutputs {
  constructor(
    private readonly counters: CounterRepository,
    private readonly keysets: KeysetRepository,
    private readonly creator: OutputDataCreator = OutputData,
  ) {}

  getCounter(mintUrl: string, keysetId: string): Promise<Counter | null> {
    return this.counters.getCounter(mintUrl, keysetId);
  }

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

  async includeInputFees(input: {
    mintUrl: string;
    unit: string;
    activeKeys: MintKeys;
    amount: Amount;
  }): Promise<Amount> {
    await this.assertActiveKeys(input.mintUrl, input.unit, input.activeKeys);
    const keyset = await this.keysets.getKeysetById(input.mintUrl, input.activeKeys.id);
    if (!keyset) {
      throw new ProofValidationError(`Active keyset ${input.activeKeys.id} is missing`);
    }
    return includeProofFees(input.amount, input.activeKeys, keyset.feePpk);
  }

  async allocate(input: AllocateOutputsInput): Promise<AllocateOutputsResult> {
    await this.assertActiveKeys(input.mintUrl, input.unit, input.activeKeys);
    if (input.includeSendFees && input.fixedSendOutputs) {
      throw new ProofValidationError(
        'Fee-inclusive allocation requires deterministic send outputs',
      );
    }
    let keepAmount = input.keepAmount;
    let sendAmount = input.sendAmount;
    if (input.includeSendFees && !sendAmount.isZero()) {
      sendAmount = await this.includeInputFees({
        mintUrl: input.mintUrl,
        unit: input.unit,
        activeKeys: input.activeKeys,
        amount: sendAmount,
      });
      const sendFee = sendAmount.subtract(input.sendAmount);
      if (keepAmount.lessThan(sendFee)) {
        throw new ProofValidationError('Keep amount is not sufficient to cover send output fees');
      }
      keepAmount = keepAmount.subtract(sendFee);
    }
    const current =
      (await this.counters.getCounter(input.mintUrl, input.activeKeys.id))?.counter ?? 0;
    const keep = keepAmount.isZero()
      ? []
      : this.creator.createDeterministicData(keepAmount, input.seed, current, input.activeKeys);
    const send = input.fixedSendOutputs
      ? [...input.fixedSendOutputs]
      : sendAmount.isZero()
        ? []
        : this.creator.createDeterministicData(
            sendAmount,
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

  async allocateBlank(input: AllocateBlankOutputsInput): Promise<AllocateOutputsResult> {
    await this.assertActiveKeys(input.mintUrl, input.unit, input.activeKeys);
    const value = input.amount.toBigInt();
    const positions = value === 0n ? 0 : Math.max((value - 1n).toString(2).length, 1);
    if (positions === 0) {
      return { outputData: serializeOutputData({ keep: [], send: [] }) };
    }
    const current =
      (await this.counters.getCounter(input.mintUrl, input.activeKeys.id))?.counter ?? 0;
    const keep = Array.from({ length: positions }, (_, index) =>
      this.creator.createSingleDeterministicData(
        0,
        input.seed,
        current + index,
        input.activeKeys.id,
      ),
    );
    const next = current + positions;
    if (!Number.isSafeInteger(next)) throw new ProofValidationError('Output counter exhausted');
    const counter = {
      mintUrl: input.mintUrl,
      keysetId: input.activeKeys.id,
      counter: next,
    };
    await this.counters.setCounter(counter.mintUrl, counter.keysetId, counter.counter);
    return { outputData: serializeOutputData({ keep, send: [] }), counter };
  }
}

function includeProofFees(amount: Amount, activeKeys: MintKeys, feePpk: number): Amount {
  if (!Number.isSafeInteger(feePpk) || feePpk < 0) {
    throw new ProofValidationError(`Invalid input fee for keyset ${activeKeys.id}`);
  }
  const denominations = splitAmount(amount, activeKeys.keys);
  let fee = feeForProofCount(denominations.length, feePpk);
  let feeDenominations = splitAmount(fee, activeKeys.keys);
  while (true) {
    const nextFee = feeForProofCount(denominations.length + feeDenominations.length, feePpk);
    if (!nextFee.greaterThan(fee)) return amount.add(fee);
    // The number of denominations is not monotonic as the fee increases. Advancing one unit at a
    // time finds the smallest stable fee instead of skipping a valid lower fixed point.
    fee = fee.add(1);
    feeDenominations = splitAmount(fee, activeKeys.keys);
  }
}

function feeForProofCount(count: number, feePpk: number): Amount {
  return Amount.from((BigInt(count) * BigInt(feePpk) + 999n) / 1000n);
}
