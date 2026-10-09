import { Amount, type Proof } from '@cashu/cashu-ts';
import type { CoreTransaction } from '../../transactions/CoreTransaction.ts';
import { defineTransition } from '../../transactions/Transition.ts';
import { RepositoryTransactionConflictError } from '../../repositories/index.ts';
import { ProofValidationError } from '../../models/Error.ts';
import { getSecretsFromSerializedOutputData } from '../../utils.ts';
import type {
  MintSwapOperation,
  PreparingMintSwapOperation,
  MintSwapFailure,
  MintSwapRetryError,
} from './MintSwapOperation.ts';
import { isMintSwapTerminalState } from './MintSwapOperation.ts';
import {
  prepareMelt,
  beginMeltExecution,
  applyMeltSwapResult,
  applyMeltPending,
  applyMeltPaidResult,
  releaseMeltAfterNonPayment,
  cancelPreparedMelt,
} from '../melt/MeltTransitions.ts';
import { prepareMint, beginMintExecution, applyMintResult } from '../mint/MintTransitions.ts';
import type { PreparedOrLaterOperation, FinalizedMeltOperation } from '../melt/MeltOperation.ts';
import type { MeltQuote } from '../../models/MeltQuote.ts';
import type { ExecutingMintOperation, PendingOrLaterOperation } from '../mint/MintOperation.ts';
import type { ApplyMeltSwapResultInput } from '../melt/MeltTransitionTypes.ts';
import type {
  PrepareMintSwapInput,
  BeginMintSwapSourceInput,
  BeginMintSwapSourceResult,
  ApplyMintSwapSourceInput,
  BeginMintSwapDestinationResult,
} from './MintSwapTransitionTypes.ts';
import {
  advanceMintSwap,
  assertMintSwapIntent,
  invoiceHash,
  meltPlanAmounts,
  MintSwapInvariantError,
  scheduleMintSwapRetry,
  stopMintSwap,
} from './MintSwapValidation.ts';
import { MintSwapDebitCapError } from './MintSwapDebitCapError.ts';

async function requireParent(tx: CoreTransaction, id: string): Promise<MintSwapOperation> {
  if (!tx.mintSwapOperations) throw new Error('Mint Swap persistence is not enabled');
  const operation = await tx.mintSwapOperations.getById(id);
  if (!operation) throw new Error('Mint Swap was not found');
  return operation;
}

async function save(
  tx: CoreTransaction,
  current: MintSwapOperation,
  next: MintSwapOperation,
): Promise<MintSwapOperation> {
  if (
    !(await tx.mintSwapOperations!.transition({
      operationId: current.id,
      expectedState: current.state,
      expectedRevision: current.revision,
      next,
    }))
  )
    throw new RepositoryTransactionConflictError('Mint Swap changed during local composition');
  return { ...next, revision: current.revision + 1 };
}

function quiescent(operation: MintSwapOperation) {
  return isMintSwapTerminalState(operation.state) || operation.state === 'needs_attention';
}

async function quotes(tx: CoreTransaction, parent: MintSwapOperation) {
  const source = await tx.meltQuotes.getMeltQuote(
    parent.sourceMintUrl,
    'bolt11',
    parent.sourceQuote.quoteId,
  );
  const destination = await tx.mintQuotes.getMintQuote(
    parent.destinationMintUrl,
    'bolt11',
    parent.destinationQuote.quoteId,
  );
  if (!source) throw new MintSwapInvariantError('quote_identity', 'quote_missing', 'source');
  if (!destination)
    throw new MintSwapInvariantError('quote_identity', 'quote_missing', 'destination');
  if (
    source.method !== 'bolt11' ||
    source.unit !== 'sat' ||
    !source.amount.equals(parent.destinationAmount)
  )
    throw new MintSwapInvariantError('quote_identity', 'quote_conflict', 'source');
  if (
    destination.method !== 'bolt11' ||
    destination.unit !== 'sat' ||
    !destination.amount.equals(parent.destinationAmount) ||
    destination.reusable
  )
    throw new MintSwapInvariantError('quote_identity', 'quote_conflict', 'destination');
  if (
    invoiceHash(source.request) !== parent.paymentRequestHash ||
    source.request !== destination.request
  )
    throw new MintSwapInvariantError('payment_request', 'invoice_mismatch', 'source');
  if (!destination.pubkey || !(await tx.keypairs.getMintQuoteKey(destination.pubkey)))
    throw new MintSwapInvariantError('recovery_material', 'key_missing', 'destination');
  return { source, destination };
}

async function children(tx: CoreTransaction, parent: MintSwapOperation) {
  const source = await tx.meltOperations.getById(parent.sourceOperationId);
  const destination = await tx.mintOperations.getById(parent.destinationOperationId);
  if (!source) throw new MintSwapInvariantError('child_identity', 'child_missing', 'source');
  if (!destination)
    throw new MintSwapInvariantError('child_identity', 'child_missing', 'destination');
  if (
    source.state === 'init' ||
    source.mintUrl !== parent.sourceMintUrl ||
    source.method !== 'bolt11' ||
    source.quoteId !== parent.sourceQuote.quoteId ||
    source.unit !== 'sat' ||
    !source.amount.equals(parent.destinationAmount) ||
    !('invoice' in source.methodData) ||
    invoiceHash(source.methodData.invoice) !== parent.paymentRequestHash
  )
    throw new MintSwapInvariantError('child_identity', 'child_conflict', 'source');
  if (
    destination.state === 'init' ||
    destination.mintUrl !== parent.destinationMintUrl ||
    destination.method !== 'bolt11' ||
    destination.quoteId !== parent.destinationQuote.quoteId ||
    destination.unit !== 'sat' ||
    !destination.amount.equals(parent.destinationAmount) ||
    invoiceHash(destination.request) !== parent.paymentRequestHash
  )
    throw new MintSwapInvariantError('child_identity', 'child_conflict', 'destination');
  const canonical = await quotes(tx, parent);
  if (destination.pubkey !== canonical.destination.pubkey)
    throw new MintSwapInvariantError('child_identity', 'child_conflict', 'destination');
  if (!source.changeOutputData || (source.needsSwap && !source.swapOutputData))
    throw new MintSwapInvariantError('recovery_material', 'outputs_missing', 'source');
  if (!destination.outputData?.keep.length || destination.outputData.send.length)
    throw new MintSwapInvariantError('recovery_material', 'outputs_missing', 'destination');
  return { source, destination, canonical };
}

async function bounds(tx: CoreTransaction, source: PreparedOrLaterOperation) {
  const plan = meltPlanAmounts(source);
  const inputs = source.needsSwap
    ? source.swapOutputData!.send.map((output) => ({
        id: output.blindedMessage.id,
      }))
    : await tx.proofs.getProofsBySecrets(source.mintUrl, source.inputProofSecrets);
  if (!source.needsSwap && inputs.length !== source.inputProofSecrets.length)
    throw new MintSwapInvariantError('recovery_material', 'proofs_missing', 'source');
  const fee = await tx.proofs.getFee(source.mintUrl, source.unit, inputs);
  return {
    minimum: source.amount.add(source.swap_fee).add(fee),
    maximum: source.inputAmount.subtract(plan.keep),
    reserved: source.inputAmount,
  };
}

async function requireBounds(
  tx: CoreTransaction,
  parent: MintSwapOperation,
  source: PreparedOrLaterOperation,
) {
  const actual = await bounds(tx, source);
  if (
    !parent.sourceDebitBounds ||
    !actual.minimum.equals(parent.sourceDebitBounds.minimum) ||
    !actual.maximum.equals(parent.sourceDebitBounds.maximum) ||
    !actual.reserved.equals(parent.sourceDebitBounds.reserved)
  )
    throw new MintSwapInvariantError('source_debit', 'debit_bounds_mismatch', 'source');
}

async function markAttention(
  tx: CoreTransaction,
  parent: MintSwapOperation,
  error: MintSwapInvariantError,
  now: number,
) {
  const at = Math.max(now, parent.updatedAt);
  return save(
    tx,
    parent,
    stopMintSwap(parent, 'needs_attention', at, { attention: error.evidence(at), attentionAt: at }),
  );
}

/** Persist immutable quote/child identities before any input reservation. */
export const createMintSwap = defineTransition<PreparingMintSwapOperation, MintSwapOperation>(
  async (tx, input) => {
    if (!tx.mintSwapOperations) throw new Error('Mint Swap persistence is not enabled');
    const current = await tx.mintSwapOperations.getById(input.id);
    if (current) {
      assertMintSwapIntent(current, input);
      return current;
    }
    await quotes(tx, input);
    await tx.mintSwapOperations.create(input);
    return input;
  },
);

/** Both child plans, reservations, counters, and prepared parent commit as one write set. */
export const prepareMintSwap = defineTransition<PrepareMintSwapInput, MintSwapOperation>(
  async (tx, input) => {
    const parent = await requireParent(tx, input.id);
    if (parent.state !== 'preparing') return parent;
    if (parent.cancellationRequestedAt !== undefined) return parent;
    const canonical = await quotes(tx, parent);
    await tx.mintMetadata.assertSupports(parent.destinationMintUrl, [9, 20]);
    // Advanced children are reconciled, never sent through idempotent preparation again.
    const previousSource = await tx.meltOperations.getById(parent.sourceOperationId);
    const previousDestination = await tx.mintOperations.getById(parent.destinationOperationId);
    const at = Math.max(input.now, parent.updatedAt);
    if (previousSource || previousDestination) {
      const existing = await children(tx, parent);
      if (existing.source.state !== 'prepared' || existing.destination.state !== 'pending') {
        const sourceDebitBounds = await bounds(tx, existing.source);
        if (parent.sourceDebitCap && sourceDebitBounds.maximum.greaterThan(parent.sourceDebitCap))
          return markAttention(
            tx,
            parent,
            new MintSwapInvariantError('source_debit', 'debit_bounds_mismatch', 'source'),
            at,
          );
        const prepared = await save(
          tx,
          parent,
          advanceMintSwap(parent, 'prepared', at, { sourceDebitBounds }),
        );
        return reconcile(tx, prepared, at);
      }
    }
    const source = await tx.perform(prepareMelt, {
      operationId: parent.sourceOperationId,
      mintUrl: parent.sourceMintUrl,
      method: 'bolt11',
      methodData: { invoice: canonical.source.request },
      quoteId: parent.sourceQuote.quoteId,
      unit: 'sat',
      activeKeys: input.sourceKeys,
      seed: input.seed,
      now: at,
    });
    if (source.operation.needsSwap)
      await tx.mintMetadata.assertSupports(parent.sourceMintUrl, [7, 9]);
    await tx.perform(prepareMint, {
      operationId: parent.destinationOperationId,
      mintUrl: parent.destinationMintUrl,
      method: 'bolt11',
      quoteId: parent.destinationQuote.quoteId,
      amount: parent.destinationAmount,
      unit: 'sat',
      activeKeys: input.destinationKeys,
      seed: input.seed,
      now: at,
    });
    const sourceDebitBounds = await bounds(tx, source.operation);
    if (parent.sourceDebitCap && sourceDebitBounds.maximum.greaterThan(parent.sourceDebitCap))
      throw new MintSwapDebitCapError();
    return save(tx, parent, advanceMintSwap(parent, 'prepared', at, { sourceDebitBounds }));
  },
);

/** Explicit authorization; only changed=true grants the coordinator a first remote dispatch. */
export const beginMintSwapSource = defineTransition<
  BeginMintSwapSourceInput,
  BeginMintSwapSourceResult
>(async (tx, input) => {
  const parent = await requireParent(tx, input.id);
  if (parent.state !== 'prepared' || parent.cancellationRequestedAt !== undefined)
    return { operation: parent, inputProofs: [], changed: false };
  const { source, destination, canonical } = await children(tx, parent);
  if (source.state !== 'prepared' || destination.state !== 'pending')
    return { operation: await reconcile(tx, parent, input.now), inputProofs: [], changed: false };
  const now = Math.max(input.now, parent.updatedAt);
  if (
    (canonical.source.expiry != null && canonical.source.expiry * 1000 <= now) ||
    (canonical.destination.expiry != null && canonical.destination.expiry * 1000 <= now)
  )
    throw new ProofValidationError('Mint Swap payment deadline has passed');
  if (!canonical.destination.amountPaid.isZero() || !canonical.destination.amountIssued.isZero())
    throw new ProofValidationError('Mint Swap destination already received payment');
  await tx.mintMetadata.assertCanMint(
    parent.destinationMintUrl,
    'bolt11',
    'sat',
    parent.destinationAmount,
  );
  await tx.mintMetadata.assertSupports(parent.destinationMintUrl, [9, 20]);
  if (source.needsSwap) await tx.mintMetadata.assertSupports(parent.sourceMintUrl, [7, 9]);
  await tx.outputs.assertActiveKeys(parent.sourceMintUrl, 'sat', input.sourceKeys);
  await tx.outputs.assertActiveKeys(parent.destinationMintUrl, 'sat', input.destinationKeys);
  if (
    [
      ...source.changeOutputData.keep,
      ...(source.swapOutputData?.keep ?? []),
      ...(source.swapOutputData?.send ?? []),
    ].some((output) => output.blindedMessage.id !== input.sourceKeys.id) ||
    destination.outputData.keep.some(
      (output) => output.blindedMessage.id !== input.destinationKeys.id,
    )
  )
    throw new ProofValidationError('Mint Swap output keysets changed before payment');
  await requireBounds(tx, parent, source);
  const started = await tx.perform(beginMeltExecution, { operationId: source.id, now });
  if (!started.changed || started.operation.state !== 'executing')
    return { operation: parent, inputProofs: [], changed: false };
  const operation = await save(
    tx,
    parent,
    advanceMintSwap(parent, 'source_pending', now, { sourceStartedAt: now }),
  );
  return { operation, source: started.operation, inputProofs: started.inputProofs, changed: true };
});

export const applyMintSwapPreSwap = defineTransition<
  { id: string; result: ApplyMeltSwapResultInput },
  MintSwapOperation
>(async (tx, input) => {
  const parent = await requireParent(tx, input.id);
  if (parent.state !== 'source_pending') return parent;
  const { source } = await children(tx, parent);
  if (source.id !== input.result.operation.id)
    throw new MintSwapInvariantError('child_identity', 'child_conflict', 'source');
  await tx.perform(applyMeltSwapResult, input.result);
  return parent;
});

/** Canonical observations have already committed; settlement composes child and parent. */
export const applyMintSwapSource = defineTransition<ApplyMintSwapSourceInput, MintSwapOperation>(
  async (tx, input) => {
    let parent = await requireParent(tx, input.id);
    if (parent.state !== 'source_pending') return parent;
    const { source, canonical } = await children(tx, parent);
    if (input.paid && (source.state === 'executing' || source.state === 'pending')) {
      if (input.paid.operation.id !== source.id)
        throw new MintSwapInvariantError('child_identity', 'child_conflict', 'source');
      await tx.perform(applyMeltPaidResult, input.paid);
    } else if (
      input.nonPayment &&
      ['executing', 'pending', 'rolling_back'].includes(source.state)
    ) {
      if (input.nonPayment.observedAt < parent.sourceStartedAt)
        throw new Error('Non-payment observation predates source authorization');
      await tx.perform(releaseMeltAfterNonPayment, {
        operationId: source.id,
        evidence: input.nonPayment,
        reason: 'Mint Swap source confirmed unpaid',
        now: input.now,
      });
    } else if (source.state === 'executing' && canonical.source.state === 'PENDING') {
      await tx.perform(applyMeltPending, { operation: source, now: input.now });
    }
    return reconcile(tx, parent, input.now);
  },
);

export const beginMintSwapDestination = defineTransition<
  { id: string; now: number },
  BeginMintSwapDestinationResult
>(async (tx, input) => {
  const parent = await requireParent(tx, input.id);
  if (parent.state !== 'destination_funded') return { operation: parent, changed: false };
  const { destination } = await children(tx, parent);
  if (destination.state !== 'pending')
    return { operation: await reconcile(tx, parent, input.now), changed: false };
  const now = Math.max(input.now, parent.updatedAt);
  const started = await tx.perform(beginMintExecution, { operationId: destination.id, now });
  if (!started.changed || started.operation.state !== 'executing')
    return { operation: parent, changed: false };
  return {
    operation: await save(
      tx,
      parent,
      advanceMintSwap(parent, 'destination_pending', now, { destinationStartedAt: now }),
    ),
    destination: started.operation,
    changed: true,
  };
});

export const applyMintSwapDestination = defineTransition<
  { id: string; operation: ExecutingMintOperation; proofs: Proof[]; now: number },
  MintSwapOperation
>(async (tx, input) => {
  const parent = await requireParent(tx, input.id);
  if (parent.state !== 'destination_pending') return parent;
  const { destination } = await children(tx, parent);
  if (destination.id !== input.operation.id)
    throw new MintSwapInvariantError('child_identity', 'child_conflict', 'destination');
  await tx.perform(applyMintResult, {
    operation: input.operation,
    proofs: input.proofs,
    now: input.now,
  });
  return reconcile(tx, parent, input.now);
});

async function stopUnpaid(
  tx: CoreTransaction,
  parent: MintSwapOperation,
  now: number,
  sourceProofs: 'not_reserved' | 'released',
  failure: MintSwapFailure,
  confirmedUnpaid = false,
) {
  const at = Math.max(now, parent.updatedAt);
  const cancelled = parent.cancellationRequestedAt !== undefined;
  return save(
    tx,
    parent,
    stopMintSwap(parent, cancelled ? 'cancelled' : 'failed', at, {
      valueNeutral: {
        sourcePayment:
          confirmedUnpaid || parent.state === 'source_pending'
            ? 'confirmed_unpaid'
            : 'not_authorized',
        sourceProofs,
        verifiedAt: at,
      },
      ...(cancelled ? { cancelledAt: at } : { failure, failedAt: at }),
    }),
  );
}

export const cancelMintSwap = defineTransition<
  { id: string; now: number; failure?: MintSwapFailure },
  MintSwapOperation
>(async (tx, input) => {
  let parent = await requireParent(tx, input.id);
  if (
    quiescent(parent) ||
    parent.state === 'destination_funded' ||
    parent.state === 'destination_pending'
  )
    return parent;
  const at = Math.max(input.now, parent.updatedAt);
  if (!input.failure && parent.cancellationRequestedAt === undefined)
    parent = await save(tx, parent, { ...parent, cancellationRequestedAt: at, updatedAt: at });
  const source = await tx.meltOperations.getById(parent.sourceOperationId);
  if (source && source.state !== 'prepared') return reconcile(tx, parent, at);
  if (parent.state === 'source_pending') return parent;
  if (source) {
    await children(tx, parent);
    await tx.perform(cancelPreparedMelt, {
      operationId: source.id,
      reason: 'Mint Swap cancelled before payment',
      now: at,
    });
  } else if (parent.state !== 'preparing')
    throw new MintSwapInvariantError('child_identity', 'child_missing', 'source');
  return stopUnpaid(
    tx,
    parent,
    at,
    source ? 'released' : 'not_reserved',
    input.failure ?? { code: 'preparation_rejected' },
  );
});

async function reconcile(
  tx: CoreTransaction,
  current: MintSwapOperation,
  now: number,
): Promise<MintSwapOperation> {
  let parent = current;
  if (quiescent(parent)) return parent;
  try {
    if (parent.state === 'preparing') {
      const source = await tx.meltOperations.getById(parent.sourceOperationId);
      const destination = await tx.mintOperations.getById(parent.destinationOperationId);
      if (!source && !destination) return parent;
      const existing = await children(tx, parent);
      const sourceDebitBounds = await bounds(tx, existing.source);
      if (parent.sourceDebitCap && sourceDebitBounds.maximum.greaterThan(parent.sourceDebitCap)) {
        if (existing.source.state === 'prepared') throw new MintSwapDebitCapError();
        throw new MintSwapInvariantError('source_debit', 'debit_bounds_mismatch', 'source');
      }
      parent = await save(
        tx,
        parent,
        advanceMintSwap(parent, 'prepared', now, { sourceDebitBounds }),
      );
    }
    let { source, destination, canonical } = await children(tx, parent);
    await requireBounds(tx, parent, source);
    if (source.state === 'failed')
      throw new MintSwapInvariantError('child_identity', 'child_conflict', 'source');
    if (source.state === 'prepared' && destination.state !== 'pending')
      throw new MintSwapInvariantError('child_identity', 'child_conflict', 'destination');
    // Follow each legal edge when child processors progressed while this parent was offline.
    if (
      parent.state === 'prepared' &&
      source.state !== 'prepared' &&
      source.state !== 'rolled_back'
    )
      parent = await save(
        tx,
        parent,
        advanceMintSwap(parent, 'source_pending', now, {
          sourceStartedAt: Math.max(now, parent.updatedAt),
        }),
      );
    if (
      source.state === 'rolled_back' &&
      (parent.state === 'prepared' || parent.state === 'source_pending')
    ) {
      if (
        canonical.source.state !== 'UNPAID' ||
        (canonical.source.lastObservedRemoteStateAt ?? -1) <
          (parent.state === 'source_pending' ? parent.sourceStartedAt : source.updatedAt)
      )
        return parent;
      const owned = await tx.proofs.getProofsByOperationId(source.mintUrl, source.id);
      if (
        owned.some(
          (proof) =>
            proof.state === 'inflight' ||
            (proof.state !== 'spent' && proof.usedByOperationId === source.id),
        )
      )
        throw new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source');
      return stopUnpaid(tx, parent, now, 'released', { code: 'source_payment_rejected' }, true);
    }
    if (parent.state === 'source_pending' && source.state === 'finalized') {
      if (
        canonical.source.state !== 'PAID' ||
        source.changeAmount === undefined ||
        source.effectiveFee === undefined
      )
        throw new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source');
      await verifySourceSettlement(tx, source, canonical.source);
      const { keep, melt } = meltPlanAmounts(source);
      if (
        melt.lessThan(source.amount.add(source.changeAmount)) ||
        !melt.subtract(source.amount).subtract(source.changeAmount).equals(source.effectiveFee)
      )
        throw new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source');
      const returned = keep.add(source.changeAmount);
      const finalDebit = source.inputAmount.subtract(returned);
      const totalFee = source.swap_fee.add(source.effectiveFee);
      if (
        !finalDebit.equals(parent.destinationAmount.add(totalFee)) ||
        !finalDebit.inRange(parent.sourceDebitBounds.minimum, parent.sourceDebitBounds.maximum)
      )
        throw new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source');
      parent = await save(
        tx,
        parent,
        advanceMintSwap(parent, 'destination_funded', now, {
          sourceSettlement: {
            reserved: source.inputAmount,
            returned,
            finalDebit,
            totalFee,
            sourcePaidObservedAt: Math.max(now, parent.updatedAt),
          },
        }),
      );
    }
    if (destination.state === 'failed')
      throw new MintSwapInvariantError('child_identity', 'child_conflict', 'destination');
    if (
      parent.state === 'destination_funded' &&
      (destination.state === 'executing' || destination.state === 'finalized')
    )
      parent = await save(
        tx,
        parent,
        advanceMintSwap(parent, 'destination_pending', now, {
          destinationStartedAt: Math.max(now, parent.updatedAt),
        }),
      );
    if (parent.state === 'destination_pending' && destination.state === 'executing') {
      const { keepSecrets } = getSecretsFromSerializedOutputData(destination.outputData);
      const saved = await tx.proofs.getProofsBySecrets(destination.mintUrl, keepSecrets);
      if (saved.length === keepSecrets.length) {
        await storedDestinationTotal(tx, destination);
        destination = (
          await tx.perform(applyMintResult, {
            operation: destination,
            proofs: [],
            now: Math.max(now, parent.updatedAt),
          })
        ).operation;
      }
    }
    if (parent.state === 'destination_pending' && destination.state === 'finalized') {
      const total = await storedDestinationTotal(tx, destination);
      if (
        !total.equals(parent.destinationAmount) ||
        canonical.destination.amountIssued.greaterThan(parent.destinationAmount)
      )
        throw new MintSwapInvariantError(
          'destination_completion',
          'proof_total_mismatch',
          'destination',
        );
      if (!canonical.destination.amountIssued.equals(total)) return parent; // Accounting can lag local issuance.
      const at = Math.max(now, parent.updatedAt);
      parent = await save(
        tx,
        parent,
        advanceMintSwap(parent, 'completed', at, {
          destinationCompletion: {
            quoteAmountIssued: canonical.destination.amountIssued,
            storedProofAmount: total,
            proofsVerifiedAt: at,
          },
          completedAt: at,
        }),
      );
    }
    return parent;
  } catch (error) {
    // Only locally detected invariant failures are outcomes. Repository failures still poison the attempt.
    if (error instanceof MintSwapInvariantError) return markAttention(tx, parent, error, now);
    throw error;
  }
}

async function storedDestinationTotal(tx: CoreTransaction, operation: PendingOrLaterOperation) {
  const { keepSecrets } = getSecretsFromSerializedOutputData(operation.outputData);
  const proofs = await tx.proofs.getProofsBySecrets(operation.mintUrl, keepSecrets);
  if (proofs.length !== keepSecrets.length)
    throw new MintSwapInvariantError('recovery_material', 'proofs_missing', 'destination');
  for (let index = 0; index < keepSecrets.length; index++) {
    const proof = proofs.find((value) => value.secret === keepSecrets[index]);
    const output = operation.outputData.keep[index]!;
    if (
      !proof ||
      proof.id !== output.blindedMessage.id ||
      !proof.amount.equals(Amount.from(output.blindedMessage.amount)) ||
      proof.unit !== operation.unit ||
      (proof.createdByOperationId != null && proof.createdByOperationId !== operation.id)
    )
      throw new MintSwapInvariantError(
        'destination_completion',
        'proof_total_mismatch',
        'destination',
      );
  }
  return Amount.sum(proofs.map((proof) => proof.amount));
}

export const reconcileMintSwap = defineTransition<{ id: string; now: number }, MintSwapOperation>(
  async (tx, input) => reconcile(tx, await requireParent(tx, input.id), input.now),
);

export const deferMintSwap = defineTransition<
  {
    id: string;
    now: number;
    random: number;
    error: Omit<MintSwapRetryError, 'at'>;
    retryAfter?: number;
  },
  MintSwapOperation
>(async (tx, input) => {
  const parent = await requireParent(tx, input.id);
  const next = scheduleMintSwapRetry(
    parent,
    input.error,
    input.now,
    input.random,
    input.retryAfter,
  );
  return next === parent ? parent : save(tx, parent, next);
});

/** Reconciliation distrusts summary fields until the exact historical proof records agree. */
async function verifySourceSettlement(
  tx: CoreTransaction,
  source: FinalizedMeltOperation,
  quote: MeltQuote,
) {
  const originals = await tx.proofs.getProofsBySecrets(source.mintUrl, source.inputProofSecrets);
  if (originals.length !== source.inputProofSecrets.length)
    throw new MintSwapInvariantError('recovery_material', 'proofs_missing', 'source');
  if (
    originals.some((proof) => proof.state !== 'spent' || proof.unit !== source.unit) ||
    !Amount.sum(originals.map((proof) => proof.amount)).equals(source.inputAmount)
  )
    throw new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source');
  if (source.swapOutputData) {
    const secrets = getSecretsFromSerializedOutputData(source.swapOutputData);
    for (const kind of ['keep', 'send'] as const) {
      const expected = kind === 'keep' ? secrets.keepSecrets : secrets.sendSecrets;
      const proofs = await tx.proofs.getProofsBySecrets(source.mintUrl, expected);
      if (proofs.length !== expected.length)
        throw new MintSwapInvariantError('recovery_material', 'proofs_missing', 'source');
      for (let index = 0; index < expected.length; index++) {
        const proof = proofs.find((value) => value.secret === expected[index]);
        const output = source.swapOutputData[kind][index]!;
        if (
          !proof ||
          proof.id !== output.blindedMessage.id ||
          !proof.amount.equals(Amount.from(output.blindedMessage.amount)) ||
          proof.unit !== source.unit ||
          (proof.createdByOperationId != null && proof.createdByOperationId !== source.id) ||
          (kind === 'send' && proof.state !== 'spent')
        )
          throw new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source');
      }
    }
  }
  if (!Array.isArray(quote.change))
    throw new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source');
  const secrets = getSecretsFromSerializedOutputData(source.changeOutputData).keepSecrets.slice(
    0,
    quote.change.length,
  );
  const change = await tx.proofs.getProofsBySecrets(source.mintUrl, secrets);
  if (change.length !== quote.change.length)
    throw new MintSwapInvariantError('recovery_material', 'proofs_missing', 'source');
  for (let index = 0; index < secrets.length; index++) {
    const proof = change.find((value) => value.secret === secrets[index]);
    const signature = quote.change[index]!;
    if (
      !proof ||
      proof.id !== signature.id ||
      !proof.amount.equals(Amount.from(signature.amount)) ||
      (proof.createdByOperationId != null && proof.createdByOperationId !== source.id) ||
      proof.unit !== source.unit
    )
      throw new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source');
  }
  if (!Amount.sum(change.map((proof) => proof.amount)).equals(source.changeAmount!))
    throw new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source');
}

export const flagMintSwapAttention = defineTransition<
  { id: string; now: number; error: MintSwapInvariantError },
  MintSwapOperation
>(async (tx, input) => {
  const parent = await requireParent(tx, input.id);
  return quiescent(parent) ? parent : markAttention(tx, parent, input.error, input.now);
});
