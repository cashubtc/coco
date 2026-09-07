import { Amount } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deserializeAmount, normalizeMintUrl } from '../../utils.ts';
import { isMintSwapAutomaticState } from './MintSwapOperation.ts';
import type {
  LastSafeCheckpoint,
  MintSwapAttention,
  MintSwapFailure,
  MintSwapOperation,
  MintSwapOperationState,
  MintSwapRetryError,
  MintSwapRetryState,
  ValueNeutralExitEvidence,
} from './MintSwapOperation.ts';

const STATES = [
  'preparing',
  'prepared',
  'source_pending',
  'destination_funded',
  'destination_pending',
  'completed',
  'cancelled',
  'failed',
  'needs_attention',
] as const;

const PREPARED_FIELDS = ['sourceDebitBounds'];
const SOURCE_FIELDS = [...PREPARED_FIELDS, 'sourceStartedAt'];
const FUNDED_FIELDS = [...SOURCE_FIELDS, 'sourceSettlement'];
const DESTINATION_FIELDS = [...FUNDED_FIELDS, 'destinationStartedAt'];
const STATE_FIELDS: Record<MintSwapOperationState, readonly string[]> = {
  preparing: [],
  prepared: PREPARED_FIELDS,
  source_pending: SOURCE_FIELDS,
  destination_funded: FUNDED_FIELDS,
  destination_pending: DESTINATION_FIELDS,
  completed: [...DESTINATION_FIELDS, 'destinationCompletion', 'completedAt'],
  cancelled: ['lastSafe', 'valueNeutral', 'cancelledAt'],
  failed: ['lastSafe', 'valueNeutral', 'failure', 'failedAt'],
  needs_attention: ['lastSafe', 'attention', 'attentionAt'],
};

/** Reject an invalid persisted fact without copying its potentially sensitive value into the error. */
function check(condition: boolean, field: string): asserts condition {
  // Never interpolate rejected values or unknown property names into diagnostics.
  if (!condition) throw new TypeError(`Invalid Mint Swap ${field}`);
}

/** Narrow persisted input to a plain record before reading any domain fields from it. */
function object(value: unknown): Record<string, unknown> {
  check(typeof value === 'object' && value !== null && !Array.isArray(value), 'record');
  check(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'record',
  );
  return value as Record<string, unknown>;
}

/** Require the exact persisted keys for a state so stale or foreign data cannot be ignored. */
function fields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  check(
    required.every((key) => Object.hasOwn(value, key)),
    'required fields',
  );
  check(
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
    'fields',
  );
}

/** Narrow a persisted string to one member of a closed domain vocabulary. */
function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const result = choices.find((item) => item === value);
  check(result !== undefined, field);
  return result;
}

/** Parse persistence metadata that must be a nonnegative safe integer. */
function integer(value: unknown, field: string): number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, field);
  return value;
}

/** Parse a local Unix-millisecond timestamp within its established lifecycle bounds. */
function time(value: unknown, minimum: number, maximum: number, field: string): number {
  const result = integer(value, field);
  check(minimum <= result && result <= maximum, field);
  return result;
}

/** Parse an opaque, nonempty identity without silently trimming it. */
function id(value: unknown): string {
  check(typeof value === 'string' && value.length > 0 && value.trim() === value, 'identity');
  return value;
}

/** Normalize an unknown mint URL through Coco's shared URL identity boundary. */
function mintUrl(value: unknown): string {
  try {
    return normalizeMintUrl(id(value));
  } catch {
    throw new TypeError('Invalid Mint Swap mint URL');
  }
}

/** Reconstruct a defensive Amount and optionally require a value greater than zero. */
function amount(value: unknown, positive = false): Amount {
  let result: Amount;
  try {
    // Amount.from(), through deserializeAmount(), owns representation, sign, integer, and safe-number
    // validation. Existing Amount instances are converted first so reads return independent values.
    result = deserializeAmount(
      value instanceof Amount
        ? value.toBigInt()
        : (value as Parameters<typeof deserializeAmount>[0]),
    );
  } catch {
    throw new TypeError('Invalid Mint Swap amount');
  }
  check(!positive || !result.isZero(), 'positive amount');
  return result;
}

/**
 * Parse a SHA-256 payment-request digest into its canonical lowercase hex representation.
 * A string must contain exactly 64 lowercase hexadecimal characters (32 bytes); adapters may also
 * hydrate the same digest as a 32-byte Uint8Array or integer array.
 */
function paymentRequestHash(value: unknown): string {
  if (typeof value === 'string') {
    check(/^[0-9a-f]{64}$/.test(value), 'payment request hash');
    return value;
  }
  // Adapters may hydrate a binary digest; V1 stores only its canonical hex representation.
  check(value instanceof Uint8Array || Array.isArray(value), 'payment request hash');
  check(value.length === 32, 'payment request hash');
  const bytes: number[] = Array.from(value);
  check(
    bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    'digest bytes',
  );
  return bytesToHex(Uint8Array.from(bytes));
}

/** Parse a BOLT11 quote reference and bind its normalized mint URL to the expected leg. */
function quote(value: unknown, expectedMintUrl: string) {
  const record = object(value);
  fields(record, ['mintUrl', 'method', 'quoteId']);
  const url = mintUrl(record.mintUrl);
  check(url === expectedMintUrl, 'quote role');
  return {
    mintUrl: url,
    method: choice(record.method, ['bolt11'] as const, 'quote method'),
    quoteId: id(record.quoteId),
  };
}

/** Parse bounded retry diagnostics without retaining raw remote errors or protocol data. */
function retryError(value: unknown, lastAttemptAt: number, updatedAt: number): MintSwapRetryError {
  const record = object(value);
  fields(record, ['category', 'code', 'at']);
  const category = choice(
    record.category,
    ['waiting', 'transient', 'ambiguous'] as const,
    'retry category',
  );
  const at = time(record.at, lastAttemptAt, updatedAt, 'retry error time');
  switch (category) {
    case 'waiting':
      return {
        category,
        at,
        code: choice(
          record.code,
          ['child_pending', 'source_pending', 'destination_pending'] as const,
          'retry code',
        ),
      };
    case 'transient':
      return {
        category,
        at,
        code: choice(
          record.code,
          ['remote_unavailable', 'local_unavailable'] as const,
          'retry code',
        ),
      };
    case 'ambiguous':
      return {
        category,
        at,
        code: choice(
          record.code,
          ['source_outcome_unknown', 'destination_outcome_unknown'] as const,
          'retry code',
        ),
      };
  }
}

/** Parse retry scheduling and enforce automatic versus quiescent state semantics. */
function retry(
  value: unknown,
  state: MintSwapOperationState,
  enteredAt: number,
  updatedAt: number,
): MintSwapRetryState {
  const record = object(value);
  fields(record, ['attemptCount', 'lastAttemptAt', 'nextAttemptAt', 'lastError']);
  const attemptCount = integer(record.attemptCount, 'retry attempt count');
  const nextAttemptAt =
    record.nextAttemptAt === null ? null : integer(record.nextAttemptAt, 'next attempt time');
  if (!isMintSwapAutomaticState(state)) {
    check(nextAttemptAt === null && attemptCount === 0, 'quiescent retry');
  } else {
    check(nextAttemptAt !== null && nextAttemptAt >= enteredAt, 'automatic retry');
  }
  if (attemptCount === 0) {
    check(record.lastAttemptAt === null && record.lastError === null, 'initial retry');
    check(nextAttemptAt === null || nextAttemptAt === enteredAt, 'initial due time');
    return { attemptCount, lastAttemptAt: null, nextAttemptAt, lastError: null };
  }
  const lastAttemptAt = time(record.lastAttemptAt, enteredAt, updatedAt, 'last attempt time');
  const lastError = retryError(record.lastError, lastAttemptAt, updatedAt);
  check(nextAttemptAt !== null && nextAttemptAt >= lastError.at, 'retry schedule');
  return { attemptCount, lastAttemptAt, nextAttemptAt, lastError };
}

interface ProgressContext {
  createdAt: number;
  stateEnteredAt: number;
  destinationAmount: Amount;
  sourceDebitCap?: Amount;
}

/** Parse and validate the source debit bounds established by successful preparation. */
function prepared(record: Record<string, unknown>, context: ProgressContext) {
  const bounds = object(record.sourceDebitBounds);
  fields(bounds, ['minimum', 'maximum', 'reserved']);
  const sourceDebitBounds = {
    minimum: amount(bounds.minimum),
    maximum: amount(bounds.maximum),
    reserved: amount(bounds.reserved),
  };
  const { minimum, maximum, reserved } = sourceDebitBounds;
  check(context.destinationAmount.lessThanOrEqual(minimum), 'minimum debit');
  check(minimum.lessThanOrEqual(maximum), 'maximum debit');
  check(maximum.lessThanOrEqual(reserved), 'reserved debit');
  check(
    !context.sourceDebitCap || maximum.lessThanOrEqual(context.sourceDebitCap),
    'source debit cap',
  );
  return { sourceDebitBounds };
}

/** Parse prepared facts plus the timestamp committed before source execution. */
function sourcePending(record: Record<string, unknown>, context: ProgressContext) {
  return {
    ...prepared(record, context),
    sourceStartedAt: time(
      record.sourceStartedAt,
      context.createdAt,
      context.stateEnteredAt,
      'source start',
    ),
  };
}

/** Parse paid-source evidence and verify the exact debit and fee equations. */
function funded(record: Record<string, unknown>, context: ProgressContext) {
  const source = sourcePending(record, context);
  const settlement = object(record.sourceSettlement);
  fields(settlement, ['reserved', 'returned', 'finalDebit', 'totalFee', 'sourcePaidObservedAt']);
  const sourceSettlement = {
    reserved: amount(settlement.reserved),
    returned: amount(settlement.returned),
    finalDebit: amount(settlement.finalDebit),
    totalFee: amount(settlement.totalFee),
    sourcePaidObservedAt: time(
      settlement.sourcePaidObservedAt,
      source.sourceStartedAt,
      context.stateEnteredAt,
      'source payment observation',
    ),
  };
  const { reserved, returned, finalDebit, totalFee } = sourceSettlement;
  check(reserved.equals(source.sourceDebitBounds.reserved), 'settlement reservation');
  check(returned.lessThanOrEqual(reserved), 'settlement return');
  check(reserved.subtract(returned).equals(finalDebit), 'net source debit');
  check(context.destinationAmount.add(totalFee).equals(finalDebit), 'total source fee');
  check(
    finalDebit.inRange(source.sourceDebitBounds.minimum, source.sourceDebitBounds.maximum),
    'final debit bounds',
  );
  return { ...source, sourceSettlement };
}

/** Parse funded facts plus the timestamp committed before destination issuance. */
function destinationPending(record: Record<string, unknown>, context: ProgressContext) {
  const source = funded(record, context);
  return {
    ...source,
    destinationStartedAt: time(
      record.destinationStartedAt,
      source.sourceSettlement.sourcePaidObservedAt,
      context.stateEnteredAt,
      'destination start',
    ),
  };
}

/** Reconstruct a non-recursive snapshot of the last automatic state and its established facts. */
function checkpoint(value: unknown, context: ProgressContext): LastSafeCheckpoint {
  const record = object(value);
  const state = choice(
    record.state,
    [
      'preparing',
      'prepared',
      'source_pending',
      'destination_funded',
      'destination_pending',
    ] as const,
    'last safe state',
  );
  fields(record, ['state', 'stateEnteredAt', ...STATE_FIELDS[state]]);
  const stateEnteredAt = time(
    record.stateEnteredAt,
    context.createdAt,
    context.stateEnteredAt,
    'checkpoint time',
  );
  const priorContext = { ...context, stateEnteredAt };
  switch (state) {
    case 'preparing':
      check(stateEnteredAt === context.createdAt, 'preparing entry time');
      return { state, stateEnteredAt };
    case 'prepared':
      return { state, stateEnteredAt, ...prepared(record, priorContext) };
    case 'source_pending': {
      const facts = sourcePending(record, priorContext);
      check(facts.sourceStartedAt === stateEnteredAt, 'source authorization time');
      return { state, stateEnteredAt, ...facts };
    }
    case 'destination_funded':
      return { state, stateEnteredAt, ...funded(record, priorContext) };
    case 'destination_pending': {
      const facts = destinationPending(record, priorContext);
      check(facts.destinationStartedAt === stateEnteredAt, 'destination authorization time');
      return { state, stateEnteredAt, ...facts };
    }
  }
}

/** Parse evidence proving that cancellation or failure did not transfer source value. */
function valueNeutral(
  value: unknown,
  lastSafe: LastSafeCheckpoint,
  enteredAt: number,
): ValueNeutralExitEvidence {
  const record = object(value);
  fields(record, ['sourcePayment', 'sourceProofs', 'verifiedAt']);
  const sourcePayment = choice(
    record.sourcePayment,
    ['not_authorized', 'confirmed_unpaid'] as const,
    'value-neutral payment',
  );
  const sourceProofs = choice(
    record.sourceProofs,
    ['not_reserved', 'released'] as const,
    'value-neutral proofs',
  );
  check(lastSafe.state !== 'prepared' || sourceProofs === 'released', 'prepared proof release');
  check(
    lastSafe.state !== 'source_pending' ||
      (sourcePayment === 'confirmed_unpaid' && sourceProofs === 'released'),
    'pending source exit',
  );
  return {
    sourcePayment,
    sourceProofs,
    verifiedAt: time(record.verifiedAt, lastSafe.stateEnteredAt, enteredAt, 'exit evidence time'),
  };
}

/** Parse a deterministic failure from the bounded V1 failure vocabulary. */
function failure(value: unknown): MintSwapFailure {
  const record = object(value);
  fields(record, ['code']);
  return {
    code: choice(
      record.code,
      ['preparation_rejected', 'source_payment_rejected', 'source_debit_cap_exceeded'] as const,
      'failure code',
    ),
  };
}

/** Parse bounded evidence explaining why automatic economic recovery must stop. */
function attention(
  value: unknown,
  lastSafe: LastSafeCheckpoint,
  enteredAt: number,
): MintSwapAttention {
  const record = object(value);
  fields(record, ['reason', 'invariant', 'evidence']);
  const evidence = object(record.evidence);
  fields(evidence, ['code', 'leg', 'observedAt']);
  return {
    reason: choice(
      record.reason,
      ['contradictory_evidence', 'missing_recovery_material'] as const,
      'attention reason',
    ),
    invariant: choice(
      record.invariant,
      [
        'child_identity',
        'quote_identity',
        'payment_request',
        'source_debit',
        'source_settlement',
        'destination_completion',
        'recovery_material',
      ] as const,
      'attention invariant',
    ),
    evidence: {
      code: choice(
        evidence.code,
        [
          'child_missing',
          'child_conflict',
          'quote_missing',
          'quote_conflict',
          'invoice_mismatch',
          'debit_bounds_mismatch',
          'settlement_mismatch',
          'proof_total_mismatch',
          'key_missing',
          'outputs_missing',
          'proofs_missing',
        ] as const,
        'attention evidence',
      ),
      leg: choice(evidence.leg, ['source', 'destination'] as const, 'attention leg'),
      observedAt: time(
        evidence.observedAt,
        lastSafe.stateEnteredAt,
        enteredAt,
        'attention evidence time',
      ),
    },
  };
}

/**
 * Hydrate V1 persisted data into a validated, independent parent snapshot.
 * Validates only parent-local facts; the coordinator must verify canonical child/quote/proof records.
 * Unknown fields are rejected, including child recovery material and unbounded diagnostics.
 */
export function parseMintSwapOperation(value: unknown): MintSwapOperation {
  const record = object(value);
  const state = choice(record.state, STATES, 'state');
  fields(
    record,
    [
      'schemaVersion',
      'id',
      'revision',
      'state',
      'sourceMintUrl',
      'destinationMintUrl',
      'unit',
      'destinationAmount',
      'sourceQuote',
      'destinationQuote',
      'sourceOperationId',
      'destinationOperationId',
      'paymentRequestHash',
      'createdAt',
      'updatedAt',
      'stateEnteredAt',
      'retry',
      ...STATE_FIELDS[state],
    ],
    ['sourceDebitCap', 'cancellationRequestedAt'],
  );
  check(record.schemaVersion === 1, 'schema version');
  const sourceMintUrl = mintUrl(record.sourceMintUrl);
  const destinationMintUrl = mintUrl(record.destinationMintUrl);
  check(sourceMintUrl !== destinationMintUrl, 'distinct mints');
  const createdAt = integer(record.createdAt, 'creation time');
  const updatedAt = integer(record.updatedAt, 'update time');
  const stateEnteredAt = time(record.stateEnteredAt, createdAt, updatedAt, 'state entry time');
  const destinationAmount = amount(record.destinationAmount, true);
  const sourceDebitCap =
    record.sourceDebitCap === undefined ? undefined : amount(record.sourceDebitCap, true);
  check(!sourceDebitCap || destinationAmount.lessThanOrEqual(sourceDebitCap), 'intent debit cap');
  const cancellationRequestedAt =
    record.cancellationRequestedAt === undefined
      ? undefined
      : time(record.cancellationRequestedAt, createdAt, updatedAt, 'cancellation request time');

  const base = {
    schemaVersion: 1 as const,
    id: id(record.id),
    revision: integer(record.revision, 'revision'),
    sourceMintUrl,
    destinationMintUrl,
    unit: choice(record.unit, ['sat'] as const, 'unit'),
    destinationAmount,
    ...(sourceDebitCap === undefined ? {} : { sourceDebitCap }),
    sourceQuote: quote(record.sourceQuote, sourceMintUrl),
    destinationQuote: quote(record.destinationQuote, destinationMintUrl),
    sourceOperationId: id(record.sourceOperationId),
    destinationOperationId: id(record.destinationOperationId),
    paymentRequestHash: paymentRequestHash(record.paymentRequestHash),
    createdAt,
    updatedAt,
    stateEnteredAt,
    retry: retry(record.retry, state, stateEnteredAt, updatedAt),
    ...(cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt }),
  };

  let result: MintSwapOperation;
  switch (state) {
    /**
     * The durable parent exists before either child is prepared, allowing recovery to resume the
     * exact preassigned child identities after an interruption.
     */
    case 'preparing':
      check(stateEnteredAt === createdAt, 'preparing entry time');
      result = { ...base, state };
      break;
    /**
     * Both child preparations have established the source debit bounds. This state remains
     * quiescent until the caller explicitly authorizes source execution.
     */
    case 'prepared':
      result = { ...base, state, ...prepared(record, base) };
      break;
    /**
     * Source execution has been authorized and durably timestamped. Recovery must reconcile the
     * exact Melt child before it retries or decides whether a value-neutral exit is possible.
     */
    case 'source_pending': {
      const facts = sourcePending(record, base);
      check(facts.sourceStartedAt === stateEnteredAt, 'source authorization time');
      result = { ...base, state, ...facts };
      break;
    }
    /**
     * The source payment is proven paid and its exact settlement is recorded. Recovery is now
     * forward-only and must continue toward destination issuance.
     */
    case 'destination_funded':
      result = { ...base, state, ...funded(record, base) };
      break;
    /**
     * Destination issuance has been authorized and durably timestamped. Recovery reconciles the
     * exact Mint child and its persisted outputs or proofs.
     */
    case 'destination_pending': {
      const facts = destinationPending(record, base);
      check(facts.destinationStartedAt === stateEnteredAt, 'destination authorization time');
      result = { ...base, state, ...facts };
      break;
    }
    /**
     * Destination quote accounting and locally stored, verified proofs both equal the requested
     * amount, completing the parent without copying child proof material into it.
     */
    case 'completed': {
      const facts = destinationPending(record, base);
      const completion = object(record.destinationCompletion);
      fields(completion, ['quoteAmountIssued', 'storedProofAmount', 'proofsVerifiedAt']);
      const destinationCompletion = {
        quoteAmountIssued: amount(completion.quoteAmountIssued),
        storedProofAmount: amount(completion.storedProofAmount),
        proofsVerifiedAt: time(
          completion.proofsVerifiedAt,
          facts.destinationStartedAt,
          stateEnteredAt,
          'proof verification time',
        ),
      };
      check(
        destinationCompletion.quoteAmountIssued.equals(destinationAmount),
        'quote issued total',
      );
      check(
        destinationCompletion.storedProofAmount.equals(destinationAmount),
        'stored proof total',
      );
      result = {
        ...base,
        state,
        ...facts,
        destinationCompletion,
        completedAt: time(record.completedAt, stateEnteredAt, stateEnteredAt, 'completion time'),
      };
      break;
    }
    /**
     * A recorded caller request ended the operation before source value moved. Cancellation shares
     * the value-neutral checkpoint parser below with deterministic failure.
     */
    case 'cancelled':
    /**
     * A deterministic rejection ended the operation before source value moved. Both terminal paths
     * require an exact pre-payment checkpoint and evidence that payment and proofs are neutral.
     */
    case 'failed': {
      const lastSafe = checkpoint(record.lastSafe, base);
      check(
        lastSafe.state === 'preparing' ||
          lastSafe.state === 'prepared' ||
          lastSafe.state === 'source_pending',
        'value-neutral checkpoint',
      );
      const evidence = valueNeutral(record.valueNeutral, lastSafe, stateEnteredAt);
      if (state === 'cancelled') {
        check(
          cancellationRequestedAt !== undefined && cancellationRequestedAt <= stateEnteredAt,
          'cancellation intent',
        );
        result = {
          ...base,
          state,
          lastSafe,
          valueNeutral: evidence,
          cancellationRequestedAt,
          cancelledAt: time(
            record.cancelledAt,
            stateEnteredAt,
            stateEnteredAt,
            'cancellation time',
          ),
        };
      } else {
        result = {
          ...base,
          state,
          lastSafe,
          valueNeutral: evidence,
          failure: failure(record.failure),
          failedAt: time(record.failedAt, stateEnteredAt, stateEnteredAt, 'failure time'),
        };
      }
      break;
    }
    /**
     * Contradictory evidence or missing recovery material makes another automatic economic action
     * unsafe, so the parent retains its last safe checkpoint for explicit repair.
     */
    case 'needs_attention': {
      const lastSafe = checkpoint(record.lastSafe, base);
      result = {
        ...base,
        state,
        lastSafe,
        attention: attention(record.attention, lastSafe, stateEnteredAt),
        attentionAt: time(record.attentionAt, stateEnteredAt, stateEnteredAt, 'attention time'),
      };
      break;
    }
  }
  const progress = result.lastSafe ?? result;
  if (cancellationRequestedAt !== undefined && result.lastSafe !== undefined) {
    check(cancellationRequestedAt <= stateEnteredAt, 'quiescent cancellation request');
  }
  if (cancellationRequestedAt !== undefined && progress.sourceSettlement !== undefined) {
    check(
      cancellationRequestedAt <= progress.sourceSettlement.sourcePaidObservedAt,
      'post-payment cancellation request',
    );
  }
  return result;
}
