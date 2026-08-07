import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';

import {
  assertMintSwapOperationUpdate,
  assertMintSwapPreparationLeaseOwner,
  canTransitionMintSwap,
  createMintSwapPreparedPlanFingerprint,
  getMintSwapOperationDueAt,
  isMintSwapOperationDue,
  validateMintSwapOperation,
  type MintSwapOperation,
} from '../../operations/mintSwap/MintSwapOperation';
import {
  isOperationEventDue,
  isOperationEventPublished,
  operationEventLogicalKey,
  validateOperationEventOutboxRecord,
} from '../../models/OperationEventOutbox';
import {
  makeMintSwapOutboxRecord,
  makePreparedMintSwapOperation,
  makePreparingMintSwapOperation,
  makeSettledMintSwapOperation,
  MINT_SWAP_TEST_NOW as now,
} from '../fixtures/MintSwap';

describe('MintSwapOperation', () => {
  it('validates every parent state shape', () => {
    const preparing = makePreparingMintSwapOperation();
    const prepared = makePreparedMintSwapOperation();
    const sourceInflight = makePreparedMintSwapOperation({
      state: 'source_inflight',
      sourceDispatchAuthorizedAt: now + 2,
      updatedAt: now + 2,
    });
    const destinationFunded = makeSettledMintSwapOperation();
    const issuing = makeSettledMintSwapOperation({
      state: 'issuing',
      destinationIssueAuthorizedAt: now + 4,
      updatedAt: now + 4,
    });
    const completedBase = makeSettledMintSwapOperation();
    const completed: MintSwapOperation = {
      ...completedBase,
      state: 'completed',
      destinationIssueAuthorizedAt: now + 4,
      completedAt: now + 5,
      updatedAt: now + 5,
      settlement: {
        ...completedBase.settlement!,
        destinationAmountIssued: Amount.from(1_000),
      },
    };
    const cancelled = makePreparingMintSwapOperation({
      state: 'cancelled',
      preparationLease: undefined,
      cancellationRequestedAt: now + 1,
      cancelledAt: now + 2,
      updatedAt: now + 2,
    });
    const failed = makePreparingMintSwapOperation({
      state: 'failed',
      preparationLease: undefined,
      terminalFailure: { code: 'PREPARATION_FAILED', reason: 'No value moved', at: now + 1 },
      updatedAt: now + 1,
    });
    const attention = makePreparingMintSwapOperation({
      state: 'needs_attention',
      preparationLease: undefined,
      attention: {
        reason: 'canonical_observation_conflict',
        message: 'Conflicting preparation evidence',
        lastSafeState: 'preparing',
        violatedInvariant: 'canonical observations are monotonic',
        evidence: { stage: 'destination_quote' },
        at: now + 1,
      },
      updatedAt: now + 1,
    });

    for (const operation of [
      preparing,
      prepared,
      sourceInflight,
      destinationFunded,
      issuing,
      completed,
      cancelled,
      failed,
      attention,
    ]) {
      expect(validateMintSwapOperation(operation)).toBe(operation);
    }
  });

  it('makes terminal records immutable while permitting active same-state revisions', () => {
    expect(canTransitionMintSwap('issuing', 'issuing')).toBe(true);
    expect(canTransitionMintSwap('prepared', 'prepared')).toBe(false);
    expect(canTransitionMintSwap('needs_attention', 'needs_attention')).toBe(false);
    expect(canTransitionMintSwap('completed', 'completed')).toBe(false);
    expect(canTransitionMintSwap('cancelled', 'cancelled')).toBe(false);
    expect(canTransitionMintSwap('failed', 'failed')).toBe(false);

    const settled = makeSettledMintSwapOperation();
    const completed: MintSwapOperation = {
      ...settled,
      state: 'completed',
      destinationIssueAuthorizedAt: now + 4,
      completedAt: now + 5,
      updatedAt: now + 5,
      settlement: {
        ...settled.settlement!,
        destinationAmountIssued: Amount.from(1_000),
      },
    };
    expect(() =>
      assertMintSwapOperationUpdate(completed, {
        ...completed,
        revision: completed.revision + 1,
        updatedAt: completed.updatedAt + 1,
      }),
    ).toThrow('Illegal mint swap transition');
  });

  it('fences preparation ownership and excludes live leases from due work', () => {
    const preparing = makePreparingMintSwapOperation();
    expect(getMintSwapOperationDueAt(preparing)).toBe(now + 30_000);
    expect(isMintSwapOperationDue(preparing, now + 29_999)).toBe(false);
    expect(isMintSwapOperationDue(preparing, now + 30_000)).toBe(true);
    expect(() =>
      assertMintSwapPreparationLeaseOwner(preparing, 'worker-a', 'lease-token-a', now + 29_999),
    ).not.toThrow();
    expect(() =>
      assertMintSwapPreparationLeaseOwner(preparing, 'worker-b', 'lease-token-a'),
    ).toThrow('not owned');

    const attached = {
      ...preparing,
      revision: 1,
      destinationQuoteRef: {
        mintUrl: preparing.destinationMintUrl,
        method: 'bolt11' as const,
        quoteId: 'destination-quote',
      },
      preparationLease: {
        ...preparing.preparationLease!,
        stage: 'destination_child' as const,
        expiresAt: now + 60_000,
      },
      updatedAt: now + 1,
    };
    expect(() => assertMintSwapOperationUpdate(preparing, attached)).not.toThrow();

    expect(() =>
      assertMintSwapOperationUpdate(preparing, {
        ...preparing,
        revision: 1,
        preparationLease: {
          ownerId: 'worker-b',
          token: 'lease-token-b',
          stage: 'destination_quote',
          acquiredAt: now + 10_000,
          expiresAt: now + 40_000,
        },
        updatedAt: now + 10_000,
      }),
    ).toThrow('cannot be taken over before expiry');

    expect(() =>
      assertMintSwapOperationUpdate(preparing, {
        ...preparing,
        revision: 1,
        preparationLease: {
          ownerId: 'worker-b',
          token: 'lease-token-b',
          stage: 'destination_quote',
          acquiredAt: now + 30_000,
          expiresAt: now + 60_000,
        },
        updatedAt: now + 30_000,
      }),
    ).not.toThrow();

    expect(() =>
      assertMintSwapOperationUpdate(preparing, {
        ...preparing,
        revision: 1,
        preparationLease: {
          ...preparing.preparationLease!,
          expiresAt: now + 60_000,
        },
        updatedAt: now + 30_000,
      }),
    ).toThrow('cannot be renewed or advanced after expiry');
  });

  it('rejects preparation stages that contradict attached durable facts', () => {
    expect(() =>
      validateMintSwapOperation(
        makePreparingMintSwapOperation({
          destinationQuoteRef: {
            mintUrl: 'https://destination.mint.test',
            method: 'bolt11',
            quoteId: 'already-attached',
          },
        }),
      ),
    ).toThrow('contradicts attached records');
  });

  it('enforces the prepared and settled accounting equations', () => {
    expect(() =>
      validateMintSwapOperation(
        makePreparedMintSwapOperation({
          preparedPlan: {
            ...makePreparedMintSwapOperation().preparedPlan!,
            minimumSourceDebit: Amount.from(1_006),
          },
        }),
      ),
    ).toThrow('minimum source debit does not reconcile');

    expect(() =>
      validateMintSwapOperation(
        makeSettledMintSwapOperation({
          settlement: {
            ...makeSettledMintSwapOperation().settlement!,
            finalSourceDebit: Amount.from(1_011),
          },
        }),
      ),
    ).toThrow('final source debit from fees does not reconcile');
  });

  it('accepts only the fee-reserve or full-reserved maximum bound', () => {
    const prepared = makePreparedMintSwapOperation();
    expect(() =>
      validateMintSwapOperation({
        ...prepared,
        preparedPlan: {
          ...prepared.preparedPlan!,
          maximumSourceDebit: Amount.from(1_024),
        },
      }),
    ).toThrow('must use the fee-reserve or reserved-input bound');

    expect(() =>
      validateMintSwapOperation({
        ...prepared,
        preparedPlan: {
          ...prepared.preparedPlan!,
          maximumSourceDebit: prepared.preparedPlan!.reservedSourceAmount,
        },
      }),
    ).not.toThrow();
  });

  it('keeps attached quote, child, key, plan, and settlement facts immutable', () => {
    const current = makePreparedMintSwapOperation();
    const update = (overrides: Partial<MintSwapOperation>): MintSwapOperation => ({
      ...current,
      state: 'source_inflight',
      revision: current.revision + 1,
      sourceDispatchAuthorizedAt: now + 2,
      updatedAt: current.updatedAt + 1,
      ...overrides,
    });

    expect(() =>
      assertMintSwapOperationUpdate(
        current,
        update({
          destinationNut20Key: { ...current.destinationNut20Key, derivationIndex: 8 },
        }),
      ),
    ).toThrow('NUT-20 derivation index is immutable');
    expect(() =>
      assertMintSwapOperationUpdate(
        current,
        update({
          sourceQuoteRef: { ...current.sourceQuoteRef!, quoteId: 'replacement' },
        }),
      ),
    ).toThrow('attached source quote is immutable');
    expect(() =>
      assertMintSwapOperationUpdate(
        current,
        update({
          preparedPlan: {
            ...current.preparedPlan!,
            maximumSourceDebit: Amount.from(1_040),
          },
        }),
      ),
    ).toThrow('maximum source debit is immutable');
  });

  it('rejects impossible authorization projections and unaudited attention recovery', () => {
    expect(() =>
      validateMintSwapOperation(
        makePreparedMintSwapOperation({ sourceDispatchAuthorizedAt: now + 1 }),
      ),
    ).toThrow('cannot authorize source dispatch');
    expect(() =>
      validateMintSwapOperation(
        makePreparingMintSwapOperation({ destinationIssueAuthorizedAt: now }),
      ),
    ).toThrow('cannot authorize destination issuance');
    expect(() =>
      validateMintSwapOperation(
        makeSettledMintSwapOperation({
          state: 'issuing',
          destinationIssueAuthorizedAt: now + 1,
        }),
      ),
    ).toThrow('must follow source dispatch');
    expect(() =>
      validateMintSwapOperation(
        makePreparedMintSwapOperation({
          state: 'cancelled',
          cancellationRequestedAt: now + 2,
          cancelledAt: now + 1,
          updatedAt: now + 2,
        }),
      ),
    ).toThrow('cancellation completion must follow its request');

    const attention = makePreparedMintSwapOperation({
      state: 'needs_attention',
      attention: {
        reason: 'accounting_mismatch',
        message: 'Issuing evidence is incomplete',
        lastSafeState: 'issuing',
        violatedInvariant: 'issuance requires durable authorization',
        evidence: {},
        at: now + 2,
      },
      updatedAt: now + 2,
    });
    expect(() => validateMintSwapOperation(attention)).toThrow('source dispatch authorization');
    expect(canTransitionMintSwap('needs_attention', 'completed')).toBe(false);

    const sourceInflight = makePreparedMintSwapOperation({
      state: 'source_inflight',
      sourceDispatchAuthorizedAt: now + 2,
      updatedAt: now + 2,
    });
    expect(() =>
      validateMintSwapOperation({
        ...sourceInflight,
        state: 'failed',
        terminalFailure: { code: 'UNPAID', reason: 'Source returned unpaid', at: now + 3 },
        updatedAt: now + 3,
      }),
    ).toThrow('requires source reclamation evidence');
    expect(() =>
      validateMintSwapOperation({
        ...sourceInflight,
        state: 'failed',
        sourceReclaimedAt: now + 3,
        terminalFailure: { code: 'UNPAID', reason: 'Source returned unpaid', at: now + 3 },
        updatedAt: now + 3,
      }),
    ).not.toThrow();
  });

  it('keeps creation and retry evidence monotonic across CAS updates', () => {
    const current = makePreparingMintSwapOperation({
      createdAt: now - 10,
      retry: { attemptCount: 2, lastAttemptAt: now, lastSuccessfulObservationAt: now },
    });
    const next = {
      ...current,
      revision: current.revision + 1,
      preparationLease: { ...current.preparationLease!, expiresAt: now + 60_000 },
      updatedAt: now + 1,
    };
    expect(() =>
      assertMintSwapOperationUpdate(current, { ...next, createdAt: current.createdAt - 1 }),
    ).toThrow('createdAt is immutable');
    expect(() =>
      assertMintSwapOperationUpdate(current, {
        ...next,
        retry: { attemptCount: 1, lastAttemptAt: now, lastSuccessfulObservationAt: now },
      }),
    ).toThrow('attempt count cannot regress');
    expect(() =>
      assertMintSwapOperationUpdate(current, {
        ...next,
        retry: { attemptCount: 2, lastAttemptAt: now - 1, lastSuccessfulObservationAt: now },
      }),
    ).toThrow('last attempt cannot regress');
  });

  it('fingerprints canonical object keys while remaining sensitive to ordered plans and keys', () => {
    const prepared = makePreparedMintSwapOperation();
    const common = {
      destinationMintOperationId: prepared.destinationMintOperationId!,
      sourceMeltOperationId: prepared.sourceMeltOperationId!,
      destinationQuoteRef: prepared.destinationQuoteRef!,
      sourceQuoteRef: prepared.sourceQuoteRef!,
      destinationNut20Key: prepared.destinationNut20Key,
      destinationAmount: prepared.destinationAmount,
      unit: 'sat' as const,
      sourceInputProofSecrets: ['a', 'b'],
      sourceOutputData: {
        keep: [],
        send: [
          {
            blindedMessage: { amount: '1025', id: 'source-keyset', B_: 'source-B' },
            blindingFactor: '02',
            secret: '62',
          },
        ],
      },
      sourceMeltAmount: prepared.preparedPlan!.sourceMeltAmount,
      sourceFeeReserve: prepared.preparedPlan!.sourceFeeReserve,
      sourcePreparationFee: prepared.preparedPlan!.sourcePreparationFee,
      sourceMeltInputFee: prepared.preparedPlan!.sourceMeltInputFee,
      minimumSourceDebit: prepared.preparedPlan!.minimumSourceDebit,
      maximumSourceDebit: prepared.preparedPlan!.maximumSourceDebit,
      reservedSourceAmount: prepared.preparedPlan!.reservedSourceAmount,
      dispatchDeadlineSeconds: prepared.preparedPlan!.dispatchDeadlineSeconds,
      requiredDispatchWindowSeconds: prepared.preparedPlan!.requiredDispatchWindowSeconds,
    };
    const first = createMintSwapPreparedPlanFingerprint({
      ...common,
      destinationOutputData: {
        keep: [
          {
            blindedMessage: { amount: '1000', id: 'destination-keyset', B_: 'destination-B' },
            blindingFactor: '01',
            secret: '61',
          },
        ],
        send: [],
      },
    });
    const reordered = createMintSwapPreparedPlanFingerprint({
      ...common,
      destinationOutputData: {
        send: [],
        keep: [
          {
            secret: '61',
            blindingFactor: '01',
            blindedMessage: { B_: 'destination-B', id: 'destination-keyset', amount: '1000' },
          },
        ],
      },
    });
    const changedKey = createMintSwapPreparedPlanFingerprint({
      ...common,
      destinationNut20Key: { ...prepared.destinationNut20Key, derivationIndex: 8 },
      destinationOutputData: firstOutputData(),
    });
    const changedOrder = createMintSwapPreparedPlanFingerprint({
      ...common,
      sourceInputProofSecrets: ['b', 'a'],
      destinationOutputData: firstOutputData(),
    });
    const changedDeadline = createMintSwapPreparedPlanFingerprint({
      ...common,
      dispatchDeadlineSeconds: common.dispatchDeadlineSeconds + 1,
      destinationOutputData: firstOutputData(),
    });
    const changedWindow = createMintSwapPreparedPlanFingerprint({
      ...common,
      requiredDispatchWindowSeconds: common.requiredDispatchWindowSeconds + 1,
      destinationOutputData: firstOutputData(),
    });

    expect(first).toBe(reordered);
    expect(changedKey).not.toBe(first);
    expect(changedOrder).not.toBe(first);
    expect(changedDeadline).not.toBe(first);
    expect(changedWindow).not.toBe(first);
    expect(
      createMintSwapPreparedPlanFingerprint({
        ...common,
        sourceFeeReserve: common.sourceFeeReserve.add(1),
        destinationOutputData: firstOutputData(),
      }),
    ).not.toBe(first);
    expect(() =>
      createMintSwapPreparedPlanFingerprint({
        ...common,
        destinationOutputData: new Map() as never,
      }),
    ).toThrow('plain objects');
  });
});

function firstOutputData() {
  return {
    keep: [
      {
        blindedMessage: { amount: '1000', id: 'destination-keyset', B_: 'destination-B' },
        blindingFactor: '01',
        secret: '61',
      },
    ],
    send: [],
  };
}

describe('OperationEventOutbox', () => {
  it('validates a sanitized logical event and derives its unique key', () => {
    const event = makeMintSwapOutboxRecord();
    expect(validateOperationEventOutboxRecord(event)).toBe(event);
    expect(operationEventLogicalKey(event)).toBe('mint-swap-op\u00001\u0000mint-swap-op:prepared');
  });

  it('uses explicit publication and due semantics', () => {
    expect(isOperationEventPublished({ publishedAt: 0 })).toBe(true);
    expect(isOperationEventDue({ nextAttemptAt: now + 10 }, now + 9)).toBe(false);
    expect(isOperationEventDue({ nextAttemptAt: now + 10 }, now + 10)).toBe(true);
    expect(isOperationEventDue({ publishedAt: now, nextAttemptAt: now - 1 }, now + 10)).toBe(false);
  });

  it('rejects mismatched transition payloads and published retry residue', () => {
    const event = makeMintSwapOutboxRecord();
    expect(() =>
      validateOperationEventOutboxRecord({
        ...event,
        payload: { ...event.payload, state: 'issuing' },
      }),
    ).toThrow('payload must contain state prepared');
    expect(() =>
      validateOperationEventOutboxRecord({
        ...event,
        publishedAt: now + 2,
        nextAttemptAt: now + 3,
      }),
    ).toThrow('cannot retain retry scheduling');
    expect(() =>
      validateOperationEventOutboxRecord({
        ...event,
        eventType: 'mint-swap-op:delayed',
        payload: { ...event.payload, state: 'completed', reasonCode: 'RETRY_EXHAUSTED' },
      }),
    ).toThrow('automatic operation state');
    expect(() =>
      validateOperationEventOutboxRecord({
        ...event,
        eventType: 'mint-swap-op:delayed',
        payload: { ...event.payload, state: 'source_inflight' },
      }),
    ).toThrow('requires a reason code');
  });
});
