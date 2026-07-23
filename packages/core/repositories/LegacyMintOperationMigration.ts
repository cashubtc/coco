import { Amount, type AmountLike } from '@cashu/cashu-ts';
import { normalizeUnit } from '../amounts.ts';
import type {
  MintIssuanceAttempt,
  MintIssuanceAttemptState,
} from '../operations/mint/MintIssuanceAttempt.ts';
import type {
  MintMethod,
  MintOperationFailure,
  MintOperationState,
} from '../operations/mint/index.ts';
import {
  deserializeOutputData,
  normalizeMintUrl,
  serializeAmount,
  type SerializedOutputData,
} from '../utils.ts';

/** Stable identifier prefix for attempts synthesized from pre-attempt Mint Operations. */
export const LEGACY_MINT_ISSUANCE_ATTEMPT_PREFIX = 'legacy-mint-operation:';

/** Storage-neutral legacy Mint Operation fields consumed by the migration planner. */
export interface LegacyMintOperationMigrationRecord {
  id: string;
  mintUrl: string;
  quoteId?: string;
  method?: MintMethod;
  unit?: string;
  amount?: AmountLike;
  state: MintOperationState;
  outputData?: SerializedOutputData;
  attemptId?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  terminalFailure?: MintOperationFailure;
}

/** Raw persisted fields accepted by the shared legacy-row decoder. */
export interface PersistedLegacyMintOperationMigrationRecord {
  id: unknown;
  mintUrl: unknown;
  quoteId?: unknown;
  method?: unknown;
  unit?: unknown;
  amount?: unknown;
  state: unknown;
  outputDataJson?: unknown;
  attemptId?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  error?: unknown;
  terminalFailureJson?: unknown;
}

/** One operation update and exact attempt record produced by the migration planner. */
export interface LegacyMintOperationMigrationPlanEntry {
  operationId: string;
  operationState: MintOperationState;
  attempt: MintIssuanceAttempt;
}

/** Adapter-ready JSON fields shared by SQL and IndexedDB migration writers. */
export interface SerializedLegacyMintIssuanceAttempt {
  quoteIdsJson: string;
  quoteAmountsJson: string;
  signingRequirementsJson: string;
  outputDataJson: string;
  requestJson: string;
  terminalErrorJson: string | null;
}

const MINT_METHODS = new Set<MintMethod>(['bolt11', 'bolt12', 'onchain']);
const MINT_OPERATION_STATES = new Set<MintOperationState>([
  'init',
  'pending',
  'executing',
  'finalized',
  'failed',
]);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Legacy Mint Operation ${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Legacy Mint Operation ${field} must be a non-negative safe integer`);
  }
  return value;
}

function parseJson(value: unknown, field: string, operationId: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Legacy Mint Operation ${operationId} ${field} must be serialized JSON`);
  }
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new Error(`Legacy Mint Operation ${operationId} has invalid ${field}`, { cause });
  }
}

function parseTerminalFailure(
  value: unknown,
  operationId: string,
): MintOperationFailure | undefined {
  const parsed = parseJson(value, 'terminalFailureJson', operationId);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Legacy Mint Operation ${operationId} has invalid terminalFailureJson`);
  }
  const failure = parsed as Record<string, unknown>;
  const reason = requiredString(failure.reason, `${operationId} terminal failure reason`);
  const observedAt = timestamp(failure.observedAt, `${operationId} terminal failure observedAt`);
  if (failure.code !== undefined && typeof failure.code !== 'string') {
    throw new Error(`Legacy Mint Operation ${operationId} terminal failure code must be a string`);
  }
  if (failure.retryable !== undefined && typeof failure.retryable !== 'boolean') {
    throw new Error(
      `Legacy Mint Operation ${operationId} terminal failure retryable must be a boolean`,
    );
  }
  return {
    reason,
    observedAt,
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
  };
}

/**
 * Validates and decodes a persisted legacy operation without inventing missing migration data.
 */
export function decodeLegacyMintOperationMigrationRecord(
  input: PersistedLegacyMintOperationMigrationRecord,
): LegacyMintOperationMigrationRecord {
  const id = requiredString(input.id, 'id');
  if (
    typeof input.state !== 'string' ||
    !MINT_OPERATION_STATES.has(input.state as MintOperationState)
  ) {
    throw new Error(`Legacy Mint Operation ${id} has invalid state ${String(input.state)}`);
  }
  if (
    input.method !== undefined &&
    input.method !== null &&
    (typeof input.method !== 'string' || !MINT_METHODS.has(input.method as MintMethod))
  ) {
    throw new Error(`Legacy Mint Operation ${id} has invalid method ${String(input.method)}`);
  }

  const parsedOutputData = parseJson(input.outputDataJson, 'outputDataJson', id);
  let outputData: SerializedOutputData | undefined;
  if (parsedOutputData !== undefined) {
    try {
      outputData = parsedOutputData as SerializedOutputData;
      deserializeOutputData(outputData);
    } catch (cause) {
      throw new Error(`Legacy Mint Operation ${id} has invalid outputDataJson`, { cause });
    }
  }

  let amount: Amount | undefined;
  if (input.amount !== undefined && input.amount !== null) {
    try {
      amount = Amount.from(input.amount as AmountLike);
    } catch (cause) {
      throw new Error(`Legacy Mint Operation ${id} has invalid amount`, { cause });
    }
  }

  return {
    id,
    mintUrl: requiredString(input.mintUrl, `${id} mintUrl`),
    quoteId: optionalString(input.quoteId, `${id} quoteId`),
    method: input.method as MintMethod | undefined,
    unit: optionalString(input.unit, `${id} unit`),
    amount,
    state: input.state as MintOperationState,
    outputData,
    attemptId: optionalString(input.attemptId, `${id} attemptId`),
    createdAt: timestamp(input.createdAt, `${id} createdAt`),
    updatedAt: timestamp(input.updatedAt, `${id} updatedAt`),
    error: optionalString(input.error, `${id} error`),
    terminalFailure: parseTerminalFailure(input.terminalFailureJson, id),
  };
}

function attemptState(state: MintOperationState): MintIssuanceAttemptState {
  switch (state) {
    case 'pending':
      return 'prepared';
    case 'executing':
      return 'recovering';
    case 'finalized':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'init':
      throw new Error('Init Mint Operations do not have legacy issuance attempts');
  }
}

function terminalError(operation: LegacyMintOperationMigrationRecord) {
  if (operation.state !== 'failed') return undefined;
  const failure = operation.terminalFailure;
  const details = failure
    ? {
        ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
        observedAt: failure.observedAt,
      }
    : undefined;
  return {
    message: failure?.reason ?? operation.error ?? 'Legacy Mint Operation failed',
    ...(failure?.code ? { code: failure.code } : {}),
    ...(details ? { details } : {}),
  };
}

function requireAttemptFields(operation: LegacyMintOperationMigrationRecord): {
  quoteId: string;
  method: MintMethod;
  unit: string;
  amount: AmountLike;
} {
  if (
    !operation.quoteId ||
    !operation.method ||
    !operation.unit ||
    operation.amount === undefined
  ) {
    throw new Error(`Legacy Mint Operation ${operation.id} is missing required attempt data`);
  }
  return {
    quoteId: operation.quoteId,
    method: operation.method,
    unit: operation.unit,
    amount: operation.amount,
  };
}

/**
 * Builds deterministic, storage-neutral migration records for legacy Mint Operations.
 *
 * Historical output counter ranges cannot be reconstructed from serialized outputs. Migrated
 * attempts therefore leave the range unknown while the adapter preserves the current counter rows
 * byte-for-byte. Exact outputs remain sufficient for recovery.
 */
export function planLegacyMintOperationMigration(
  operations: LegacyMintOperationMigrationRecord[],
): LegacyMintOperationMigrationPlanEntry[] {
  const plan: LegacyMintOperationMigrationPlanEntry[] = [];

  for (const operation of operations) {
    // Pending rows were never submitted. Keeping them pending preserves reusable quote watching and
    // lets normal execution allocate or reuse outputs only after the quote becomes claimable.
    if (
      operation.state === 'init' ||
      operation.state === 'pending' ||
      operation.attemptId ||
      !operation.outputData
    ) {
      continue;
    }
    const outputs = [...operation.outputData.keep, ...operation.outputData.send];
    if (outputs.length === 0) continue;
    const keysetIds = new Set(outputs.map((output) => output.blindedMessage.id));
    if (keysetIds.size !== 1) {
      throw new Error(`Legacy Mint Operation ${operation.id} has outputs from multiple keysets`);
    }
    const keysetId = keysetIds.values().next().value;
    if (!keysetId) {
      throw new Error(`Legacy Mint Operation ${operation.id} has no output keyset`);
    }
    const { quoteId, method, unit, amount } = requireAttemptFields(operation);
    const state = attemptState(operation.state);
    const attempt: MintIssuanceAttempt = {
      id: `${LEGACY_MINT_ISSUANCE_ATTEMPT_PREFIX}${operation.id}`,
      mintUrl: normalizeMintUrl(operation.mintUrl),
      method,
      unit: normalizeUnit(unit),
      keysetId,
      state,
      memberOperationIds: [operation.id],
      quoteIds: [quoteId],
      quoteAmounts: [Amount.from(amount)],
      signingRequirements: [null],
      outputData: operation.outputData,
      request: { kind: 'single', quoteId },
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      submittedAt: operation.updatedAt,
      ...(state === 'recovering' ? { recoveryStartedAt: operation.updatedAt } : {}),
      ...(state === 'succeeded' ? { recoveredAt: operation.updatedAt } : {}),
      ...(state === 'failed' ? { terminalError: terminalError(operation) } : {}),
    };
    plan.push({
      operationId: operation.id,
      operationState: operation.state,
      attempt,
    });
  }

  return plan;
}

/** Serializes shared attempt fields while retaining the adapter's exact output JSON bytes. */
export function serializeLegacyMintIssuanceAttempt(
  attempt: MintIssuanceAttempt,
  outputDataJson: string,
): SerializedLegacyMintIssuanceAttempt {
  return {
    quoteIdsJson: JSON.stringify(attempt.quoteIds),
    quoteAmountsJson: JSON.stringify(attempt.quoteAmounts.map(serializeAmount)),
    signingRequirementsJson: JSON.stringify(attempt.signingRequirements),
    outputDataJson,
    requestJson: JSON.stringify(attempt.request),
    terminalErrorJson: attempt.terminalError ? JSON.stringify(attempt.terminalError) : null,
  };
}
