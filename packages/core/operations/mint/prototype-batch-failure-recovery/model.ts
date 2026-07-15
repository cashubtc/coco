export type AttemptPhase =
  | 'submitted'
  | 'checking_quotes'
  | 'ready_to_resume'
  | 'recovering_outputs'
  | 'rejected'
  | 'finalized'
  | 'critical_failure';

export type CheckReason = 'ambiguous' | 'state_rejection' | 'validation_rejection' | null;
export type QuoteState = 'PAID' | 'ISSUED' | 'UNPAID' | 'UNKNOWN';
export type OperationState = 'executing' | 'pending' | 'finalized' | 'failed';
export type NextDispatch = 'none' | 'normal_pool' | 'single_fallback' | 'rechunk';

export interface PrototypeMember {
  id: string;
  quoteId: string;
  quoteState: QuoteState;
  operationState: OperationState;
  outcome: string;
}

export interface PrototypeState {
  attempt: {
    id: string;
    phase: AttemptPhase;
    checkReason: CheckReason;
    outputSetId: string;
    submissions: number;
    expectedProofs: number;
    readyProofs: number;
    error?: string;
  };
  members: PrototypeMember[];
  nextDispatch: NextDispatch;
  history: string[];
}

export type PrototypeAction =
  | { type: 'valid_success' }
  | { type: 'ambiguous_response' }
  | { type: 'state_rejection' }
  | { type: 'validation_rejection' }
  | { type: 'endpoint_rejection' }
  | { type: 'batch_size_rejection' }
  | { type: 'observe_all_paid' }
  | { type: 'observe_all_issued' }
  | { type: 'observe_mixed' }
  | { type: 'observe_unpaid_and_expired' }
  | { type: 'check_unusable' }
  | { type: 'resume_same_attempt' }
  | { type: 'recover_full' }
  | { type: 'recover_none' }
  | { type: 'recover_partial' }
  | { type: 'recovery_unusable' };

export function createPrototypeState(): PrototypeState {
  return {
    attempt: {
      id: 'attempt-A',
      phase: 'submitted',
      checkReason: null,
      outputSetId: 'outputs-A',
      submissions: 1,
      expectedProofs: 4,
      readyProofs: 0,
    },
    members: ['quote-1', 'quote-2', 'quote-3'].map((quoteId, index) => ({
      id: `operation-${index + 1}`,
      quoteId,
      quoteState: 'PAID' as const,
      operationState: 'executing' as const,
      outcome: 'awaiting attempt outcome',
    })),
    nextDispatch: 'none',
    history: ['Persisted and submitted attempt-A with outputs-A.'],
  };
}

function append(state: PrototypeState, message: string): PrototypeState {
  return { ...state, history: [...state.history, message] };
}

function withMembers(
  state: PrototypeState,
  update: (member: PrototypeMember, index: number) => PrototypeMember,
): PrototypeState {
  return { ...state, members: state.members.map(update) };
}

function finishWithProofs(state: PrototypeState): PrototypeState {
  const updated = withMembers(state, (member) => ({
    ...member,
    quoteState: 'ISSUED',
    operationState: 'finalized',
    outcome: 'complete exact proofs recovered',
  }));
  return append(
    {
      ...updated,
      attempt: {
        ...updated.attempt,
        phase: 'finalized',
        checkReason: null,
        readyProofs: updated.attempt.expectedProofs,
        error: undefined,
      },
      nextDispatch: 'none',
    },
    'The complete exact proof set is ready; every member finalized.',
  );
}

function failAllExternallyIssued(state: PrototypeState): PrototypeState {
  const updated = withMembers(state, (member) => ({
    ...member,
    quoteState: 'ISSUED',
    operationState: 'failed',
    outcome: 'quote redeemed elsewhere; no exact local proofs',
  }));
  return append(
    {
      ...updated,
      attempt: {
        ...updated.attempt,
        phase: 'rejected',
        checkReason: null,
        error: 'No exact attempt proofs were recoverable.',
      },
      nextDispatch: 'none',
    },
    'All quotes were issued elsewhere; every member failed.',
  );
}

export function reducePrototype(state: PrototypeState, action: PrototypeAction): PrototypeState {
  switch (action.type) {
    case 'valid_success':
      if (state.attempt.phase !== 'submitted') return state;
      return finishWithProofs(state);

    case 'ambiguous_response':
    case 'state_rejection':
    case 'validation_rejection': {
      if (state.attempt.phase !== 'submitted') return state;
      const checkReason: Exclude<CheckReason, null> =
        action.type === 'ambiguous_response'
          ? 'ambiguous'
          : action.type === 'state_rejection'
            ? 'state_rejection'
            : 'validation_rejection';
      return append(
        {
          ...state,
          attempt: { ...state.attempt, phase: 'checking_quotes', checkReason },
        },
        `Started quote-state reconciliation after ${checkReason.replaceAll('_', ' ')}.`,
      );
    }

    case 'batch_size_rejection': {
      if (state.attempt.phase !== 'submitted') return state;
      const updated = withMembers(state, (member) => ({
        ...member,
        operationState: 'pending',
        outcome: 'rechunk at the reduced effective batch limit',
      }));
      return append(
        {
          ...updated,
          attempt: { ...updated.attempt, phase: 'rejected', checkReason: null },
          nextDispatch: 'rechunk',
        },
        'Confirmed batch-size rejection; members will be deterministically rechunked.',
      );
    }

    case 'endpoint_rejection': {
      if (state.attempt.phase !== 'submitted') return state;
      const updated = withMembers(state, (member) => ({
        ...member,
        operationState: 'pending',
        outcome: 'eligible for a fresh single-member attempt',
      }));
      return append(
        {
          ...updated,
          attempt: { ...updated.attempt, phase: 'rejected', checkReason: null },
          nextDispatch: 'single_fallback',
        },
        'Endpoint incompatibility confirmed; use singles until capability refresh.',
      );
    }

    case 'observe_all_paid': {
      if (state.attempt.phase !== 'checking_quotes') return state;
      const observed = withMembers(state, (member) => ({
        ...member,
        quoteState: 'PAID',
      }));
      if (state.attempt.checkReason === 'ambiguous') {
        return append(
          {
            ...observed,
            attempt: { ...observed.attempt, phase: 'ready_to_resume', checkReason: null },
          },
          'All quotes remain PAID; the same attempt and exact outputs may resume.',
        );
      }

      const nextDispatch =
        state.attempt.checkReason === 'validation_rejection' ? 'single_fallback' : 'normal_pool';
      const pending = withMembers(observed, (member) => ({
        ...member,
        operationState: 'pending',
        outcome:
          nextDispatch === 'single_fallback'
            ? 'eligible for a fresh single-member attempt'
            : 'eligible for normal dispatch grouping',
      }));
      return append(
        {
          ...pending,
          attempt: { ...pending.attempt, phase: 'rejected', checkReason: null },
          nextDispatch,
        },
        nextDispatch === 'single_fallback'
          ? 'Eligibility was unchanged after a validation rejection; fall back to singles.'
          : 'Eligibility filtering changed nothing; all members return to the normal pool.',
      );
    }

    case 'observe_all_issued': {
      if (state.attempt.phase !== 'checking_quotes') return state;
      const observed = withMembers(state, (member) => ({
        ...member,
        quoteState: 'ISSUED',
      }));
      if (state.attempt.checkReason !== 'ambiguous') {
        return failAllExternallyIssued(observed);
      }
      return append(
        {
          ...observed,
          attempt: { ...observed.attempt, phase: 'recovering_outputs', checkReason: null },
        },
        'All quotes are ISSUED after ambiguity; enter exact-output NUT-09 recovery.',
      );
    }

    case 'observe_mixed': {
      if (state.attempt.phase !== 'checking_quotes') return state;
      const updated = withMembers(state, (member, index) =>
        index === 0
          ? {
              ...member,
              quoteState: 'ISSUED',
              operationState: 'failed',
              outcome: 'redeemed elsewhere; no NUT-09 recovery for a mixed batch',
            }
          : {
              ...member,
              quoteState: 'PAID',
              operationState: 'pending',
              outcome: 'eligible for normal dispatch grouping',
            },
      );
      return append(
        {
          ...updated,
          attempt: { ...updated.attempt, phase: 'rejected', checkReason: null },
          nextDispatch: 'normal_pool',
        },
        'Mixed states prove the atomic batch did not issue; filter members independently.',
      );
    }

    case 'observe_unpaid_and_expired': {
      if (state.attempt.phase !== 'checking_quotes') return state;
      const updated = withMembers(state, (member, index) => {
        if (index === 0) {
          return {
            ...member,
            quoteState: 'UNPAID',
            operationState: 'pending',
            outcome: 'unexpired and waiting for payment',
          };
        }
        if (index === 1) {
          return {
            ...member,
            quoteState: 'UNPAID',
            operationState: 'failed',
            outcome: 'unpaid and expired',
          };
        }
        return {
          ...member,
          quoteState: 'PAID',
          operationState: 'pending',
          outcome: 'eligible for normal dispatch grouping',
        };
      });
      return append(
        {
          ...updated,
          attempt: { ...updated.attempt, phase: 'rejected', checkReason: null },
          nextDispatch: 'normal_pool',
        },
        'Per-quote eligibility reconciled without retrying the rejected attempt.',
      );
    }

    case 'check_unusable':
      if (state.attempt.phase !== 'checking_quotes') return state;
      return append(
        state,
        'Quote check was unusable; keep the attempt undispatched and retry the check later.',
      );

    case 'resume_same_attempt':
      if (state.attempt.phase !== 'ready_to_resume') return state;
      return append(
        {
          ...state,
          attempt: {
            ...state.attempt,
            phase: 'submitted',
            submissions: state.attempt.submissions + 1,
          },
        },
        'Resubmitted the same attempt, member order, and exact output set.',
      );

    case 'recover_full':
      if (state.attempt.phase !== 'recovering_outputs') return state;
      return finishWithProofs(state);

    case 'recover_none':
      if (state.attempt.phase !== 'recovering_outputs') return state;
      return failAllExternallyIssued(state);

    case 'recovery_unusable':
      if (state.attempt.phase !== 'recovering_outputs') return state;
      return append(
        state,
        'NUT-09 recovery was unusable; keep every member executing and retry later.',
      );

    case 'recover_partial': {
      if (state.attempt.phase !== 'recovering_outputs') return state;
      const updated = withMembers(state, (member) => ({
        ...member,
        operationState: 'failed',
        outcome: 'critical batch atomicity violation',
      }));
      return append(
        {
          ...updated,
          attempt: {
            ...updated.attempt,
            phase: 'critical_failure',
            readyProofs: 2,
            error: 'The mint signed only part of an atomic output set.',
          },
          nextDispatch: 'none',
        },
        'Saved every valid proof as ready, failed all members, and prohibited quote retry.',
      );
    }
  }
}
