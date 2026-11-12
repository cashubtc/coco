/**
 * Portable, redacted scenario trace.
 *
 * The trace records the scenario plan, component versions and the observed ordering of commands,
 * faults, crashes and observations. Secret-bearing values appear only as references. Every secret
 * the harness handles is registered, and writing fails if any of them would reach the trace.
 */
import { writeFileSync } from 'node:fs';
import type { ScenarioPlan } from './scenarios.ts';

export const TRACE_FORMAT = 'coco-wallet-fault-simulation/trace/v2';

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
