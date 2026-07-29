import { Amount } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { normalizeMintUrl } from '../../utils';

export type MintSwapOperationState =
  | 'preparing'
  | 'prepared'
  | 'source_inflight'
  | 'destination_funded'
  | 'issuing'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'needs_attention';

export type MintSwapAttentionReason =
  | 'ownership_conflict'
  | 'prepared_plan_mismatch'
  | 'source_paid_destination_terminal'
  | 'destination_issued_source_not_paid'
  | 'destination_proofs_unrecoverable'
  | 'source_reclamation_unproven'
  | 'accounting_mismatch'
  | 'canonical_observation_conflict'
  | 'required_recovery_capability_missing'
  | 'missing_post_effect_recovery_material';

export type MintSwapEventType =
  | 'mint-swap-op:prepared'
  | 'mint-swap-op:source-inflight'
  | 'mint-swap-op:destination-funded'
  | 'mint-swap-op:issuing'
  | 'mint-swap-op:completed'
  | 'mint-swap-op:cancelled'
  | 'mint-swap-op:failed'
  | 'mint-swap-op:needs-attention'
  | 'mint-swap-op:delayed';

export interface MintSwapQuoteRef {
  mintUrl: string;
  method: 'bolt11';
  quoteId: string;
}

export interface MintSwapNut20KeyRef {
  publicKey: string;
  derivationIndex: number;
}

export interface MintSwapPreparedPlan {
  fingerprint: string;
  dispatchDeadline: number;
  requiredDispatchWindowSeconds: number;
  sourceMeltAmount: Amount;
  sourceFeeReserve: Amount;
  sourcePreparationFee: Amount;
  sourceMeltInputFee: Amount;
  minimumSourceDebit: Amount;
  maximumSourceDebit: Amount;
  reservedSourceAmount: Amount;
}

export interface MintSwapSettlement {
  sourcePaymentFee: Amount;
  totalSourceFee: Amount;
  sourceMeltChangeAmount: Amount;
  sourceKeepAmount: Amount;
  sourceReturnedAmount: Amount;
  finalSourceDebit: Amount;
  destinationAmountIssued?: Amount;
}

export interface MintSwapRetry {
  attemptCount: number;
  nextAttemptAt?: number;
  lastAttemptAt?: number;
  lastSuccessfulObservationAt?: number;
  lastError?: string;
}

export interface MintSwapAttentionRecord {
  reason: MintSwapAttentionReason;
  message: string;
  lastSafeState: MintSwapOperationState;
  violatedInvariant: string;
  evidence: Record<string, string | number | boolean | null>;
  at: number;
}

export interface MintSwapTerminalFailure {
  code: string;
  reason: string;
  at: number;
}

export interface MintSwapOperation {
  id: string;
  state: MintSwapOperationState;
  revision: number;
  sourceMintUrl: string;
  destinationMintUrl: string;
  unit: 'sat';
  destinationAmount: Amount;
  destinationQuoteRef?: MintSwapQuoteRef;
  destinationMintOperationId?: string;
  sourceQuoteRef?: MintSwapQuoteRef;
  sourceMeltOperationId?: string;
  destinationNut20Key?: MintSwapNut20KeyRef;
  preparedPlan?: MintSwapPreparedPlan;
  settlement?: MintSwapSettlement;
  sourceDispatchAuthorizedAt?: number;
  destinationIssueAuthorizedAt?: number;
  cancellationRequestedAt?: number;
  cancelledAt?: number;
  retry: MintSwapRetry;
  attention?: MintSwapAttentionRecord;
  terminalFailure?: MintSwapTerminalFailure;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface MintSwapPreparedPlanFingerprintInput {
  destinationMintOperationId: string;
  sourceMeltOperationId: string;
  destinationQuoteRef: MintSwapQuoteRef;
  sourceQuoteRef: MintSwapQuoteRef;
  destinationAmount: Amount;
  unit: 'sat';
  sourceInputProofSecrets: readonly string[];
  destinationOutputData: unknown;
  sourceOutputData: unknown;
  maximumSourceDebit: Amount;
}

const TERMINAL_STATES = new Set<MintSwapOperationState>(['completed', 'cancelled', 'failed']);
const AUTOMATIC_STATES = new Set<MintSwapOperationState>([
  'preparing',
  'source_inflight',
  'destination_funded',
  'issuing',
]);

const PREPARED_PLAN_STATES = new Set<MintSwapOperationState>([
  'prepared',
  'source_inflight',
  'destination_funded',
  'issuing',
  'completed',
  'needs_attention',
]);

const TRANSITIONS: Record<MintSwapOperationState, ReadonlySet<MintSwapOperationState>> = {
  preparing: new Set(['prepared', 'cancelled', 'failed', 'needs_attention']),
  prepared: new Set(['source_inflight', 'cancelled', 'failed', 'needs_attention']),
  source_inflight: new Set(['destination_funded', 'cancelled', 'failed', 'needs_attention']),
  destination_funded: new Set(['issuing', 'completed', 'needs_attention']),
  issuing: new Set(['issuing', 'completed', 'needs_attention']),
  completed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
  needs_attention: new Set(['destination_funded', 'issuing', 'completed', 'cancelled', 'failed']),
};

export function isTerminalMintSwapState(state: MintSwapOperationState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isAutomaticMintSwapState(state: MintSwapOperationState): boolean {
  return AUTOMATIC_STATES.has(state);
}

export function canTransitionMintSwap(
  from: MintSwapOperationState,
  to: MintSwapOperationState,
): boolean {
  return from === to || TRANSITIONS[from].has(to);
}

export function assertMintSwapTransition(
  from: MintSwapOperationState,
  to: MintSwapOperationState,
): void {
  if (!canTransitionMintSwap(from, to)) {
    throw new Error(`Illegal mint swap transition: ${from} -> ${to}`);
  }
}

export function createMintSwapPreparedPlanFingerprint(
  input: MintSwapPreparedPlanFingerprintInput,
): string {
  const canonical = canonicalizeForFingerprint({
    ...input,
    destinationQuoteRef: normalizeQuoteRef(input.destinationQuoteRef),
    sourceQuoteRef: normalizeQuoteRef(input.sourceQuoteRef),
  });
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

export function validateMintSwapAccounting(operation: MintSwapOperation): void {
  const plan = operation.preparedPlan;
  const settlement = operation.settlement;
  if (!plan || !settlement) {
    throw new Error('Mint swap settlement requires a prepared plan');
  }

  const minimum = operation.destinationAmount
    .add(plan.sourcePreparationFee)
    .add(plan.sourceMeltInputFee);
  assertAmountEquals(plan.minimumSourceDebit, minimum, 'minimum source debit');

  const totalFee = plan.sourcePreparationFee
    .add(plan.sourceMeltInputFee)
    .add(settlement.sourcePaymentFee);
  assertAmountEquals(settlement.totalSourceFee, totalFee, 'total source fee');

  const debitFromFees = operation.destinationAmount.add(settlement.totalSourceFee);
  assertAmountEquals(settlement.finalSourceDebit, debitFromFees, 'final source debit from fees');

  const returned = settlement.sourceKeepAmount.add(settlement.sourceMeltChangeAmount);
  assertAmountEquals(settlement.sourceReturnedAmount, returned, 'source returned amount');

  if (settlement.sourceReturnedAmount.greaterThan(plan.reservedSourceAmount)) {
    throw new Error('Mint swap source returned amount exceeds reserved source amount');
  }
  const debitFromReturns = plan.reservedSourceAmount.subtract(settlement.sourceReturnedAmount);
  assertAmountEquals(
    settlement.finalSourceDebit,
    debitFromReturns,
    'final source debit from returned value',
  );

  if (settlement.finalSourceDebit.greaterThan(plan.maximumSourceDebit)) {
    throw new Error('Mint swap final source debit exceeds accepted maximum');
  }

  if (operation.state === 'completed') {
    if (!settlement.destinationAmountIssued) {
      throw new Error('Completed mint swap requires destination issued amount');
    }
    assertAmountEquals(
      settlement.destinationAmountIssued,
      operation.destinationAmount,
      'destination issued amount',
    );
  }
}

export function validateMintSwapOperation(operation: MintSwapOperation): MintSwapOperation {
  assertNonEmpty(operation.id, 'Mint swap id');
  assertTimestamp(operation.createdAt, 'Mint swap createdAt');
  assertTimestamp(operation.updatedAt, 'Mint swap updatedAt');
  if (operation.updatedAt < operation.createdAt) {
    throw new Error('Mint swap updatedAt cannot precede createdAt');
  }
  if (!Number.isSafeInteger(operation.revision) || operation.revision < 0) {
    throw new Error('Mint swap revision must be a non-negative safe integer');
  }

  const sourceMintUrl = normalizeMintUrl(operation.sourceMintUrl);
  const destinationMintUrl = normalizeMintUrl(operation.destinationMintUrl);
  if (sourceMintUrl === destinationMintUrl) {
    throw new Error('Mint swap source and destination mints must be distinct');
  }
  if (
    operation.sourceMintUrl !== sourceMintUrl ||
    operation.destinationMintUrl !== destinationMintUrl
  ) {
    throw new Error('Mint swap mint URLs must be normalized');
  }
  if (operation.unit !== 'sat') {
    throw new Error('Mint swap unit must be sat');
  }
  if (operation.destinationAmount.isZero()) {
    throw new Error('Mint swap destination amount must be positive');
  }

  validateRetry(operation.retry);
  validateQuoteRef(operation.destinationQuoteRef, destinationMintUrl, 'destination');
  validateQuoteRef(operation.sourceQuoteRef, sourceMintUrl, 'source');

  if (operation.destinationNut20Key) {
    assertNonEmpty(operation.destinationNut20Key.publicKey, 'Mint swap NUT-20 public key');
    if (
      !Number.isSafeInteger(operation.destinationNut20Key.derivationIndex) ||
      operation.destinationNut20Key.derivationIndex < 0
    ) {
      throw new Error('Mint swap NUT-20 derivation index must be a non-negative safe integer');
    }
  }

  if (PREPARED_PLAN_STATES.has(operation.state) || operation.preparedPlan) {
    requirePreparedFields(operation);
  }
  if (operation.state === 'source_inflight') {
    assertTimestamp(
      operation.sourceDispatchAuthorizedAt,
      'Mint swap source dispatch authorization',
    );
  }
  if (
    operation.state === 'destination_funded' ||
    operation.state === 'issuing' ||
    operation.state === 'completed'
  ) {
    assertTimestamp(
      operation.sourceDispatchAuthorizedAt,
      'Mint swap source dispatch authorization',
    );
    validateMintSwapAccounting(operation);
  }
  if (operation.state === 'issuing' || operation.state === 'completed') {
    assertTimestamp(
      operation.destinationIssueAuthorizedAt,
      'Mint swap destination issue authorization',
    );
  }
  if (operation.state === 'completed') {
    assertTimestamp(operation.completedAt, 'Mint swap completion time');
  }
  if (operation.state === 'cancelled') {
    assertTimestamp(operation.cancellationRequestedAt, 'Mint swap cancellation request');
    assertTimestamp(operation.cancelledAt, 'Mint swap cancellation completion');
  }
  if (operation.state === 'failed' && !operation.terminalFailure) {
    throw new Error('Failed mint swap requires terminal failure details');
  }
  if (operation.terminalFailure) {
    assertNonEmpty(operation.terminalFailure.code, 'Mint swap terminal failure code');
    assertNonEmpty(operation.terminalFailure.reason, 'Mint swap terminal failure reason');
    assertTimestamp(operation.terminalFailure.at, 'Mint swap terminal failure time');
  }
  if (operation.state === 'needs_attention' && !operation.attention) {
    throw new Error('Mint swap needing attention requires structured evidence');
  }
  if (operation.attention) {
    assertNonEmpty(operation.attention.message, 'Mint swap attention message');
    assertNonEmpty(operation.attention.violatedInvariant, 'Mint swap violated invariant');
    assertTimestamp(operation.attention.at, 'Mint swap attention time');
  }

  return operation;
}

export function assertPreparedMintSwapImmutable(
  current: MintSwapOperation,
  next: MintSwapOperation,
): void {
  if (!current.preparedPlan) return;
  const fields: Array<[unknown, unknown, string]> = [
    [current.sourceMintUrl, next.sourceMintUrl, 'source mint URL'],
    [current.destinationMintUrl, next.destinationMintUrl, 'destination mint URL'],
    [current.unit, next.unit, 'unit'],
    [current.destinationAmount.toString(), next.destinationAmount.toString(), 'destination amount'],
    [current.destinationMintOperationId, next.destinationMintOperationId, 'destination child'],
    [current.sourceMeltOperationId, next.sourceMeltOperationId, 'source child'],
    [
      quoteRefKey(current.destinationQuoteRef),
      quoteRefKey(next.destinationQuoteRef),
      'destination quote',
    ],
    [quoteRefKey(current.sourceQuoteRef), quoteRefKey(next.sourceQuoteRef), 'source quote'],
    [current.preparedPlan.fingerprint, next.preparedPlan?.fingerprint, 'prepared fingerprint'],
    [
      current.preparedPlan.dispatchDeadline,
      next.preparedPlan?.dispatchDeadline,
      'dispatch deadline',
    ],
    [
      current.preparedPlan.requiredDispatchWindowSeconds,
      next.preparedPlan?.requiredDispatchWindowSeconds,
      'dispatch window',
    ],
    [
      current.preparedPlan.sourceMeltAmount.toString(),
      next.preparedPlan?.sourceMeltAmount.toString(),
      'source melt amount',
    ],
    [
      current.preparedPlan.sourceFeeReserve.toString(),
      next.preparedPlan?.sourceFeeReserve.toString(),
      'source fee reserve',
    ],
    [
      current.preparedPlan.sourcePreparationFee.toString(),
      next.preparedPlan?.sourcePreparationFee.toString(),
      'source preparation fee',
    ],
    [
      current.preparedPlan.sourceMeltInputFee.toString(),
      next.preparedPlan?.sourceMeltInputFee.toString(),
      'source melt input fee',
    ],
    [
      current.preparedPlan.minimumSourceDebit.toString(),
      next.preparedPlan?.minimumSourceDebit.toString(),
      'minimum source debit',
    ],
    [
      current.preparedPlan.maximumSourceDebit.toString(),
      next.preparedPlan?.maximumSourceDebit.toString(),
      'maximum source debit',
    ],
    [
      current.preparedPlan.reservedSourceAmount.toString(),
      next.preparedPlan?.reservedSourceAmount.toString(),
      'reserved source amount',
    ],
  ];
  const changed = fields.find(([left, right]) => left !== right);
  if (changed) {
    throw new Error(`Prepared mint swap ${changed[2]} is immutable`);
  }
}

function requirePreparedFields(operation: MintSwapOperation): void {
  if (
    !operation.destinationQuoteRef ||
    !operation.destinationMintOperationId ||
    !operation.sourceQuoteRef ||
    !operation.sourceMeltOperationId ||
    !operation.destinationNut20Key ||
    !operation.preparedPlan
  ) {
    throw new Error(`Mint swap state ${operation.state} requires a complete prepared plan`);
  }
  assertNonEmpty(operation.destinationMintOperationId, 'Mint swap destination child id');
  assertNonEmpty(operation.sourceMeltOperationId, 'Mint swap source child id');
  assertNonEmpty(operation.preparedPlan.fingerprint, 'Mint swap prepared fingerprint');
  const plan = operation.preparedPlan;
  assertTimestamp(plan.dispatchDeadline, 'Mint swap dispatch deadline');
  if (
    !Number.isSafeInteger(plan.requiredDispatchWindowSeconds) ||
    plan.requiredDispatchWindowSeconds < 30
  ) {
    throw new Error('Mint swap required dispatch window must be at least 30 seconds');
  }
  for (const [name, amount] of Object.entries({
    sourceFeeReserve: plan.sourceFeeReserve,
    sourceMeltAmount: plan.sourceMeltAmount,
    sourcePreparationFee: plan.sourcePreparationFee,
    sourceMeltInputFee: plan.sourceMeltInputFee,
    minimumSourceDebit: plan.minimumSourceDebit,
    maximumSourceDebit: plan.maximumSourceDebit,
    reservedSourceAmount: plan.reservedSourceAmount,
  })) {
    Amount.from(amount);
    if (amount.toString().startsWith('-')) {
      throw new Error(`Mint swap ${name} cannot be negative`);
    }
  }
  const minimum = operation.destinationAmount
    .add(plan.sourcePreparationFee)
    .add(plan.sourceMeltInputFee);
  assertAmountEquals(plan.minimumSourceDebit, minimum, 'minimum source debit');
  assertAmountEquals(plan.sourceMeltAmount, operation.destinationAmount, 'source melt amount');
  if (plan.maximumSourceDebit.lessThan(plan.minimumSourceDebit)) {
    throw new Error('Mint swap maximum source debit is below minimum source debit');
  }
  if (plan.maximumSourceDebit.greaterThan(plan.reservedSourceAmount)) {
    throw new Error('Mint swap maximum source debit exceeds reserved source amount');
  }
}

function validateRetry(retry: MintSwapRetry): void {
  if (!retry || !Number.isSafeInteger(retry.attemptCount) || retry.attemptCount < 0) {
    throw new Error('Mint swap retry attempt count must be a non-negative safe integer');
  }
  for (const [name, value] of Object.entries({
    nextAttemptAt: retry.nextAttemptAt,
    lastAttemptAt: retry.lastAttemptAt,
    lastSuccessfulObservationAt: retry.lastSuccessfulObservationAt,
  })) {
    if (value !== undefined) assertTimestamp(value, `Mint swap retry ${name}`);
  }
}

function validateQuoteRef(
  ref: MintSwapQuoteRef | undefined,
  expectedMintUrl: string,
  role: string,
): void {
  if (!ref) return;
  if (ref.method !== 'bolt11') {
    throw new Error(`Mint swap ${role} quote method must be bolt11`);
  }
  if (normalizeMintUrl(ref.mintUrl) !== expectedMintUrl || ref.mintUrl !== expectedMintUrl) {
    throw new Error(`Mint swap ${role} quote mint URL does not match its leg`);
  }
  assertNonEmpty(ref.quoteId, `Mint swap ${role} quote id`);
}

function normalizeQuoteRef(ref: MintSwapQuoteRef): MintSwapQuoteRef {
  return { ...ref, mintUrl: normalizeMintUrl(ref.mintUrl) };
}

function quoteRefKey(ref?: MintSwapQuoteRef): string | undefined {
  return ref ? `${ref.mintUrl}\u0000${ref.method}\u0000${ref.quoteId}` : undefined;
}

function assertAmountEquals(actual: Amount, expected: Amount, name: string): void {
  if (!actual.equals(expected)) {
    throw new Error(`Mint swap ${name} does not reconcile`);
  }
}

function assertTimestamp(value: number | undefined, name: string): void {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative Unix-millisecond timestamp`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} cannot be empty`);
}

function canonicalizeForFingerprint(value: unknown): string {
  if (value instanceof Amount) return JSON.stringify(value.toString());
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeForFingerprint(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeForFingerprint(item)}`);
  return `{${entries.join(',')}}`;
}
