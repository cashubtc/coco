import { describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import type {
  MintSwapOperation,
  MintSwapOperationState,
} from '../../operations/mintSwap/MintSwapOperation.ts';
import { parseMintSwapOperation } from '../../operations/mintSwap/parseMintSwapOperation.ts';
import { validateMintSwapTransition } from '../../operations/mintSwap/validateMintSwapTransition.ts';
import {
  initialMintSwapRetry,
  mintSwapCheckpoint,
  mintSwapFixtures,
  MINT_SWAP_CREATED_AT as T,
} from '../fixtures/MintSwap.ts';

const STATES = Object.keys(mintSwapFixtures()) as MintSwapOperationState[];
type Raw = Record<string, unknown>;
function raw(state: MintSwapOperationState = 'preparing'): Raw {
  return JSON.parse(JSON.stringify(mintSwapFixtures()[state]));
}
function nested(value: Raw, field: string): Raw {
  return value[field] as Raw;
}
function stamp(next: MintSwapOperation, revision = 1): MintSwapOperation {
  return { ...next, revision };
}

describe('Mint Swap V1 persisted state shapes', () => {
  for (const state of STATES) {
    it(`round-trips ${state} with reconstructed Amount values`, () => {
      const fixture = mintSwapFixtures()[state];
      const parsed = parseMintSwapOperation(raw(state));
      expect(parsed).toEqual(fixture);
      expect(parsed.destinationAmount).toBeInstanceOf(Amount);
      expect(parsed).not.toBe(fixture);
    });
  }

  const examples: Raw = {
    ...raw('completed'),
    ...raw('cancelled'),
    ...raw('failed'),
    ...raw('needs_attention'),
  };
  const stateFields = [
    'sourceDebitBounds',
    'sourceStartedAt',
    'sourceSettlement',
    'destinationStartedAt',
    'destinationCompletion',
    'completedAt',
    'lastSafe',
    'valueNeutral',
    'cancelledAt',
    'failure',
    'failedAt',
    'attention',
    'attentionAt',
  ];
  for (const state of STATES) {
    for (const field of stateFields) {
      it(`${state} ${field in raw(state) ? 'requires' : 'forbids'} ${field}`, () => {
        const value = raw(state);
        if (field in value) delete value[field];
        else value[field] = examples[field];
        expect(() => parseMintSwapOperation(value)).toThrow(TypeError);
      });
    }
  }

  it.each([null, undefined, true, [], 1, 'record', new Date()].map((value) => [value] as const))(
    'rejects non-record input %p',
    (value) => {
      expect(() => parseMintSwapOperation(value)).toThrow(TypeError);
    },
  );

  it('rejects recursive checkpoints, parent copies, and forbidden checkpoint facts', () => {
    for (const value of [
      raw('prepared'),
      { ...mintSwapCheckpoint(mintSwapFixtures().prepared), lastSafe: {} },
      { state: 'completed', stateEnteredAt: T },
      {
        state: 'preparing',
        stateEnteredAt: T,
        sourceDebitBounds: mintSwapFixtures().prepared.sourceDebitBounds,
      },
    ]) {
      expect(() =>
        parseMintSwapOperation({ ...raw('needs_attention'), lastSafe: value }),
      ).toThrow();
    }
  });

  it('defensively reconstructs nested Amount, quote, retry, and checkpoint evidence', () => {
    const source = mintSwapFixtures().needs_attention;
    const parsed = parseMintSwapOperation(source);
    source.sourceQuote.quoteId = 'changed';
    source.lastSafe.sourceDebitBounds!.minimum = Amount.from(999);
    source.attention.evidence.observedAt++;
    expect(parsed).toEqual(mintSwapFixtures().needs_attention);
    expect(parsed.destinationAmount).not.toBe(source.destinationAmount);
  });
});

describe('Mint Swap identity and serialization boundaries', () => {
  const invalid: Array<[string, unknown]> = [
    ['schemaVersion', 0],
    ['schemaVersion', 2],
    ['schemaVersion', '1'],
    ['state', 'issuing'],
    ['unit', 'msat'],
    ['unit', 'SAT'],
    ['unit', 'sat '],
    ['id', ''],
    ['id', ' '],
    ['sourceOperationId', ''],
    ['destinationOperationId', null],
    ['revision', -1],
    ['revision', 0.5],
    ['revision', Number.MAX_SAFE_INTEGER + 1],
    ['revision', '0'],
    ['sourceMintUrl', 'https://SOURCE.example'],
    ['sourceMintUrl', 'https://source.example/'],
    ['sourceMintUrl', 'https://source.example:443'],
    ['sourceMintUrl', 'https://source.example/?secret=1'],
    ['sourceMintUrl', 'https://source.example#fragment'],
    ['sourceMintUrl', 'https://user:pass@source.example'],
    ['sourceMintUrl', 'not a URL'],
    ['destinationMintUrl', 'https://source.example'],
    ['paymentRequestHash', ''],
    ['paymentRequestHash', 'ab'.repeat(31)],
    ['paymentRequestHash', 'AB'.repeat(32)],
    ['paymentRequestHash', 'zz'.repeat(32)],
    ['kind', 'mint-swap'],
    ['key', 'secret'],
  ];
  for (const [field, value] of invalid) {
    it(`rejects invalid ${field}: ${String(value).slice(0, 50)}`, () => {
      expect(() => parseMintSwapOperation({ ...raw(), [field]: value })).toThrow(TypeError);
    });
  }
  for (const role of ['sourceQuote', 'destinationQuote']) {
    for (const [field, value] of [
      ['mintUrl', 'https://other.example'],
      ['method', 'bolt12'],
      ['quoteId', ''],
      ['unit', 'msat'],
    ] as const) {
      it(`rejects ${role} ${field} mismatches`, () => {
        const valueToParse = raw();
        nested(valueToParse, role)[field] = value;
        expect(() => parseMintSwapOperation(valueToParse)).toThrow(TypeError);
      });
    }
  }

  it('accepts canonical HTTP and path-based mint URLs', () => {
    const value = raw();
    value.sourceMintUrl = 'http://localhost:3338/mint';
    nested(value, 'sourceQuote').mintUrl = value.sourceMintUrl;
    expect(parseMintSwapOperation(value).sourceMintUrl).toBe('http://localhost:3338/mint');
  });

  it('reconstructs byte-like invoice digests without retaining buffer aliases', () => {
    const bytes = new Uint8Array(32).fill(171);
    for (const digest of [bytes, Array.from(bytes), Buffer.from(bytes)]) {
      const parsed = parseMintSwapOperation({ ...raw(), paymentRequestHash: digest });
      digest[0] = 0;
      expect(parsed.paymentRequestHash).toBe('ab'.repeat(32));
    }
  });

  it.each(
    [
      new Uint8Array(31),
      Array(32).fill(-1),
      Array(32).fill(256),
      Array(32).fill(1.5),
      Array(32).fill('1'),
      Array(32),
      {},
    ].map((digest) => [digest] as const),
  )('rejects malformed digest bytes %p', (digest) => {
    expect(() => parseMintSwapOperation({ ...raw(), paymentRequestHash: digest })).toThrow(
      TypeError,
    );
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', '-1', '1.5', {}, null])(
    'rejects invalid destination amount %p',
    (value) => {
      expect(() => parseMintSwapOperation({ ...raw(), destinationAmount: value })).toThrow(
        TypeError,
      );
    },
  );

  it('accepts exact integer strings and bigints beyond safe-number range', () => {
    const value = raw();
    delete value.sourceDebitCap;
    value.destinationAmount = '900719925474099300000';
    expect(parseMintSwapOperation(value).destinationAmount.toBigInt()).toBe(900719925474099300000n);
    value.destinationAmount = 900719925474099300001n;
    expect(parseMintSwapOperation(value).destinationAmount.toString()).toBe(
      '900719925474099300001',
    );
  });

  it('rejects missing common fields', () => {
    for (const key of Object.keys(raw()).filter(
      (key) => key !== 'sourceDebitCap' && key !== 'cancellationRequestedAt',
    )) {
      const value = raw();
      delete value[key];
      expect(() => parseMintSwapOperation(value)).toThrow(TypeError);
    }
  });
});

describe('Mint Swap exact debit and completion accounting', () => {
  it('accepts equality boundaries and zero fees/returned amount', () => {
    const value = raw('completed');
    value.sourceDebitCap = 100;
    value.sourceDebitBounds = { minimum: 100, maximum: 100, reserved: 100 };
    value.sourceSettlement = {
      reserved: 100,
      returned: 0,
      finalDebit: 100,
      totalFee: 0,
      sourcePaidObservedAt: T + 3_000,
    };
    expect(parseMintSwapOperation(value).state).toBe('completed');
  });

  const violations: Array<[string, MintSwapOperationState, (value: Raw) => void]> = [
    [
      'minimum below destination by one',
      'prepared',
      (v) => {
        nested(v, 'sourceDebitBounds').minimum = 99;
      },
    ],
    [
      'maximum below minimum by one',
      'prepared',
      (v) => {
        nested(v, 'sourceDebitBounds').maximum = 101;
      },
    ],
    [
      'maximum above reserved by one',
      'prepared',
      (v) => {
        nested(v, 'sourceDebitBounds').reserved = 109;
      },
    ],
    [
      'cap below maximum by one',
      'prepared',
      (v) => {
        v.sourceDebitCap = 109;
      },
    ],
    [
      'cap below intent by one',
      'preparing',
      (v) => {
        v.sourceDebitCap = 99;
      },
    ],
    [
      'zero cap',
      'preparing',
      (v) => {
        v.sourceDebitCap = 0;
      },
    ],
    [
      'settlement reserved differs from bounds',
      'destination_funded',
      (v) => {
        nested(v, 'sourceSettlement').reserved = 129;
      },
    ],
    [
      'return greater than reservation',
      'destination_funded',
      (v) => {
        nested(v, 'sourceSettlement').returned = 129;
      },
    ],
    [
      'reserved minus returned differs from debit',
      'destination_funded',
      (v) => {
        nested(v, 'sourceSettlement').returned = 24;
      },
    ],
    [
      'destination plus total fee differs from debit',
      'destination_funded',
      (v) => {
        nested(v, 'sourceSettlement').totalFee = 6;
      },
    ],
    [
      'final debit below minimum by one',
      'destination_funded',
      (v) => {
        Object.assign(nested(v, 'sourceSettlement'), {
          returned: 27,
          finalDebit: 101,
          totalFee: 1,
        });
      },
    ],
    [
      'final debit above maximum by one',
      'destination_funded',
      (v) => {
        Object.assign(nested(v, 'sourceSettlement'), {
          returned: 17,
          finalDebit: 111,
          totalFee: 11,
        });
      },
    ],
    [
      'negative fee',
      'destination_funded',
      (v) => {
        nested(v, 'sourceSettlement').totalFee = -1;
      },
    ],
    [
      'quote issued short by one',
      'completed',
      (v) => {
        nested(v, 'destinationCompletion').quoteAmountIssued = 99;
      },
    ],
    [
      'quote issued excessive by one',
      'completed',
      (v) => {
        nested(v, 'destinationCompletion').quoteAmountIssued = 101;
      },
    ],
    [
      'stored proofs short by one',
      'completed',
      (v) => {
        nested(v, 'destinationCompletion').storedProofAmount = 99;
      },
    ],
    [
      'stored proofs excessive by one',
      'completed',
      (v) => {
        nested(v, 'destinationCompletion').storedProofAmount = 101;
      },
    ],
  ];
  for (const [name, state, mutate] of violations) {
    it(`rejects ${name}`, () => {
      const value = raw(state);
      mutate(value);
      expect(() => parseMintSwapOperation(value)).toThrow(TypeError);
    });
  }
});

describe('Mint Swap value-neutral exits and bounded diagnostics', () => {
  for (const state of ['cancelled', 'failed'] as const) {
    it(`${state} requires confirmed UNPAID and released proofs after source authorization`, () => {
      for (const payment of ['not_authorized', 'confirmed_unpaid', 'pending', 'paid']) {
        for (const proofs of ['not_reserved', 'released', 'reserved']) {
          const value = raw(state);
          Object.assign(nested(value, 'valueNeutral'), {
            sourcePayment: payment,
            sourceProofs: proofs,
          });
          if (payment === 'confirmed_unpaid' && proofs === 'released')
            expect(parseMintSwapOperation(value).state).toBe(state);
          else expect(() => parseMintSwapOperation(value)).toThrow(TypeError);
        }
      }
    });
    it(`${state} accepts non-authorization and no reservation during preparing`, () => {
      const value = raw(state);
      value.lastSafe = mintSwapCheckpoint(mintSwapFixtures().preparing);
      Object.assign(nested(value, 'valueNeutral'), {
        sourcePayment: 'not_authorized',
        sourceProofs: 'not_reserved',
      });
      expect(parseMintSwapOperation(value).state).toBe(state);
    });
    it(`${state} requires release of the established prepared reservation`, () => {
      const value = raw(state);
      value.lastSafe = mintSwapCheckpoint(mintSwapFixtures().prepared);
      nested(value, 'valueNeutral').sourceProofs = 'not_reserved';
      expect(() => parseMintSwapOperation(value)).toThrow('prepared proof release');
      nested(value, 'valueNeutral').sourceProofs = 'released';
      expect(parseMintSwapOperation(value).state).toBe(state);
    });
    it(`${state} rejects a post-payment checkpoint`, () => {
      expect(() =>
        parseMintSwapOperation({
          ...raw(state),
          lastSafe: mintSwapCheckpoint(mintSwapFixtures().destination_funded),
        }),
      ).toThrow();
    });
  }

  it('requires recorded cancellation intent', () => {
    const value = raw('cancelled');
    delete value.cancellationRequestedAt;
    expect(() => parseMintSwapOperation(value)).toThrow(TypeError);
  });

  it('rejects requests timestamped after failure or attention became quiescent', () => {
    for (const state of ['failed', 'needs_attention'] as const) {
      const value = raw(state);
      value.lastSafe = mintSwapCheckpoint(mintSwapFixtures().preparing);
      value.updatedAt = T + 6_000;
      value.cancellationRequestedAt = T + 5_001;
      expect(() => parseMintSwapOperation(value)).toThrow('quiescent cancellation request');
    }
  });

  it('rejects unbounded errors and unknown diagnostic codes without echoing them', () => {
    const secret = 'sensitive invoice and signing key';
    for (const field of ['reason', 'invariant', 'message']) {
      const value = raw('needs_attention');
      nested(value, 'attention')[field] = secret;
      expect(() => parseMintSwapOperation(value)).toThrow(TypeError);
      try {
        parseMintSwapOperation(value);
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
    const value = raw('failed');
    nested(value, 'failure').code = 'retry_exhausted';
    expect(() => parseMintSwapOperation(value)).toThrow(TypeError);
    expect(() =>
      parseMintSwapOperation({
        ...raw('needs_attention'),
        attention: {
          ...mintSwapFixtures().needs_attention.attention,
          evidence: {
            code: 'proofs_missing',
            leg: 'destination',
            observedAt: T + 5_000,
            proofs: [],
          },
        },
      }),
    ).toThrow(TypeError);
  });
});

describe('Mint Swap monotonic milliseconds and retry schema', () => {
  it.each([-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1700000000000'])(
    'rejects unsafe timestamp %p',
    (value) => {
      for (const field of ['createdAt', 'updatedAt', 'stateEnteredAt', 'cancellationRequestedAt']) {
        expect(() => parseMintSwapOperation({ ...raw(), [field]: value })).toThrow(TypeError);
      }
    },
  );

  it('rejects reversed creation, state entry, and update times', () => {
    for (const patch of [
      { createdAt: T + 1 },
      { stateEnteredAt: T - 1 },
      { updatedAt: T - 1 },
      { stateEnteredAt: T + 1, updatedAt: T + 1 },
    ]) {
      expect(() => parseMintSwapOperation({ ...raw(), ...patch })).toThrow(TypeError);
    }
  });

  const times: Array<[MintSwapOperationState, string, string | null, number]> = [
    ['source_pending', 'sourceStartedAt', null, T + 1_999],
    ['destination_funded', 'sourceSettlement', 'sourcePaidObservedAt', T + 1_999],
    ['destination_pending', 'destinationStartedAt', null, T + 2_999],
    ['completed', 'destinationCompletion', 'proofsVerifiedAt', T + 3_999],
    ['completed', 'completedAt', null, T + 5_001],
    ['cancelled', 'valueNeutral', 'verifiedAt', T + 1_999],
    ['cancelled', 'cancelledAt', null, T + 4_999],
    ['failed', 'failedAt', null, T + 5_001],
    ['needs_attention', 'attentionAt', null, T + 4_999],
    ['needs_attention', 'lastSafe', 'stateEnteredAt', T + 5_001],
  ];
  for (const [state, field, member, value] of times) {
    it(`rejects out-of-order ${state} ${field}.${member ?? ''}`, () => {
      const input = raw(state);
      if (member === null) input[field] = value;
      else nested(input, field)[member] = value;
      expect(() => parseMintSwapOperation(input)).toThrow(TypeError);
    });
  }

  it('retains cancellation after PAID but rejects a request timestamp after payment', () => {
    expect(parseMintSwapOperation(raw('completed')).cancellationRequestedAt).toBe(T);
    expect(() =>
      parseMintSwapOperation({ ...raw('completed'), cancellationRequestedAt: T + 3_001 }),
    ).toThrow();
  });

  for (const state of STATES) {
    it(`enforces ${state} initial due scheduling`, () => {
      const value = raw(state);
      const schedule = nested(value, 'retry');
      schedule.nextAttemptAt = schedule.nextAttemptAt === null ? T : null;
      expect(() => parseMintSwapOperation(value)).toThrow();
    });
  }

  it('persists waiting, transient and ambiguous retries without a post-payment attempt limit', () => {
    for (const [category, code] of [
      ['waiting', 'source_pending'],
      ['transient', 'remote_unavailable'],
      ['ambiguous', 'source_outcome_unknown'],
    ]) {
      const value = raw('destination_pending');
      value.retry = {
        attemptCount: Number.MAX_SAFE_INTEGER,
        lastAttemptAt: T + 4_000,
        nextAttemptAt: T + 30_000,
        lastError: { category, code, at: T + 4_000 },
      };
      expect(parseMintSwapOperation(value).state).toBe('destination_pending');
    }
  });

  it('rejects incomplete, inconsistent and unsafe retry metadata', () => {
    const retry = {
      attemptCount: 1,
      lastAttemptAt: T,
      nextAttemptAt: T + 2_000,
      lastError: { category: 'waiting', code: 'child_pending', at: T },
    };
    for (const patch of [
      { attemptCount: -1 },
      { attemptCount: 0.1 },
      { attemptCount: Number.MAX_SAFE_INTEGER + 1 },
      { attemptCount: 0 },
      { lastAttemptAt: null },
      { lastAttemptAt: T - 1 },
      { lastAttemptAt: T + 1 },
      { nextAttemptAt: T - 1 },
      { nextAttemptAt: Infinity },
      { lastError: null },
      { lastError: { category: 'waiting', code: 'remote_unavailable', at: T } },
      { lastError: { category: 'waiting', code: 'child_pending', at: T + 1 } },
      { lastError: { category: 'unknown', code: 'child_pending', at: T } },
      {
        lastError: { category: 'waiting', code: 'child_pending', at: T, message: 'remote payload' },
      },
    ])
      expect(() => parseMintSwapOperation({ ...raw(), retry: { ...retry, ...patch } })).toThrow(
        TypeError,
      );
    expect(() => parseMintSwapOperation({ ...raw(), retry: initialMintSwapRetry(T + 1) })).toThrow(
      TypeError,
    );
  });
});

describe('Mint Swap transition policy', () => {
  const allowed: Record<MintSwapOperationState, MintSwapOperationState[]> = {
    preparing: ['preparing', 'prepared', 'cancelled', 'failed', 'needs_attention'],
    prepared: ['prepared', 'source_pending', 'cancelled', 'failed', 'needs_attention'],
    source_pending: [
      'source_pending',
      'destination_funded',
      'cancelled',
      'failed',
      'needs_attention',
    ],
    destination_funded: ['destination_funded', 'destination_pending', 'needs_attention'],
    destination_pending: ['destination_pending', 'completed', 'needs_attention'],
    completed: [],
    cancelled: [],
    failed: [],
    needs_attention: [],
  };
  for (const from of STATES) {
    for (const to of STATES) {
      it(`${allowed[from].includes(to) ? 'allows' : 'rejects'} ${from} -> ${to}`, () => {
        const fixtures = mintSwapFixtures();
        const before = fixtures[from];
        let next: MintSwapOperation = stamp(fixtures[to]);
        if (allowed[from].includes(to) && next.lastSafe) {
          next = parseMintSwapOperation({ ...next, lastSafe: mintSwapCheckpoint(before) });
        }
        const run = () => validateMintSwapTransition(before, next);
        if (allowed[from].includes(to)) expect(run).not.toThrow();
        else expect(run).toThrow(TypeError);
      });
    }
  }

  it('rejects rewriting every established identity and intent field', () => {
    const { prepared } = mintSwapFixtures();
    const patches: Raw[] = [
      { id: 'replacement' },
      { sourceOperationId: 'replacement' },
      { destinationOperationId: 'replacement' },
      { paymentRequestHash: 'cd'.repeat(32) },
      { destinationAmount: Amount.from(99) },
      { sourceDebitCap: Amount.from(111) },
      { sourceDebitCap: undefined },
      { sourceQuote: { ...prepared.sourceQuote, quoteId: 'replacement' } },
      { destinationQuote: { ...prepared.destinationQuote, quoteId: 'replacement' } },
      { createdAt: T - 1 },
      {
        sourceMintUrl: 'https://other.example',
        sourceQuote: { ...prepared.sourceQuote, mintUrl: 'https://other.example' },
      },
      {
        destinationMintUrl: 'https://other.example',
        destinationQuote: { ...prepared.destinationQuote, mintUrl: 'https://other.example' },
      },
    ];
    for (const patch of patches) {
      const next = parseMintSwapOperation({ ...stamp(prepared), ...patch });
      expect(() => validateMintSwapTransition(prepared, next)).toThrow('immutable');
    }
  });

  it('preserves established debit bounds, start times and settlement', () => {
    const { destination_pending: before } = mintSwapFixtures();
    for (const patch of [
      { sourceDebitBounds: { ...before.sourceDebitBounds, minimum: Amount.from(101) } },
      { sourceStartedAt: T + 1_999 },
      { sourceSettlement: { ...before.sourceSettlement, sourcePaidObservedAt: T + 2_999 } },
    ]) {
      const next = parseMintSwapOperation({ ...stamp(before), ...patch });
      expect(() => validateMintSwapTransition(before, next)).toThrow('established facts');
    }
    const complete = parseMintSwapOperation({
      ...stamp(mintSwapFixtures().completed),
      destinationStartedAt: T + 3_999,
    });
    expect(() => validateMintSwapTransition(before, complete)).toThrow('established facts');
  });

  it('requires an exact last-safe checkpoint rather than a changed or invented past', () => {
    const { source_pending: before, cancelled } = mintSwapFixtures();
    const next = parseMintSwapOperation({
      ...stamp(cancelled),
      lastSafe: mintSwapCheckpoint(mintSwapFixtures().prepared),
    });
    expect(() => validateMintSwapTransition(before, next)).toThrow();
    const changed = parseMintSwapOperation({
      ...stamp(cancelled),
      lastSafe: {
        ...cancelled.lastSafe,
        sourceDebitBounds: { ...cancelled.lastSafe.sourceDebitBounds, minimum: Amount.from(101) },
      },
    });
    expect(() => validateMintSwapTransition(before, changed)).toThrow();
  });

  it('requires a persistence increment of exactly one and rejects unsafe increments', () => {
    const { preparing } = mintSwapFixtures();
    for (const revision of [0, 2, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateMintSwapTransition(preparing, stamp(preparing, revision))).toThrow();
    }
  });

  it('rejects clock rollback and same-state entry-time changes; accepts clamped equal time', () => {
    const { prepared } = mintSwapFixtures();
    const before = { ...prepared, updatedAt: T + 1_100 };
    expect(() =>
      validateMintSwapTransition(before, stamp({ ...before, updatedAt: T + 1_099 })),
    ).toThrow();
    expect(() =>
      validateMintSwapTransition(before, stamp({ ...before, stateEnteredAt: T + 1_001 })),
    ).toThrow();
    expect(() => validateMintSwapTransition(before, stamp(before))).not.toThrow();
    expect(() =>
      validateMintSwapTransition(
        prepared,
        stamp({ ...mintSwapFixtures().source_pending, updatedAt: T + 2_001 }),
      ),
    ).toThrow();
  });

  it('sets cancellation once in allowed states and preserves it through PENDING and PAID', () => {
    const fixtures = mintSwapFixtures();
    for (const state of ['preparing', 'prepared', 'source_pending'] as const) {
      const before = { ...fixtures[state], cancellationRequestedAt: undefined };
      expect(() =>
        validateMintSwapTransition(
          before,
          stamp({ ...before, cancellationRequestedAt: before.updatedAt }),
        ),
      ).not.toThrow();
      expect(() =>
        validateMintSwapTransition(
          fixtures[state],
          stamp({ ...fixtures[state], cancellationRequestedAt: undefined }),
        ),
      ).toThrow();
      expect(() =>
        validateMintSwapTransition(
          fixtures[state],
          stamp({
            ...fixtures[state],
            cancellationRequestedAt: T + 1,
            updatedAt: fixtures[state].updatedAt + 1,
          }),
        ),
      ).toThrow();
    }
    const before = { ...fixtures.source_pending, cancellationRequestedAt: undefined };
    expect(() => validateMintSwapTransition(before, stamp(fixtures.destination_funded))).toThrow();
    expect(() =>
      validateMintSwapTransition(fixtures.source_pending, stamp(fixtures.destination_funded)),
    ).not.toThrow();
  });

  it('resets retry on state change and rejects carrying attempt evidence into the next state', () => {
    const { source_pending: source, destination_funded } = mintSwapFixtures();
    const before: MintSwapOperation = {
      ...source,
      retry: {
        attemptCount: 2,
        lastAttemptAt: T + 2_000,
        nextAttemptAt: T + 10_000,
        lastError: { category: 'waiting', code: 'source_pending', at: T + 2_000 },
      },
    };
    expect(() => validateMintSwapTransition(before, stamp(destination_funded))).not.toThrow();
    const next = {
      ...stamp(destination_funded),
      retry: {
        ...before.retry,
        lastAttemptAt: T + 3_000,
        lastError: { category: 'waiting' as const, code: 'source_pending' as const, at: T + 3_000 },
      },
    };
    expect(() => validateMintSwapTransition(before, next)).toThrow('retry reset');
  });

  it('couples each retry-count increment to one new attempt and preserves evidence on reschedule', () => {
    const source = mintSwapFixtures().source_pending;
    const before: MintSwapOperation = {
      ...source,
      updatedAt: T + 2_200,
      retry: {
        attemptCount: 2,
        lastAttemptAt: T + 2_100,
        nextAttemptAt: T + 10_000,
        lastError: { category: 'waiting', code: 'source_pending', at: T + 2_200 },
      },
    };
    const rescheduled: MintSwapOperation = {
      ...stamp(before),
      updatedAt: T + 2_300,
      retry: { ...before.retry, nextAttemptAt: T + 12_000 },
    };
    expect(() => validateMintSwapTransition(before, rescheduled)).not.toThrow();

    const attempted: MintSwapOperation = {
      ...rescheduled,
      retry: {
        ...before.retry,
        attemptCount: 3,
        lastAttemptAt: T + 2_300,
        nextAttemptAt: T + 12_000,
        lastError: { category: 'transient', code: 'remote_unavailable', at: T + 2_300 },
      },
    };
    expect(() => validateMintSwapTransition(before, attempted)).not.toThrow();

    expect(() =>
      validateMintSwapTransition(before, {
        ...attempted,
        retry: { ...attempted.retry, attemptCount: 4 },
      }),
    ).toThrow('retry count progression');
    expect(() =>
      validateMintSwapTransition(before, {
        ...attempted,
        retry: { ...attempted.retry, attemptCount: 1 },
      }),
    ).toThrow('retry count progression');
    expect(() =>
      validateMintSwapTransition(before, {
        ...attempted,
        retry: { ...attempted.retry, attemptCount: before.retry.attemptCount },
      }),
    ).toThrow('retry attempt without count');
    expect(() =>
      validateMintSwapTransition(before, {
        ...attempted,
        retry: {
          ...attempted.retry,
          lastAttemptAt: T + 2_200,
          lastError: before.retry.lastError,
        },
      }),
    ).toThrow('new retry evidence');
    expect(() =>
      validateMintSwapTransition(before, {
        ...rescheduled,
        retry: {
          ...rescheduled.retry,
          lastError: { category: 'waiting', code: 'child_pending', at: T + 2_200 },
        },
      }),
    ).toThrow('retry evidence without count');
  });

  it('rejects newly added evidence timestamped before the latest persisted update', () => {
    const f = mintSwapFixtures();
    const pairs: Array<[MintSwapOperation, MintSwapOperation]> = [
      [
        { ...f.source_pending, updatedAt: T + 3_001 },
        {
          ...f.destination_funded,
          updatedAt: T + 3_002,
          stateEnteredAt: T + 3_002,
          retry: initialMintSwapRetry(T + 3_002),
        },
      ],
      [
        { ...f.destination_pending, updatedAt: T + 5_001 },
        { ...f.completed, updatedAt: T + 5_002, stateEnteredAt: T + 5_002, completedAt: T + 5_002 },
      ],
      [
        { ...f.source_pending, updatedAt: T + 5_001 },
        { ...f.cancelled, updatedAt: T + 5_002, stateEnteredAt: T + 5_002, cancelledAt: T + 5_002 },
      ],
      [
        { ...f.destination_pending, updatedAt: T + 5_001 },
        {
          ...f.needs_attention,
          updatedAt: T + 5_002,
          stateEnteredAt: T + 5_002,
          attentionAt: T + 5_002,
        },
      ],
    ];
    for (const [before, next] of pairs) {
      expect(() => validateMintSwapTransition(before, stamp(next))).toThrow('time');
    }
  });
});

// Compile-time fixtures remain inside the core tsc scope and are never executed.
function illegalTypeCombinations() {
  const f = mintSwapFixtures();
  // @ts-expect-error Prepared cannot carry settlement, including through a non-literal value.
  const preparedSettlement: MintSwapOperation = {
    ...f.prepared,
    sourceSettlement: f.destination_funded.sourceSettlement,
  };
  // @ts-expect-error Prepared cannot carry source authorization.
  const preparedAuthorization: MintSwapOperation = { ...f.prepared, sourceStartedAt: T };
  const { sourceStartedAt, ...sourceWithoutAuthorization } = f.source_pending;
  // @ts-expect-error Source pending requires source authorization.
  const missingSource: MintSwapOperation = sourceWithoutAuthorization;
  const { sourceSettlement, ...fundedWithoutSettlement } = f.destination_funded;
  // @ts-expect-error Destination funded requires settlement.
  const missingSettlement: MintSwapOperation = fundedWithoutSettlement;
  const { destinationStartedAt, ...destinationWithoutAuthorization } = f.destination_pending;
  // @ts-expect-error Destination pending requires destination authorization.
  const missingDestination: MintSwapOperation = destinationWithoutAuthorization;
  const { destinationCompletion, ...completeWithoutProofs } = f.completed;
  // @ts-expect-error Completed requires exact issued and stored-proof evidence.
  const missingProofs: MintSwapOperation = completeWithoutProofs;
  const { completedAt, ...completeWithoutTime } = f.completed;
  // @ts-expect-error Completed requires a completion time.
  const missingTime: MintSwapOperation = completeWithoutTime;
  const { valueNeutral, ...failedWithoutEvidence } = f.failed;
  // @ts-expect-error Failure requires value-neutral evidence.
  const missingFailure: MintSwapOperation = failedWithoutEvidence;
  const { attention, ...attentionWithoutEvidence } = f.needs_attention;
  // @ts-expect-error Attention requires structured evidence.
  const missingAttention: MintSwapOperation = attentionWithoutEvidence;
  const { lastSafe, ...attentionWithoutCheckpoint } = f.needs_attention;
  // @ts-expect-error Attention requires a non-recursive last-safe checkpoint.
  const missingCheckpoint: MintSwapOperation = attentionWithoutCheckpoint;
  const op: MintSwapOperation = f.prepared;
  // @ts-expect-error Revision is read-only persistence metadata.
  op.revision = 2;
}
