import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunReport, mergeCoverage, type RunReport } from '../../fault-simulation/report.ts';
import {
  SIM_FILES,
  SuiteUsageError,
  bunVersionProblem,
  checkTestSelection,
  corpusCoverageGaps,
  parseJunit,
  planSuite,
  runSuite,
  runBudgetedProcess,
} from '../../fault-simulation/suite.ts';
import { readTrace } from '../../fault-simulation/trace.ts';

const report = (name: string) =>
  buildRunReport(
    readTrace(
      readFileSync(new URL(`../../fault-simulation/fixtures/${name}`, import.meta.url), 'utf8'),
    ),
  );

/** A fixed random source, so randomized seeds are reproducible in the test. */
const sequence =
  (...values: number[]) =>
  () =>
    values.shift() ?? 0;

describe('suite execution boundaries', () => {
  it('refuses reused output without modifying previous evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coco-suite-reuse-'));
    try {
      const evidence = join(dir, 'original-failure.json');
      writeFileSync(evidence, 'original failure');
      expect(await runSuite(['--profile', 'seeds', '--seeds', '1', '--out', dir])).toBe(2);
      expect(readFileSync(evidence, 'utf8')).toBe('original failure');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminates a replay worker at its remaining budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coco-suite-budget-'));
    try {
      const result = await runBudgetedProcess(
        ['-e', 'setInterval(() => {}, 1000)'],
        {},
        join(dir, 'worker.log'),
        100,
      );
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(() => process.kill(result.pid, 0)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('suite planning', () => {
  it('runs the whole fixed corpus with the fixed seeds on pull requests', () => {
    expect(planSuite(['--profile', 'pr'], sequence())).toMatchObject({
      profile: 'pr',
      files: [SIM_FILES.scenarios, SIM_FILES.palette, SIM_FILES.artifacts],
      seeds: [1, 2],
      faultSeeds: [5, 18],
      requireCorpusCoverage: true,
      replayFailures: false,
    });
  });

  it('keeps the pull-request corpus fixed', () => {
    expect(() => planSuite(['--profile', 'pr', '--seeds', '7'], sequence())).toThrow(
      SuiteUsageError,
    );
  });

  it('draws bounded random seeds nightly and records them, alongside the fixed corpus', () => {
    const plan = planSuite(
      ['--profile', 'nightly', '--random-seeds', '2'],
      sequence(0.5, 0.25, 0.75, 0),
    );

    expect(plan).toMatchObject({
      profile: 'nightly',
      files: [SIM_FILES.scenarios, SIM_FILES.palette, SIM_FILES.artifacts],
      seeds: [2147483648, 1073741824],
      faultSeeds: [3221225472, 0],
      requireCorpusCoverage: true,
      replayFailures: true,
    });
  });

  it('runs only the generated tests of arbitrary local seeds', () => {
    const plan = planSuite(['--profile', 'seeds', '--fault-seeds', '7,4294967295'], sequence());

    expect(plan).toMatchObject({
      profile: 'seeds',
      files: [SIM_FILES.palette],
      seeds: [],
      faultSeeds: [7, 4294967295],
      requireCorpusCoverage: false,
    });
    expect(plan.testNamePattern).toBeDefined();
  });

  it('rejects seeds that are not unsigned 32-bit integers and an empty seed selection', () => {
    for (const args of [
      ['--profile', 'seeds', '--seeds', '1,x'],
      ['--profile', 'seeds', '--seeds', '-1'],
      ['--profile', 'seeds', '--fault-seeds', '4294967296'],
      ['--profile', 'seeds'],
      ['--profile', 'weekly'],
      ['--profile', 'nightly', '--random-seeds', '0'],
      // The nightly budget must stay inside the CI job's timeout.
      ['--profile', 'nightly', '--random-seeds', '6'],
      ['--budget-minutes', 'soon'],
      ['--unknown'],
    ]) {
      expect(() => planSuite(args, sequence())).toThrow(SuiteUsageError);
    }
  });

  it('defaults to the pull-request corpus with a measured budget', () => {
    const plan = planSuite([], sequence());
    expect(plan.profile).toBe('pr');
    expect(plan.budgetMs).toBeGreaterThan(0);
  });
});

const junit = (cases: string) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="0">
  <testsuite name="x" file="x">${cases}
  </testsuite>
</testsuites>`;

const testcase = (file: string, name: string, body = '') =>
  `<testcase name="${name}" classname="c" time="1.5" file="${file}" line="1" assertions="1"${
    body ? `>${body}</testcase>` : ' />'
  }`;

const generated = (seed: number) =>
  `generated workload from scenario seed ${seed} stays accounted for`;
const faulted = (seed: number, mode: string) =>
  `scenario seed ${seed}, ${mode} recovery: every fault fires and value stays accounted`;

describe('test selection', () => {
  const plan = planSuite(['--profile', 'seeds', '--seeds', '3', '--fault-seeds', '9'], sequence());
  const scenarios = 'packages/core/test/fault-simulation/walletFaultSimulation.sim.ts';
  const palette = 'packages/core/test/fault-simulation/faultPalette.sim.ts';

  it('parses executed, failed and skipped test cases', () => {
    const cases = parseJunit(
      junit(
        testcase(scenarios, generated(3)) +
          testcase(palette, 'x &amp; y', '<skipped />') +
          testcase(palette, faulted(9, 'explicit'), '<failure type="AssertionError" />'),
      ),
    );

    expect(cases).toEqual([
      { file: scenarios, name: generated(3), seconds: 1.5, status: 'passed' },
      { file: palette, name: 'x & y', seconds: 1.5, status: 'skipped' },
      { file: palette, name: faulted(9, 'explicit'), seconds: 1.5, status: 'failed' },
    ]);
  });

  it('accepts a run that executed every requested seed in both recovery modes', () => {
    const cases = parseJunit(
      junit(
        testcase(scenarios, generated(3)) +
          testcase(palette, faulted(9, 'automatic')) +
          testcase(palette, faulted(9, 'explicit')) +
          testcase(palette, 'a test outside the seed filter', '<skipped />'),
      ),
    );

    expect(checkTestSelection(plan, cases)).toEqual([]);
  });

  it('reports seeds and recovery modes that were not executed, and empty files', () => {
    const cases = parseJunit(
      junit(
        testcase(palette, faulted(9, 'automatic')) +
          testcase(palette, faulted(9, 'explicit'), '<skipped />'),
      ),
    );

    expect(checkTestSelection(plan, cases)).toEqual([
      `no test executed from ${SIM_FILES.scenarios}`,
      `not executed: ${generated(3)}`,
      `not executed: ${faulted(9, 'explicit')}`,
    ]);
  });

  it('rejects any skipped test in the corpus and an empty run', () => {
    const corpus = planSuite(['--profile', 'pr'], sequence());
    const skipped = parseJunit(junit(testcase(scenarios, 'healthy baseline', '<skipped />')));

    expect(checkTestSelection(corpus, skipped)).toEqual(
      expect.arrayContaining(['skipped: healthy baseline']),
    );
    expect(checkTestSelection(corpus, [])).toEqual(
      expect.arrayContaining(['no test executed at all']),
    );
  });
});

const outcomes = (reports: RunReport[]) =>
  reports.map((run) => ({ outcome: run.outcome, expectationMet: run.expectationMet }));

describe('corpus coverage gate', () => {
  it('names every agreed fault kind, recovery mode and outcome a run set did not demonstrate', () => {
    const reports = [report('v2-generated-faults-explicit-seed-5.trace.json')];

    const gaps = corpusCoverageGaps(
      mergeCoverage(reports.map((r) => r.coverage)),
      outcomes(reports),
    );

    expect(gaps).toEqual([
      'fault kind dropRequest never exercised',
      'fault kind dropResponse never exercised',
      'fault kind withholdResponse never exercised',
      'recovery mode automatic never judged',
      'no Wallet crash interrupted a request the mint had accepted',
      'no exchange fault interrupted a command after the mint accepted it',
      'no led race won by the sender',
      'no duplicate delivery was rejected',
      'no detected wallet failure from a negative control',
      'no detected infrastructure failure from a negative control',
    ]);
  });

  it('counts a fault that never fired and traffic that bypassed the link as gaps', () => {
    const coverage = mergeCoverage([report('v2-wallet-crashes.trace.json').coverage]);
    coverage.faults.unfired['dropRequest POST /v1/swap @mint-a'] = 1;
    coverage.link.unrouted = 2;

    expect(corpusCoverageGaps(coverage, [])).toEqual(
      expect.arrayContaining([
        'installed faults never fired: dropRequest POST /v1/swap @mint-a',
        '2 Wallet requests bypassed the transport link (unrouted)',
      ]),
    );
  });
});

describe('runtime prerequisites', () => {
  it('requires a Bun whose fetch does not resend a POST after the connection drops', () => {
    // Bun 1.3.11 resent a dropped POST transparently, hiding dropped requests and responses from
    // Coco; 1.3.14 is the verified minimum.
    expect(bunVersionProblem('1.3.11')).toContain('1.3.14');
    expect(bunVersionProblem('1.3.13')).toContain('1.3.14');
    expect(bunVersionProblem('1.3.14')).toBeUndefined();
    expect(bunVersionProblem('1.4.0')).toBeUndefined();
    expect(bunVersionProblem('2.0.1')).toBeUndefined();
    expect(bunVersionProblem('unknown')).toContain('1.3.14');
  });
});
