import { Amount, sumProofs, type Proof } from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError } from '@core/models/Error.ts';
import type { MeltQuote } from '@core/models/MeltQuote.ts';
import { resolveOnchainMeltFeeOption } from '@core/models/MeltQuote.ts';
import { assertOutputProofs } from '@core/proofs/OutputProofs.ts';
import type { CoreProof } from '@core/types.ts';
import {
  deserializeOutputData,
  getSecretsFromSerializedOutputData,
  mapProofToCoreProof,
  normalizeMintUrl,
  stringifyJson,
  type SerializedOutputData,
} from '@core/utils.ts';
import type { CoreTransaction } from '../../transactions/CoreTransaction.ts';
import { defineTransition } from '../../transactions/Transition.ts';
import type {
  ExecutingMeltOperation,
  FinalizedMeltOperation,
  MeltMethodFinalizedData,
  MeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
  PreparedOrLaterOperation,
  RolledBackMeltOperation,
} from './MeltOperation.ts';
import type {
  ApplyMeltPaidResult,
  ApplyMeltPaidResultInput,
  ApplyMeltPendingInput,
  ApplyMeltPendingResult,
  ApplyMeltSwapResult,
  ApplyMeltSwapResultInput,
  BeginMeltExecutionInput,
  BeginMeltExecutionResult,
  CancelPreparedMeltInput,
  CancelPreparedMeltResult,
  CleanupMeltInitResult,
  DeferMeltRecoveryInput,
  PrepareMeltInput,
  PrepareMeltResult,
  ReleaseMeltAfterNonPaymentInput,
  ReleaseMeltAfterNonPaymentResult,
} from './MeltTransitionTypes.ts';

/** Persist the exact Melt request, proof reservation, and both Output Allocations together. */
export const prepareMelt = defineTransition<PrepareMeltInput, PrepareMeltResult>(
  async (tx, input) => {
    const mintUrl = normalizeMintUrl(input.mintUrl);
    const unit = normalizeUnit(input.unit);
    await tx.mintMetadata.assertCanMelt(mintUrl, input.method, unit);
    const quote = await tx.meltQuotes.getMeltQuote(mintUrl, input.method, input.quoteId);
    if (!quote) throw new Error(`Melt quote ${input.quoteId} was not found`);
    assertQuoteMatchesPreparation(quote, input, mintUrl, unit);

    const existing = await tx.meltOperations.getById(input.operationId);
    if (existing) {
      if (!samePreparationIntent(existing, input, quote, mintUrl, unit)) {
        throw new Error(`Melt operation ${input.operationId} has a different intent`);
      }
      if (existing.state === 'prepared') {
        return { operation: existing, reservedProofs: [], changed: false };
      }
      if (existing.state !== 'init') {
        throw new Error(`Cannot prepare operation ${existing.id} in state ${existing.state}`);
      }
    }

    const siblings = await tx.meltOperations.getByQuoteId(mintUrl, quote.quoteId);
    const sibling = siblings.find((operation) => operation.id !== input.operationId);
    if (sibling) {
      throw new Error(
        `Melt quote ${quote.quoteId} is already tracked by operation ${sibling.id} in state ${sibling.state}`,
      );
    }

    const feeReserve = getFeeReserve(quote, input);
    const required = quote.amount.add(feeReserve);
    const swapAmount = await tx.outputs.includeInputFees({
      mintUrl,
      unit,
      activeKeys: input.activeKeys,
      amount: required,
    });
    const reservation = await tx.proofs.selectAndReserveForMelt({
      mintUrl,
      unit,
      operationId: input.operationId,
      amount: required,
      swapAmount,
    });
    const requiredInputAmount = reservation.needsSwap
      ? swapAmount.add(reservation.inputFee)
      : required;
    if (reservation.inputAmount.lessThan(requiredInputAmount)) {
      throw new ProofValidationError('Melt amount is not sufficient after fees');
    }

    const meltInputAmount = reservation.needsSwap ? swapAmount : reservation.inputAmount;
    const changeAllocation = await tx.outputs.allocateBlank({
      mintUrl,
      unit,
      activeKeys: input.activeKeys,
      seed: input.seed,
      amount: meltInputAmount.subtract(quote.amount),
    });
    let swapOutputData: SerializedOutputData | undefined;
    let finalCounter = changeAllocation.counter;
    const swapFee = reservation.needsSwap ? reservation.inputFee : Amount.zero();
    if (reservation.needsSwap) {
      const keepAmount = reservation.inputAmount.subtract(swapAmount).subtract(swapFee);
      const swapAllocation = await tx.outputs.allocate({
        mintUrl,
        unit,
        activeKeys: input.activeKeys,
        seed: input.seed,
        keepAmount,
        sendAmount: swapAmount,
      });
      swapOutputData = swapAllocation.outputData;
      finalCounter = swapAllocation.counter ?? finalCounter;
      const planned = deserializeOutputData(swapOutputData);
      const plannedKeep = Amount.sum(planned.keep.map((output) => output.blindedMessage.amount));
      const plannedSend = Amount.sum(planned.send.map((output) => output.blindedMessage.amount));
      if (!plannedKeep.add(plannedSend).add(swapFee).equals(reservation.inputAmount)) {
        throw new ProofValidationError('Melt swap output plan does not balance selected inputs');
      }
    }

    const operation: PreparedMeltOperation = {
      id: input.operationId,
      mintUrl,
      method: input.method,
      methodData: input.methodData,
      quoteId: quote.quoteId,
      unit,
      needsSwap: reservation.needsSwap,
      amount: quote.amount,
      fee_reserve: feeReserve,
      swap_fee: swapFee,
      inputAmount: reservation.inputAmount,
      inputProofSecrets: reservation.proofs.map((proof) => proof.secret),
      changeOutputData: changeAllocation.outputData,
      ...(swapOutputData ? { swapOutputData } : {}),
      state: 'prepared',
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    assertPreparedPlan(operation);
    if (existing) await tx.meltOperations.update(operation);
    else await tx.meltOperations.create(operation);
    return {
      operation,
      reservedProofs: reservation.proofs,
      counter: finalCounter,
      changed: true,
    };
  },
);

/** Commit durable authorization before either the pre-swap or direct NUT-05 request. */
export const beginMeltExecution = defineTransition<
  BeginMeltExecutionInput,
  BeginMeltExecutionResult
>(async (tx, input) => {
  const current = await requireOperation(tx, input.operationId);
  if (current.state !== 'prepared') {
    return { operation: current, inputProofs: [], changed: false };
  }
  await tx.mintMetadata.assertCanMelt(current.mintUrl, current.method, current.unit);
  const quote = await requireQuote(tx, current);
  if (quote.state !== 'UNPAID') {
    throw new Error(`Cannot execute melt operation: quote is ${quote.state}`);
  }
  const inputProofs = await tx.proofs.getOwned({
    mintUrl: current.mintUrl,
    unit: current.unit,
    operationId: current.id,
    secrets: current.inputProofSecrets,
    state: 'ready',
  });
  await tx.proofs.markInflight({
    mintUrl: current.mintUrl,
    unit: current.unit,
    operationId: current.id,
    secrets: current.inputProofSecrets,
  });
  const operation: ExecutingMeltOperation = {
    ...current,
    state: 'executing',
    updatedAt: input.now,
    error: undefined,
  };
  await tx.meltOperations.update(operation);
  return { operation, inputProofs, changed: true };
});

/** Persist a successful pre-swap before authorizing the following NUT-05 request. */
export const applyMeltSwapResult = defineTransition<ApplyMeltSwapResultInput, ApplyMeltSwapResult>(
  async (tx, input) => {
    const current = await requireOperation(tx, input.operation.id);
    if (current.state !== 'executing' || !samePreparedRequest(current, input.operation)) {
      throw new Error('Melt swap result does not match persisted request');
    }
    if (!current.needsSwap || !current.swapOutputData) {
      throw new Error(`Melt operation ${current.id} has no pre-swap plan`);
    }
    const keepProofs = mapProofToCoreProof(current.mintUrl, 'ready', input.keepProofs, {
      unit: current.unit,
      createdByOperationId: current.id,
    });
    const sendProofs = mapProofToCoreProof(current.mintUrl, 'inflight', input.sendProofs, {
      unit: current.unit,
      createdByOperationId: current.id,
    }).map((proof) => ({ ...proof, usedByOperationId: current.id }));
    assertOutputProofs({
      mintUrl: current.mintUrl,
      unit: current.unit,
      outputData: current.swapOutputData,
      kind: 'keep',
      state: 'ready',
      createdByOperationId: current.id,
      proofs: keepProofs,
    });
    assertOutputProofs({
      mintUrl: current.mintUrl,
      unit: current.unit,
      outputData: current.swapOutputData,
      kind: 'send',
      state: 'inflight',
      createdByOperationId: current.id,
      proofs: sendProofs,
    });

    const storedOutputs = await tx.proofs.getProofsBySecrets(
      current.mintUrl,
      [...keepProofs, ...sendProofs].map((proof) => proof.secret),
    );
    if (storedOutputs.length > 0) {
      await tx.proofs.getOwned({
        mintUrl: current.mintUrl,
        unit: current.unit,
        operationId: current.id,
        secrets: current.inputProofSecrets,
        state: 'spent',
      });
      const stored = await requireStoredProofs(tx, current, [...keepProofs, ...sendProofs]);
      return {
        operation: current,
        savedProofs: [],
        sendProofs: stored.filter((proof) =>
          sendProofs.some((send) => send.secret === proof.secret),
        ),
        spentInputSecrets: [],
        changed: false,
      };
    }
    await tx.proofs.settleSpend({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
      state: ['inflight', 'spent'],
      outputs: [...keepProofs, ...sendProofs],
    });
    const operation: ExecutingMeltOperation = { ...current, updatedAt: input.now };
    await tx.meltOperations.update(operation);
    return {
      operation,
      savedProofs: [...keepProofs, ...sendProofs],
      sendProofs,
      spentInputSecrets: current.inputProofSecrets,
      changed: true,
    };
  },
);

/** Record local PENDING while accepting a canonical PENDING or newer PAID quote. */
export const applyMeltPending = defineTransition<ApplyMeltPendingInput, ApplyMeltPendingResult>(
  async (tx, input) => {
    const current = await requireOperation(tx, input.operation.id);
    if (current.state === 'pending') return { operation: current, changed: false };
    if (current.state !== 'executing' || !samePreparedRequest(current, input.operation)) {
      throw new Error('Melt pending result does not match persisted request');
    }
    const quote = await requireQuote(tx, current);
    if (quote.state !== 'PENDING' && quote.state !== 'PAID') {
      throw new Error(`Cannot mark melt operation pending from quote state ${quote.state}`);
    }
    await requireMeltInputs(tx, current, ['inflight', 'spent']);
    const operation: PendingMeltOperation = {
      ...current,
      state: 'pending',
      updatedAt: input.now,
      error: undefined,
    };
    await tx.meltOperations.update(operation);
    return { operation, changed: true };
  },
);

/** Save verified NUT-08 change, spend exact Melt inputs, and finalize atomically. */
export const applyMeltPaidResult = defineTransition<ApplyMeltPaidResultInput, ApplyMeltPaidResult>(
  async (tx, input) => {
    const current = await requireOperation(tx, input.operation.id);
    if (current.state === 'finalized') {
      return {
        operation: current,
        changeProofs: [],
        spentInputSecrets: [],
        changed: false,
      };
    }
    if (
      (current.state !== 'executing' && current.state !== 'pending') ||
      !samePreparedRequest(current, input.operation)
    ) {
      throw new Error('Melt paid result does not match persisted request');
    }
    const quote = await requireQuote(tx, current);
    if (quote.state !== 'PAID') {
      throw new Error(`Cannot finalize melt operation from quote state ${quote.state}`);
    }
    if (!Array.isArray(quote.change)) {
      throw new ProofValidationError(
        'Cannot finalize melt operation: canonical settlement change is incomplete',
      );
    }
    if (quote.change.length !== input.changeProofs.length) {
      throw new ProofValidationError('Melt change proofs do not match canonical settlement');
    }
    assertFinalizedData(quote, input.finalizedData);
    const changeProofs = mapProofToCoreProof(current.mintUrl, 'ready', input.changeProofs, {
      unit: current.unit,
      createdByOperationId: current.id,
    });
    assertChangeProofs(current, changeProofs);
    const meltInputs = await requireMeltInputs(tx, current, ['inflight', 'spent']);
    await tx.proofs.saveCreated(current.mintUrl, changeProofs);
    const inflightInputs = meltInputs.filter((proof) => proof.state === 'inflight');
    if (inflightInputs.length > 0) {
      if (current.needsSwap) {
        const meltSend = meltSendProofInput(current);
        const inflightSecrets = new Set(inflightInputs.map((proof) => proof.secret));
        await tx.proofs.recordMeltSendSpent({
          ...meltSend,
          secrets: [...inflightSecrets],
          outputs: meltSend.outputs.filter((output) => inflightSecrets.has(output.secret)),
        });
      } else {
        await tx.proofs.recordSpent({
          mintUrl: current.mintUrl,
          unit: current.unit,
          operationId: current.id,
          secrets: inflightInputs.map((proof) => proof.secret),
        });
      }
    }
    const changeAmount = sumProofs(changeProofs);
    const meltInputAmount = Amount.sum(meltInputs.map((proof) => proof.amount));
    const operation: FinalizedMeltOperation = {
      ...current,
      state: 'finalized',
      updatedAt: input.now,
      error: undefined,
      changeAmount,
      effectiveFee: meltInputAmount.subtract(current.amount).subtract(changeAmount),
      finalizedData: input.finalizedData,
    };
    await tx.meltOperations.update(operation);
    return {
      operation,
      changeProofs,
      spentInputSecrets: inflightInputs.map((proof) => proof.secret),
      changed: true,
    };
  },
);

/** Release only after fresh canonical non-payment evidence has been committed. */
export const releaseMeltAfterNonPayment = defineTransition<
  ReleaseMeltAfterNonPaymentInput,
  ReleaseMeltAfterNonPaymentResult
>(async (tx, input) => {
  const current = await requireOperation(tx, input.operationId);
  if (
    current.state === 'rolled_back' ||
    current.state === 'finalized' ||
    current.state === 'failed'
  ) {
    return {
      operation: current,
      restoredSecrets: [],
      releasedSecrets: [],
      changed: false,
    };
  }
  if (
    current.state !== 'executing' &&
    current.state !== 'pending' &&
    current.state !== 'rolling_back'
  ) {
    throw new Error(`Cannot release melt operation ${current.id} in state ${current.state}`);
  }
  const quote = await requireQuote(tx, current);
  assertNonPaymentEvidence(current, quote, input.evidence);
  let restoredSecrets: string[];
  let releasedSecrets: string[];
  if (!current.needsSwap) {
    await tx.proofs.releaseUnsubmitted({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
    });
    restoredSecrets = current.inputProofSecrets;
    releasedSecrets = current.inputProofSecrets;
  } else {
    if (!current.swapOutputData) throw new Error('Melt pre-swap output plan is missing');
    const sendSecrets = getSecretsFromSerializedOutputData(current.swapOutputData).sendSecrets;
    const storedSend = await tx.proofs.getProofsBySecrets(current.mintUrl, sendSecrets);
    if (storedSend.length === sendSecrets.length) {
      await tx.proofs.releaseMeltSendUnsubmitted(meltSendProofInput(current));
      await tx.proofs.releaseOwned(current.mintUrl, current.id, current.inputProofSecrets);
      restoredSecrets = sendSecrets;
      releasedSecrets = [...sendSecrets, ...current.inputProofSecrets];
    } else if (storedSend.length === 0 && input.evidence.originalProofsUnspent === true) {
      await tx.proofs.releaseUnsubmitted({
        mintUrl: current.mintUrl,
        unit: current.unit,
        operationId: current.id,
        secrets: current.inputProofSecrets,
      });
      restoredSecrets = current.inputProofSecrets;
      releasedSecrets = current.inputProofSecrets;
    } else {
      throw new ProofValidationError('Pre-swap outcome is incomplete; Melt resources stay owned');
    }
  }
  const operation: RolledBackMeltOperation = {
    ...current,
    state: 'rolled_back',
    updatedAt: input.now,
    error: input.reason,
  };
  await tx.meltOperations.update(operation);
  return { operation, restoredSecrets, releasedSecrets, changed: true };
});

/** A prepared operation authorized no remote effect, so its reservation can be released locally. */
export const cancelPreparedMelt = defineTransition<
  CancelPreparedMeltInput,
  CancelPreparedMeltResult
>(async (tx, input) => {
  const current = await requireOperation(tx, input.operationId);
  if (current.state === 'rolled_back') {
    return {
      operation: current,
      restoredSecrets: [],
      releasedSecrets: [],
      changed: false,
    };
  }
  if (current.state !== 'prepared') {
    throw new Error(`Cannot cancel melt operation ${current.id} in state ${current.state}`);
  }
  await tx.proofs.releaseUnsubmitted({
    mintUrl: current.mintUrl,
    unit: current.unit,
    operationId: current.id,
    secrets: current.inputProofSecrets,
  });
  const operation: RolledBackMeltOperation = {
    ...current,
    state: 'rolled_back',
    updatedAt: input.now,
    error: input.reason,
  };
  await tx.meltOperations.update(operation);
  return {
    operation,
    restoredSecrets: current.inputProofSecrets,
    releasedSecrets: current.inputProofSecrets,
    changed: true,
  };
});

/** Remove legacy init rows and any reservation that an interrupted legacy prepare left behind. */
export const cleanupMeltInit = defineTransition<string, CleanupMeltInitResult>(
  async (tx, operationId) => {
    const current = await tx.meltOperations.getById(operationId);
    if (!current || current.state !== 'init') return { releasedSecrets: [], changed: false };
    const owned = (await tx.proofs.getProofsByOperationId(current.mintUrl, current.id)).filter(
      (proof) => proof.usedByOperationId === current.id,
    );
    const releasedSecrets = owned.map((proof) => proof.secret);
    if (releasedSecrets.length > 0) {
      await tx.proofs.releaseOwned(current.mintUrl, current.id, releasedSecrets);
    }
    await tx.meltOperations.delete(operationId);
    return { releasedSecrets, changed: true };
  },
);

/** Retain exact request material and owned resources after an ambiguous outcome. */
export const deferMeltRecovery = defineTransition<DeferMeltRecoveryInput, void>(
  async (tx, input) => {
    const current = await requireOperation(tx, input.operationId);
    if (
      current.state !== 'executing' &&
      current.state !== 'pending' &&
      current.state !== 'rolling_back'
    ) {
      return;
    }
    await tx.meltOperations.update({
      ...current,
      updatedAt: input.now,
      error: input.error?.slice(0, 500),
    });
  },
);

async function requireOperation(tx: CoreTransaction, id: string): Promise<MeltOperation> {
  const operation = await tx.meltOperations.getById(id);
  if (!operation) throw new Error(`Operation ${id} not found`);
  return operation;
}

async function requireQuote(
  tx: CoreTransaction,
  operation: PreparedOrLaterOperation,
): Promise<MeltQuote> {
  const quote = await tx.meltQuotes.getMeltQuote(
    operation.mintUrl,
    operation.method,
    operation.quoteId,
  );
  if (!quote) throw new Error(`Melt quote ${operation.quoteId} was not found`);
  assertSameUnit(quote.unit, operation.unit, `Melt quote ${quote.quoteId}`);
  if (!quote.amount.equals(operation.amount)) throw new Error('Melt quote amount changed');
  return quote;
}

function assertQuoteMatchesPreparation(
  quote: MeltQuote,
  input: PrepareMeltInput,
  mintUrl: string,
  unit: string,
): void {
  if (
    quote.mintUrl !== mintUrl ||
    quote.method !== input.method ||
    quote.quoteId !== input.quoteId
  ) {
    throw new Error('Melt quote identity does not match preparation');
  }
  assertSameUnit(quote.unit, unit, `Melt quote ${quote.quoteId}`);
  if (quote.state !== 'UNPAID')
    throw new Error(`Cannot prepare melt quote in state ${quote.state}`);
  if (quote.expiry * 1000 <= input.now)
    throw new ProofValidationError('Cannot prepare expired melt quote');
  switch (input.method) {
    case 'bolt11':
      if ((input.methodData as { invoice: string }).invoice !== quote.request)
        throw new Error('Melt quote request does not match BOLT11 invoice');
      break;
    case 'bolt12':
      if ((input.methodData as { offer: string }).offer !== quote.request)
        throw new Error('Melt quote request does not match BOLT12 offer');
      break;
    case 'onchain': {
      const data = input.methodData as { address: string; amountSats: Amount; feeIndex?: number };
      if (data.address !== quote.request || !data.amountSats.equals(quote.amount))
        throw new Error('Melt quote request does not match on-chain intent');
      break;
    }
  }
}

function getFeeReserve(quote: MeltQuote, input: PrepareMeltInput): Amount {
  if (quote.method !== 'onchain') return quote.fee_reserve;
  const feeIndex = (input.methodData as { feeIndex?: number }).feeIndex;
  return resolveOnchainMeltFeeOption(quote, feeIndex).feeOption.fee_reserve;
}

function samePreparationIntent(
  operation: MeltOperation,
  input: PrepareMeltInput,
  quote: MeltQuote,
  mintUrl: string,
  unit: string,
): boolean {
  return (
    operation.mintUrl === mintUrl &&
    operation.method === input.method &&
    normalizeUnit(operation.unit) === unit &&
    stringifyJson(operation.methodData) === stringifyJson(input.methodData) &&
    (!('quoteId' in operation) || operation.quoteId == null || operation.quoteId === quote.quoteId)
  );
}

function samePreparedRequest(a: PreparedOrLaterOperation, b: PreparedOrLaterOperation): boolean {
  return (
    a.id === b.id &&
    a.mintUrl === b.mintUrl &&
    a.method === b.method &&
    a.quoteId === b.quoteId &&
    a.unit === b.unit &&
    a.amount.equals(b.amount) &&
    a.fee_reserve.equals(b.fee_reserve) &&
    a.swap_fee.equals(b.swap_fee) &&
    a.inputAmount.equals(b.inputAmount) &&
    a.needsSwap === b.needsSwap &&
    stringifyJson(a.methodData) === stringifyJson(b.methodData) &&
    stringifyJson(a.inputProofSecrets) === stringifyJson(b.inputProofSecrets) &&
    stringifyJson(a.changeOutputData) === stringifyJson(b.changeOutputData) &&
    stringifyJson(a.swapOutputData ?? null) === stringifyJson(b.swapOutputData ?? null)
  );
}

function assertPreparedPlan(operation: PreparedMeltOperation): void {
  if (
    operation.inputProofSecrets.length === 0 ||
    new Set(operation.inputProofSecrets).size !== operation.inputProofSecrets.length
  ) {
    throw new ProofValidationError('Melt input plan contains no proofs or duplicate secrets');
  }
  if (operation.needsSwap !== Boolean(operation.swapOutputData)) {
    throw new ProofValidationError('Melt swap decision does not match its output plan');
  }
}

async function requireStoredProofs(
  tx: CoreTransaction,
  operation: PreparedOrLaterOperation,
  expected: CoreProof[],
): Promise<CoreProof[]> {
  const stored = await tx.proofs.getProofsBySecrets(
    operation.mintUrl,
    expected.map((proof) => proof.secret),
  );
  if (
    stored.length !== expected.length ||
    stored.some((proof) => {
      const candidate = expected.find((item) => item.secret === proof.secret);
      return (
        !candidate ||
        proof.id !== candidate.id ||
        !proof.amount.equals(candidate.amount) ||
        proof.C !== candidate.C ||
        proof.state !== candidate.state ||
        proof.createdByOperationId !== candidate.createdByOperationId ||
        proof.usedByOperationId !== candidate.usedByOperationId
      );
    })
  ) {
    throw new ProofValidationError('Persisted pre-swap result conflicts with remote candidates');
  }
  return stored;
}

async function requireMeltInputs(
  tx: CoreTransaction,
  operation: PreparedOrLaterOperation,
  state: CoreProof['state'] | readonly CoreProof['state'][],
): Promise<CoreProof[]> {
  if (operation.needsSwap) {
    return tx.proofs.getMeltSendProofs({ ...meltSendProofInput(operation), state });
  }
  return tx.proofs.getOwned({
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    operationId: operation.id,
    secrets: operation.inputProofSecrets,
    state,
  });
}

function meltSendProofInput(operation: PreparedOrLaterOperation) {
  if (!operation.swapOutputData) throw new Error('Melt pre-swap output plan is missing');
  const outputs = deserializeOutputData(operation.swapOutputData).send.map((output) => ({
    secret: new TextDecoder().decode(output.secret),
    id: output.blindedMessage.id,
    amount: output.blindedMessage.amount,
  }));
  return {
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    operationId: operation.id,
    secrets: outputs.map((output) => output.secret),
    outputs,
  };
}

function assertChangeProofs(operation: PreparedOrLaterOperation, proofs: CoreProof[]): void {
  const outputs = deserializeOutputData(operation.changeOutputData).keep;
  const expectedSecrets = outputs.map((output) => new TextDecoder().decode(output.secret));
  if (
    proofs.length > expectedSecrets.length ||
    new Set(proofs.map((proof) => proof.secret)).size !== proofs.length
  ) {
    throw new ProofValidationError('Melt change proofs do not match allocated outputs');
  }
  proofs.forEach((proof, index) => {
    const output = outputs[index];
    if (
      !output ||
      proof.secret !== expectedSecrets[index] ||
      proof.id !== output.blindedMessage.id ||
      proof.mintUrl !== operation.mintUrl ||
      normalizeUnit(proof.unit) !== normalizeUnit(operation.unit) ||
      proof.state !== 'ready' ||
      proof.createdByOperationId !== operation.id
    ) {
      throw new ProofValidationError('Melt change proofs do not match allocated outputs');
    }
  });
  const meltInputAmount = operation.needsSwap
    ? Amount.sum(
        deserializeOutputData(operation.swapOutputData!).send.map(
          (output) => output.blindedMessage.amount,
        ),
      )
    : operation.inputAmount;
  if (sumProofs(proofs).greaterThan(meltInputAmount.subtract(operation.amount))) {
    throw new ProofValidationError('Melt change exceeds the committed change capacity');
  }
}

function assertFinalizedData(
  quote: MeltQuote,
  finalizedData: MeltMethodFinalizedData | undefined,
): void {
  if (quote.method === 'onchain') {
    const actual =
      finalizedData && 'outpoint' in finalizedData ? finalizedData.outpoint : undefined;
    if (actual !== (quote.outpoint ?? undefined)) {
      throw new Error('Melt on-chain settlement does not match canonical quote');
    }
    return;
  }
  const actual = finalizedData && 'preimage' in finalizedData ? finalizedData.preimage : undefined;
  if (actual !== (quote.payment_preimage ?? undefined)) {
    throw new Error('Melt preimage does not match canonical quote');
  }
}

function assertNonPaymentEvidence(
  operation: PreparedOrLaterOperation,
  quote: MeltQuote,
  evidence: ReleaseMeltAfterNonPaymentInput['evidence'],
): void {
  if (
    normalizeMintUrl(evidence.mintUrl) !== operation.mintUrl ||
    evidence.method !== operation.method ||
    evidence.quoteId !== operation.quoteId
  ) {
    throw new Error('Melt non-payment evidence has a different quote identity');
  }
  if (
    quote.state !== 'UNPAID' ||
    quote.lastObservedRemoteState !== 'UNPAID' ||
    quote.lastObservedRemoteStateAt !== evidence.observedAt
  ) {
    throw new Error('Melt non-payment evidence is stale or contradicted by the canonical quote');
  }
}
