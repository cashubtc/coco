import { Amount } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { normalizeMintUrl } from '../../utils';
import type { SerializedOutputData } from '../../utils';

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

/**
 * The local preparation step protected by a fenced lease.
 *
 * A coordinator persists the next stage before beginning it. Attaching that
 * stage's result and advancing to the next stage is one CAS update.
 */
export type MintSwapPreparationStage =
  | 'destination_quote'
  | 'destination_child'
  | 'source_quote'
  | 'source_child';

export interface MintSwapPreparationLease {
  ownerId: string;
  /** Unique fencing token. A stale worker must not commit with an old token. */
  token: string;
  stage: MintSwapPreparationStage;
  acquiredAt: number;
  expiresAt: number;
}

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
  dispatchDeadlineSeconds: number;
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
  /**
   * Reference to the fresh NUT-20 key persisted before destination quote I/O.
   * The private key remains in the keyring and is never copied into this model.
   */
  destinationNut20Key: MintSwapNut20KeyRef;
  preparationLease?: MintSwapPreparationLease;
  destinationQuoteRef?: MintSwapQuoteRef;
  destinationMintOperationId?: string;
  sourceQuoteRef?: MintSwapQuoteRef;
  sourceMeltOperationId?: string;
  preparedPlan?: MintSwapPreparedPlan;
  settlement?: MintSwapSettlement;
  sourceDispatchAuthorizedAt?: number;
  /** Durable evidence that authorized source inputs were reclaimed before value-neutral exit. */
  sourceReclaimedAt?: number;
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
  destinationNut20Key: MintSwapNut20KeyRef;
  destinationAmount: Amount;
  unit: 'sat';
  sourceInputProofSecrets: readonly string[];
  destinationOutputData: SerializedOutputData;
  sourceOutputData: SerializedOutputData;
  sourceMeltAmount: Amount;
  sourceFeeReserve: Amount;
  sourcePreparationFee: Amount;
  sourceMeltInputFee: Amount;
  minimumSourceDebit: Amount;
  maximumSourceDebit: Amount;
  reservedSourceAmount: Amount;
  dispatchDeadlineSeconds: number;
  requiredDispatchWindowSeconds: number;
}

const TERMINAL_STATES = new Set<MintSwapOperationState>(['completed', 'cancelled', 'failed']);
const ALL_STATES = new Set<MintSwapOperationState>([
  'preparing',
  'prepared',
  'source_inflight',
  'destination_funded',
  'issuing',
  'completed',
  'cancelled',
  'failed',
  'needs_attention',
]);
const ATTENTION_REASONS = new Set<MintSwapAttentionReason>([
  'ownership_conflict',
  'prepared_plan_mismatch',
  'source_paid_destination_terminal',
  'destination_issued_source_not_paid',
  'destination_proofs_unrecoverable',
  'source_reclamation_unproven',
  'accounting_mismatch',
  'canonical_observation_conflict',
  'required_recovery_capability_missing',
  'missing_post_effect_recovery_material',
]);
const AUTOMATIC_STATES = new Set<MintSwapOperationState>([
  'preparing',
  'source_inflight',
  'destination_funded',
  'issuing',
]);
const PREPARED_REQUIRED_STATES = new Set<MintSwapOperationState>([
  'prepared',
  'source_inflight',
  'destination_funded',
  'issuing',
  'completed',
]);
const PREPARATION_STAGE_ORDER: readonly MintSwapPreparationStage[] = [
  'destination_quote',
  'destination_child',
  'source_quote',
  'source_child',
];

const TRANSITIONS: Record<MintSwapOperationState, ReadonlySet<MintSwapOperationState>> = {
  preparing: new Set(['prepared', 'cancelled', 'failed', 'needs_attention']),
  prepared: new Set(['source_inflight', 'cancelled', 'failed', 'needs_attention']),
  source_inflight: new Set(['destination_funded', 'cancelled', 'failed', 'needs_attention']),
  destination_funded: new Set(['issuing', 'completed', 'needs_attention']),
  issuing: new Set(['issuing', 'completed', 'needs_attention']),
  completed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
  // S2 deliberately makes attention quiescent. S4 may add explicit, audited repair commands.
  needs_attention: new Set(),
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
  if (from === to) return isAutomaticMintSwapState(from);
  return TRANSITIONS[from].has(to);
}

export function assertMintSwapTransition(
  from: MintSwapOperationState,
  to: MintSwapOperationState,
): void {
  if (!canTransitionMintSwap(from, to)) {
    throw new Error(`Illegal mint swap transition: ${from} -> ${to}`);
  }
}

export function isMintSwapPreparationLeaseActive(
  operation: Pick<MintSwapOperation, 'state' | 'preparationLease'>,
  now: number,
): boolean {
  assertTimestamp(now, 'Mint swap lease check time');
  return operation.state === 'preparing' && (operation.preparationLease?.expiresAt ?? 0) > now;
}

export function assertMintSwapPreparationLeaseOwner(
  operation: Pick<MintSwapOperation, 'id' | 'state' | 'preparationLease'>,
  ownerId: string,
  token: string,
  now?: number,
): void {
  const lease = operation.preparationLease;
  if (
    operation.state !== 'preparing' ||
    !lease ||
    lease.ownerId !== ownerId ||
    lease.token !== token
  ) {
    throw new Error(`Mint swap ${operation.id} preparation lease is not owned by this worker`);
  }
  if (now !== undefined && !isMintSwapPreparationLeaseActive(operation, now)) {
    throw new Error(`Mint swap ${operation.id} preparation lease has expired`);
  }
}

/**
 * Return the earliest durable time at which automatic work may be claimed.
 * `null` identifies caller-driven, quiescent, or terminal states.
 */
export function getMintSwapOperationDueAt(
  operation: Pick<MintSwapOperation, 'state' | 'preparationLease' | 'retry'>,
): number | null {
  if (operation.state === 'preparing') {
    if (!operation.preparationLease) return null;
    return Math.max(operation.preparationLease.expiresAt, operation.retry.nextAttemptAt ?? 0);
  }
  if (
    operation.state === 'source_inflight' ||
    operation.state === 'destination_funded' ||
    operation.state === 'issuing'
  ) {
    return operation.retry.nextAttemptAt ?? 0;
  }
  return null;
}

export function isMintSwapOperationDue(
  operation: Pick<MintSwapOperation, 'state' | 'preparationLease' | 'retry'>,
  now: number,
): boolean {
  assertTimestamp(now, 'Mint swap due check time');
  const dueAt = getMintSwapOperationDueAt(operation);
  return dueAt !== null && dueAt <= now;
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

  for (const [name, amount] of Object.entries({
    sourcePaymentFee: settlement.sourcePaymentFee,
    totalSourceFee: settlement.totalSourceFee,
    sourceMeltChangeAmount: settlement.sourceMeltChangeAmount,
    sourceKeepAmount: settlement.sourceKeepAmount,
    sourceReturnedAmount: settlement.sourceReturnedAmount,
    finalSourceDebit: settlement.finalSourceDebit,
    destinationAmountIssued: settlement.destinationAmountIssued,
  })) {
    if (amount !== undefined) assertNonNegativeAmount(amount, `Mint swap ${name}`);
  }

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
  if (!ALL_STATES.has(operation.state)) {
    throw new Error(`Unknown mint swap state: ${String(operation.state)}`);
  }
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
  if (operation.unit !== 'sat') throw new Error('Mint swap unit must be sat');
  assertNonNegativeAmount(operation.destinationAmount, 'Mint swap destination amount');
  if (operation.destinationAmount.isZero()) {
    throw new Error('Mint swap destination amount must be positive');
  }

  validateNut20Key(operation.destinationNut20Key);
  validateRetry(operation.retry);
  if (operation.retry.lastAttemptAt !== undefined) {
    assertOperationTimestampOrder(
      operation,
      operation.retry.lastAttemptAt,
      'Mint swap retry last attempt',
    );
  }
  if (operation.retry.lastSuccessfulObservationAt !== undefined) {
    assertOperationTimestampOrder(
      operation,
      operation.retry.lastSuccessfulObservationAt,
      'Mint swap retry last successful observation',
    );
  }
  validateQuoteRef(operation.destinationQuoteRef, destinationMintUrl, 'destination');
  validateQuoteRef(operation.sourceQuoteRef, sourceMintUrl, 'source');
  validateAttachmentOrder(operation);

  if (operation.state === 'preparing') {
    validatePreparationLease(operation);
  } else if (operation.preparationLease) {
    throw new Error(`Mint swap state ${operation.state} cannot retain a preparation lease`);
  }

  if (PREPARED_REQUIRED_STATES.has(operation.state) || operation.preparedPlan) {
    requirePreparedFields(operation);
  }
  if (operation.state === 'needs_attention' && operation.attention?.lastSafeState !== 'preparing') {
    requirePreparedFields(operation);
  }

  const progressState = getMintSwapProgressState(operation);
  if (operation.sourceDispatchAuthorizedAt !== undefined) {
    assertTimestamp(
      operation.sourceDispatchAuthorizedAt,
      'Mint swap source dispatch authorization',
    );
    assertOperationTimestampOrder(
      operation,
      operation.sourceDispatchAuthorizedAt,
      'Mint swap source dispatch authorization',
    );
    if (progressState === 'preparing' || progressState === 'prepared') {
      throw new Error(`Mint swap state ${operation.state} cannot authorize source dispatch`);
    }
  }
  if (
    progressState === 'source_inflight' ||
    progressState === 'destination_funded' ||
    progressState === 'issuing' ||
    progressState === 'completed'
  ) {
    assertTimestamp(
      operation.sourceDispatchAuthorizedAt,
      'Mint swap source dispatch authorization',
    );
  }

  if (operation.destinationIssueAuthorizedAt !== undefined) {
    assertTimestamp(
      operation.destinationIssueAuthorizedAt,
      'Mint swap destination issue authorization',
    );
    assertOperationTimestampOrder(
      operation,
      operation.destinationIssueAuthorizedAt,
      'Mint swap destination issue authorization',
    );
    if (progressState !== 'issuing' && progressState !== 'completed') {
      throw new Error(`Mint swap state ${operation.state} cannot authorize destination issuance`);
    }
    if (
      operation.sourceDispatchAuthorizedAt === undefined ||
      operation.destinationIssueAuthorizedAt < operation.sourceDispatchAuthorizedAt
    ) {
      throw new Error('Mint swap destination issuance authorization must follow source dispatch');
    }
  }

  if (operation.sourceReclaimedAt !== undefined) {
    assertTimestamp(operation.sourceReclaimedAt, 'Mint swap source reclamation');
    assertOperationTimestampOrder(
      operation,
      operation.sourceReclaimedAt,
      'Mint swap source reclamation',
    );
    if (operation.state !== 'failed' && operation.state !== 'cancelled') {
      throw new Error(
        'Source reclamation evidence is valid only for value-neutral terminal states',
      );
    }
    if (
      operation.sourceDispatchAuthorizedAt === undefined ||
      operation.sourceReclaimedAt < operation.sourceDispatchAuthorizedAt
    ) {
      throw new Error('Mint swap source reclamation must follow source dispatch authorization');
    }
  }
  if (progressState === 'issuing' || progressState === 'completed') {
    assertTimestamp(
      operation.destinationIssueAuthorizedAt,
      'Mint swap destination issue authorization',
    );
  }

  if (
    progressState === 'destination_funded' ||
    progressState === 'issuing' ||
    progressState === 'completed'
  ) {
    validateMintSwapAccounting(operation);
  } else if (operation.settlement) {
    validateMintSwapAccounting(operation);
  }

  if (operation.cancellationRequestedAt !== undefined) {
    assertTimestamp(operation.cancellationRequestedAt, 'Mint swap cancellation request');
    assertOperationTimestampOrder(
      operation,
      operation.cancellationRequestedAt,
      'Mint swap cancellation request',
    );
  }
  if (operation.cancelledAt !== undefined) {
    assertTimestamp(operation.cancelledAt, 'Mint swap cancellation completion');
    assertOperationTimestampOrder(
      operation,
      operation.cancelledAt,
      'Mint swap cancellation completion',
    );
    if (operation.state !== 'cancelled') {
      throw new Error('Only a cancelled mint swap may have cancelledAt');
    }
  }
  if (operation.state === 'cancelled') {
    assertTimestamp(operation.cancellationRequestedAt, 'Mint swap cancellation request');
    assertTimestamp(operation.cancelledAt, 'Mint swap cancellation completion');
    if (operation.cancelledAt! < operation.cancellationRequestedAt!) {
      throw new Error('Mint swap cancellation completion must follow its request');
    }
  }

  if (operation.completedAt !== undefined) {
    assertTimestamp(operation.completedAt, 'Mint swap completion time');
    assertOperationTimestampOrder(operation, operation.completedAt, 'Mint swap completion time');
    if (operation.state !== 'completed') {
      throw new Error('Only a completed mint swap may have completedAt');
    }
  }
  if (operation.state === 'completed') {
    assertTimestamp(operation.completedAt, 'Mint swap completion time');
    if (operation.completedAt! < operation.destinationIssueAuthorizedAt!) {
      throw new Error('Mint swap completion must follow destination issuance authorization');
    }
  }

  if (operation.state === 'failed' && !operation.terminalFailure) {
    throw new Error('Failed mint swap requires terminal failure details');
  }
  if (operation.terminalFailure) {
    if (operation.state !== 'failed') {
      throw new Error('Only a failed mint swap may have terminal failure details');
    }
    validateTerminalFailure(operation.terminalFailure);
    assertOperationTimestampOrder(
      operation,
      operation.terminalFailure.at,
      'Mint swap terminal failure time',
    );
    if (
      operation.sourceReclaimedAt !== undefined &&
      operation.terminalFailure.at < operation.sourceReclaimedAt
    ) {
      throw new Error('Mint swap terminal failure must follow source reclamation');
    }
  }

  if (operation.state === 'needs_attention' && !operation.attention) {
    throw new Error('Mint swap needing attention requires structured evidence');
  }
  if (operation.attention) {
    if (operation.state !== 'needs_attention') {
      throw new Error('Only a mint swap needing attention may contain attention evidence');
    }
    validateAttention(operation.attention);
    assertOperationTimestampOrder(operation, operation.attention.at, 'Mint swap attention time');
  }

  if ((operation.state === 'failed' || operation.state === 'cancelled') && operation.settlement) {
    throw new Error(
      `Mint swap state ${operation.state} cannot contain transferred-value settlement`,
    );
  }
  if (
    (operation.state === 'failed' || operation.state === 'cancelled') &&
    operation.sourceDispatchAuthorizedAt !== undefined &&
    operation.sourceReclaimedAt === undefined
  ) {
    throw new Error('Value-neutral terminal mint swap requires source reclamation evidence');
  }
  if (
    (operation.state === 'failed' || operation.state === 'cancelled') &&
    operation.destinationIssueAuthorizedAt !== undefined
  ) {
    throw new Error(`Mint swap state ${operation.state} cannot authorize destination issuance`);
  }

  return operation;
}

/**
 * Validate a CAS replacement against the currently stored operation.
 *
 * Repositories should call this before committing a winning revision.
 */
export function assertMintSwapOperationUpdate(
  current: MintSwapOperation,
  next: MintSwapOperation,
): void {
  validateMintSwapOperation(current);
  validateMintSwapOperation(next);
  if (current.id !== next.id) throw new Error('Mint swap id is immutable');
  if (next.revision !== current.revision + 1) {
    throw new Error('Mint swap update must advance revision exactly once');
  }
  if (next.updatedAt < current.updatedAt) {
    throw new Error('Mint swap updatedAt cannot regress');
  }
  assertMintSwapTransition(current.state, next.state);
  assertAlwaysImmutable(current, next);
  assertAttachedReferencesImmutable(current, next);
  assertAuthorizationImmutable(current, next);
  assertSettlementImmutable(current, next);
  assertPreparedMintSwapImmutable(current, next);
  assertPreparationLeaseUpdate(current, next);
  assertRetryUpdate(current, next);
  assertCancellationRequestUpdate(current, next);
}

export function assertPreparedMintSwapImmutable(
  current: MintSwapOperation,
  next: MintSwapOperation,
): void {
  if (!current.preparedPlan) return;
  const fields: Array<[unknown, unknown, string]> = [
    [current.preparedPlan.fingerprint, next.preparedPlan?.fingerprint, 'prepared fingerprint'],
    [
      current.preparedPlan.dispatchDeadlineSeconds,
      next.preparedPlan?.dispatchDeadlineSeconds,
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
  if (changed) throw new Error(`Prepared mint swap ${changed[2]} is immutable`);
}

function validatePreparationLease(operation: MintSwapOperation): void {
  const lease = operation.preparationLease;
  if (!lease) throw new Error('Preparing mint swap requires a durable preparation lease');
  assertNonEmpty(lease.ownerId, 'Mint swap preparation lease owner');
  assertNonEmpty(lease.token, 'Mint swap preparation lease token');
  assertTimestamp(lease.acquiredAt, 'Mint swap preparation lease acquiredAt');
  assertTimestamp(lease.expiresAt, 'Mint swap preparation lease expiresAt');
  if (lease.expiresAt <= lease.acquiredAt) {
    throw new Error('Mint swap preparation lease must expire after it is acquired');
  }
  if (lease.acquiredAt < operation.createdAt || lease.acquiredAt > operation.updatedAt) {
    throw new Error('Mint swap preparation lease acquisition is outside the operation timeline');
  }
  if (lease.expiresAt <= operation.updatedAt) {
    throw new Error('A newly persisted preparation lease must still be active');
  }
  if (!PREPARATION_STAGE_ORDER.includes(lease.stage)) {
    throw new Error(`Unknown mint swap preparation stage: ${String(lease.stage)}`);
  }

  const hasDestinationQuote = operation.destinationQuoteRef !== undefined;
  const hasDestinationChild = operation.destinationMintOperationId !== undefined;
  const hasSourceQuote = operation.sourceQuoteRef !== undefined;
  const hasSourceChild = operation.sourceMeltOperationId !== undefined;
  const stageFacts: Record<MintSwapPreparationStage, readonly boolean[]> = {
    destination_quote: [
      !hasDestinationQuote,
      !hasDestinationChild,
      !hasSourceQuote,
      !hasSourceChild,
    ],
    destination_child: [
      hasDestinationQuote,
      !hasDestinationChild,
      !hasSourceQuote,
      !hasSourceChild,
    ],
    source_quote: [hasDestinationQuote, hasDestinationChild, !hasSourceQuote, !hasSourceChild],
    source_child: [hasDestinationQuote, hasDestinationChild, hasSourceQuote, !hasSourceChild],
  };
  if (!stageFacts[lease.stage].every(Boolean)) {
    throw new Error(`Mint swap preparation stage ${lease.stage} contradicts attached records`);
  }
  if (operation.preparedPlan) {
    throw new Error('Preparing mint swap cannot contain a completed prepared plan');
  }
}

function assertPreparationLeaseUpdate(current: MintSwapOperation, next: MintSwapOperation): void {
  if (current.state !== 'preparing' || next.state !== 'preparing') return;
  const currentLease = current.preparationLease!;
  const nextLease = next.preparationLease!;
  const currentStage = PREPARATION_STAGE_ORDER.indexOf(currentLease.stage);
  const nextStage = PREPARATION_STAGE_ORDER.indexOf(nextLease.stage);
  if (nextStage < currentStage || nextStage > currentStage + 1) {
    throw new Error('Mint swap preparation stage must advance at most one step');
  }

  if (currentLease.token === nextLease.token) {
    if (
      currentLease.ownerId !== nextLease.ownerId ||
      currentLease.acquiredAt !== nextLease.acquiredAt
    ) {
      throw new Error('Mint swap preparation lease identity is immutable for one token');
    }
    if (nextLease.expiresAt < currentLease.expiresAt) {
      throw new Error('Mint swap preparation lease expiry cannot regress');
    }
    if (next.updatedAt >= currentLease.expiresAt) {
      throw new Error('Mint swap preparation lease cannot be renewed or advanced after expiry');
    }
    return;
  }

  if (nextLease.acquiredAt < currentLease.expiresAt) {
    throw new Error('Mint swap preparation lease cannot be taken over before expiry');
  }
}

function requirePreparedFields(operation: MintSwapOperation): void {
  if (
    !operation.destinationQuoteRef ||
    !operation.destinationMintOperationId ||
    !operation.sourceQuoteRef ||
    !operation.sourceMeltOperationId ||
    !operation.preparedPlan
  ) {
    throw new Error(`Mint swap state ${operation.state} requires a complete prepared plan`);
  }
  assertNonEmpty(operation.destinationMintOperationId, 'Mint swap destination child id');
  assertNonEmpty(operation.sourceMeltOperationId, 'Mint swap source child id');
  const plan = operation.preparedPlan;
  if (!/^[0-9a-f]{64}$/.test(plan.fingerprint)) {
    throw new Error('Mint swap prepared fingerprint must be canonical SHA-256 hex');
  }
  assertUnixSeconds(plan.dispatchDeadlineSeconds, 'Mint swap dispatch deadline');
  if (plan.dispatchDeadlineSeconds < Math.floor(operation.createdAt / 1_000)) {
    throw new Error('Mint swap dispatch deadline cannot precede operation creation');
  }
  if (
    !Number.isSafeInteger(plan.requiredDispatchWindowSeconds) ||
    plan.requiredDispatchWindowSeconds < 30
  ) {
    throw new Error('Mint swap required dispatch window must be at least 30 seconds');
  }
  if (
    operation.state === 'prepared' &&
    plan.dispatchDeadlineSeconds <
      Math.floor(operation.updatedAt / 1_000) + plan.requiredDispatchWindowSeconds
  ) {
    throw new Error('Prepared mint swap does not retain its required dispatch safety window');
  }
  for (const [name, amount] of Object.entries({
    sourceMeltAmount: plan.sourceMeltAmount,
    sourceFeeReserve: plan.sourceFeeReserve,
    sourcePreparationFee: plan.sourcePreparationFee,
    sourceMeltInputFee: plan.sourceMeltInputFee,
    minimumSourceDebit: plan.minimumSourceDebit,
    maximumSourceDebit: plan.maximumSourceDebit,
    reservedSourceAmount: plan.reservedSourceAmount,
  })) {
    assertNonNegativeAmount(amount, `Mint swap ${name}`);
  }

  assertAmountEquals(plan.sourceMeltAmount, operation.destinationAmount, 'source melt amount');
  const minimum = operation.destinationAmount
    .add(plan.sourcePreparationFee)
    .add(plan.sourceMeltInputFee);
  assertAmountEquals(plan.minimumSourceDebit, minimum, 'minimum source debit');
  if (plan.maximumSourceDebit.lessThan(plan.minimumSourceDebit)) {
    throw new Error('Mint swap maximum source debit is below minimum source debit');
  }
  if (plan.maximumSourceDebit.greaterThan(plan.reservedSourceAmount)) {
    throw new Error('Mint swap maximum source debit exceeds reserved source amount');
  }

  const reserveBound = plan.minimumSourceDebit.add(plan.sourceFeeReserve);
  if (
    !plan.maximumSourceDebit.equals(reserveBound) &&
    !plan.maximumSourceDebit.equals(plan.reservedSourceAmount)
  ) {
    throw new Error(
      'Mint swap maximum source debit must use the fee-reserve or reserved-input bound',
    );
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
  if (retry.lastError !== undefined) assertNonEmpty(retry.lastError, 'Mint swap retry last error');
}

function validateNut20Key(key: MintSwapNut20KeyRef): void {
  if (!key) throw new Error('Mint swap requires a persisted NUT-20 key reference');
  assertNonEmpty(key.publicKey, 'Mint swap NUT-20 public key');
  if (!/^(02|03)[0-9a-f]{64}$/.test(key.publicKey)) {
    throw new Error('Mint swap NUT-20 public key must be canonical compressed hex');
  }
  if (!Number.isSafeInteger(key.derivationIndex) || key.derivationIndex < 0) {
    throw new Error('Mint swap NUT-20 derivation index must be a non-negative safe integer');
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

function validateAttachmentOrder(operation: MintSwapOperation): void {
  if (operation.destinationMintOperationId && !operation.destinationQuoteRef) {
    throw new Error('Mint swap destination child requires its quote reference');
  }
  if (operation.sourceQuoteRef && !operation.destinationMintOperationId) {
    throw new Error('Mint swap source quote requires the prepared destination child');
  }
  if (operation.sourceMeltOperationId && !operation.sourceQuoteRef) {
    throw new Error('Mint swap source child requires its quote reference');
  }
}

function validateAttention(attention: MintSwapAttentionRecord): void {
  if (!ATTENTION_REASONS.has(attention.reason)) {
    throw new Error(`Unknown mint swap attention reason: ${String(attention.reason)}`);
  }
  if (!ALL_STATES.has(attention.lastSafeState)) {
    throw new Error(`Unknown mint swap last safe state: ${String(attention.lastSafeState)}`);
  }
  if (
    attention.lastSafeState === 'completed' ||
    attention.lastSafeState === 'cancelled' ||
    attention.lastSafeState === 'failed' ||
    attention.lastSafeState === 'needs_attention'
  ) {
    throw new Error('Mint swap attention last safe state must be a non-terminal progress state');
  }
  assertNonEmpty(attention.message, 'Mint swap attention message');
  assertNonEmpty(attention.violatedInvariant, 'Mint swap violated invariant');
  assertTimestamp(attention.at, 'Mint swap attention time');
  for (const [key, value] of Object.entries(attention.evidence)) {
    assertNonEmpty(key, 'Mint swap attention evidence key');
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new Error('Mint swap attention evidence must be scalar');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Mint swap attention evidence number must be finite');
    }
  }
}

function validateTerminalFailure(failure: MintSwapTerminalFailure): void {
  assertNonEmpty(failure.code, 'Mint swap terminal failure code');
  assertNonEmpty(failure.reason, 'Mint swap terminal failure reason');
  assertTimestamp(failure.at, 'Mint swap terminal failure time');
}

function assertAlwaysImmutable(current: MintSwapOperation, next: MintSwapOperation): void {
  const fields: Array<[unknown, unknown, string]> = [
    [current.createdAt, next.createdAt, 'createdAt'],
    [current.sourceMintUrl, next.sourceMintUrl, 'source mint URL'],
    [current.destinationMintUrl, next.destinationMintUrl, 'destination mint URL'],
    [current.unit, next.unit, 'unit'],
    [current.destinationAmount.toString(), next.destinationAmount.toString(), 'destination amount'],
    [
      current.destinationNut20Key.publicKey,
      next.destinationNut20Key.publicKey,
      'NUT-20 public key',
    ],
    [
      current.destinationNut20Key.derivationIndex,
      next.destinationNut20Key.derivationIndex,
      'NUT-20 derivation index',
    ],
  ];
  const changed = fields.find(([left, right]) => left !== right);
  if (changed) throw new Error(`Mint swap ${changed[2]} is immutable`);
}

function assertRetryUpdate(current: MintSwapOperation, next: MintSwapOperation): void {
  if (next.retry.attemptCount < current.retry.attemptCount) {
    throw new Error('Mint swap retry attempt count cannot regress');
  }
  for (const [currentValue, nextValue, name] of [
    [current.retry.lastAttemptAt, next.retry.lastAttemptAt, 'last attempt'],
    [
      current.retry.lastSuccessfulObservationAt,
      next.retry.lastSuccessfulObservationAt,
      'last successful observation',
    ],
  ] as const) {
    if (currentValue !== undefined && (nextValue === undefined || nextValue < currentValue)) {
      throw new Error(`Mint swap retry ${name} cannot regress`);
    }
  }
}

function assertCancellationRequestUpdate(
  current: MintSwapOperation,
  next: MintSwapOperation,
): void {
  if (
    current.cancellationRequestedAt === undefined &&
    next.cancellationRequestedAt !== undefined &&
    current.state !== 'preparing' &&
    current.state !== 'prepared' &&
    current.state !== 'source_inflight'
  ) {
    throw new Error(`Cannot newly request cancellation from mint swap state ${current.state}`);
  }
}

function getMintSwapProgressState(operation: MintSwapOperation): MintSwapOperationState {
  return operation.state === 'needs_attention'
    ? (operation.attention?.lastSafeState ?? operation.state)
    : operation.state;
}

function assertAttachedReferencesImmutable(
  current: MintSwapOperation,
  next: MintSwapOperation,
): void {
  const fields: Array<[unknown, unknown, string]> = [
    [
      quoteRefKey(current.destinationQuoteRef),
      quoteRefKey(next.destinationQuoteRef),
      'destination quote',
    ],
    [current.destinationMintOperationId, next.destinationMintOperationId, 'destination child'],
    [quoteRefKey(current.sourceQuoteRef), quoteRefKey(next.sourceQuoteRef), 'source quote'],
    [current.sourceMeltOperationId, next.sourceMeltOperationId, 'source child'],
  ];
  const removedOrChanged = fields.find(
    ([currentValue, nextValue]) => currentValue !== undefined && currentValue !== nextValue,
  );
  if (removedOrChanged) {
    throw new Error(`Mint swap attached ${removedOrChanged[2]} is immutable`);
  }
}

function assertAuthorizationImmutable(current: MintSwapOperation, next: MintSwapOperation): void {
  for (const [currentValue, nextValue, name] of [
    [
      current.sourceDispatchAuthorizedAt,
      next.sourceDispatchAuthorizedAt,
      'source dispatch authorization',
    ],
    [
      current.destinationIssueAuthorizedAt,
      next.destinationIssueAuthorizedAt,
      'destination issue authorization',
    ],
    [current.cancellationRequestedAt, next.cancellationRequestedAt, 'cancellation request'],
    [current.sourceReclaimedAt, next.sourceReclaimedAt, 'source reclamation evidence'],
  ] as const) {
    if (currentValue !== undefined && currentValue !== nextValue) {
      throw new Error(`Mint swap ${name} is immutable`);
    }
  }
}

function assertSettlementImmutable(current: MintSwapOperation, next: MintSwapOperation): void {
  if (!current.settlement) return;
  if (!next.settlement) throw new Error('Mint swap settlement cannot be removed');
  for (const [currentValue, nextValue, name] of [
    [current.settlement.sourcePaymentFee, next.settlement.sourcePaymentFee, 'source payment fee'],
    [current.settlement.totalSourceFee, next.settlement.totalSourceFee, 'total source fee'],
    [
      current.settlement.sourceMeltChangeAmount,
      next.settlement.sourceMeltChangeAmount,
      'source melt change',
    ],
    [current.settlement.sourceKeepAmount, next.settlement.sourceKeepAmount, 'source keep amount'],
    [
      current.settlement.sourceReturnedAmount,
      next.settlement.sourceReturnedAmount,
      'source returned amount',
    ],
    [current.settlement.finalSourceDebit, next.settlement.finalSourceDebit, 'final source debit'],
  ] as const) {
    if (!currentValue.equals(nextValue)) throw new Error(`Mint swap ${name} is immutable`);
  }
  if (current.settlement.destinationAmountIssued) {
    if (
      !next.settlement.destinationAmountIssued ||
      !current.settlement.destinationAmountIssued.equals(next.settlement.destinationAmountIssued)
    ) {
      throw new Error('Mint swap destination issued amount is immutable once observed');
    }
  }
}

function normalizeQuoteRef(ref: MintSwapQuoteRef): MintSwapQuoteRef {
  return { ...ref, mintUrl: normalizeMintUrl(ref.mintUrl) };
}

function quoteRefKey(ref?: MintSwapQuoteRef): string | undefined {
  return ref ? `${ref.mintUrl}\u0000${ref.method}\u0000${ref.quoteId}` : undefined;
}

function assertNonNegativeAmount(amount: Amount, name: string): void {
  Amount.from(amount);
  if (amount.toString().startsWith('-')) throw new Error(`${name} cannot be negative`);
}

function assertAmountEquals(actual: Amount, expected: Amount, name: string): void {
  if (!actual.equals(expected)) throw new Error(`Mint swap ${name} does not reconcile`);
}

function assertTimestamp(value: number | undefined, name: string): asserts value is number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative Unix-millisecond timestamp`);
  }
}

function assertUnixSeconds(value: number | undefined, name: string): asserts value is number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative Unix-seconds timestamp`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} cannot be empty`);
}

function assertOperationTimestampOrder(
  operation: Pick<MintSwapOperation, 'createdAt' | 'updatedAt'>,
  value: number,
  name: string,
): void {
  if (value < operation.createdAt || value > operation.updatedAt) {
    throw new Error(`${name} must be within the operation timeline`);
  }
}

function canonicalizeForFingerprint(value: unknown, seen = new Set<object>()): string {
  if (value instanceof Amount) return JSON.stringify(value.toString());
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Mint swap fingerprint numbers must be finite');
    return JSON.stringify(value);
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('Mint swap fingerprint input must be serializable');
  }
  if (typeof value !== 'object') {
    throw new Error('Mint swap fingerprint input contains an unsupported value');
  }
  if (seen.has(value)) throw new Error('Mint swap fingerprint input cannot be cyclic');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalizeForFingerprint(item, seen)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Mint swap fingerprint input must contain only plain objects and arrays');
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeForFingerprint(item, seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}
