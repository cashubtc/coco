/**
 * Portable, redacted scenario trace.
 *
 * The trace records the scenario plan, component versions and the observed ordering of commands,
 * faults, crashes and observations. Secret-bearing values appear only as references. Every secret
 * the harness handles is registered, and writing fails if any of them would reach the trace.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { ScenarioPlan, ScenarioStep } from './scenarios.ts';
import { planWorkload } from './workload.ts';

export const TRACE_FORMAT = 'coco-wallet-fault-simulation/trace/v2';
/** S1 traces: a single implicit mint and explicitly listed requirements. */
export const TRACE_FORMAT_V1 = 'coco-wallet-fault-simulation/trace/v1';
const TRACE_FORMAT_PREFIX = 'coco-wallet-fault-simulation/trace/';

export interface TraceEvent {
  seq: number;
  atMs: number;
  source: string;
  type: string;
  data?: Record<string, unknown>;
}

export interface TraceDocument {
  format: typeof TRACE_FORMAT;
  runId: string;
  plan: ScenarioPlan;
  components: Record<string, unknown>;
  configuration: Record<string, unknown>;
  privateInputs: { description: string; references: Record<string, string> };
  events: TraceEvent[];
  result?: Record<string, unknown>;
}

/** A secret would have reached a portable artifact. */
export class RedactionError extends Error {
  override readonly name = 'RedactionError';
}

/** A trace this harness cannot read faithfully. Never silently replaced by a different plan. */
export class UnsupportedTraceError extends Error {
  override readonly name = 'UnsupportedTraceError';
}

/**
 * A recorded trace in the current document shape. Observations (`events`, `result`,
 * `components`) are historical evidence and are returned exactly as recorded; only the plan of an
 * older format is translated, and `migratedFrom` says so.
 */
export interface RecordedTrace extends Omit<TraceDocument, 'format'> {
  format: typeof TRACE_FORMAT;
  migratedFrom?: { format: string; notes: string[] };
}

/**
 * Reads a recorded trace of any supported format.
 *
 * A v2 trace is returned as recorded, including step kinds this harness may not know, so reports
 * keep working across additive changes. Executing it is validated separately by replay. A v1
 * trace is translated to the equivalent v2 plan; translation fails with
 * {@link UnsupportedTraceError} rather than dropping a step or a requirement it cannot express.
 */
export function readTrace(text: string): RecordedTrace {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new UnsupportedTraceError('Trace is not valid JSON', { cause: error });
  }
  if (!isRecord(value)) throw new UnsupportedTraceError('Trace is not a JSON object');
  const format = value.format;
  if (format === TRACE_FORMAT) return requireDocument(value) as RecordedTrace;
  if (format === TRACE_FORMAT_V1) return migrateV1(requireDocument(value));
  if (typeof format === 'string' && format.startsWith(TRACE_FORMAT_PREFIX)) {
    throw new UnsupportedTraceError(`Trace format ${format} is not supported by this harness`);
  }
  throw new UnsupportedTraceError(`Not a wallet fault simulation trace: ${String(format)}`);
}

export function readTraceFile(path: string): RecordedTrace {
  return readTrace(readFileSync(path, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireDocument(value: Record<string, unknown>): TraceDocument {
  const plan = value.plan;
  if (
    typeof value.runId !== 'string' ||
    !isRecord(plan) ||
    !Array.isArray(plan.steps) ||
    !Array.isArray(plan.wallets) ||
    !Array.isArray(value.events)
  ) {
    throw new UnsupportedTraceError(
      'Trace lacks a run ID, a plan with steps and Wallets, or events',
    );
  }
  return {
    ...(value as unknown as TraceDocument),
    components: isRecord(value.components) ? value.components : {},
    configuration: isRecord(value.configuration) ? value.configuration : {},
    privateInputs: isRecord(value.privateInputs)
      ? (value.privateInputs as TraceDocument['privateInputs'])
      : { description: 'Not recorded', references: {} },
  };
}

/** The only mint of an S1 run. */
const V1_MINT = 'mint-a';

interface V1Requirement {
  wallet?: unknown;
  operation?: unknown;
  token?: unknown;
  state?: unknown;
}

/**
 * Translates an S1 plan. S1 had one implicit mint, called the final observation step
 * `awaitRequirements` and listed the required Receive outcomes, which the workload model now
 * derives. Each listed requirement must be implied by the derived expectations.
 */
function migrateV1(document: TraceDocument): RecordedTrace {
  const recorded = document.plan as unknown as Record<string, unknown> & {
    steps: Record<string, unknown>[];
    requirements?: V1Requirement[];
  };
  const steps = recorded.steps.map((step): ScenarioStep => {
    switch (step.kind) {
      case 'fund':
      case 'send':
      case 'withholdResponse':
        return { ...step, mint: V1_MINT } as unknown as ScenarioStep;
      case 'receive':
      case 'heal':
      case 'restart':
        return step as unknown as ScenarioStep;
      case 'awaitRequirements':
        return { kind: 'checkpoint' };
      default:
        throw new UnsupportedTraceError(`v1 step kind ${String(step.kind)} has no v2 equivalent`);
    }
  });
  const { requirements = [], ...rest } = recorded;
  const plan = { ...rest, mints: [V1_MINT], steps } as unknown as ScenarioPlan;

  let planned;
  try {
    planned = planWorkload(plan);
  } catch (error) {
    throw new UnsupportedTraceError(`v1 plan is not valid in the current workload model`, {
      cause: error,
    });
  }
  for (const requirement of requirements) {
    const implied =
      requirement.operation === 'receive' &&
      requirement.state === 'finalized' &&
      planned.steps.some(
        ({ step, receive }) =>
          step.kind === 'receive' &&
          step.wallet === requirement.wallet &&
          step.token === requirement.token &&
          receive === 'finalized',
      );
    if (!implied) {
      throw new UnsupportedTraceError(
        `v1 requirement ${JSON.stringify(requirement)} is not implied by the current workload model`,
      );
    }
  }
  return {
    ...document,
    format: TRACE_FORMAT,
    plan,
    migratedFrom: {
      format: TRACE_FORMAT_V1,
      notes: [
        `Steps without a mint run at ${V1_MINT}`,
        'awaitRequirements became a checkpoint, which also checks fund accounting',
        `${requirements.length} listed requirement(s) are implied by the workload model`,
      ],
    },
  };
}

export class ScenarioTrace {
  private readonly startedAt = Date.now();
  private readonly secrets = new Set<string>();
  readonly document: TraceDocument;

  constructor(runId: string, plan: ScenarioPlan) {
    this.document = {
      format: TRACE_FORMAT,
      runId,
      plan,
      components: {},
      configuration: {},
      privateInputs: {
        description:
          'Wallet Seeds and Wallet stores are private replay inputs. Clean-state replay of this ' +
          'plan generates fresh Wallet Seeds and needs none of them.',
        references: {},
      },
      events: [],
    };
  }

  /** Registers a value that must never appear in the portable trace. */
  registerSecret(...values: string[]): void {
    for (const value of values) if (value) this.secrets.add(value);
  }

  get secretCount(): number {
    return this.secrets.size;
  }

  record(source: string, type: string, data?: Record<string, unknown>): void {
    this.document.events.push({
      seq: this.document.events.length + 1,
      atMs: Date.now() - this.startedAt,
      source,
      type,
      ...(data ? { data } : {}),
    });
  }

  /** Serializes the trace after checking that no registered secret occurs in it. */
  serialize(): string {
    const json = JSON.stringify(this.document, null, 2);
    for (const secret of this.secrets) {
      if (json.includes(secret)) throw new RedactionError('A registered secret reached the trace');
    }
    return json;
  }

  write(path: string): void {
    writeFileSync(path, this.serialize());
  }
}
