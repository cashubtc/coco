export type OperationState = 'pending' | 'prepared' | 'executing' | 'finalized';
export type AttemptPhase = 'submitted' | 'ambiguous' | 'recovering' | 'restoring' | 'finalized';

export interface PrototypeOperation {
  id: string;
  quoteId: string;
  createdAt: number;
  state: OperationState;
  scheduled: boolean;
  attemptId?: string;
  outcome: string;
}

export interface PrototypeAttempt {
  id: string;
  kind: 'single' | 'batch';
  phase: AttemptPhase;
  source: 'explicit' | 'processor';
  requestedOperationId?: string;
  memberIds: string[];
  outputSetId: string;
  submissions: number;
}

export interface PrototypeState {
  nut29Available: boolean;
  batchLimit: number;
  mintLock: 'free' | 'held';
  transaction: 'idle' | 'committed';
  operations: PrototypeOperation[];
  attempt?: PrototypeAttempt;
  caller: string;
  trace: string[];
}

export type PrototypeAction =
  | { type: 'toggle_capability' }
  | { type: 'explicit_dispatch' }
  | { type: 'processor_dispatch' }
  | { type: 'competing_explicit' }
  | { type: 'success' }
  | { type: 'ambiguous' }
  | { type: 'restart' }
  | { type: 'observe_all_paid' }
  | { type: 'observe_all_issued' }
  | { type: 'recover_proofs' };

export function createPrototypeState(): PrototypeState {
  return {
    nut29Available: true,
    batchLimit: 3,
    mintLock: 'free',
    transaction: 'idle',
    operations: [
      {
        id: 'operation-1',
        quoteId: 'quote-1',
        createdAt: 1,
        state: 'pending',
        scheduled: true,
        outcome: 'PAID and scheduled by the processor',
      },
      {
        id: 'operation-2',
        quoteId: 'quote-2',
        createdAt: 2,
        state: 'pending',
        scheduled: true,
        outcome: 'PAID and scheduled by the processor',
      },
      {
        id: 'operation-3',
        quoteId: 'quote-3',
        createdAt: 3,
        state: 'pending',
        scheduled: false,
        outcome: 'PAID; available to an explicit caller',
      },
    ],
    caller: 'idle',
    trace: [
      'MintOperationProcessor called schedule(operation-1) and schedule(operation-2).',
      'No batch exists; the coordinator holds only individual readiness entries.',
    ],
  };
}

function append(state: PrototypeState, ...messages: string[]): PrototypeState {
  return { ...state, trace: [...state.trace, ...messages] };
}

function persistAttempt(
  state: PrototypeState,
  source: PrototypeAttempt['source'],
  targetId?: string,
): PrototypeState {
  const scheduled = state.operations
    .filter((operation) => operation.state === 'pending' && operation.scheduled)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const target = targetId
    ? state.operations.find(
        (operation) => operation.id === targetId && operation.state === 'pending',
      )
    : undefined;
  const candidates = target
    ? [target, ...scheduled.filter((operation) => operation.id !== target.id)]
    : scheduled;
  const limit = state.nut29Available ? state.batchLimit : 1;
  const selected = candidates.slice(0, limit);

  if (selected.length === 0) {
    return append(state, 'Coordinator found no ready Mint Operations; no attempt was created.');
  }

  const memberIds = selected.map((operation) => operation.id);
  const attempt: PrototypeAttempt = {
    id: 'attempt-A',
    kind: memberIds.length > 1 ? 'batch' : 'single',
    phase: 'submitted',
    source,
    requestedOperationId: targetId,
    memberIds,
    outputSetId: 'outputs-A',
    submissions: 1,
  };

  const operations = state.operations.map((operation) =>
    memberIds.includes(operation.id)
      ? {
          ...operation,
          state: 'executing' as const,
          scheduled: false,
          attemptId: attempt.id,
          outcome: `reserved by ${attempt.id}; awaiting its atomic outcome`,
        }
      : operation,
  );

  return append(
    {
      ...state,
      mintLock: 'free',
      transaction: 'committed',
      operations,
      attempt,
      caller:
        source === 'explicit'
          ? `MintOpsApi awaits ${targetId} through ${attempt.id}`
          : 'MintOperationProcessor awaits one scheduled coordination turn',
    },
    source === 'explicit'
      ? `MintOperationService delegated coordinate(${targetId}) immediately.`
      : 'MintOperationProcessor called coordinate() after its scheduling window.',
    'MintIssuanceCoordinator acquired the shared mint lock and re-read durable eligibility.',
    state.nut29Available
      ? `Coordinator selected [${memberIds.join(', ')}] under NUT-29.`
      : `NUT-29 unavailable; coordinator selected only [${memberIds.join(', ')}].`,
    `One transaction allocated outputs-A, persisted attempt-A, and attached its members.`,
    'Coordinator marked the exact attempt submitted, released the lock, and called the mint transport.',
  );
}

function finalizeAttempt(state: PrototypeState, recovered: boolean): PrototypeState {
  if (!state.attempt) return state;
  const memberIds = state.attempt.memberIds;
  return append(
    {
      ...state,
      operations: state.operations.map((operation) =>
        memberIds.includes(operation.id)
          ? {
              ...operation,
              state: 'finalized' as const,
              outcome: 'complete exact proofs are stored locally',
            }
          : operation,
      ),
      attempt: { ...state.attempt, phase: 'finalized' },
      transaction: 'committed',
      caller: state.attempt.requestedOperationId
        ? `MintOpsApi receives ${state.attempt.requestedOperationId} as finalized`
        : 'processor turn complete',
    },
    recovered
      ? 'Coordinator restored the complete exact output set owned by attempt-A.'
      : 'Coordinator validated the complete returned signature set for outputs-A.',
    'One transaction saved proofs and finalized the attempt and every member.',
    'Normal per-operation events emitted after commit; no public Mint Batch event was required.',
  );
}

export function reducePrototype(state: PrototypeState, action: PrototypeAction): PrototypeState {
  switch (action.type) {
    case 'toggle_capability':
      if (state.attempt) return state;
      return append(
        { ...state, nut29Available: !state.nut29Available },
        `NUT-29 capability set to ${state.nut29Available ? 'unavailable' : 'available'}.`,
      );

    case 'explicit_dispatch':
      if (state.attempt) return state;
      return persistAttempt(state, 'explicit', 'operation-3');

    case 'processor_dispatch':
      if (state.attempt) return state;
      return persistAttempt(state, 'processor');

    case 'competing_explicit': {
      const attempt = state.attempt;
      if (!attempt || attempt.phase === 'finalized') return state;
      const targetId = attempt.memberIds[attempt.memberIds.length - 1]!;
      return append(
        {
          ...state,
          caller: `A second explicit caller joins ${attempt.id} for ${targetId}`,
        },
        `MintOperationService delegated coordinate(${targetId}).`,
        `Coordinator found ${targetId} attached to ${attempt.id}; it allocated no outputs and created no competing attempt.`,
      );
    }

    case 'success':
      if (state.attempt?.phase !== 'submitted') return state;
      return finalizeAttempt(state, false);

    case 'ambiguous':
      if (state.attempt?.phase !== 'submitted') return state;
      return append(
        {
          ...state,
          attempt: { ...state.attempt, phase: 'ambiguous' },
          caller: 'requested Mint Operation remains executing and recoverable',
        },
        'Mint transport timed out; coordinator classified the submission as ambiguous.',
        'The exact attempt, member order, and outputs-A remain durable; no fallback is allowed.',
      );

    case 'restart':
      if (!state.attempt || !['submitted', 'ambiguous'].includes(state.attempt.phase)) return state;
      return append(
        {
          ...state,
          attempt: { ...state.attempt, phase: 'recovering' },
          caller: 'startup recovery coordinates an existing member',
        },
        'Ephemeral schedule entries were lost on restart; durable operation and attempt state remained.',
        `Recovery called coordinate(${state.attempt.memberIds[0]}); coordinator loaded attempt-A rather than rebuilding a batch.`,
        'Coordinator begins recovery with attributable canonical quote observations.',
      );

    case 'observe_all_paid':
      if (state.attempt?.phase !== 'recovering') return state;
      return append(
        {
          ...state,
          attempt: {
            ...state.attempt,
            phase: 'submitted',
            submissions: state.attempt.submissions + 1,
          },
          caller: 'recovery resubmits the exact persisted attempt',
        },
        'Every member remains PAID; coordinator resubmitted attempt-A with the same order and outputs-A.',
      );

    case 'observe_all_issued':
      if (state.attempt?.phase !== 'recovering') return state;
      return append(
        {
          ...state,
          attempt: { ...state.attempt, phase: 'restoring' },
          caller: 'recovery restores outputs-A through NUT-09',
        },
        'Every member is ISSUED; coordinator entered exact-output recovery for attempt-A.',
      );

    case 'recover_proofs':
      if (state.attempt?.phase !== 'restoring') return state;
      return finalizeAttempt(state, true);
  }
}
