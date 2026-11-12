/**
 * Portable run reports derived from recorded traces: failure identity, replay comparison and
 * actually exercised coverage.
 *
 * Everything here reads observations from the trace (events and result), never from the plan
 * alone, so a report cannot claim coverage a run did not achieve. Reports carry no secret-bearing
 * values: they are built only from a redacted trace.
 */
import { readTraceFile, type RecordedTrace, type TraceEvent } from './trace.ts';

type Outcome = 'pass' | 'wallet_failure' | 'unresolved' | 'infrastructure_failure';

/**
 * What makes two failures "the same": the outcome, the failing findings by code and the mint and
 * Wallet they concern, and for a contradicted command its kind, or for an unresolved run its error
 * class. Wallet outcomes unavailable from a live process at the decisive checkpoint are also
 * part of the identity: omitting startup recovery must not reproduce a failure after recovery.
 * Amounts, operation IDs and step indices are excluded because they legitimately differ
 * between a run and its replay or minimized form.
 */
export interface FailureSignature {
  outcome: string;
  findings: string[];
  commandFailure?: string;
  reasonClass?: string;
  /** Wallets whose decisive outcomes could not be observed through a running Coco Session. */
  unobservedWallets?: string[];
}

interface RecordedFinding {
  code?: unknown;
  severity?: unknown;
  mint?: unknown;
  wallet?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function findingKey(finding: RecordedFinding): string {
  return [
    String(finding.code),
    ...(typeof finding.mint === 'string' ? [`mint=${finding.mint}`] : []),
    ...(typeof finding.wallet === 'string' ? [`wallet=${finding.wallet}`] : []),
  ].join(' ');
}

/** The checker verdict that decided the run: the last non-passing one, else the last one. */
function decisiveVerdict(events: TraceEvent[]): Record<string, unknown> | undefined {
  const verdicts = events
    .filter((event) => event.type === 'verdict' && isRecord(event.data))
    .map((event) => event.data!);
  return verdicts.findLast((verdict) => verdict.status !== 'pass') ?? verdicts.at(-1);
}

export function runOutcome(trace: RecordedTrace): { outcome: string; expectationMet: boolean } {
  const result = trace.result ?? {};
  return {
    outcome: typeof result.outcome === 'string' ? result.outcome : 'unresolved',
    expectationMet: result.expectationMet === true,
  };
}

export function failureSignature(trace: RecordedTrace): FailureSignature {
  const { outcome } = runOutcome(trace);
  if (outcome === 'pass') return { outcome, findings: [] };
  const severity = outcome === 'unresolved' ? 'unresolved' : 'failure';
  const verdict = decisiveVerdict(trace.events);
  const recorded = Array.isArray(verdict?.findings) ? (verdict.findings as RecordedFinding[]) : [];
  const findings = [
    ...new Set(recorded.filter((finding) => finding.severity === severity).map(findingKey)),
  ].sort();
  const signature: FailureSignature = { outcome, findings };

  // Limit provenance to the decisive checkpoint. Earlier stopped Wallets may have recovered by
  // this point. v1 records read-only fallback; v2 also records an unavailable Wallet explicitly.
  const unobservedWallets = new Set<string>();
  if (verdict) {
    for (const event of trace.events) {
      if (event.type === 'verdict') {
        if (event.data === verdict) break;
        unobservedWallets.clear();
      } else if (event.type === 'outcomes_unobservable') {
        unobservedWallets.add(event.source);
      } else if (
        event.type === 'outcome_observed' &&
        event.data?.provenance === 'persisted_read_only' &&
        typeof event.data.wallet === 'string'
      ) {
        unobservedWallets.add(event.data.wallet);
      }
    }
  }
  if (unobservedWallets.size > 0) signature.unobservedWallets = [...unobservedWallets].sort();

  const commandFailed = trace.events.find((event) => event.type === 'command_failed');
  const failedStep = commandFailed?.data?.step;
  if (typeof failedStep === 'number') {
    signature.commandFailure = String(trace.plan.steps[failedStep]?.kind ?? 'unknown');
  }
  const reason = trace.result?.reason;
  const errorClass = typeof reason === 'string' ? /^([A-Z]\w*Error):/.exec(reason)?.[1] : undefined;
  if (errorClass) signature.reasonClass = errorClass;
  return signature;
}

export function sameFailure(a: FailureSignature, b: FailureSignature): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const canonical = (signature: FailureSignature) => ({
  outcome: signature.outcome,
  findings: [...signature.findings].sort(),
  commandFailure: signature.commandFailure ?? null,
  reasonClass: signature.reasonClass ?? null,
  unobservedWallets: [...(signature.unobservedWallets ?? [])].sort(),
});

export interface ReplayComparison {
  /**
   * For an original that met its expectation: `consistent` or `diverged`. For an original
   * failure: `reproduced` (same identity), `not_reproduced` (the replay met its expectation),
   * `different_failure`, or `inconclusive` (the replay environment failed).
   */
  status:
    | 'consistent'
    | 'diverged'
    | 'reproduced'
    | 'not_reproduced'
    | 'different_failure'
    | 'inconclusive';
  /** A replay never changes this: an original failure remains unresolved until fixed. */
  original: 'expectation_met' | 'unresolved';
  replayOutcome: string;
  /** Recorded component fields that differ, as dotted paths. */
  componentDifferences: string[];
}

export function compareRuns(original: RecordedTrace, replay: RecordedTrace): ReplayComparison {
  const before = runOutcome(original);
  const after = runOutcome(replay);
  const componentDifferences = differingPaths(original.components, replay.components).filter(
    (path) => path !== 'replayOf',
  );
  const base = { replayOutcome: after.outcome, componentDifferences };
  if (before.expectationMet) {
    return {
      ...base,
      original: 'expectation_met',
      status: after.expectationMet ? 'consistent' : 'diverged',
    };
  }
  let status: ReplayComparison['status'];
  if (after.outcome === ('infrastructure_failure' satisfies Outcome)) status = 'inconclusive';
  else if (sameFailure(failureSignature(original), failureSignature(replay))) status = 'reproduced';
  else if (after.expectationMet) status = 'not_reproduced';
  else status = 'different_failure';
  return { ...base, original: 'unresolved', status };
}

function differingPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((key) => differingPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

/** Exercised coverage, counted from observations. Keys are human-readable and stable. */
export interface Coverage {
  runs: number;
  /** `kind:result` of foreground commands; `kind:dispatched` for traces that predate results. */
  commands: Record<string, number>;
  faults: {
    /** Fault rules the gateway reports as applied: `METHOD path phase/action [@mint]`. */
    fired: Record<string, number>;
    /** Installed fault rules that never fired: `kind METHOD path [@mint]`. Not covered. */
    unfired: Record<string, number>;
  };
  /**
   * Agreed palette fault kinds that demonstrably happened: fired gateway and link faults by plan
   * step kind, every Wallet `crash`, and every `restartMint` the mint survived with its state.
   */
  faultKinds: Record<string, number>;
  /**
   * `signal trigger=… mintAcceptedRequest=… persisted=…` per Wallet crash; fields a crash did not
   * record (an idle crash has no interrupted request) are left out.
   */
  crashes: Record<string, number>;
  /** `after_crash`, `graceful`, `forced` (disposal had to kill) or `unrecorded`. */
  restarts: Record<string, number>;
  /** Recovery mode by the number of checkpoints that judged outcomes under it. */
  recoveryModes: Record<string, number>;
  /** `lead=… winner=…` or `unled winner=…` per receive-versus-reclaim race. */
  races: Record<string, number>;
  /** `keysetsRetained=… proofStatesRetained=…` per mint restart. */
  mintRestarts: Record<string, number>;
  /** `command fault result mintAcceptedRequest=… persisted=…` per corroborated exposed command. */
  exchanges: Record<string, number>;
  /** `kind before->after` per operation an explicit recovery call changed, or `no_change`. */
  recoveries: Record<string, number>;
  /** Checkpoint verdicts by status. */
  checkpoints: Record<string, number>;
  /** Wallet-to-mint requests seen by the gateways, by `METHOD path`. */
  transport: Record<string, number>;
  /** Transport link totals; `unrouted` counts requests that named no known mint (a bypass). */
  link: LinkTotals;
}

export interface LinkTotals {
  webSocketUpgrades: number;
  webSocketsClosedByFault: number;
  refusedConnections: number;
  connectionsClosedByFault: number;
  unrouted: number;
}

const emptyLink = (): LinkTotals => ({
  webSocketUpgrades: 0,
  webSocketsClosedByFault: 0,
  refusedConnections: 0,
  connectionsClosedByFault: 0,
  unrouted: 0,
});

const emptyCoverage = (runs: number): Coverage => ({
  runs,
  commands: {},
  faults: { fired: {}, unfired: {} },
  faultKinds: {},
  crashes: {},
  restarts: {},
  recoveryModes: {},
  races: {},
  mintRestarts: {},
  exchanges: {},
  recoveries: {},
  checkpoints: {},
  transport: {},
  link: emptyLink(),
});

export interface ReportedFinding {
  code: string;
  severity: string;
  message: string;
  mint?: string;
  wallet?: string;
  token?: string;
  amount?: number;
}

export interface RunReport {
  runId: string;
  scenario: {
    id: string;
    description: string;
    expect: string;
    recoveryMode: string;
    scenarioSeed?: number;
    generatorVersion?: number;
    migratedFrom?: string;
    replayOf?: string;
  };
  outcome: string;
  expectationMet: boolean;
  reason?: string;
  signature: FailureSignature;
  components: Record<string, unknown>;
  configuration: Record<string, unknown>;
  /** From the decisive checker verdict. */
  accounting: {
    status?: string;
    unexplained: Record<string, number>;
    stranded: Record<string, number>;
    outstanding: Record<string, number>;
    findings: ReportedFinding[];
  };
  coverage: Coverage;
  privateInputs: {
    /** Clean-state replay starts fresh Wallets with fresh Wallet Seeds. */
    requiredForCleanStateReplay: string[];
    /** Private references kept beside the trace to inspect the original Wallet state. */
    retainedForDiagnosis: Record<string, string>;
  };
  /** Event types this report does not interpret; the events remain in the trace. */
  additionalEvents: Record<string, number>;
}

/** Event types the report interprets or that carry no coverage of their own. */
const INTERPRETED_EVENTS = new Set([
  'process_started',
  'world_ready',
  'step',
  'command',
  'result',
  'rejected',
  'restart',
  'fault_installed',
  'fault_fired',
  'environment_healthy',
  'crashed',
  'crash_corroborated',
  'race_hold_installed',
  'race_lead_committed',
  'race_result',
  'outcomes_awaited',
  'outcomes_unobservable',
  'outcome_observed',
  'verdict',
  'checker_control_applied',
  'command_failed',
  'traffic',
  // Palette events whose coverage comes from the run result (faults, exchanges, recoveries and
  // mint restarts) or from the commands they belong to.
  'interrupted',
  'outage_started',
  'outage_ended',
  'websockets_dropped',
  'mint_killed',
  'mint_restarted',
  'exchange_corroborated',
  'recovery_observed',
  // S1 (v1) observation events.
  'requirement_observed',
  'requirement_unobservable',
]);

const count = (counts: Record<string, number>, key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const atMint = (mint: unknown) => (typeof mint === 'string' ? ` @${mint}` : '');

/**
 * Gateway faults recorded before fault kinds were (S1 and S2 traces) only installed
 * `withholdResponse`; the phase and action still identify the others.
 */
function inferredFaultKind(fault: Record<string, unknown>): string {
  if (typeof fault.kind === 'string') return fault.kind;
  const mechanism = `${String(fault.phase)}/${String(fault.action)}`;
  return (
    {
      'before_forward/drop': 'dropRequest',
      'after_downstream_response/drop': 'dropResponse',
      'after_downstream_response/delay': 'withholdResponse',
    }[mechanism] ?? `unrecorded ${mechanism}`
  );
}

const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);

function exercisedCoverage(trace: RecordedTrace): Coverage {
  const result = trace.result ?? {};
  const coverage = emptyCoverage(1);

  if (isRecord(result.commands)) {
    for (const [key, value] of Object.entries(result.commands)) {
      if (typeof value === 'number') count(coverage.commands, key, value);
    }
  } else {
    for (const event of trace.events) {
      if (event.type === 'step') count(coverage.commands, `${String(event.data?.kind)}:dispatched`);
    }
  }

  const fired = Array.isArray(result.faultsFired) ? result.faultsFired.filter(isRecord) : [];
  const firedRules = new Set<string>();
  for (const fault of fired) {
    if (typeof fault.applied === 'number' && fault.applied < 1) continue;
    firedRules.add(`${String(fault.ruleId)}${atMint(fault.mint)}`);
    count(coverage.faultKinds, inferredFaultKind(fault));
    count(
      coverage.faults.fired,
      `${text(fault.method) ?? '*'} ${text(fault.path) ?? '*'} ${String(fault.phase)}/${String(fault.action)}${atMint(fault.mint)}`,
    );
  }

  const crashedSinceRestart = new Set<string>();
  const recoveryMode = text(trace.plan.recoveryMode) ?? 'unrecorded';
  for (const event of trace.events) {
    const data = event.data ?? {};
    switch (event.type) {
      case 'fault_installed':
        if (!firedRules.has(`${String(data.ruleId)}${atMint(data.mint)}`)) {
          count(
            coverage.faults.unfired,
            `${String(data.kind)} ${text(data.method) ?? '*'} ${text(data.path) ?? '*'}${atMint(data.mint)}`,
          );
        }
        break;
      case 'crashed':
        crashedSinceRestart.add(event.source);
        break;
      case 'restart':
        count(
          coverage.restarts,
          crashedSinceRestart.delete(event.source)
            ? 'after_crash'
            : data.previousProcess === 'disposed'
              ? 'graceful'
              : data.previousProcess === 'killed'
                ? 'forced'
                : 'unrecorded',
        );
        break;
      case 'verdict':
        if (event.source !== 'checker') break;
        count(coverage.checkpoints, String(data.status));
        count(coverage.recoveryModes, recoveryMode);
        break;
      case 'traffic':
        if (isRecord(data.requests)) {
          for (const [request, requests] of Object.entries(data.requests)) {
            if (typeof requests === 'number') count(coverage.transport, request, requests);
          }
        }
        break;
    }
  }

  for (const crash of records(result.crashes)) {
    count(
      coverage.crashes,
      [
        String(crash.signal),
        ...(typeof crash.trigger === 'string' ? [`trigger=${crash.trigger}`] : []),
        ...(crash.mintAcceptedRequest === undefined
          ? []
          : [`mintAcceptedRequest=${String(crash.mintAcceptedRequest)}`]),
        ...(crash.persistedOperationState === undefined
          ? []
          : [`persisted=${String(crash.persistedOperationState)}`]),
      ].join(' '),
    );
    if (crash.signal === 'SIGKILL') count(coverage.faultKinds, 'crash');
  }
  for (const restart of records(result.mintRestarts)) {
    count(
      coverage.mintRestarts,
      `keysetsRetained=${String(restart.keysetsRetained)} proofStatesRetained=${String(restart.proofStatesRetained)}`,
    );
    if (restart.keysetsRetained === true && restart.proofStatesRetained === true) {
      count(coverage.faultKinds, 'restartMint');
    }
  }
  for (const exchange of records(result.exchanges)) {
    count(
      coverage.exchanges,
      [
        String(exchange.command),
        String(exchange.fault),
        String(exchange.result),
        ...(exchange.mintAcceptedRequest === undefined
          ? []
          : [`mintAcceptedRequest=${String(exchange.mintAcceptedRequest)}`]),
        ...(exchange.persistedOperationState === undefined
          ? []
          : [`persisted=${String(exchange.persistedOperationState)}`]),
      ].join(' '),
    );
  }
  for (const recovery of records(result.recoveries)) {
    const transitions = records(recovery.transitions);
    if (transitions.length === 0) count(coverage.recoveries, 'no_change');
    for (const transition of transitions) {
      count(
        coverage.recoveries,
        `${String(transition.kind)} ${String(transition.before)}->${String(transition.after)}`,
      );
    }
  }
  // Every record of a Wallet repeats that Wallet's unrouted count; count it once per Wallet.
  const unrouted = new Map<string, number>();
  for (const entry of records(result.transport)) {
    for (const field of [
      'webSocketUpgrades',
      'webSocketsClosedByFault',
      'refusedConnections',
      'connectionsClosedByFault',
    ] as const) {
      if (typeof entry[field] === 'number') coverage.link[field] += entry[field];
    }
    if (typeof entry.unrouted === 'number') unrouted.set(String(entry.wallet), entry.unrouted);
  }
  coverage.link.unrouted = [...unrouted.values()].reduce((sum, value) => sum + value, 0);
  const races = Array.isArray(result.races) ? result.races.filter(isRecord) : [];
  for (const race of races) {
    const lead = typeof race.lead === 'string' ? `lead=${race.lead}` : 'unled';
    count(coverage.races, `${lead} winner=${String(race.winner ?? 'unobserved')}`);
  }
  return coverage;
}

function byMint(ledger: unknown, field: string): Record<string, number> {
  if (!isRecord(ledger)) return {};
  if (isRecord(ledger.mints)) {
    const values: Record<string, number> = {};
    for (const [mint, entry] of Object.entries(ledger.mints)) {
      if (isRecord(entry) && typeof entry[field] === 'number') values[mint] = entry[field];
    }
    return values;
  }
  return typeof ledger[field] === 'number' ? { all: ledger[field] } : {};
}

/** Builds the portable report of one recorded run from its trace alone. */
export function buildRunReport(trace: RecordedTrace): RunReport {
  const { outcome, expectationMet } = runOutcome(trace);
  const plan = trace.plan;
  const verdict = decisiveVerdict(trace.events);
  const recordedFindings = Array.isArray(verdict?.findings)
    ? verdict.findings.filter(isRecord)
    : [];
  const additionalEvents: Record<string, number> = {};
  for (const event of trace.events) {
    if (!INTERPRETED_EVENTS.has(event.type)) count(additionalEvents, event.type);
  }
  const reason = text(trace.result?.reason);
  const replayOf = text(trace.components.replayOf);
  return {
    runId: trace.runId,
    scenario: {
      id: plan.id,
      description: plan.description,
      expect: plan.expect,
      recoveryMode: plan.recoveryMode,
      ...(plan.generator
        ? { scenarioSeed: plan.generator.seed, generatorVersion: plan.generator.version }
        : {}),
      ...(trace.migratedFrom ? { migratedFrom: trace.migratedFrom.format } : {}),
      ...(replayOf ? { replayOf } : {}),
    },
    outcome,
    expectationMet,
    ...(reason ? { reason } : {}),
    signature: failureSignature(trace),
    components: trace.components,
    configuration: trace.configuration,
    accounting: {
      ...(typeof verdict?.status === 'string' ? { status: verdict.status } : {}),
      unexplained: byMint(verdict?.ledger, 'unexplained'),
      stranded: byMint(verdict?.ledger, 'stranded'),
      outstanding: byMint(verdict?.ledger, 'outstanding'),
      findings: recordedFindings.map((finding) => ({
        code: String(finding.code),
        severity: String(finding.severity),
        message: String(finding.message),
        ...(typeof finding.mint === 'string' ? { mint: finding.mint } : {}),
        ...(typeof finding.wallet === 'string' ? { wallet: finding.wallet } : {}),
        ...(typeof finding.token === 'string' ? { token: finding.token } : {}),
        ...(typeof finding.amount === 'number' ? { amount: finding.amount } : {}),
      })),
    },
    coverage: exercisedCoverage(trace),
    privateInputs: {
      requiredForCleanStateReplay: [],
      retainedForDiagnosis: { ...trace.privateInputs.references },
    },
    additionalEvents,
  };
}

export function mergeCoverage(coverages: Coverage[]): Coverage {
  const merged = emptyCoverage(0);
  const add = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [key, value] of Object.entries(from)) count(into, key, value);
  };
  for (const coverage of coverages) {
    merged.runs += coverage.runs;
    add(merged.commands, coverage.commands);
    add(merged.faults.fired, coverage.faults.fired);
    add(merged.faults.unfired, coverage.faults.unfired);
    add(merged.faultKinds, coverage.faultKinds);
    add(merged.crashes, coverage.crashes);
    add(merged.restarts, coverage.restarts);
    add(merged.recoveryModes, coverage.recoveryModes);
    add(merged.races, coverage.races);
    add(merged.mintRestarts, coverage.mintRestarts);
    add(merged.exchanges, coverage.exchanges);
    add(merged.recoveries, coverage.recoveries);
    add(merged.checkpoints, coverage.checkpoints);
    add(merged.transport, coverage.transport);
    for (const field of Object.keys(merged.link) as (keyof LinkTotals)[]) {
      merged.link[field] += coverage.link[field];
    }
  }
  return merged;
}

function table(title: string, counts: Record<string, number>, empty: string): string[] {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return [`- ${title}: ${empty}`];
  return [`- ${title}:`, ...entries.map(([key, value]) => `  - ${key}: ${value}`)];
}

/** Coverage as Markdown lines; empty categories say so rather than disappearing. */
export function renderCoverage(coverage: Coverage): string {
  return [
    `Runs: ${coverage.runs}`,
    ...table('Commands', coverage.commands, 'none'),
    ...table('Faults fired', coverage.faults.fired, 'none'),
    ...table('Faults installed but never fired (not covered)', coverage.faults.unfired, 'none'),
    ...table('Fault kinds exercised', coverage.faultKinds, 'none'),
    ...table('Wallet crashes', coverage.crashes, 'none'),
    ...table('Wallet restarts', coverage.restarts, 'none'),
    ...table('Mint restarts', coverage.mintRestarts, 'none'),
    ...table('Interrupted exchanges', coverage.exchanges, 'none'),
    ...table('Explicit recovery transitions', coverage.recoveries, 'none'),
    ...table('Recovery modes (checkpoints)', coverage.recoveryModes, 'none'),
    ...table('Receive-versus-reclaim races', coverage.races, 'none'),
    ...table('Checkpoints', coverage.checkpoints, 'none'),
    ...table('Gateway requests', coverage.transport, 'none'),
    ...table('Transport link', { ...coverage.link }, 'none'),
  ].join('\n');
}

/** A human-readable portable report. Contains only values already in the redacted trace. */
export function renderReport(report: RunReport): string {
  const { scenario, signature, accounting } = report;
  const lines = [
    `# Wallet fault simulation run ${report.runId}`,
    '',
    `Scenario \`${scenario.id}\` (expect ${scenario.expect}, recovery ${scenario.recoveryMode})` +
      (scenario.scenarioSeed !== undefined
        ? `, scenario seed ${scenario.scenarioSeed}, generator v${scenario.generatorVersion}`
        : '') +
      (scenario.migratedFrom ? `, migrated from ${scenario.migratedFrom}` : '') +
      (scenario.replayOf ? `, replay of ${scenario.replayOf}` : ''),
    '',
    `Outcome: **${report.outcome}**, expectation ${report.expectationMet ? 'met' : 'NOT met'}` +
      (report.reason ? ` (${report.reason})` : ''),
    `Failure identity: ${JSON.stringify(signature)}`,
    '',
    '## Accounting differences',
    ...table('Unexplained value by mint', accounting.unexplained, 'not recorded'),
    ...table('Stranded value by mint', accounting.stranded, 'not recorded'),
    ...table('Outstanding tokens by mint', accounting.outstanding, 'not recorded'),
    ...(accounting.findings.length === 0
      ? ['- Findings: none']
      : [
          '- Findings:',
          ...accounting.findings.map((f) => `  - ${f.severity} ${f.code}: ${f.message}`),
        ]),
    '',
    '## Exercised coverage',
    renderCoverage(report.coverage),
    ...table(
      'Additional event types (in the trace, not interpreted)',
      report.additionalEvents,
      'none',
    ),
    '',
    '## Private inputs',
    'Clean-state replay needs no private inputs: it starts fresh Wallets with fresh Wallet Seeds.',
    'Retained beside the trace for diagnosis only (never publish):',
    ...Object.entries(report.privateInputs.retainedForDiagnosis).map(
      ([name, path]) => `- ${name}: \`${path}\``,
    ),
    '',
    '## Components',
    '```json',
    JSON.stringify(report.components, null, 2),
    '```',
    '',
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('Usage: bun packages/core/test/fault-simulation/report.ts <trace.json>...');
    process.exit(2);
  }
  const reports = paths.map((path) => buildRunReport(readTraceFile(path)));
  if (reports.length === 1) console.log(renderReport(reports[0]!));
  else {
    for (const report of reports) {
      console.log(`- ${report.runId}: ${report.outcome} (${JSON.stringify(report.signature)})`);
    }
    console.log(
      `\n## Aggregate exercised coverage\n\n${renderCoverage(mergeCoverage(reports.map((r) => r.coverage)))}`,
    );
  }
}
