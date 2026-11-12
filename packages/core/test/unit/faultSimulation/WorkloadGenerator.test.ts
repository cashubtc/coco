import { describe, expect, it } from 'bun:test';
import type { ScenarioPlan } from '../../fault-simulation/scenarios.ts';
import {
  generateWorkload,
  planWorkload,
  type PlannedWorkload,
  type WorkloadOptions,
} from '../../fault-simulation/workload.ts';

const options = (seed: number): WorkloadOptions => ({
  seed,
  wallets: ['alice', 'bob', 'carol'],
  mints: ['mint-a', 'mint-b'],
  commands: 24,
  initialFunding: 128,
  maxAmount: 32,
  checkpointEvery: 8,
});

const corpus = Array.from({ length: 40 }, (_, index) => index + 1).map((seed) => {
  const plan = generateWorkload(options(seed));
  return { seed, plan, planned: planWorkload(plan) };
});

const workloadCommands = (plan: ScenarioPlan) =>
  plan.steps.filter((step) => step.kind !== 'fund' && step.kind !== 'checkpoint');

/** Facts about one plan, computed from its own steps rather than from generator internals. */
function exercised(planned: PlannedWorkload): Set<string> {
  const facts = new Set<string>();
  const firstRecipient = new Map<string, string>();
  for (const { step, receive, reclaim } of planned.steps) {
    if (step.kind === 'send') facts.add(`send:${step.mint}:${step.wallet}`);
    if (step.kind === 'restart') facts.add('restart');
    if (step.kind === 'raceReclaim') facts.add(`race:${step.lead ?? 'unled'}`);
    if (step.kind === 'reclaim') facts.add(`reclaim:${reclaim}`);
    if (step.kind === 'receive') {
      facts.add(`receive:${receive}`);
      if (receive === 'finalized') firstRecipient.set(step.token, step.wallet);
      if (receive === 'rejected') {
        facts.add(
          firstRecipient.get(step.token) === step.wallet
            ? 'duplicate:same-recipient'
            : 'duplicate:other-wallet',
        );
      }
    }
  }
  for (const token of planned.tokens.values()) facts.add(`fate:${token.fate.kind}`);
  return facts;
}

describe('generateWorkload', () => {
  it('reproduces the same commands from the same scenario seed', () => {
    expect(generateWorkload(options(7))).toEqual(generateWorkload(options(7)));
    expect(generateWorkload(options(7)).steps).not.toEqual(generateWorkload(options(8)).steps);
  });

  it('records the scenario seed and options so the choices can be regenerated', () => {
    const plan = generateWorkload(options(42));

    expect(plan.id).toBe('generated-seed-42');
    expect(plan.generator).toMatchObject({ ...options(42), version: expect.any(Number) });
    expect(plan.wallets).toEqual(['alice', 'bob', 'carol']);
    expect(plan.mints).toEqual(['mint-a', 'mint-b']);
  });

  it('funds every Wallet at every mint before generated commands', () => {
    const { plan } = corpus[0]!;
    const funding = plan.steps.slice(0, 6);

    expect(funding).toEqual(
      ['alice', 'bob', 'carol'].flatMap((wallet) =>
        ['mint-a', 'mint-b'].map((mint) => ({ kind: 'fund', wallet, mint, amount: 128 })),
      ),
    );
    expect(plan.steps.slice(6).some((step) => step.kind === 'fund')).toBe(false);
  });

  it('only generates commands whose state preconditions hold', () => {
    // planWorkload throws PlanPreconditionError for any meaningless command.
    for (const { plan } of corpus) expect(() => planWorkload(plan)).not.toThrow();
  });

  it('keeps the command budget, checkpoints periodically and ends with a checkpoint', () => {
    for (const { plan } of corpus) {
      const commands = workloadCommands(plan).length;
      expect(commands).toBeGreaterThanOrEqual(24);
      expect(commands).toBeLessThanOrEqual(25);
      expect(plan.steps.at(-1)).toEqual({ kind: 'checkpoint' });
      expect(plan.steps.filter((step) => step.kind === 'checkpoint').length).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it('leaves at least one intentionally undelivered token in every plan', () => {
    for (const { planned } of corpus) {
      const outstanding = [...planned.tokens.values()].filter(
        (token) => token.fate.kind === 'outstanding',
      );
      expect(outstanding.length).toBeGreaterThan(0);
    }
  });

  it('covers every workload command, both mints and every sender across a small seed corpus', () => {
    const covered = new Set(corpus.flatMap(({ planned }) => [...exercised(planned)]));

    expect([...covered].sort()).toEqual(
      expect.arrayContaining([
        'receive:finalized',
        'receive:rejected',
        'duplicate:same-recipient',
        'duplicate:other-wallet',
        'reclaim:rolled_back',
        'reclaim:rejected',
        'race:unled',
        'race:recipient',
        'race:sender',
        'restart',
        'fate:outstanding',
        'fate:received',
        'fate:reclaimed',
        'fate:raced',
        ...['mint-a', 'mint-b'].flatMap((mint) =>
          ['alice', 'bob', 'carol'].map((wallet) => `send:${mint}:${wallet}`),
        ),
      ]),
    );
  });

  it('spends most generated commands on value movement rather than restarts', () => {
    for (const { plan } of corpus) {
      const restarts = plan.steps.filter((step) => step.kind === 'restart').length;
      expect(restarts).toBeLessThanOrEqual(3);
    }
  });

  it('rejects a scenario seed that is not an unsigned 32-bit integer', () => {
    for (const seed of [-1, 1.5, 2 ** 32, Number.NaN]) {
      expect(() => generateWorkload(options(seed))).toThrow(/seed/);
    }
  });
});
