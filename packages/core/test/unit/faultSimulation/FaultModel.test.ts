import { describe, expect, it } from 'bun:test';
import type { ScenarioPlan, ScenarioStep } from '../../fault-simulation/scenarios.ts';
import { PlanPreconditionError, planWorkload } from '../../fault-simulation/workload.ts';

function plan(steps: ScenarioStep[], recoveryMode: 'automatic' | 'explicit' = 'automatic') {
  return {
    id: 'fault-model-test',
    description: 'Fault model test plan',
    expect: 'pass',
    recoveryMode,
    recoveryDeadlineMs: 60_000,
    wallets: ['alice', 'bob', 'carol'],
    mints: ['mint-a', 'mint-b'],
    steps,
  } satisfies ScenarioPlan;
}

const funded: ScenarioStep[] = [
  { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
  { kind: 'fund', wallet: 'bob', mint: 'mint-a', amount: 64 },
];
const sent: ScenarioStep[] = [
  ...funded,
  { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 20, token: 't1' },
];

describe('fault steps in the workload model', () => {
  it("exposes only the targeted Wallet's next swap at that mint, without serializing others", () => {
    const planned = planWorkload(
      plan([
        ...sent,
        { kind: 'dropResponse', wallet: 'bob', mint: 'mint-a', path: '/v1/swap' },
        { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 10, token: 't2' },
        { kind: 'receive', wallet: 'bob', token: 't1' },
        { kind: 'heal' },
        { kind: 'checkpoint' },
      ]),
    );

    expect(planned.steps[3]).toMatchObject({ wallets: ['bob'], barrier: false });
    expect(planned.steps[4]!.exposure).toBeUndefined();
    expect(planned.steps[5]).toMatchObject({
      receive: 'finalized',
      exposure: { fault: 'dropResponse', mint: 'mint-a', faultStep: 3 },
    });
    // Coco recovers a lost Receive exchange inline, so no later recovery step is required.
    expect(planned.steps[5]!.awaitsRecovery).toBeUndefined();
  });

  it('rejects a fault that the targeted Wallet would not consume with a swap', () => {
    expect(() =>
      planWorkload(
        plan([
          ...sent,
          { kind: 'dropRequest', wallet: 'bob', mint: 'mint-a', path: '/v1/swap' },
          { kind: 'fund', wallet: 'bob', mint: 'mint-a', amount: 8 },
        ]),
      ),
    ).toThrow(PlanPreconditionError);
    expect(() =>
      planWorkload(
        plan([
          ...sent,
          { kind: 'dropRequest', wallet: 'bob', mint: 'mint-a', path: '/v1/swap' },
          { kind: 'heal' },
        ]),
      ),
    ).toThrow('never consumed');
    expect(() =>
      planWorkload(
        plan([...sent, { kind: 'dropRequest', wallet: 'bob', mint: 'mint-a', path: '/v1/mint' }]),
      ),
    ).toThrow(PlanPreconditionError);
  });

  it('holds an interrupted Send token back until its sender restarts or explicitly recovers', () => {
    const interrupted: ScenarioStep[] = [
      ...funded,
      { kind: 'dropResponse', wallet: 'alice', mint: 'mint-a', path: '/v1/swap' },
      { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 20, token: 't1' },
      { kind: 'heal' },
    ];
    expect(() =>
      planWorkload(plan([...interrupted, { kind: 'receive', wallet: 'bob', token: 't1' }])),
    ).toThrow('awaits recovery');

    const restarted = planWorkload(
      plan([
        ...interrupted,
        { kind: 'restart', wallet: 'alice' },
        { kind: 'receive', wallet: 'bob', token: 't1' },
        { kind: 'checkpoint' },
      ]),
    );
    expect(restarted.steps[3]).toMatchObject({
      exposure: { fault: 'dropResponse' },
      awaitsRecovery: 'alice',
    });
    expect(restarted.tokens.get('t1')?.fate).toEqual({ kind: 'received', recipient: 'bob' });
    // The restart releases t1, so the delivery is ordered after it.
    expect(restarted.steps[5]).toMatchObject({ wallets: ['alice'], tokens: ['t1'] });

    const recovered = planWorkload(
      plan(
        [
          ...interrupted,
          { kind: 'recover', wallet: 'alice' },
          { kind: 'receive', wallet: 'bob', token: 't1' },
        ],
        'explicit',
      ),
    );
    expect(recovered.steps[5]).toMatchObject({ wallets: ['alice'], tokens: ['t1'] });
    expect(recovered.steps[6]).toMatchObject({ receive: 'finalized' });
  });

  it('keeps explicit public recovery out of automatic-progress scenarios', () => {
    expect(() =>
      planWorkload(plan([...funded, { kind: 'recover', wallet: 'alice' }], 'automatic')),
    ).toThrow('explicit');
  });

  it('only recovers explicitly once every fault has healed', () => {
    expect(() =>
      planWorkload(
        plan(
          [
            ...funded,
            { kind: 'disconnect', wallet: 'bob', mint: 'mint-b' },
            { kind: 'recover', wallet: 'alice' },
          ],
          'explicit',
        ),
      ),
    ).toThrow('healed');
  });

  it('exposes commands during a Wallet outage and holds the token until recovery', () => {
    const planned = planWorkload(
      plan([
        ...sent,
        { kind: 'disconnect', wallet: 'bob', mint: 'mint-a' },
        { kind: 'receive', wallet: 'bob', token: 't1' },
        { kind: 'reconnect', wallet: 'bob', mint: 'mint-a' },
        { kind: 'restart', wallet: 'bob' },
        { kind: 'receive', wallet: 'carol', token: 't1' },
        { kind: 'checkpoint' },
      ]),
    );

    // Environmental faults order every later step after them, whichever Wallet runs it.
    expect(planned.steps[3]).toMatchObject({ wallets: ['bob'], barrier: true });
    expect(planned.steps[4]).toMatchObject({
      receive: 'finalized',
      exposure: { fault: 'outage', mint: 'mint-a', faultStep: 3 },
      awaitsRecovery: 'bob',
    });
    // After recovery the duplicate delivery is an ordinary rejected one.
    expect(planned.steps[7]).toMatchObject({ receive: 'rejected' });
    expect(() =>
      planWorkload(plan([...sent, { kind: 'reconnect', wallet: 'bob', mint: 'mint-a' }])),
    ).toThrow(PlanPreconditionError);
  });

  it('requires a healed environment before a checkpoint and at the end of the plan', () => {
    const withOutage: ScenarioStep[] = [
      ...sent,
      { kind: 'delayResponses', wallet: 'alice', mint: 'mint-a', delayMs: 500, count: 3 },
    ];
    expect(() => planWorkload(plan([...withOutage, { kind: 'checkpoint' }]))).toThrow('healed');
    expect(() => planWorkload(plan(withOutage))).toThrow('healing');
    expect(() =>
      planWorkload(plan([...withOutage, { kind: 'heal' }, { kind: 'checkpoint' }])),
    ).not.toThrow();
  });

  it('drops WebSockets only where the Wallet holds a subscription it has not already lost', () => {
    expect(() =>
      planWorkload(plan([...sent, { kind: 'dropWebSockets', wallet: 'bob', mint: 'mint-a' }])),
    ).toThrow(PlanPreconditionError);
    const dropped: ScenarioStep[] = [
      ...sent,
      { kind: 'dropWebSockets', wallet: 'alice', mint: 'mint-a' },
    ];
    expect(planWorkload(plan(dropped)).steps[3]).toMatchObject({
      wallets: ['alice'],
      barrier: true,
    });
    expect(() =>
      planWorkload(plan([...dropped, { kind: 'dropWebSockets', wallet: 'alice', mint: 'mint-a' }])),
    ).toThrow(PlanPreconditionError);
    expect(() =>
      planWorkload(
        plan([
          ...dropped,
          { kind: 'restart', wallet: 'alice' },
          { kind: 'dropWebSockets', wallet: 'alice', mint: 'mint-a' },
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects foreground commands of a crashed Wallet until it restarts', () => {
    const crashed: ScenarioStep[] = [...sent, { kind: 'crash', wallet: 'bob' }];
    expect(planWorkload(plan(crashed)).steps[3]).toMatchObject({ wallets: ['bob'], barrier: true });
    expect(() =>
      planWorkload(plan([...crashed, { kind: 'receive', wallet: 'bob', token: 't1' }])),
    ).toThrow('crashed');
    expect(() =>
      planWorkload(
        plan([
          ...crashed,
          { kind: 'restart', wallet: 'bob' },
          { kind: 'receive', wallet: 'bob', token: 't1' },
        ]),
      ),
    ).not.toThrow();
  });

  it('restarts a mint exclusively and loses every WebSocket subscription to it', () => {
    const planned = planWorkload(plan([...sent, { kind: 'restartMint', mint: 'mint-a' }]));
    expect(planned.steps[3]).toMatchObject({ barrier: true });
    expect(() =>
      planWorkload(
        plan([
          ...sent,
          { kind: 'restartMint', mint: 'mint-a' },
          { kind: 'dropWebSockets', wallet: 'alice', mint: 'mint-a' },
        ]),
      ),
    ).toThrow(PlanPreconditionError);
  });

  it('keeps a race out of a delayed path, where the delay would take its hold', () => {
    expect(() =>
      planWorkload(
        plan([
          ...sent,
          { kind: 'delayResponses', wallet: 'bob', mint: 'mint-a', delayMs: 500, count: 2 },
          { kind: 'raceReclaim', token: 't1', recipient: 'bob', lead: 'recipient' },
        ]),
      ),
    ).toThrow('delayed');
  });
});
