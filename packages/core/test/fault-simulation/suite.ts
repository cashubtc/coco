/**
 * The wallet fault simulation suite entrypoint used locally and in CI.
 *
 * A profile selects real-mint test files and scenario seeds: `pr` (the fixed corpus with fixed
 * seeds), `nightly` (the fixed corpus with bounded random seeds) or `seeds` (only the generated
 * workloads of arbitrary local seeds). The suite checks prerequisites, runs `bun test` under a
 * wall-clock budget, and then establishes from evidence rather than from the test exit code alone:
 *
 * - the intended tests actually executed (JUnit), with no skipped test in a corpus profile;
 * - every run met its expectation, apart from the deliberately failing evidence fixture;
 * - for the corpus profiles, every agreed fault kind, both recovery modes, both supported race
 *   outcomes and the negative controls were demonstrably exercised, no installed fault stayed
 *   unfired and no Wallet traffic bypassed the transport link.
 *
 * Its output directory has two parts. `work/` is the harness artifacts root, holding every run's
 * directory including `private/` (Wallet Seeds and stores of failed runs); it never leaves the
 * machine. `portable/` holds only exports the secret scanner approved: per-run traces and reports,
 * the JUnit report, the test log, and the suite summary. CI uploads `portable/` alone.
 *
 * The suite never retries a test. With `--replay-failures` (the nightly default) it replays failed
 * runs from clean state once and records the comparison, but a passing replay never changes the
 * original failure or the exit code.
 *
 * Exit codes: 0 pass, 1 failure (tests, evidence, selection, coverage or export), 2 usage,
 * 3 missing prerequisite, 4 budget exceeded.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPortableArtifacts, findProhibitedContent, retainedSecrets } from './artifacts.ts';
import { MINT_IMAGE } from './environment.ts';
import { FAULT_LAB_REVISION, preparePinnedGateway } from './faultLabGateway.ts';
import {
  buildRunReport,
  mergeCoverage,
  renderCoverage,
  type Coverage,
  type RunReport,
} from './report.ts';
import { readTraceFile } from './trace.ts';

const HARNESS = 'packages/core/test/fault-simulation';

/** Real-mint test files, relative to the repository root, as `bun test` reports them. */
export const SIM_FILES = {
  scenarios: `${HARNESS}/walletFaultSimulation.sim.ts`,
  palette: `${HARNESS}/faultPalette.sim.ts`,
  artifacts: `${HARNESS}/walletFaultSimulationArtifacts.sim.ts`,
} as const;

const CORPUS_FILES = [SIM_FILES.scenarios, SIM_FILES.palette, SIM_FILES.artifacts];

/** The fixed scenario seeds of the pull-request corpus. */
export const PR_SEEDS = [1, 2];
export const PR_FAULT_SEEDS = [5, 18];
const DEFAULT_RANDOM_SEEDS = 3;
/** Keeps the nightly budget (20 + 9 minutes per seed) inside the CI job's 75-minute timeout. */
const MAX_RANDOM_SEEDS = 5;
const DEFAULT_MAX_REPLAYS = 2;

/**
 * Wall-clock budgets in minutes for the tests and replays, from measured runs (see the harness
 * README). They bound a hung run; they are not targets. Measured locally: the `pr` profile took
 * 434 and 446 s, the fixed tests alone about 140 s, a fault-free generated workload 6–13 s and a
 * generated fault workload up to 72 s per recovery mode.
 */
const BUDGET_MINUTES = {
  corpus: 20,
  perSeed: 3,
  perFaultSeed: 6,
  seedsBase: 5,
};

/**
 * Plan IDs of runs that fail on purpose as evidence-tooling fixtures (the known-bad plan, its
 * replays and minimization candidates in `walletFaultSimulationArtifacts.sim.ts`). Their tests
 * assert the failure; the suite does not count them as wallet failures.
 */
export const DELIBERATE_FAILURE_PREFIX = 'known-bad-';

/** Palette fault kinds every corpus run set must demonstrate, as reported in `faultKinds`. */
export const REQUIRED_FAULT_KINDS = [
  'dropRequest',
  'dropResponse',
  'withholdResponse',
  'delayResponses',
  'disconnect',
  'dropWebSockets',
  'crash',
  'restartMint',
];

/**
 * The oldest Bun verified to surface a dropped connection to the caller. Bun 1.3.11's `fetch`
 * resent a POST whose connection closed before the response, so a dropped swap request or
 * response reached the mint twice and never reached Coco as a failure: the palette's exchange
 * faults would silently test nothing. The transport link test detects this.
 */
export const MINIMUM_BUN = '1.3.14';

const versionParts = (version: string) =>
  /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1, 4).map(Number);

/** Why a Bun version cannot run the harness, or `undefined` if it can. */
export function bunVersionProblem(version: string): string | undefined {
  const actual = versionParts(version);
  const minimum = versionParts(MINIMUM_BUN)!;
  if (actual) {
    for (let index = 0; index < 3; index++) {
      if (actual[index]! > minimum[index]!) return undefined;
      if (actual[index]! < minimum[index]!) break;
      if (index === 2) return undefined;
    }
  }
  return (
    `Bun ${version} is older than ${MINIMUM_BUN}; its fetch resends a POST whose connection ` +
    'dropped, which hides dropped requests and responses from Coco'
  );
}

export class SuiteUsageError extends Error {
  override readonly name = 'SuiteUsageError';
}

export type SuiteProfile = 'pr' | 'nightly' | 'seeds';

export interface SuitePlan {
  profile: SuiteProfile;
  files: string[];
  /** Scenario seeds of fault-free generated workloads. */
  seeds: number[];
  /** Scenario seeds of generated fault workloads, each run in both recovery modes. */
  faultSeeds: number[];
  /** Restricts `bun test` to the generated tests of the selected seeds (`seeds` profile). */
  testNamePattern?: string;
  budgetMs: number;
  /** Require the corpus coverage gate (`corpusCoverageGaps`). */
  requireCorpusCoverage: boolean;
  replayFailures: boolean;
  maxReplays: number;
  /** Fail prerequisites unless Node is within Fault Lab's declared engine range. */
  strictRuntime: boolean;
  build: boolean;
  outDir?: string;
}

const USAGE = `Usage: bun ${HARNESS}/suite.ts [options]

  --profile pr|nightly|seeds   pr: fixed corpus and seeds ${PR_SEEDS} / ${PR_FAULT_SEEDS} (default)
                               nightly: fixed corpus with random seeds
                               seeds: only the generated workloads of --seeds / --fault-seeds
  --seeds a,b                  fault-free generated workload seeds (seeds profile)
  --fault-seeds a,b            generated fault workload seeds, both recovery modes (seeds profile)
  --random-seeds N             nightly: N random seeds of each kind (default ${DEFAULT_RANDOM_SEEDS}, max ${MAX_RANDOM_SEEDS})
  --budget-minutes M           wall-clock budget for the tests and replays
  --replay-failures            replay each failed run once from clean state (nightly default)
  --max-replays N              at most N replays (default ${DEFAULT_MAX_REPLAYS})
  --strict-runtime             require Node within Fault Lab's declared engine range (CI)
  --skip-build                 reuse the current core build
  --out DIR                    output directory (default .cache/fault-simulation/suites/<id>)

Exit codes: 0 pass, 1 failure, 2 usage, 3 missing prerequisite, 4 budget exceeded.`;

function parseSeeds(flag: string, value: string | undefined): number[] {
  if (value === undefined || value.trim() === '') {
    throw new SuiteUsageError(`${flag} needs a comma-separated list of seeds`);
  }
  return value.split(',').map((part) => {
    const text = part.trim();
    const seed = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(seed) || seed > 0xffff_ffff) {
      throw new SuiteUsageError(
        `${flag}: ${JSON.stringify(text)} is not an unsigned 32-bit integer`,
      );
    }
    return seed;
  });
}

function parsePositive(flag: string, value: string | undefined, integer: boolean): number {
  const number = Number(value);
  if (value === undefined || !(number > 0) || (integer && !Number.isInteger(number))) {
    throw new SuiteUsageError(`${flag} needs a positive ${integer ? 'integer' : 'number'}`);
  }
  return number;
}

const alternation = (seeds: number[]) => `(${seeds.join('|')})`;

/** Names of the generated tests a plan must execute, in plan order. */
export function expectedSeedTests(plan: Pick<SuitePlan, 'seeds' | 'faultSeeds'>): string[] {
  return [
    ...plan.seeds.map(
      (seed) => `generated workload from scenario seed ${seed} stays accounted for`,
    ),
    ...plan.faultSeeds.flatMap((seed) =>
      (['automatic', 'explicit'] as const).map(
        (mode) =>
          `scenario seed ${seed}, ${mode} recovery: every fault fires and value stays accounted`,
      ),
    ),
  ];
}

/**
 * Builds a suite plan from command-line arguments. `random` returns values in [0, 1) and draws
 * the nightly seeds, which are recorded in the plan and the summary.
 */
export function planSuite(args: string[], random: () => number): SuitePlan {
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (['--replay-failures', '--strict-runtime', '--skip-build'].includes(flag)) {
      options.set(flag, true);
      continue;
    }
    if (
      ![
        '--profile',
        '--seeds',
        '--fault-seeds',
        '--random-seeds',
        '--budget-minutes',
        '--max-replays',
        '--out',
      ].includes(flag)
    ) {
      throw new SuiteUsageError(`Unknown option ${flag}`);
    }
    const value = args[++index];
    if (value === undefined) throw new SuiteUsageError(`${flag} needs a value`);
    options.set(flag, value);
  }
  const value = (flag: string) => {
    const option = options.get(flag);
    return typeof option === 'string' ? option : undefined;
  };

  const profile = value('--profile') ?? 'pr';
  if (profile !== 'pr' && profile !== 'nightly' && profile !== 'seeds') {
    throw new SuiteUsageError(`Unknown profile ${profile}`);
  }
  const explicitSeeds = options.has('--seeds') || options.has('--fault-seeds');
  if (profile !== 'seeds' && explicitSeeds) {
    throw new SuiteUsageError(
      `The ${profile} profile has fixed or random seeds; use --profile seeds`,
    );
  }
  if (profile !== 'nightly' && options.has('--random-seeds')) {
    throw new SuiteUsageError('--random-seeds applies to the nightly profile');
  }

  let seeds: number[];
  let faultSeeds: number[];
  let files: string[];
  let budgetMinutes: number;
  let testNamePattern: string | undefined;
  if (profile === 'pr') {
    seeds = [...PR_SEEDS];
    faultSeeds = [...PR_FAULT_SEEDS];
    files = [...CORPUS_FILES];
    budgetMinutes = BUDGET_MINUTES.corpus;
  } else if (profile === 'nightly') {
    const count = options.has('--random-seeds')
      ? parsePositive('--random-seeds', value('--random-seeds'), true)
      : DEFAULT_RANDOM_SEEDS;
    if (count > MAX_RANDOM_SEEDS) {
      throw new SuiteUsageError(`--random-seeds is at most ${MAX_RANDOM_SEEDS}`);
    }
    const draw = () => Math.floor(random() * 2 ** 32);
    seeds = Array.from({ length: count }, draw);
    faultSeeds = Array.from({ length: count }, draw);
    files = [...CORPUS_FILES];
    budgetMinutes =
      BUDGET_MINUTES.corpus + count * (BUDGET_MINUTES.perSeed + BUDGET_MINUTES.perFaultSeed);
  } else {
    seeds = options.has('--seeds') ? parseSeeds('--seeds', value('--seeds')) : [];
    faultSeeds = options.has('--fault-seeds')
      ? parseSeeds('--fault-seeds', value('--fault-seeds'))
      : [];
    if (seeds.length + faultSeeds.length === 0) {
      throw new SuiteUsageError('The seeds profile needs --seeds and/or --fault-seeds');
    }
    files = [
      ...(seeds.length > 0 ? [SIM_FILES.scenarios] : []),
      ...(faultSeeds.length > 0 ? [SIM_FILES.palette] : []),
    ];
    testNamePattern = [
      ...(seeds.length > 0
        ? [`generated workload from scenario seed ${alternation(seeds)} stays`]
        : []),
      ...(faultSeeds.length > 0
        ? [`scenario seed ${alternation(faultSeeds)}, (automatic|explicit) recovery`]
        : []),
    ].join('|');
    budgetMinutes =
      BUDGET_MINUTES.seedsBase +
      seeds.length * BUDGET_MINUTES.perSeed +
      faultSeeds.length * BUDGET_MINUTES.perFaultSeed;
  }
  if (options.has('--budget-minutes')) {
    budgetMinutes = parsePositive('--budget-minutes', value('--budget-minutes'), false);
  }
  const outDir = value('--out');
  return {
    profile,
    files,
    seeds,
    faultSeeds,
    ...(testNamePattern ? { testNamePattern } : {}),
    budgetMs: Math.round(budgetMinutes * 60_000),
    requireCorpusCoverage: profile !== 'seeds',
    replayFailures: profile === 'nightly' || options.has('--replay-failures'),
    maxReplays: options.has('--max-replays')
      ? parsePositive('--max-replays', value('--max-replays'), true)
      : DEFAULT_MAX_REPLAYS,
    strictRuntime: options.has('--strict-runtime'),
    build: !options.has('--skip-build'),
    ...(outDir ? { outDir } : {}),
  };
}

export interface TestCase {
  file: string;
  name: string;
  seconds: number;
  status: 'passed' | 'failed' | 'skipped';
}

const decodeXml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Test cases from `bun test --reporter=junit` output. */
export function parseJunit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  for (const match of xml.matchAll(/<testcase\s([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes: Record<string, string> = {};
    for (const [, key, value] of match[1]!.matchAll(/(\w+)="([^"]*)"/g)) {
      attributes[key!] = decodeXml(value!);
    }
    const body = match[2] ?? '';
    cases.push({
      file: (attributes.file ?? '').replace(/^\.\//, ''),
      name: attributes.name ?? '',
      seconds: Number(attributes.time ?? 0),
      status: /<(failure|error)\b/.test(body)
        ? 'failed'
        : /<skipped\b/.test(body)
          ? 'skipped'
          : 'passed',
    });
  }
  return cases;
}

/**
 * Problems with what `bun test` actually executed: nothing at all, a selected file without an
 * executed test, a requested seed or recovery mode that did not run, or, outside a seed filter,
 * any skipped test. A test's presence in a file is not evidence that it ran.
 */
export function checkTestSelection(plan: SuitePlan, cases: TestCase[]): string[] {
  const problems: string[] = [];
  const executed = cases.filter((testCase) => testCase.status !== 'skipped');
  if (executed.length === 0) problems.push('no test executed at all');
  for (const file of plan.files) {
    if (!executed.some((testCase) => testCase.file === file)) {
      problems.push(`no test executed from ${file}`);
    }
  }
  for (const name of expectedSeedTests(plan)) {
    if (!executed.some((testCase) => testCase.name === name))
      problems.push(`not executed: ${name}`);
  }
  if (plan.testNamePattern === undefined) {
    for (const testCase of cases) {
      if (testCase.status === 'skipped') problems.push(`skipped: ${testCase.name}`);
    }
  }
  return problems;
}

const keys = (counts: Record<string, number>) => Object.keys(counts);
const anyKey = (counts: Record<string, number>, predicate: (key: string) => boolean) =>
  keys(counts).some((key) => (counts[key] ?? 0) > 0 && predicate(key));

/**
 * What the corpus must demonstrably exercise, judged from observed coverage and run outcomes.
 * Each gap names a requirement of spec #616 the run set did not establish.
 */
export function corpusCoverageGaps(
  coverage: Coverage,
  outcomes: { outcome: string; expectationMet: boolean }[],
): string[] {
  const gaps: string[] = [];
  for (const kind of REQUIRED_FAULT_KINDS) {
    if (!coverage.faultKinds[kind]) gaps.push(`fault kind ${kind} never exercised`);
  }
  for (const mode of ['automatic', 'explicit']) {
    if (!coverage.recoveryModes[mode]) gaps.push(`recovery mode ${mode} never judged`);
  }
  if (!coverage.restarts.after_crash) gaps.push('no Wallet restarted after a crash');
  if (!anyKey(coverage.crashes, (key) => key.includes('mintAcceptedRequest=true'))) {
    gaps.push('no Wallet crash interrupted a request the mint had accepted');
  }
  if (!anyKey(coverage.exchanges, (key) => key.includes('interrupted mintAcceptedRequest=false'))) {
    gaps.push("no exchange fault interrupted a command before the mint's effect");
  }
  if (!anyKey(coverage.exchanges, (key) => key.includes('interrupted mintAcceptedRequest=true'))) {
    gaps.push('no exchange fault interrupted a command after the mint accepted it');
  }
  if (!anyKey(coverage.recoveries, (key) => key !== 'no_change')) {
    gaps.push('no explicit recovery changed an operation');
  }
  if (!coverage.races['lead=recipient winner=recipient']) {
    gaps.push('no led race won by the recipient');
  }
  if (!coverage.races['lead=sender winner=sender']) gaps.push('no led race won by the sender');
  if (!coverage.commands['receive:rejected']) gaps.push('no duplicate delivery was rejected');
  if (!coverage.commands['reclaim:completed']) gaps.push('no reclaim completed');
  const unfired = keys(coverage.faults.unfired);
  if (unfired.length > 0) gaps.push(`installed faults never fired: ${unfired.join(', ')}`);
  if (coverage.link.unrouted > 0) {
    gaps.push(`${coverage.link.unrouted} Wallet requests bypassed the transport link (unrouted)`);
  }
  const detected = (outcome: string) =>
    outcomes.some((run) => run.outcome === outcome && run.expectationMet);
  if (!detected('wallet_failure')) gaps.push('no detected wallet failure from a negative control');
  if (!detected('infrastructure_failure')) {
    gaps.push('no detected infrastructure failure from a negative control');
  }
  return gaps;
}

// ---------------------------------------------------------------------------------------------
// Orchestration

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

type Verdict =
  | 'pass'
  | 'failed'
  | 'usage_error'
  | 'prerequisite_missing'
  | 'budget_exceeded'
  | 'internal_error';

const EXIT_CODES: Record<Verdict, number> = {
  pass: 0,
  failed: 1,
  internal_error: 1,
  usage_error: 2,
  prerequisite_missing: 3,
  budget_exceeded: 4,
};

interface RunEntry {
  runId: string;
  scenario: string;
  scenarioSeed?: number;
  recoveryMode: string;
  outcome: string;
  expectationMet: boolean;
  deliberate: boolean;
  replayOf?: string;
  seconds: number;
  /** Portable export, relative to `portable/`, or why the run was not exported. */
  exported?: string;
  exportProblem?: string;
  withheldLogs: string[];
  /** Private inputs were kept beside the local run (never exported). */
  privateRetained: boolean;
}

interface SuiteSummary {
  profile: SuiteProfile;
  plan: SuitePlan;
  startedAt: string;
  elapsedSeconds: number;
  runtime: Record<string, string | boolean>;
  prerequisites: string[];
  warnings: string[];
  testExitCode?: number | null;
  tests: TestCase[];
  testSeconds: number;
  selectionProblems: string[];
  runs: RunEntry[];
  coverage?: Coverage;
  coverageGaps: string[];
  replays: { original: string; replay?: string; status: string }[];
  leftoverContainers: string[];
  withheldSuiteFiles: string[];
  problems: string[];
  verdict: Verdict;
  exitCode: number;
  workDir: string;
}

function command(args: string[]): { ok: boolean; output: string } {
  try {
    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    return {
      ok: result.exitCode === 0,
      output: (result.exitCode === 0 ? result.stdout : result.stderr).toString().trim(),
    };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** Major-version bounds of an engine range such as `>=24.0.0 <25`. */
function satisfiesEngine(version: string, range: string): boolean {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  const lower = /\>=\s*v?(\d+)/.exec(range)?.[1];
  const upper = /<\s*v?(\d+)/.exec(range)?.[1];
  return (
    Number.isFinite(major) &&
    (lower === undefined || major >= Number(lower)) &&
    (upper === undefined || major < Number(upper))
  );
}

/**
 * Establishes what the harness needs before any test runs, so a missing prerequisite is reported
 * as such instead of surfacing as an unrelated test failure (and never as a skip).
 */
async function checkPrerequisites(summary: SuiteSummary): Promise<void> {
  const runtime = summary.runtime;
  runtime.bun = Bun.version;
  const suiteBun = bunVersionProblem(Bun.version);
  if (suiteBun) summary.prerequisites.push(`suite and test process: ${suiteBun}`);
  runtime.platform = `${process.platform}-${process.arch}`;
  const git = command(['git', '-C', repositoryRoot, 'rev-parse', 'HEAD']);
  if (git.ok) runtime.cocoCommit = git.output;
  else summary.prerequisites.push(`git is unavailable: ${git.output}`);

  const docker = command(['docker', 'version', '--format', '{{.Server.Version}}']);
  if (docker.ok) runtime.docker = docker.output;
  else summary.prerequisites.push(`Docker daemon is not reachable: ${docker.output}`);

  // Wallet processes run under the `bun` on PATH; the gateway and link under `node`.
  const walletBun = command(['bun', '--version']);
  if (!walletBun.ok) {
    summary.prerequisites.push(`bun is not on PATH (it runs the Wallets): ${walletBun.output}`);
  } else {
    runtime.walletBun = walletBun.output;
    const walletBunProblem = bunVersionProblem(walletBun.output);
    if (walletBunProblem) summary.prerequisites.push(`Wallet processes: ${walletBunProblem}`);
  }
  if (walletBun.ok && walletBun.output !== Bun.version) {
    summary.warnings.push(
      `Wallets run under bun ${walletBun.output}, the suite under ${Bun.version}`,
    );
  }

  const node = command(['node', '--version']);
  if (node.ok) runtime.node = node.output;
  else summary.prerequisites.push(`Node.js is unavailable (it runs the gateway): ${node.output}`);
  if (node.ok && !satisfiesEngine(node.output, '>=22')) {
    summary.prerequisites.push(`Node.js ${node.output} is older than 22`);
  }

  if (summary.prerequisites.length > 0) return;
  const cacheRoot = join(repositoryRoot, '.cache', 'fault-simulation');
  const checkout =
    process.env.COCO_FAULT_LAB_CHECKOUT ?? join(cacheRoot, 'cashu-fault-lab', FAULT_LAB_REVISION);
  try {
    await preparePinnedGateway(cacheRoot);
    runtime.faultLabRevision = FAULT_LAB_REVISION;
    // Later runs reuse this verified checkout instead of fetching into each work directory.
    process.env.COCO_FAULT_LAB_CHECKOUT = checkout;
  } catch (error) {
    summary.prerequisites.push(
      `Pinned Fault Lab gateway unavailable: ${error instanceof Error ? error.message : error}`,
    );
    return;
  }
  const engines = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  const engine = engines.engines?.node;
  if (engine) {
    runtime.faultLabNodeEngine = engine;
    runtime.nodeSatisfiesFaultLabEngine = satisfiesEngine(node.output, engine);
    if (!runtime.nodeSatisfiesFaultLabEngine) {
      const message = `Node.js ${node.output} is outside Fault Lab's declared engine ${engine}`;
      if (summary.plan.strictRuntime) summary.prerequisites.push(message);
      else summary.warnings.push(message);
    }
  }

  const image = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', MINT_IMAGE]);
  const pulled = image.ok ? image : command(['docker', 'pull', '-q', MINT_IMAGE]);
  if (pulled.ok) runtime.mintImage = MINT_IMAGE;
  else summary.prerequisites.push(`Mint image ${MINT_IMAGE} unavailable: ${pulled.output}`);
}

/** Removes containers the harness started from a test process that did not clean up. */
function removeLeftoverContainers(pid: number): string[] {
  const listed = command([
    'docker',
    'ps',
    '-a',
    '--filter',
    'name=coco-faultsim-',
    '--format',
    '{{.Names}}',
  ]);
  if (!listed.ok) return [];
  const leftover = listed.output
    .split('\n')
    .filter((name) => new RegExp(`-${pid}(-|$)`).test(name));
  for (const name of leftover) command(['docker', 'rm', '-f', name]);
  return leftover;
}

interface TestProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  pid: number;
}

/** Runs `bun test` in its own process group so a budget overrun kills every process it started. */
function runTests(
  plan: SuitePlan,
  env: Record<string, string>,
  junitPath: string,
  logPath: string,
  budgetMs: number,
): Promise<TestProcessResult> {
  const args = [
    'test',
    ...plan.files.map((file) => `./${file}`),
    '--reporter=junit',
    `--reporter-outfile=${junitPath}`,
    ...(plan.testNamePattern ? ['-t', plan.testNamePattern] : []),
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const write = (chunk: Buffer, stream: { write(chunk: Buffer): unknown }) => {
      appendFileSync(logPath, chunk);
      stream.write(chunk);
    };
    child.stdout!.on('data', (chunk: Buffer) => write(chunk, process.stdout));
    child.stderr!.on('data', (chunk: Buffer) => write(chunk, process.stderr));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, budgetMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, timedOut, pid: child.pid! });
    });
  });
}

const PORTABLE_SUITE_FILES = ['junit.xml', 'test-output.log'];

/** Reports and exports every run in the work directory that is not yet in the summary. */
function collectRuns(workDir: string, portableDir: string, summary: SuiteSummary): RunReport[] {
  const runsDir = join(workDir, 'runs');
  if (!existsSync(runsDir)) return [];
  const known = new Set(summary.runs.map((run) => run.runId));
  const reports: RunReport[] = [];
  for (const runId of readdirSync(runsDir).sort()) {
    if (known.has(runId)) continue;
    const runDir = join(runsDir, runId);
    const tracePath = join(runDir, 'trace.json');
    const privateRetained = existsSync(join(runDir, 'private'));
    if (!existsSync(tracePath)) {
      summary.runs.push({
        runId,
        scenario: 'unknown',
        recoveryMode: 'unknown',
        outcome: 'unresolved',
        expectationMet: false,
        deliberate: false,
        seconds: 0,
        exportProblem: 'no trace was written (redaction refusal or interrupted run)',
        withheldLogs: [],
        privateRetained,
      });
      continue;
    }
    const trace = readTraceFile(tracePath);
    const report = buildRunReport(trace);
    reports.push(report);
    const entry: RunEntry = {
      runId,
      scenario: report.scenario.id,
      ...(report.scenario.scenarioSeed !== undefined
        ? { scenarioSeed: report.scenario.scenarioSeed }
        : {}),
      recoveryMode: report.scenario.recoveryMode,
      outcome: report.outcome,
      expectationMet: report.expectationMet,
      deliberate: report.scenario.id.startsWith(DELIBERATE_FAILURE_PREFIX),
      ...(report.scenario.replayOf ? { replayOf: report.scenario.replayOf } : {}),
      seconds: Math.round((trace.events.at(-1)?.atMs ?? 0) / 100) / 10,
      withheldLogs: [],
      privateRetained,
    };
    try {
      const exported = exportPortableArtifacts(runDir, join(portableDir, 'runs', runId));
      entry.exported = `runs/${runId}`;
      entry.withheldLogs = exported.withheld.map(
        ({ file, reasons }) => `${file} (${reasons.join(', ')})`,
      );
    } catch (error) {
      entry.exportProblem =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    summary.runs.push(entry);
  }
  return reports;
}

/** Wallet Seeds retained beside any local run, to prove no suite-level file contains them. */
function allRetainedSecrets(workDir: string): string[] {
  const runsDir = join(workDir, 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).flatMap((runId) => retainedSecrets(join(runsDir, runId)));
}

function renderSummary(summary: SuiteSummary): string {
  const { plan } = summary;
  const list = (items: string[], empty = 'none') =>
    items.length === 0 ? [`- ${empty}`] : items.map((item) => `- ${item}`);
  const passed = summary.tests.filter((testCase) => testCase.status === 'passed').length;
  const failed = summary.tests.filter((testCase) => testCase.status === 'failed').length;
  const skipped = summary.tests.filter((testCase) => testCase.status === 'skipped').length;
  return [
    `# Wallet fault simulation suite: ${summary.verdict} (exit ${summary.exitCode})`,
    '',
    `Profile \`${summary.profile}\`; fault-free seeds ${JSON.stringify(plan.seeds)}; fault seeds ` +
      `${JSON.stringify(plan.faultSeeds)} (each automatic and explicit); budget ` +
      `${(plan.budgetMs / 60_000).toFixed(1)} min; elapsed ${Math.round(summary.elapsedSeconds)} s ` +
      `(tests ${Math.round(summary.testSeconds)} s).`,
    '',
    '## Problems',
    ...list([...summary.prerequisites, ...summary.problems]),
    '',
    '## Warnings',
    ...list(summary.warnings),
    '',
    `## Tests: ${passed} passed, ${failed} failed, ${skipped} skipped (bun exit ${summary.testExitCode ?? 'n/a'})`,
    '',
    '| File | Test | Status | Seconds |',
    '| --- | --- | --- | --- |',
    ...summary.tests.map(
      (testCase) =>
        `| ${testCase.file.replace(`${HARNESS}/`, '')} | ${testCase.name} | ${testCase.status} | ${testCase.seconds.toFixed(1)} |`,
    ),
    '',
    `## Runs: ${summary.runs.length}`,
    '',
    '| Scenario | Seed | Recovery | Outcome | Expectation | Seconds | Portable export |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...summary.runs.map(
      (run) =>
        `| ${run.scenario}${run.replayOf ? ' (replay)' : ''}${run.deliberate ? ' (deliberate failure)' : ''} | ` +
        `${run.scenarioSeed ?? ''} | ${run.recoveryMode} | ${run.outcome} | ` +
        `${run.expectationMet ? 'met' : 'NOT met'} | ${run.seconds} | ` +
        `${run.exported ?? `withheld: ${run.exportProblem}`}${run.withheldLogs.length ? `; logs withheld: ${run.withheldLogs.join(', ')}` : ''} |`,
    ),
    '',
    '## Replays of failed runs (originals stay failed)',
    ...list(
      summary.replays.map(
        (replay) =>
          `${replay.original}: ${replay.status}${replay.replay ? ` (${replay.replay})` : ''}`,
      ),
    ),
    '',
    '## Exercised coverage',
    summary.coverage ? renderCoverage(summary.coverage) : 'No runs were recorded.',
    '',
    '## Corpus coverage gaps',
    ...list(
      summary.coverageGaps,
      plan.requireCorpusCoverage ? 'none' : 'not required for this profile',
    ),
    '',
    '## Runtime',
    ...Object.entries(summary.runtime).map(([key, value]) => `- ${key}: ${value}`),
    '',
    'Private inputs (Wallet Seeds and stores of failed runs) stay in the local work directory and ' +
      'are never part of this portable output. Clean-state replay needs none of them.',
    '',
  ].join('\n');
}

/** Runs the suite and returns its exit code; always writes the summary when it can. */
export async function runSuite(args: string[]): Promise<number> {
  const started = Date.now();
  let plan: SuitePlan;
  try {
    plan = planSuite(args, () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32);
  } catch (error) {
    if (!(error instanceof SuiteUsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return EXIT_CODES.usage_error;
  }
  const suiteId = `${plan.profile}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = resolve(
    plan.outDir ?? join(repositoryRoot, '.cache', 'fault-simulation', 'suites', suiteId),
  );
  const workDir = join(outDir, 'work');
  const portableDir = join(outDir, 'portable');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(portableDir, { recursive: true });
  const junitPath = join(workDir, 'junit.xml');
  const logPath = join(workDir, 'test-output.log');
  writeFileSync(logPath, '');

  const summary: SuiteSummary = {
    profile: plan.profile,
    plan,
    startedAt: new Date(started).toISOString(),
    elapsedSeconds: 0,
    runtime: {},
    prerequisites: [],
    warnings: [],
    tests: [],
    testSeconds: 0,
    selectionProblems: [],
    runs: [],
    coverageGaps: [],
    replays: [],
    leftoverContainers: [],
    withheldSuiteFiles: [],
    problems: [],
    verdict: 'internal_error',
    exitCode: EXIT_CODES.internal_error,
    workDir: relative(repositoryRoot, workDir).startsWith('..')
      ? workDir
      : relative(repositoryRoot, workDir),
  };
  // The budget bounds the tests and replays; prerequisites and the build are not part of it.
  let budgetStarted = Date.now();
  const remaining = () => plan.budgetMs - (Date.now() - budgetStarted);

  try {
    console.log(`Fault simulation suite ${suiteId}: ${JSON.stringify({ ...plan, outDir })}`);
    await checkPrerequisites(summary);
    if (summary.prerequisites.length > 0) {
      summary.verdict = 'prerequisite_missing';
      return finish();
    }
    if (plan.build) {
      const build = command([process.execPath, 'run', '--filter=@cashu/coco-core', 'build']);
      if (!build.ok) {
        summary.problems.push(`Core build failed: ${build.output.slice(-2_000)}`);
        summary.verdict = 'failed';
        return finish();
      }
    }

    budgetStarted = Date.now();
    // Replays run in this process, so they must use the same artifacts root.
    process.env.COCO_FAULT_SIM_ARTIFACTS = workDir;
    const tests = await runTests(
      plan,
      {
        COCO_FAULT_SIM_ARTIFACTS: workDir,
        COCO_FAULT_SIM_SEEDS: plan.seeds.join(','),
        COCO_FAULT_SIM_FAULT_SEEDS: plan.faultSeeds.join(','),
      },
      junitPath,
      logPath,
      Math.max(remaining(), 1),
    );
    summary.testExitCode = tests.exitCode;
    summary.leftoverContainers = removeLeftoverContainers(tests.pid);
    if (existsSync(junitPath)) {
      summary.tests = parseJunit(readFileSync(junitPath, 'utf8'));
      summary.testSeconds = summary.tests.reduce((sum, testCase) => sum + testCase.seconds, 0);
    }

    const reports = collectRuns(workDir, portableDir, summary);
    summary.coverage = mergeCoverage(reports.map((report) => report.coverage));

    if (tests.timedOut) {
      summary.problems.push(
        `Budget of ${(plan.budgetMs / 60_000).toFixed(1)} minutes exceeded; the test process group was killed`,
      );
      summary.verdict = 'budget_exceeded';
      return finish();
    }

    if (tests.exitCode !== 0) summary.problems.push(`bun test exited with ${tests.exitCode}`);
    if (!existsSync(junitPath)) summary.problems.push('bun test wrote no JUnit report');
    summary.selectionProblems = checkTestSelection(plan, summary.tests);
    summary.problems.push(...summary.selectionProblems.map((problem) => `selection: ${problem}`));
    for (const testCase of summary.tests.filter((testCase) => testCase.status === 'failed')) {
      summary.problems.push(`test failed: ${testCase.name}`);
    }
    const failedRuns = summary.runs.filter((run) => !run.expectationMet && !run.deliberate);
    for (const run of failedRuns) {
      summary.problems.push(
        `run ${run.runId} ended ${run.outcome} without meeting its expectation`,
      );
    }
    for (const run of summary.runs.filter((entry) => entry.exportProblem)) {
      summary.problems.push(`run ${run.runId} was not exported: ${run.exportProblem}`);
    }
    if (summary.leftoverContainers.length > 0) {
      summary.warnings.push(
        `Removed containers the tests left behind: ${summary.leftoverContainers.join(', ')}`,
      );
    }
    if (plan.requireCorpusCoverage) {
      summary.coverageGaps = corpusCoverageGaps(summary.coverage, reports);
      summary.problems.push(...summary.coverageGaps.map((gap) => `coverage: ${gap}`));
    }

    if (plan.replayFailures) {
      await replayFailures(failedRuns.filter((run) => !run.replayOf));
      if (remaining() <= 0) {
        summary.problems.push('Budget exceeded while replaying failed runs');
        summary.verdict = 'budget_exceeded';
        return finish();
      }
    }
    summary.verdict = summary.problems.length === 0 ? 'pass' : 'failed';
    return finish();
  } catch (error) {
    summary.problems.push(
      `Suite error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    summary.verdict = 'internal_error';
    return finish();
  }

  async function replayFailures(failed: RunEntry[]): Promise<void> {
    const { replayTrace } = await import('./replay.ts');
    for (const run of failed.slice(0, plan.maxReplays)) {
      if (remaining() <= 0) break;
      const before = new Set(readdirSync(join(workDir, 'runs')));
      try {
        const result = await replayTrace(join(workDir, 'runs', run.runId, 'trace.json'));
        const replayId = readdirSync(join(workDir, 'runs')).find((id) => !before.has(id));
        summary.replays.push({
          original: run.runId,
          ...(replayId ? { replay: replayId } : {}),
          status: result.comparison.status,
        });
      } catch (error) {
        summary.replays.push({
          original: run.runId,
          status: `error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    // Export the replay runs too; the originals and the suite verdict are left as they are.
    collectRuns(workDir, portableDir, summary);
  }

  function finish(): number {
    summary.exitCode = EXIT_CODES[summary.verdict];
    summary.elapsedSeconds = (Date.now() - started) / 1000;
    const secrets = allRetainedSecrets(workDir);
    for (const name of PORTABLE_SUITE_FILES) {
      const path = join(workDir, name);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      const problems = findProhibitedContent(text, secrets);
      if (problems.length === 0) writeFileSync(join(portableDir, name), text);
      else {
        summary.withheldSuiteFiles.push(
          `${name} (${problems.map((problem) => problem.kind).join(', ')})`,
        );
      }
    }
    let markdown = renderSummary(summary);
    let json = JSON.stringify(summary, null, 2);
    const leaked = [
      ...findProhibitedContent(markdown, secrets),
      ...findProhibitedContent(json, secrets),
    ];
    if (leaked.length > 0) {
      // Never publish a summary that would carry secret-shaped content; keep only the verdict.
      summary.verdict = 'failed';
      summary.exitCode = EXIT_CODES.failed;
      const kinds = [...new Set(leaked.map((problem) => problem.kind))].join(', ');
      markdown = `# Wallet fault simulation suite: failed\n\nSummary withheld: it contained ${kinds}.\n`;
      json = JSON.stringify({ verdict: 'failed', exitCode: 1, withheld: kinds }, null, 2);
    }
    writeFileSync(join(portableDir, 'summary.json'), json);
    writeFileSync(join(portableDir, 'summary.md'), markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(`\n${markdown}\nPortable output: ${portableDir}\nLocal work directory: ${workDir}`);
    return summary.exitCode;
  }
}

if (import.meta.main) {
  process.exit(await runSuite(process.argv.slice(2)));
}
