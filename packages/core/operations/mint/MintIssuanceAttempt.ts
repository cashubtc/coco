import { Amount } from '@cashu/cashu-ts';
import { normalizeUnit } from '../../amounts.ts';
import { normalizeMintUrl, type SerializedOutputData } from '../../utils.ts';

/** One Mint Operation's contribution to an atomic Mint Issuance Attempt. */
export interface MintIssuanceAttemptMember {
  operationId: string;
  quoteId: string;
  amount: Amount;
}

/** Structured metadata retained for a terminally failed attempt. */
export interface MintIssuanceAttemptFailure {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

interface MintIssuanceAttemptBase {
  id: string;
  mintUrl: string;
  unit: string;
  members: MintIssuanceAttemptMember[];
  outputData: SerializedOutputData;
  createdAt: number;
}

/** Recovery material that has been persisted but is definitely unsent. */
export interface PreparedMintIssuanceAttempt extends MintIssuanceAttemptBase {
  state: 'prepared';
  submittedAt?: never;
  terminalFailure?: never;
}

/** Recovery material for a request that may have reached the mint. */
export interface SubmittedMintIssuanceAttempt extends MintIssuanceAttemptBase {
  state: 'submitted';
  submittedAt: number;
  terminalFailure?: never;
}

/** Retained recovery material for a completely finalized issuance request. */
export interface SucceededMintIssuanceAttempt extends MintIssuanceAttemptBase {
  state: 'succeeded';
  submittedAt: number;
  terminalFailure?: never;
}

/** Retained recovery material for a definitive pre-signing rejection. */
export interface FailedMintIssuanceAttempt extends MintIssuanceAttemptBase {
  state: 'failed';
  submittedAt: number;
  terminalFailure: MintIssuanceAttemptFailure;
}

/** Durable lifecycle record for one exact aggregate mint issuance request. */
export type MintIssuanceAttempt =
  | PreparedMintIssuanceAttempt
  | SubmittedMintIssuanceAttempt
  | SucceededMintIssuanceAttempt
  | FailedMintIssuanceAttempt;

/** Legal persisted lifecycle states for a Mint Issuance Attempt. */
export type MintIssuanceAttemptState = MintIssuanceAttempt['state'];

/** The only legal compare-and-transition state changes. */
export type MintIssuanceAttemptTransition =
  | { from: 'prepared'; to: 'submitted'; submittedAt: number }
  | { from: 'submitted'; to: 'succeeded' }
  | {
      from: 'submitted';
      to: 'failed';
      terminalFailure: MintIssuanceAttemptFailure;
    };

/** States whose exact request may still need submission or recovery. */
export const INCOMPLETE_MINT_ISSUANCE_ATTEMPT_STATES = [
  'prepared',
  'submitted',
] as const satisfies readonly MintIssuanceAttempt['state'][];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

/** Defensively parses persisted ordered membership data. */
export function parseMintIssuanceAttemptMembers(value: unknown): MintIssuanceAttemptMember[] {
  if (!Array.isArray(value)) {
    throw new Error('Mint issuance attempt members must be an array');
  }
  return normalizeMembers(
    value.map((member, index) => {
      if (!isRecord(member)) {
        throw new Error(`Mint issuance attempt member ${index} must be an object`);
      }
      if (typeof member.amount !== 'string' && typeof member.amount !== 'number') {
        throw new Error(`Mint issuance attempt member ${index} amount is invalid`);
      }
      return {
        operationId: requireString(member.operationId, `Mint issuance attempt member ${index} id`),
        quoteId: requireString(member.quoteId, `Mint issuance attempt member ${index} quote id`),
        amount: Amount.from(member.amount),
      };
    }),
  );
}

/** Defensively parses persisted aggregate output recovery material. */
export function parseMintIssuanceAttemptOutputData(value: unknown): SerializedOutputData {
  if (!isRecord(value) || !Array.isArray(value.keep) || !Array.isArray(value.send)) {
    throw new Error('Mint issuance attempt output data must contain keep and send arrays');
  }

  const parseOutputs = (outputs: unknown[], group: string): SerializedOutputData['keep'] =>
    outputs.map((output, index) => {
      if (!isRecord(output) || !isRecord(output.blindedMessage)) {
        throw new Error(`Mint issuance attempt ${group} output ${index} must be an object`);
      }
      const amount = output.blindedMessage.amount;
      if (typeof amount !== 'string' && typeof amount !== 'number') {
        throw new Error(`Mint issuance attempt ${group} output ${index} amount is invalid`);
      }
      Amount.from(amount);
      const blindingFactor = requireString(
        output.blindingFactor,
        `Mint issuance attempt ${group} output ${index} blinding factor`,
      );
      BigInt(`0x${blindingFactor}`);
      const secret = requireString(
        output.secret,
        `Mint issuance attempt ${group} output ${index} secret`,
      );
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(secret)) {
        throw new Error(`Mint issuance attempt ${group} output ${index} secret must be hex`);
      }
      if (output.ephemeralE !== undefined && typeof output.ephemeralE !== 'string') {
        throw new Error(`Mint issuance attempt ${group} output ${index} ephemeral E is invalid`);
      }
      return {
        blindedMessage: {
          amount,
          id: requireString(
            output.blindedMessage.id,
            `Mint issuance attempt ${group} output ${index} keyset id`,
          ),
          B_: requireString(
            output.blindedMessage.B_,
            `Mint issuance attempt ${group} output ${index} blinded message`,
          ),
        },
        blindingFactor,
        secret,
        ...(output.ephemeralE === undefined ? {} : { ephemeralE: output.ephemeralE }),
      };
    });

  return {
    keep: parseOutputs(value.keep, 'keep'),
    send: parseOutputs(value.send, 'send'),
  };
}

/** Defensively parses optional metadata for a terminally failed attempt. */
export function parseMintIssuanceAttemptFailure(value: unknown): MintIssuanceAttemptFailure {
  if (!isRecord(value)) {
    throw new Error('Mint issuance attempt terminal failure must be an object');
  }
  if (value.code !== undefined && typeof value.code !== 'string') {
    throw new Error('Mint issuance attempt terminal failure code must be a string');
  }
  if (value.details !== undefined && !isRecord(value.details)) {
    throw new Error('Mint issuance attempt terminal failure details must be an object');
  }
  return {
    message: requireString(value.message, 'Mint issuance attempt terminal failure message'),
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(value.details === undefined ? {} : { details: value.details }),
  };
}

function cloneOutputData(outputData: SerializedOutputData): SerializedOutputData {
  return {
    keep: outputData.keep.map((output) => ({
      ...output,
      blindedMessage: { ...output.blindedMessage },
    })),
    send: outputData.send.map((output) => ({
      ...output,
      blindedMessage: { ...output.blindedMessage },
    })),
  };
}

function cloneFailure(failure: MintIssuanceAttemptFailure): MintIssuanceAttemptFailure {
  return {
    ...failure,
    details: failure.details
      ? (JSON.parse(JSON.stringify(failure.details)) as Record<string, unknown>)
      : undefined,
  };
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
}

function normalizeMembers(members: MintIssuanceAttemptMember[]): MintIssuanceAttemptMember[] {
  if (members.length === 0) throw new Error('Mint issuance attempt members must not be empty');

  const operationIds = new Set<string>();
  const quoteIds = new Set<string>();
  return members.map((member) => {
    requireNonEmpty(member.operationId, 'Mint issuance attempt member operationId');
    requireNonEmpty(member.quoteId, 'Mint issuance attempt member quoteId');
    if (operationIds.has(member.operationId)) {
      throw new Error(`Duplicate Mint Operation member: ${member.operationId}`);
    }
    if (quoteIds.has(member.quoteId)) {
      throw new Error(`Duplicate mint quote member: ${member.quoteId}`);
    }
    operationIds.add(member.operationId);
    quoteIds.add(member.quoteId);

    const amount = Amount.from(member.amount);
    if (amount.isZero()) {
      throw new Error('Mint issuance attempt member amount must be positive');
    }
    return { operationId: member.operationId, quoteId: member.quoteId, amount };
  });
}

/** Validates, normalizes, and defensively clones an adapter-facing attempt record. */
export function normalizeMintIssuanceAttempt(attempt: MintIssuanceAttempt): MintIssuanceAttempt {
  requireNonEmpty(attempt.id, 'Mint issuance attempt id');
  if (!Number.isFinite(attempt.createdAt)) {
    throw new Error('Mint issuance attempt createdAt must be finite');
  }

  const base = {
    id: attempt.id,
    mintUrl: normalizeMintUrl(attempt.mintUrl),
    unit: normalizeUnit(attempt.unit),
    members: normalizeMembers(attempt.members),
    outputData: cloneOutputData(attempt.outputData),
    createdAt: attempt.createdAt,
  };

  if (attempt.state === 'prepared') return { ...base, state: 'prepared' };
  if (!Number.isFinite(attempt.submittedAt)) {
    throw new Error('Submitted Mint issuance attempt submittedAt must be finite');
  }
  if (attempt.state === 'failed') {
    requireNonEmpty(attempt.terminalFailure.message, 'Mint issuance attempt failure message');
    return {
      ...base,
      state: 'failed',
      submittedAt: attempt.submittedAt,
      terminalFailure: cloneFailure(attempt.terminalFailure),
    };
  }
  return { ...base, state: attempt.state, submittedAt: attempt.submittedAt };
}

/** Applies a legal transition, or returns null when the compare state does not match. */
export function applyMintIssuanceAttemptTransition(
  attempt: MintIssuanceAttempt,
  transition: MintIssuanceAttemptTransition,
): MintIssuanceAttempt | null {
  if (attempt.state !== transition.from) return null;

  if (transition.from === 'prepared' && transition.to === 'submitted') {
    return normalizeMintIssuanceAttempt({
      ...attempt,
      state: 'submitted',
      submittedAt: transition.submittedAt,
    });
  }
  if (attempt.state !== 'submitted') {
    throw new Error('Illegal Mint issuance attempt transition');
  }
  if (transition.from === 'submitted' && transition.to === 'succeeded') {
    return normalizeMintIssuanceAttempt({ ...attempt, state: 'succeeded' });
  }
  if (transition.from === 'submitted' && transition.to === 'failed') {
    return normalizeMintIssuanceAttempt({
      ...attempt,
      state: 'failed',
      terminalFailure: transition.terminalFailure,
    });
  }

  throw new Error(`Illegal Mint issuance attempt transition`);
}
