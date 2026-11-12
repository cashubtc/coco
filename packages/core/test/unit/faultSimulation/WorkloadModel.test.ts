import { describe, expect, it } from 'bun:test';
import type { ScenarioPlan, ScenarioStep } from '../../fault-simulation/scenarios.ts';
import {
  PlanPreconditionError,
  expectedReceiveStates,
  expectedSendStates,
  planWorkload,
} from '../../fault-simulation/workload.ts';

function plan(steps: ScenarioStep[]): ScenarioPlan {
  return {
    id: 'model-test',
    description: 'Workload model test plan',
    expect: 'pass',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    wallets: ['alice', 'bob', 'carol'],
    mints: ['mint-a', 'mint-b'],
    steps,
  };
}

const funded: ScenarioStep[] = [
  { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
  { kind: 'fund', wallet: 'alice', mint: 'mint-b', amount: 64 },
];

describe('planWorkload', () => {
  it('expects a first delivery to be received and a later delivery of the same token rejected', () => {
    const planned = planWorkload(
      plan([
        ...funded,
        { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 20, token: 't1' },
        { kind: 'receive', wallet: 'bob', token: 't1' },
        { kind: 'receive', wallet: 'bob', token: 't1' },
        { kind: 'receive', wallet: 'carol', token: 't1' },
      ]),
    );

    expect(planned.steps.slice(3).map((step) => step.receive)).toEqual([
      'finalized',
      'rejected',
      'rejected',
    ]);
    expect(planned.tokens.get('t1')).toMatchObject({
      sender: 'alice',
      mint: 'mint-a',
      amount: 20,
      fate: { kind: 'received', recipient: 'bob' },
    });
  });

  it('names the Wallets and tokens each step occupies so the runner can order dependent work', () => {
    const planned = planWorkload(
      plan([
        ...funded,
        { kind: 'send', wallet: 'alice', mint: 'mint-b', amount: 10, token: 't1' },
        { kind: 'raceReclaim', token: 't1', recipient: 'carol' },
        { kind: 'restart', wallet: 'bob' },
        { kind: 'checkpoint' },
      ]),
    );

    expect(
      planned.steps.slice(2).map(({ wallets, tokens, barrier }) => ({ wallets, tokens, barrier })),
    ).toEqual([
      { wallets: ['alice'], tokens: ['t1'], barrier: false },
      { wallets: ['carol', 'alice'], tokens: ['t1'], barrier: false },
      { wallets: ['bob'], tokens: [], barrier: false },
      { wallets: [], tokens: [], barrier: true },
    ]);
    expect(planned.steps[3]).toMatchObject({ receive: 'either', reclaim: 'either' });
    expect(planned.tokens.get('t1')?.fate).toEqual({ kind: 'raced', recipient: 'carol' });
  });

  it('expects the led claimant of a coordinated race to win and runs the race exclusively', () => {
    const planned = planWorkload(
      plan([
        ...funded,
        { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 10, token: 't1' },
        { kind: 'send', wallet: 'alice', mint: 'mint-b', amount: 10, token: 't2' },
        { kind: 'raceReclaim', token: 't1', recipient: 'bob', lead: 'recipient' },
        { kind: 'raceReclaim', token: 't2', recipient: 'carol', lead: 'sender' },
      ]),
    );

    expect(
      planned.steps.slice(4).map(({ wallets, barrier, receive, reclaim, fateAfter }) => ({
        wallets,
        barrier,
        receive,
        reclaim,
        fateAfter,
      })),
    ).toEqual([
      {
        wallets: ['bob', 'alice'],
        barrier: true,
        receive: 'finalized',
        reclaim: 'rejected',
        fateAfter: { kind: 'received', recipient: 'bob' },
      },
      {
        wallets: ['carol', 'alice'],
        barrier: true,
        receive: 'rejected',
        reclaim: 'rolled_back',
        fateAfter: { kind: 'reclaimed' },
      },
    ]);
    expect(planned.spendable('bob', 'mint-a')).toBe(9);
  });

  it('expects an uncontested reclaim to roll back and any later claim of that token to be rejected', () => {
    const planned = planWorkload(
      plan([
        ...funded,
        { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 16, token: 't1' },
        { kind: 'reclaim', token: 't1' },
        { kind: 'receive', wallet: 'bob', token: 't1' },
        { kind: 'reclaim', token: 't1' },
      ]),
    );

    expect(planned.steps.slice(3).map(({ receive, reclaim }) => ({ receive, reclaim }))).toEqual([
      { receive: undefined, reclaim: 'rolled_back' },
      { receive: 'rejected', reclaim: undefined },
      { receive: undefined, reclaim: 'rejected' },
    ]);
    expect(planned.tokens.get('t1')?.fate).toEqual({ kind: 'reclaimed' });
  });

  it('keeps an undelivered token outstanding', () => {
    const planned = planWorkload(
      plan([...funded, { kind: 'send', wallet: 'alice', mint: 'mint-b', amount: 8, token: 't1' }]),
    );

    expect(planned.tokens.get('t1')?.fate).toEqual({ kind: 'outstanding' });
  });

  it('rejects plans whose commands lack their state preconditions', () => {
    const invalid: [string, ScenarioStep[]][] = [
      ['unknown token', [...funded, { kind: 'receive', wallet: 'bob', token: 'missing' }]],
      [
        'insufficient funds at that mint',
        [{ kind: 'send', wallet: 'bob', mint: 'mint-a', amount: 8, token: 't1' }],
      ],
      [
        'funds held at the other mint',
        [
          { kind: 'fund', wallet: 'bob', mint: 'mint-b', amount: 64 },
          { kind: 'send', wallet: 'bob', mint: 'mint-a', amount: 8, token: 't1' },
        ],
      ],
      [
        'reused token reference',
        [
          ...funded,
          { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 8, token: 't1' },
          { kind: 'send', wallet: 'alice', mint: 'mint-b', amount: 8, token: 't1' },
        ],
      ],
      [
        'race against a token that is no longer outstanding',
        [
          ...funded,
          { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 8, token: 't1' },
          { kind: 'receive', wallet: 'bob', token: 't1' },
          { kind: 'raceReclaim', token: 't1', recipient: 'carol' },
        ],
      ],
      [
        'race in which the sender would also be the recipient',
        [
          ...funded,
          { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 8, token: 't1' },
          { kind: 'raceReclaim', token: 't1', recipient: 'alice' },
        ],
      ],
      ['unknown Wallet', [{ kind: 'fund', wallet: 'dave', mint: 'mint-a', amount: 8 }]],
      ['unknown mint', [{ kind: 'fund', wallet: 'alice', mint: 'mint-z', amount: 8 }]],
      [
        'token too small to survive its own reclaim fee',
        [...funded, { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 1, token: 't1' }],
      ],
    ];

    for (const [name, steps] of invalid) {
      expect(() => planWorkload(plan(steps)), name).toThrow(PlanPreconditionError);
    }
  });

  it('keeps a conservative spendable bound that only credits value a Wallet will certainly hold', () => {
    const planned = planWorkload(
      plan([
        { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 40 },
        { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 20, token: 't1' },
        { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 10, token: 't2' },
        { kind: 'raceReclaim', token: 't1', recipient: 'bob' },
      ]),
    );

    // 40 funded, two sends each reserving their amount plus the send fee reserve, and a race whose
    // winner is unknown in advance, so neither side is credited.
    expect(planned.spendable('alice', 'mint-a')).toBeLessThan(10);
    expect(planned.spendable('bob', 'mint-a')).toBe(0);
    expect(() =>
      planWorkload(
        plan([
          { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 40 },
          { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 20, token: 't1' },
          { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 10, token: 't2' },
          { kind: 'raceReclaim', token: 't1', recipient: 'bob' },
          { kind: 'send', wallet: 'bob', mint: 'mint-a', amount: 4, token: 't3' },
        ]),
      ),
    ).toThrow(PlanPreconditionError);
  });
});

describe('expected operation states', () => {
  it('derives the sender Send state from the token fate', () => {
    expect(expectedSendStates({ kind: 'outstanding' })).toEqual(['pending']);
    expect(expectedSendStates({ kind: 'received', recipient: 'bob' })).toEqual(['finalized']);
    expect(expectedSendStates({ kind: 'reclaimed' })).toEqual(['rolled_back']);
    expect(expectedSendStates({ kind: 'raced', recipient: 'bob' })).toEqual([
      'finalized',
      'rolled_back',
    ]);
  });

  it('derives the Receive state from the delivery expectation', () => {
    expect(expectedReceiveStates('finalized')).toEqual(['finalized']);
    expect(expectedReceiveStates('rejected')).toEqual(['rolled_back']);
    expect(expectedReceiveStates('either')).toEqual(['finalized', 'rolled_back']);
  });
});
