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
import { normalizeMintUrl, type SerializedOutputData } from '../utils.ts';

export const LEGACY_MINT_ISSUANCE_ATTEMPT_PREFIX = 'legacy-mint-operation:';

export interface LegacyMintOperationMigrationRecord {
  id: string;
  mintUrl: string;
  quoteId: string;
  method: MintMethod;
  unit: string;
  amount: AmountLike;
  state: MintOperationState;
  outputData?: SerializedOutputData;
  attemptId?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  terminalFailure?: MintOperationFailure;
}

export interface LegacyMintCounterSnapshot {
  mintUrl: string;
  keysetId: string;
  counter: number;
}

export interface LegacyMintOperationMigrationPlanEntry {
  operationId: string;
  operationState: MintOperationState;
  attempt: MintIssuanceAttempt;
}

interface Candidate {
  operation: LegacyMintOperationMigrationRecord;
  mintUrl: string;
  unit: string;
  keysetId: string;
  outputCount: number;
  counterStart?: number;
}

function groupKey(mintUrl: string, keysetId: string): string {
  return JSON.stringify([mintUrl, keysetId]);
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

/**
 * Builds deterministic, storage-neutral migration records for legacy Mint Operations.
 *
 * Counter ranges are assigned from the already-consumed suffix of each keyset counter. The
 * counter itself is an input snapshot and is never changed by this planner.
 */
export function planLegacyMintOperationMigration(
  operations: LegacyMintOperationMigrationRecord[],
  counters: LegacyMintCounterSnapshot[],
): LegacyMintOperationMigrationPlanEntry[] {
  const candidates: Candidate[] = [];

  for (const operation of operations) {
    if (operation.state === 'init' || operation.attemptId || !operation.outputData) continue;
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
    candidates.push({
      operation,
      mintUrl: normalizeMintUrl(operation.mintUrl),
      unit: normalizeUnit(operation.unit),
      keysetId,
      outputCount: outputs.length,
    });
  }

  candidates.sort(
    (a, b) =>
      a.operation.createdAt - b.operation.createdAt || a.operation.id.localeCompare(b.operation.id),
  );

  const countersByGroup = new Map<string, number>();
  for (const counter of counters) {
    const key = groupKey(normalizeMintUrl(counter.mintUrl), counter.keysetId);
    const known = countersByGroup.get(key);
    if (known !== undefined && known !== counter.counter) {
      throw new Error(`Conflicting legacy counter snapshots for keyset ${counter.keysetId}`);
    }
    countersByGroup.set(key, counter.counter);
  }

  const candidatesByGroup = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = groupKey(candidate.mintUrl, candidate.keysetId);
    const grouped = candidatesByGroup.get(key) ?? [];
    grouped.push(candidate);
    candidatesByGroup.set(key, grouped);
  }

  for (const [key, grouped] of candidatesByGroup) {
    const counter = countersByGroup.get(key);
    if (counter === undefined) {
      throw new Error(
        `Legacy counter is missing for Mint Operation ${grouped[0]!.operation.id} keyset ${grouped[0]!.keysetId}`,
      );
    }
    const outputCount = grouped.reduce((sum, candidate) => sum + candidate.outputCount, 0);
    if (!Number.isSafeInteger(counter) || counter < outputCount) {
      throw new Error(
        `Legacy counter ${counter} cannot cover ${outputCount} outputs for keyset ${grouped[0]!.keysetId}`,
      );
    }
    let cursor = counter - outputCount;
    for (const candidate of grouped) {
      candidate.counterStart = cursor;
      cursor += candidate.outputCount;
    }
  }

  return candidates.map(({ operation, mintUrl, unit, keysetId, outputCount, counterStart }) => {
    if (counterStart === undefined || !operation.outputData) {
      throw new Error(`Legacy Mint Operation ${operation.id} has no assigned counter range`);
    }
    const state = attemptState(operation.state);
    const wasSubmitted = operation.state !== 'pending';
    const attempt: MintIssuanceAttempt = {
      id: `${LEGACY_MINT_ISSUANCE_ATTEMPT_PREFIX}${operation.id}`,
      mintUrl,
      method: operation.method,
      unit,
      keysetId,
      state,
      memberOperationIds: [operation.id],
      quoteIds: [operation.quoteId],
      quoteAmounts: [Amount.from(operation.amount)],
      signingRequirements: [null],
      outputData: operation.outputData,
      counterStart,
      counterEnd: counterStart + outputCount,
      request: { kind: 'single', quoteId: operation.quoteId },
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      ...(wasSubmitted ? { submittedAt: operation.updatedAt } : {}),
      ...(state === 'recovering' ? { recoveryStartedAt: operation.updatedAt } : {}),
      ...(state === 'succeeded' ? { recoveredAt: operation.updatedAt } : {}),
      ...(state === 'failed' ? { terminalError: terminalError(operation) } : {}),
    };
    return {
      operationId: operation.id,
      operationState: operation.state === 'pending' ? 'executing' : operation.state,
      attempt,
    };
  });
}
