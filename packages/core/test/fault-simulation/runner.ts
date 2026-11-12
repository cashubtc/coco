/**
 * Executes a scenario plan in a fresh world and classifies its outcome.
 *
 * World: one pinned mint container per logical mint, one pinned Fault Lab gateway in front of each
 * mint, and one Wallet actor process per Wallet. Wallets only know gateway URLs, so all their mint
 * HTTP traffic passes through a gateway. Every Wallet trusts every mint; transfers stay within the
 * token's mint.
 *
 * Scheduling: steps are dispatched in plan order. A step starts once the previous steps of its
 * Wallets and of its token have settled, so each Wallet has at most one foreground command
 * outstanding while different Wallets act concurrently. Barrier steps (faults, healing,
 * checkpoints, led races) wait for all earlier steps and block later ones.
 *
 * Outcomes: `pass`, `wallet_failure` (a required guarantee is missing in a healthy environment),
 * `unresolved` (evidence or a scenario precondition is missing) and `infrastructure_failure` (the
 * environment could not be established). Only `pass` counts as passing, except that negative
 * controls expect `wallet_failure`.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMintUrl } from '../../utils.ts';
import {
  checkFundAccounting,
  type AccountingEvidence,
  type AccountingVerdict,
  type ObservedProof,
  type OperationObservation,
  type RequiredOperationOutcome,
  type StoredProof,
} from './accounting.ts';
import {
  InfrastructureFailure,
  awaitStartup,
  MINT_IMAGE,
  MINT_INPUT_FEE_PPK,
  MINT_MNEMONICS,
  MINT_UNIT,
  MintContainer,
  waitUntil,
} from './environment.ts';
import {
  MintProbe,
  decodeTokenInputs,
  readPersistedOperationState,
  readStoredProofs,
} from './evidence.ts';
import {
  FAULT_LAB_REPOSITORY,
  FAULT_LAB_REVISION,
  FaultLabGateway,
  nodeVersion,
  preparePinnedGateway,
} from './faultLabGateway.ts';
import type { CheckerControl, ScenarioPlan, ScenarioStep } from './scenarios.ts';
import { TRACE_FORMAT, ScenarioTrace, type TraceDocument } from './trace.ts';
import {
  ActorCommandError,
  ActorTerminatedError,
  WalletActor,
  type ActorResults,
  type WalletActorOptions,
} from './walletActor.ts';
import {
  expectedReceiveStates,
  expectedSendStates,
  generateWorkload,
  planWorkload,
  type PlannedStep,
  type ReceiveExpectation,
  type TokenFate,
} from './workload.ts';

export type ScenarioOutcome = 'pass' | 'wallet_failure' | 'unresolved' | 'infrastructure_failure';

export interface FiredFault {
  ruleId: string;
  mint: string;
  phase: string;
  action: string;
  method?: string;
  path?: string;
  applied: number;
}

export interface CrashRecord {
  wallet: string;
  signal: string | null;
  /** Direct mint evidence that the request whose response was withheld took effect. */
  mintAcceptedRequest: boolean;
  /** Receive state in the store after the crash, read without a Coco Session. */
  persistedOperationState: string | undefined;
}

/** Observed result of one foreground command, judged against the plan's expectation. */
export interface CommandOutcome {
  step: number;
  kind: ScenarioStep['kind'];
  wallets: string[];
  token?: string;
  /**
   * `rejected` is a pass when the plan expects rejection, such as a duplicate delivery.
   * `interrupted` means the harness crashed the Wallet while the command was outstanding.
   */
  result: 'completed' | 'rejected' | 'interrupted';
}

/** A receive-versus-reclaim race and the claimant the mint and Coco agree won it. */
export interface RaceRecord {
  step: number;
  token: string;
  mint: string;
  recipient: string;
  sender: string;
  lead?: 'recipient' | 'sender';
  receive: 'completed' | 'rejected';
  reclaim: 'completed' | 'rejected';
  /** For a led race: the follower settled while the lead's committed response was still held. */
  overlapped?: boolean;
  /** Filled in by checkpoints from mint and operation evidence. */
  winner?: 'recipient' | 'sender' | 'none' | 'both' | 'unobserved';
}

export interface CheckpointRecord {
  step: number;
  status: AccountingVerdict['status'];
  findings: string[];
  ledger: Omit<AccountingVerdict['ledger'], 'wallets'>;
  /** Time from the start of the recovery deadline until expected states held or it passed. */
  msAwaitingOutcomes: number;
  expectedOutcomesMet: boolean;
}

export interface ScenarioRun {
  runId: string;
  outcome: ScenarioOutcome;
  expectationMet: boolean;
  reason?: string;
  /** Verdict of the final checkpoint. */
  verdict?: AccountingVerdict;
  checkpoints: CheckpointRecord[];
  commands: CommandOutcome[];
  races: RaceRecord[];
  faultsFired: FiredFault[];
  crashes: CrashRecord[];
  tracePath: string;
  /** Number of secrets the redaction check verified to be absent from the trace. */
  secretsChecked: number;
}

/** A scenario precondition (such as an unfired fault) was not established. */
class ScenarioPreconditionError extends Error {
  override readonly name = 'ScenarioPreconditionError';
}

/** A command's observable result contradicts the plan in an environment without active faults. */
class WalletOutcomeError extends Error {
  override readonly name = 'WalletOutcomeError';
}

/** How long a led race holds the lead's committed swap response at the gateway. */
const LEAD_HOLD_MS = 3_000;

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function artifactsRoot(): string {
  return process.env.COCO_FAULT_SIM_ARTIFACTS ?? join(repositoryRoot, '.cache', 'fault-simulation');
}

function componentVersions(): Record<string, unknown> {
  const git = (args: string[]) =>
    Bun.spawnSync(['git', ...args], { cwd: repositoryRoot })
      .stdout.toString()
      .trim();
  const cashuTs = JSON.parse(
    readFileSync(fileURLToPath(import.meta.resolve('@cashu/cashu-ts/package.json')), 'utf8'),
  ) as { version: string };
  return {
    coco: { commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) !== '' },
    bun: Bun.version,
    cashuTs: cashuTs.version,
    faultLab: {
      repository: FAULT_LAB_REPOSITORY,
      revision: FAULT_LAB_REVISION,
      component: 'apps/http-fault-gateway',
      runtime: `node ${nodeVersion()}`,
    },
  };
}

interface MintNode {
  name: string;
  container: MintContainer;
  gateway: FaultLabGateway;
  probe: MintProbe;
  /** The URL Wallets use: the gateway in front of this mint. */
  url: string;
}

interface TokenRecord {
  ref: string;
  sender: string;
  mint: string;
  inputs: Omit<ObservedProof, 'mintState'>[];
  encoded: string;
  sendOperationId: string;
  fate: TokenFate;
}

interface ReceiveAttempt {
  wallet: string;
  token: string;
  step: number;
  expectation: ReceiveExpectation;
  /** Absent when preparation was rejected before Coco created an operation. */
  operationId?: string;
}

interface ExpectedOutcome {
  wallet: string;
  kind: 'receive' | 'send';
  operationId: string;
  expectedStates: string[];
}

/** Mutable state of one run. Kept in one place so steps read as the scenario's workflow. */
class ScenarioWorld {
  readonly actors = new Map<string, WalletActor>();
  readonly actorOptions = new Map<string, WalletActorOptions>();
  readonly mints = new Map<string, MintNode>();
  readonly mintByUrl = new Map<string, string>();
  readonly tokens = new Map<string, TokenRecord>();
  readonly receiveAttempts: ReceiveAttempt[] = [];
  readonly funding: { wallet: string; mint: string; amount: number }[] = [];
  readonly installedFaults: { ruleId: string; mint: string }[] = [];
  readonly faultsFired = new Map<string, FiredFault>();
  readonly crashes: CrashRecord[] = [];
  readonly commands: CommandOutcome[] = [];
  readonly races: RaceRecord[] = [];
  readonly checkpoints: CheckpointRecord[] = [];
  lastVerdict: AccountingVerdict | undefined;
  commandFailure: string | undefined;
  /** Set once a command failure or a failed checkpoint ends dispatch of further steps. */
  stopped = false;
  recoveryObservation: RecoveryObservation | undefined;
  readonly missedRecoveryOutcomes = new Map<string, string | undefined>();

  constructor(
    readonly plan: ScenarioPlan,
    readonly trace: ScenarioTrace,
  ) {}

  actor(wallet: string): WalletActor {
    const actor = this.actors.get(wallet);
    if (!actor) throw new Error(`Unknown Wallet ${wallet}`);
    return actor;
  }

  mint(name: string): MintNode {
    const mint = this.mints.get(name);
    if (!mint) throw new Error(`Unknown mint ${name}`);
    return mint;
  }

  token(ref: string): TokenRecord {
    const token = this.tokens.get(ref);
    if (!token) throw new Error(`Unknown token ${ref}`);
    return token;
  }

  mintOfUrl = (url: string): string | undefined => this.mintByUrl.get(normalizeMintUrl(url));

  async captureFiredFaults(): Promise<void> {
    for (const { ruleId, mint } of this.installedFaults) {
      const evidence = await this.mint(mint).gateway.evidence();
      const rule = evidence.rules.find((candidate) => candidate.id === ruleId);
      if (!rule || rule.applied === 0) continue;
      this.faultsFired.set(ruleId, {
        ruleId,
        mint,
        phase: rule.phase,
        action: rule.action,
        method: rule.method,
        path: rule.path,
        applied: rule.applied,
      });
    }
  }

  async startActor(wallet: string): Promise<WalletActor> {
    const actor = await WalletActor.start(this.actorOptions.get(wallet)!);
    this.actors.set(wallet, actor);
    this.trace.record(wallet, 'process_started', { pid: actor.pid });
    return actor;
  }

  /** Expected states of every operation created so far, derived from the plan's token fates. */
  expectedOutcomes(): ExpectedOutcome[] {
    const outcomes: ExpectedOutcome[] = [...this.tokens.values()].map((token) => ({
      wallet: token.sender,
      kind: 'send',
      operationId: token.sendOperationId,
      expectedStates: expectedSendStates(token.fate),
    }));
    for (const attempt of this.receiveAttempts) {
      if (!attempt.operationId) continue;
      outcomes.push({
        wallet: attempt.wallet,
        kind: 'receive',
        operationId: attempt.operationId,
        expectedStates: expectedReceiveStates(attempt.expectation),
      });
    }
    return outcomes;
  }
}

const rejection = (error: unknown): error is ActorCommandError =>
  error instanceof ActorCommandError;

async function runStep(world: ScenarioWorld, planned: PlannedStep): Promise<void> {
  const { trace } = world;
  const { step, index } = planned;
  const completed = (result: CommandOutcome['result'], token?: string) =>
    world.commands.push({
      step: index,
      kind: step.kind,
      wallets: planned.wallets,
      ...(token ? { token } : {}),
      result,
    });
  switch (step.kind) {
    case 'fund': {
      const mint = world.mint(step.mint);
      trace.record(step.wallet, 'command', {
        step: index,
        type: 'fund',
        mint: step.mint,
        amount: step.amount,
      });
      const result = await world
        .actor(step.wallet)
        .request({ type: 'fund', mintUrl: mint.url, amount: step.amount });
      trace.record(step.wallet, 'result', { step: index, type: 'fund', ...result });
      if (result.state !== 'finalized') {
        throw new WalletOutcomeError(`Funding ${step.wallet} at ${step.mint} is ${result.state}`);
      }
      world.funding.push({ wallet: step.wallet, mint: step.mint, amount: step.amount });
      completed('completed');
      return;
    }
    case 'send': {
      const mint = world.mint(step.mint);
      trace.record(step.wallet, 'command', {
        step: index,
        type: 'send',
        mint: step.mint,
        amount: step.amount,
        token: step.token,
      });
      const result = await world
        .actor(step.wallet)
        .request({ type: 'send', mintUrl: mint.url, amount: step.amount });
      trace.registerSecret(result.token);
      const keysetIds = (await mint.probe.keysets()).map((keyset) => keyset.id);
      const decoded = decodeTokenInputs(result.token, step.mint, keysetIds);
      trace.registerSecret(...decoded.secrets);
      world.tokens.set(step.token, {
        ref: step.token,
        sender: step.wallet,
        mint: step.mint,
        inputs: decoded.inputs,
        encoded: result.token,
        sendOperationId: result.operationId,
        fate: planned.fateAfter!,
      });
      const tokenAmount = decoded.inputs.reduce((total, input) => total + input.amount, 0);
      trace.record(step.wallet, 'result', {
        step: index,
        type: 'send',
        operationId: result.operationId,
        token: step.token,
        tokenAmount,
        tokenProofs: decoded.inputs.length,
      });
      if (tokenAmount !== step.amount) {
        throw new WalletOutcomeError(`${step.token} carries ${tokenAmount}, not ${step.amount}`);
      }
      completed('completed', step.token);
      return;
    }
    case 'receive': {
      const token = world.token(step.token);
      const attempt: ReceiveAttempt = {
        wallet: step.wallet,
        token: step.token,
        step: index,
        expectation: planned.receive!,
      };
      world.receiveAttempts.push(attempt);
      const actor = world.actor(step.wallet);
      trace.record(step.wallet, 'command', {
        step: index,
        type: 'prepareReceive',
        token: step.token,
        expect: attempt.expectation,
      });
      let prepared: ActorResults['prepareReceive'];
      try {
        prepared = await actor.request({ type: 'prepareReceive', token: token.encoded });
      } catch (error) {
        if (!rejection(error) || attempt.expectation === 'finalized') throw error;
        trace.record(step.wallet, 'rejected', { step: index, type: 'prepareReceive' });
        completed('rejected', step.token);
        return;
      }
      attempt.operationId = prepared.operationId;
      token.fate = planned.fateAfter!;
      trace.record(step.wallet, 'command', {
        step: index,
        type: 'executeReceive',
        operationId: prepared.operationId,
      });
      const execution = actor
        .request({ type: 'executeReceive', operationId: prepared.operationId })
        .then(
          (result) => ({ result }),
          (error: Error) => ({ error }),
        );
      if (step.crashWhenFaultFires) {
        await crashWhenFaultFires(world, step.wallet, token, prepared.operationId, execution);
        completed('interrupted', step.token);
        return;
      }
      const settled = await execution;
      if ('error' in settled) {
        if (!rejection(settled.error) || attempt.expectation === 'finalized') throw settled.error;
        trace.record(step.wallet, 'rejected', { step: index, type: 'executeReceive' });
        completed('rejected', step.token);
        return;
      }
      trace.record(step.wallet, 'result', {
        step: index,
        type: 'executeReceive',
        ...settled.result,
      });
      if (attempt.expectation === 'rejected') {
        throw new WalletOutcomeError(`Duplicate delivery of ${step.token} was accepted`);
      }
      completed('completed', step.token);
      return;
    }
    case 'reclaim': {
      const token = world.token(step.token);
      trace.record(token.sender, 'command', {
        step: index,
        type: 'reclaim',
        token: step.token,
        operationId: token.sendOperationId,
        expect: planned.reclaim,
      });
      token.fate = planned.fateAfter!;
      try {
        const result = await world
          .actor(token.sender)
          .request({ type: 'reclaim', operationId: token.sendOperationId });
        trace.record(token.sender, 'result', { step: index, type: 'reclaim', ...result });
      } catch (error) {
        if (!rejection(error) || planned.reclaim === 'rolled_back') throw error;
        trace.record(token.sender, 'rejected', { step: index, type: 'reclaim' });
        completed('rejected', step.token);
        return;
      }
      if (planned.reclaim === 'rejected') {
        throw new WalletOutcomeError(`Reclaim of already claimed ${step.token} was accepted`);
      }
      completed('completed', step.token);
      return;
    }
    case 'raceReclaim':
      await race(world, planned, step);
      return;
    case 'restart': {
      const previous = world.actors.get(step.wallet);
      const stopped = previous ? await previous.shutdown() : 'not_running';
      trace.record(step.wallet, 'restart', {
        step: index,
        previousProcess: stopped,
        sameStore: true,
        sameWalletSeed: true,
      });
      if (stopped === 'killed') {
        throw new WalletOutcomeError(`${step.wallet} did not dispose within 10 seconds`);
      }
      await world.startActor(step.wallet);
      completed('completed');
      return;
    }
    case 'withholdResponse': {
      // The held response is lost when the Wallet process dies; the long hold outlasts the run.
      const ruleId = await world.mint(step.mint).gateway.addRule({
        phase: 'after_downstream_response',
        action: 'delay',
        delayMs: 600_000,
        count: 1,
        match: { method: step.method, path: step.path },
      });
      world.installedFaults.push({ ruleId, mint: step.mint });
      trace.record('gateway', 'fault_installed', { step: index, ruleId, ...step });
      return;
    }
    case 'heal': {
      await stopRecoveryObservation(world);
      await world.captureFiredFaults();
      for (const mint of world.mints.values()) {
        await mint.gateway.clearRules();
        const evidence = await mint.gateway.evidence();
        if (evidence.rules.length !== 0) {
          throw new InfrastructureFailure(`Fault rules remain at ${mint.name}`);
        }
      }
      await waitUntil('healthy mint and gateway paths', 10_000, async () => {
        for (const mint of world.mints.values()) {
          const direct = await fetch(`${mint.container.directUrl}/v1/info`);
          const proxied = await fetch(`${mint.url}/v1/info`);
          if (!direct.ok || !proxied.ok) return false;
        }
        return true;
      });
      world.recoveryObservation = await startRecoveryObservation(world);
      trace.record('harness', 'environment_healthy', { step: index });
      return;
    }
    case 'checkpoint':
      await checkpoint(world, index);
      return;
  }
}

/**
 * A coordinated receive-versus-reclaim race. Without a lead both claimants start together. With a
 * lead, the lead's swap response is held at the gateway after the mint has committed it, and the
 * follower then runs to completion while that response is still held.
 */
async function race(
  world: ScenarioWorld,
  planned: PlannedStep,
  step: Extract<ScenarioStep, { kind: 'raceReclaim' }>,
): Promise<void> {
  const { trace } = world;
  const token = world.token(step.token);
  const mint = world.mint(token.mint);
  const recipient = world.actor(step.recipient);
  const sender = world.actor(token.sender);

  const attempt: ReceiveAttempt = {
    wallet: step.recipient,
    token: step.token,
    step: planned.index,
    expectation: planned.receive!,
  };
  world.receiveAttempts.push(attempt);
  trace.record(step.recipient, 'command', {
    step: planned.index,
    type: 'prepareReceive',
    token: step.token,
    race: true,
  });
  attempt.operationId = (
    await recipient.request({ type: 'prepareReceive', token: token.encoded })
  ).operationId;
  token.fate = planned.fateAfter!;

  const settle = (side: 'receive' | 'reclaim', request: Promise<unknown>) =>
    request.then(
      () => ({ side, result: 'completed' as const, at: performance.now() }),
      (error: unknown) => {
        if (!rejection(error)) throw error;
        return { side, result: 'rejected' as const, at: performance.now() };
      },
    );
  const start = (side: 'receive' | 'reclaim') => {
    trace.record(side === 'receive' ? step.recipient : token.sender, 'command', {
      step: planned.index,
      type: side === 'receive' ? 'executeReceive' : 'reclaim',
      token: step.token,
      race: true,
    });
    return settle(
      side,
      side === 'receive'
        ? recipient.request({ type: 'executeReceive', operationId: attempt.operationId! })
        : sender.request({ type: 'reclaim', operationId: token.sendOperationId }),
    );
  };

  const record: RaceRecord = {
    step: planned.index,
    token: step.token,
    mint: token.mint,
    recipient: step.recipient,
    sender: token.sender,
    ...(step.lead ? { lead: step.lead } : {}),
    receive: 'rejected',
    reclaim: 'rejected',
  };
  let results: Awaited<ReturnType<typeof settle>>[];
  if (!step.lead) {
    results = await Promise.all([start('receive'), start('reclaim')]);
  } else {
    const leadSide = step.lead === 'recipient' ? 'receive' : 'reclaim';
    const followSide = leadSide === 'receive' ? 'reclaim' : 'receive';
    const ruleId = await mint.gateway.addRule({
      phase: 'after_downstream_response',
      action: 'delay',
      delayMs: LEAD_HOLD_MS,
      count: 1,
      match: { method: 'POST', path: '/v1/swap' },
    });
    trace.record('gateway', 'race_hold_installed', { step: planned.index, ruleId, leadSide });
    let leadSettled = false;
    const lead = start(leadSide);
    void lead.then(() => (leadSettled = true));
    // Event trigger: the mint has answered the lead's swap and the gateway is holding the reply.
    await waitUntil(
      'race lead swap committed',
      30_000,
      async () => {
        if (leadSettled) throw new ScenarioPreconditionError('Race lead settled before its hold');
        const evidence = await mint.gateway.evidence();
        return (evidence.rules.find((rule) => rule.id === ruleId)?.applied ?? 0) > 0;
      },
      10,
    ).catch((error: unknown) => {
      if (error instanceof ScenarioPreconditionError) throw error;
      throw new ScenarioPreconditionError('The race lead swap never reached the mint');
    });
    trace.record('gateway', 'race_lead_committed', { step: planned.index, ruleId });
    const follower = await start(followSide);
    const leader = await lead;
    record.overlapped = follower.at < leader.at;
    if (!record.overlapped) {
      trace.record('harness', 'race_hold_expired', { step: planned.index, token: step.token });
      throw new ScenarioPreconditionError(
        'Race follower did not settle while the lead response was held',
      );
    }
    results = [leader, follower];
  }
  for (const result of results) {
    record[result.side] = result.result;
    trace.record(result.side === 'receive' ? step.recipient : token.sender, 'race_result', {
      step: planned.index,
      side: result.side,
      result: result.result,
    });
  }
  world.races.push(record);
  world.commands.push({
    step: planned.index,
    kind: 'raceReclaim',
    wallets: planned.wallets,
    token: step.token,
    result: 'completed',
  });

  const expected = { receive: planned.receive, reclaim: planned.reclaim };
  if (record.receive === 'completed' && record.reclaim === 'completed') {
    throw new WalletOutcomeError(`Both claimants of ${step.token} report success`);
  }
  if (step.lead) {
    const winnerSide = step.lead === 'recipient' ? 'receive' : 'reclaim';
    if (record[winnerSide] !== 'completed') {
      throw new WalletOutcomeError(
        `The ${step.lead} led the ${step.token} race but its ${winnerSide} was rejected ` +
          `(expected ${expected[winnerSide]})`,
      );
    }
  }
}

async function crashWhenFaultFires(
  world: ScenarioWorld,
  wallet: string,
  token: TokenRecord,
  operationId: string,
  execution: Promise<{ result: unknown } | { error: Error }>,
): Promise<void> {
  const fault = world.installedFaults.at(-1);
  if (!fault) throw new Error('No fault precedes the crash trigger');
  const { gateway, probe } = world.mint(fault.mint);
  let settledEarly = false;
  void execution.then(() => (settledEarly = true));
  // Event trigger: the gateway has received the mint's response and is withholding it.
  await waitUntil(
    'fault trigger',
    30_000,
    async () => {
      if (settledEarly) throw new ScenarioPreconditionError('Receive settled before the fault');
      const evidence = await gateway.evidence();
      return (evidence.rules.find((rule) => rule.id === fault.ruleId)?.applied ?? 0) > 0;
    },
    10,
  ).catch((error: unknown) => {
    if (error instanceof ScenarioPreconditionError) throw error;
    throw new ScenarioPreconditionError('The withheld-response fault never fired');
  });
  await world.captureFiredFaults();
  world.trace.record('gateway', 'fault_fired', { ruleId: fault.ruleId, mint: fault.mint });

  const actor = world.actor(wallet);
  const { signal } = await actor.crash();
  const settled = await execution;
  world.trace.record(wallet, 'crashed', {
    pid: actor.pid,
    signal,
    pendingCommandInterrupted: 'error' in settled && settled.error.name === 'ActorTerminatedError',
  });

  const states = await probe.proofStates(token.inputs.map((input) => input.y));
  const mintAcceptedRequest = token.inputs.every((input) => states.get(input.y) === 'SPENT');
  const dbPath = world.actorOptions.get(wallet)!.dbPath;
  const persistedOperationState = readPersistedOperationState(dbPath, 'receive', operationId);
  const crash = { wallet, signal, mintAcceptedRequest, persistedOperationState };
  world.crashes.push(crash);
  world.trace.record('harness', 'crash_corroborated', { ...crash });
  if (!mintAcceptedRequest) {
    throw new ScenarioPreconditionError('The mint did not accept the withheld request');
  }
  if (persistedOperationState !== 'executing') {
    throw new ScenarioPreconditionError(
      `The crash did not interrupt the Receive (${persistedOperationState})`,
    );
  }
}

interface RecoveryObservation {
  expected: ExpectedOutcome[];
  startedAt: number;
  missed: Map<string, string | undefined>;
  cancelled: boolean;
  atCheckpoint: boolean;
  done: Promise<void>;
  error?: unknown;
}

const outcomeKey = (outcome: ExpectedOutcome) =>
  JSON.stringify([outcome.wallet, outcome.kind, outcome.operationId, outcome.expectedStates]);

/**
 * Capture the healthy baseline before releasing foreground work, then observe recovery alongside
 * that work. Only outcomes already required here belong to this window; later token transitions
 * get a separate check. An observed success and a missed deadline are both retained.
 */
async function startRecoveryObservation(
  world: ScenarioWorld,
  expected = world.expectedOutcomes(),
): Promise<RecoveryObservation> {
  const observation: RecoveryObservation = {
    expected,
    startedAt: Date.now(),
    missed: new Map(),
    cancelled: false,
    atCheckpoint: false,
    done: Promise.resolve(),
  };
  const pending = new Map(expected.map((outcome) => [outcomeKey(outcome), outcome]));
  const states = new Map<string, string | undefined>();
  const sample = async (baseline: boolean) => {
    const results = await Promise.allSettled(
      world.plan.wallets.map(async (wallet) => {
        const outcomes = [...pending.values()].filter((outcome) => outcome.wallet === wallet);
        if (!outcomes.length) return;
        const actor = world.actors.get(wallet);
        if (!actor?.running) {
          return;
        }
        let view: ActorResults['observe'];
        try {
          view = await actor.request({
            type: 'observe',
            receiveIds: outcomes
              .filter((outcome) => outcome.kind === 'receive')
              .map((outcome) => outcome.operationId),
            sendIds: outcomes
              .filter((outcome) => outcome.kind === 'send')
              .map((outcome) => outcome.operationId),
          });
        } catch (error) {
          // A planned restart can terminate an observation already in flight. The replacement
          // Session is observed on the next iteration; no recovery call is made here.
          if (!(error instanceof ActorTerminatedError)) throw error;
          return;
        }
        const inTime =
          baseline || Date.now() < observation.startedAt + world.plan.recoveryDeadlineMs;
        for (const outcome of outcomes) {
          const state = view.operations.find((op) => op.id === outcome.operationId)?.state;
          states.set(outcome.operationId, state);
          // A Send can pass through pending and be claimed by later foreground work between polls.
          // Final accounting still checks the exact fate required by that later work.
          const advanced =
            outcome.kind === 'send' &&
            outcome.expectedStates.includes('pending') &&
            (state === 'finalized' || state === 'rolled_back');
          if (
            inTime &&
            state !== undefined &&
            (outcome.expectedStates.includes(state) || advanced)
          ) {
            pending.delete(outcomeKey(outcome));
            world.trace.record('harness', 'outcome_observed', {
              wallet,
              operationId: outcome.operationId,
              state,
              provenance: 'public',
              phase: baseline ? 'healthy_baseline' : 'recovery',
              msSinceHealthy: Date.now() - observation.startedAt,
            });
          }
        }
      }),
    );
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  };
  await sample(true);
  // Baseline reads are part of establishing the healthy observation point. No subsequent
  // foreground command can start until this function returns.
  observation.startedAt = Date.now();
  observation.done = (async () => {
    while (pending.size) {
      const expired = Date.now() >= observation.startedAt + world.plan.recoveryDeadlineMs;
      for (const [key, outcome] of pending) {
        if (expired || (observation.atCheckpoint && !world.actors.get(outcome.wallet)?.running)) {
          observation.missed.set(outcome.operationId, states.get(outcome.operationId));
          pending.delete(key);
        }
      }
      if (!pending.size || observation.cancelled) return;
      await Bun.sleep(
        Math.min(
          100,
          Math.max(1, observation.startedAt + world.plan.recoveryDeadlineMs - Date.now()),
        ),
      );
      if (!observation.cancelled) await sample(false);
    }
  })().catch((error: unknown) => {
    observation.error = error;
  });
  return observation;
}

async function stopRecoveryObservation(world: ScenarioWorld): Promise<void> {
  const observation = world.recoveryObservation;
  if (!observation) return;
  observation.cancelled = true;
  await observation.done;
  for (const [id, state] of observation.missed) world.missedRecoveryOutcomes.set(id, state);
  world.recoveryObservation = undefined;
  if (observation.error) throw observation.error;
}

async function awaitExpectedOutcomes(world: ScenarioWorld, step: number) {
  const expected = world.expectedOutcomes();
  const prior = world.recoveryObservation;
  const start = prior?.startedAt ?? Date.now();
  if (prior) {
    prior.atCheckpoint = true;
    await prior.done;
    for (const [id, state] of prior.missed) world.missedRecoveryOutcomes.set(id, state);
    if (prior.error) throw prior.error;
  }
  const alreadyObserved = new Set(prior?.expected.map(outcomeKey));
  const current = await startRecoveryObservation(
    world,
    expected.filter((outcome) => !alreadyObserved.has(outcomeKey(outcome))),
  );
  current.atCheckpoint = true;
  await current.done;
  if (current.error) throw current.error;
  for (const [id, state] of current.missed) world.missedRecoveryOutcomes.set(id, state);
  for (const wallet of new Set(
    expected
      .filter((outcome) => !world.actors.get(outcome.wallet)?.running)
      .map((outcome) => outcome.wallet),
  )) {
    world.trace.record(wallet, 'outcomes_unobservable', {
      step,
      reason: 'Wallet process is not running',
    });
  }
  world.recoveryObservation = undefined;
  const msAwaitingOutcomes = Date.now() - start;
  world.trace.record('harness', 'outcomes_awaited', {
    step,
    expected: expected.length,
    unmet: [...world.missedRecoveryOutcomes].map(([operationId, state]) => ({
      operationId,
      state,
    })),
    msAwaitingOutcomes,
  });
  return {
    msAwaitingOutcomes,
    met: world.missedRecoveryOutcomes.size === 0,
    missedDeadlineIds: new Set(world.missedRecoveryOutcomes.keys()),
  };
}

async function checkpoint(world: ScenarioWorld, step: number): Promise<void> {
  const awaited = await awaitExpectedOutcomes(world, step);
  const verdict = await evaluate(world, step, awaited.missedDeadlineIds);
  world.lastVerdict = verdict;
  const { wallets: _wallets, ...ledger } = verdict.ledger;
  world.checkpoints.push({
    step,
    status: verdict.status,
    findings: verdict.findings.map((finding) => `${finding.code}: ${finding.message}`),
    ledger,
    msAwaitingOutcomes: awaited.msAwaitingOutcomes,
    expectedOutcomesMet: awaited.met,
  });
  if (verdict.status !== 'pass') world.stopped = true;
}

/** Collects mint, store and public evidence and runs the independent checker. */
async function evaluate(
  world: ScenarioWorld,
  step: number,
  missedDeadlineIds: Set<string>,
): Promise<AccountingVerdict> {
  const { plan, trace } = world;
  const expected = world.expectedOutcomes();

  const stored = new Map<string, Omit<StoredProof, 'mintState'>[]>();
  const views = new Map<string, ActorResults['observe']>();
  for (const wallet of plan.wallets) {
    const { proofs, secrets } = readStoredProofs(
      world.actorOptions.get(wallet)!.dbPath,
      MINT_UNIT,
      world.mintOfUrl,
    );
    trace.registerSecret(...secrets);
    stored.set(wallet, proofs);
    const actor = world.actors.get(wallet);
    if (!actor?.running) continue;
    const ids = (kind: 'receive' | 'send') =>
      expected
        .filter((outcome) => outcome.wallet === wallet && outcome.kind === kind)
        .map((outcome) => outcome.operationId);
    views.set(
      wallet,
      await actor.request({ type: 'observe', receiveIds: ids('receive'), sendIds: ids('send') }),
    );
  }

  // Proof states come from each mint directly, by the mint that issued the proof.
  const ysByMint = new Map<string, string[]>();
  const addY = (proof: { mint: string; y: string }) =>
    ysByMint.set(proof.mint, [...(ysByMint.get(proof.mint) ?? []), proof.y]);
  for (const proofs of stored.values()) proofs.forEach(addY);
  for (const token of world.tokens.values()) token.inputs.forEach(addY);
  const states = new Map<string, Map<string, ObservedProof['mintState'] & string>>();
  for (const [mint, ys] of ysByMint) {
    const node = world.mints.get(mint);
    if (node) states.set(mint, await node.probe.proofStates(ys));
  }
  const withState = <T extends { mint: string; y: string }>(proof: T) => ({
    ...proof,
    mintState: states.get(proof.mint)?.get(proof.y),
  });
  const keysetFeePpk: Record<string, Record<string, number>> = {};
  for (const mint of world.mints.values()) {
    keysetFeePpk[mint.name] = await mint.probe.keysetFeePpk(MINT_UNIT);
  }

  /** Public session state first; without a running session, the read-only persisted state. */
  const observe = (wallet: string, kind: 'receive' | 'send', operationId: string) => {
    const view = views.get(wallet)?.operations.find((op) => op.id === operationId);
    if (view) return { state: view.state, historyEntries: view.historyEntries, public: true };
    const dbPath = world.actorOptions.get(wallet)!.dbPath;
    return {
      state: readPersistedOperationState(dbPath, kind, operationId),
      historyEntries: undefined,
      public: false,
    };
  };
  const observation = (
    wallet: string,
    kind: 'receive' | 'send',
    operationId: string,
  ): OperationObservation => ({
    wallet,
    operationId,
    state: observe(wallet, kind, operationId).state,
  });

  const requiredOutcomes: RequiredOperationOutcome[] = expected.map((outcome) => {
    const observed = observe(outcome.wallet, outcome.kind, outcome.operationId);
    if (!observed.public) {
      trace.record('harness', 'outcome_observed', {
        step,
        wallet: outcome.wallet,
        operationId: outcome.operationId,
        state: observed.state,
        provenance: 'persisted_read_only',
      });
    }
    return {
      ...outcome,
      observedState: observed.state,
      missedDeadline: missedDeadlineIds.has(outcome.operationId),
      historyEntries: observed.historyEntries,
    };
  });

  const evidence: AccountingEvidence = {
    unit: MINT_UNIT,
    mints: plan.mints,
    keysetFeePpk,
    funding: world.funding,
    wallets: plan.wallets.map((wallet) => {
      const balances = views.get(wallet)?.balances ?? {};
      const publicBalances: Record<string, number | undefined> = {};
      for (const [url, balance] of Object.entries(balances)) {
        publicBalances[world.mintOfUrl(url) ?? url] = balance;
      }
      return { wallet, storedProofs: stored.get(wallet)!.map(withState), publicBalances };
    }),
    tokens: [...world.tokens.values()].map((token) => ({
      ref: token.ref,
      mint: token.mint,
      sender: token.sender,
      inputs: token.inputs.map(withState),
      expectedFate: token.fate,
      send: observation(token.sender, 'send', token.sendOperationId),
      receives: world.receiveAttempts
        .filter((attempt) => attempt.token === token.ref && attempt.operationId)
        .map((attempt) => observation(attempt.wallet, 'receive', attempt.operationId!)),
    })),
    requiredOutcomes,
  };
  if (plan.checkerControl) applyCheckerControl(world, evidence, plan.checkerControl);

  recordRaceWinners(world, evidence);
  const verdict = checkFundAccounting(evidence);
  trace.record('checker', 'verdict', { step, ...verdict });
  return verdict;
}

function recordRaceWinners(world: ScenarioWorld, evidence: AccountingEvidence): void {
  for (const race of world.races) {
    const token = evidence.tokens.find((candidate) => candidate.ref === race.token)!;
    const receive = token.receives.find((r) => r.wallet === race.recipient);
    const states = [token.send.state, receive?.state];
    if (states.includes(undefined)) {
      race.winner = 'unobserved';
      continue;
    }
    const recipientWon = receive!.state === 'finalized';
    const senderWon = token.send.state === 'rolled_back';
    race.winner =
      recipientWon && senderWon
        ? 'both'
        : recipientWon
          ? 'recipient'
          : senderWon
            ? 'sender'
            : 'none';
  }
}

/**
 * Tampers with collected evidence, never with Wallet state, to show that the checker detects lost
 * or duplicated value in evidence gathered from a real run.
 */
function applyCheckerControl(
  world: ScenarioWorld,
  evidence: AccountingEvidence,
  control: CheckerControl,
): void {
  const tokenProofs = new Set(
    evidence.tokens.flatMap((token) => token.inputs.map((input) => `${input.mint}|${input.y}`)),
  );
  const holder = evidence.wallets.find((wallet) =>
    wallet.storedProofs.some(
      (proof) =>
        proof.mintState === 'UNSPENT' &&
        proof.storeState === 'ready' &&
        !tokenProofs.has(`${proof.mint}|${proof.y}`),
    ),
  );
  if (!holder) throw new ScenarioPreconditionError('No held proof for the checker control');
  const index = holder.storedProofs.findIndex(
    (proof) =>
      proof.mintState === 'UNSPENT' &&
      proof.storeState === 'ready' &&
      !tokenProofs.has(`${proof.mint}|${proof.y}`),
  );
  const proof = holder.storedProofs[index]!;
  if (control === 'hideHeldProof') {
    holder.storedProofs.splice(index, 1);
  } else {
    const other = evidence.wallets.find((wallet) => wallet !== holder)!;
    other.storedProofs.push({ ...proof });
  }
  world.trace.record('checker', 'checker_control_applied', {
    control,
    wallet: holder.wallet,
    mint: proof.mint,
    amount: proof.amount,
  });
}

/**
 * Dispatches the plan with per-Wallet and per-token ordering, so different Wallets act
 * concurrently while each Wallet has at most one foreground command outstanding.
 */
async function dispatch(world: ScenarioWorld, steps: PlannedStep[]): Promise<void> {
  const walletTail = new Map<string, Promise<unknown>>();
  const tokenTail = new Map<string, Promise<unknown>>();
  const inflight = new Set<Promise<unknown>>();
  let fatal: unknown;

  const execute = async (planned: PlannedStep) => {
    try {
      await runStep(world, planned);
    } catch (error) {
      if (error instanceof ActorCommandError || error instanceof WalletOutcomeError) {
        // A command result that contradicts the plan is a wallet failure. Keep evaluating so the
        // report still shows the resulting fund state.
        world.commandFailure ??= `step ${planned.index}: ${error.message}`;
        world.trace.record('harness', 'command_failed', {
          step: planned.index,
          message: error.message,
        });
      } else {
        fatal ??= error;
      }
      world.stopped = true;
    }
  };

  for (const planned of steps) {
    if (world.stopped) break;
    world.trace.record('harness', 'step', { index: planned.index, kind: planned.step.kind });
    if (planned.barrier) {
      await Promise.all(inflight);
      if (world.stopped) break;
      await execute(planned);
      continue;
    }
    const dependencies = [
      ...planned.wallets.map((wallet) => walletTail.get(wallet)),
      ...planned.tokens.map((token) => tokenTail.get(token)),
    ];
    const task = Promise.all(dependencies).then(() =>
      world.stopped ? undefined : execute(planned),
    );
    for (const wallet of planned.wallets) walletTail.set(wallet, task);
    for (const token of planned.tokens) tokenTail.set(token, task);
    inflight.add(task);
    void task.then(() => inflight.delete(task));
  }
  await Promise.all(inflight);
  if (fatal) throw fatal;
}

export interface RunScenarioOptions {
  /** Run ID of the trace this run replays. */
  replayOf?: string;
}

export async function runScenario(
  plan: ScenarioPlan,
  options: RunScenarioOptions = {},
): Promise<ScenarioRun> {
  const runId = `${plan.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
    .randomUUID()
    .slice(0, 8)}`;
  const runDir = join(artifactsRoot(), 'runs', runId);
  const privateDir = join(runDir, 'private');
  mkdirSync(privateDir, { recursive: true });
  chmodSync(privateDir, 0o700);
  const tracePath = join(runDir, 'trace.json');
  const trace = new ScenarioTrace(runId, plan);
  if (options.replayOf) trace.document.components.replayOf = options.replayOf;

  let outcome: ScenarioOutcome = 'pass';
  let reason: string | undefined;
  const world = new ScenarioWorld(plan, trace);

  try {
    // Validates the plan before any infrastructure starts; an invalid plan is unresolved.
    const planned = planWorkload(plan);
    if (planned.steps.at(-1)?.step.kind !== 'checkpoint') {
      planned.steps.push({
        index: plan.steps.length,
        step: { kind: 'checkpoint' },
        wallets: [],
        tokens: [],
        barrier: true,
      });
    }
    Object.assign(trace.document.components, componentVersions());
    if (plan.mints.length > MINT_MNEMONICS.length) {
      throw new InfrastructureFailure(`At most ${MINT_MNEMONICS.length} mints are configured`);
    }
    const bundlePath = await preparePinnedGateway(artifactsRoot());
    const suffix = `${runId.slice(-8)}-${process.pid}`;
    await awaitStartup(
      plan.mints.map(async (name, index) => {
        const container = await MintContainer.start(
          `coco-faultsim-${suffix}-${name}`,
          MINT_MNEMONICS[index]!,
        );
        world.mints.set(name, { name, container } as MintNode);
        const gateway = await FaultLabGateway.start({
          bundlePath,
          downstream: container.directUrl,
          logPath: join(runDir, `gateway-${name}.log`),
        });
        const node: MintNode = {
          name,
          container,
          gateway,
          probe: new MintProbe(container.directUrl),
          url: gateway.url,
        };
        world.mints.set(name, node);
        world.mintByUrl.set(normalizeMintUrl(gateway.url), name);
      }),
    );
    const mintNodes = plan.mints.map((name) => world.mint(name));
    Object.assign(trace.document.components, {
      mint: {
        image: MINT_IMAGE,
        imageId: mintNodes[0]!.container.imageDigest,
        paymentBackend: 'fakewallet',
      },
    });
    trace.document.configuration = {
      unit: MINT_UNIT,
      inputFeePpk: MINT_INPUT_FEE_PPK,
      mints: await Promise.all(
        mintNodes.map(async (mint, index) => ({
          mint: mint.name,
          mnemonic: `test vector ${index + 1}`,
          keysets: (await mint.probe.keysets()).map(({ id, unit, input_fee_ppk }) => ({
            id,
            unit,
            inputFeePpk: input_fee_ppk ?? 0,
          })),
          transport: 'Wallets use this mint only through its own Fault Lab gateway',
        })),
      ),
      wallets: plan.wallets.map((wallet) => ({
        wallet,
        storage: 'SQLite file (bun:sqlite through sql-storage)',
        backgroundOwners: 'Coco defaults: Background Watchers and Processors enabled',
        trustedMints: plan.mints,
      })),
      concurrency: 'At most one foreground command per Wallet; different Wallets concurrently',
      recoveryMode: plan.recoveryMode,
      recoveryDeadlineMs: plan.recoveryDeadlineMs,
      ...(plan.generator ? { scenarioSeed: plan.generator.seed } : {}),
    };

    await awaitStartup(
      plan.wallets.map(async (wallet) => {
        const seedPath = join(privateDir, `${wallet}.seed`);
        const seedHex = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('hex');
        writeFileSync(seedPath, seedHex, { mode: 0o600 });
        trace.registerSecret(seedHex);
        trace.document.privateInputs.references[`${wallet}.walletSeed`] = `private/${wallet}.seed`;
        trace.document.privateInputs.references[`${wallet}.store`] = `private/${wallet}.sqlite`;
        world.actorOptions.set(wallet, {
          wallet,
          dbPath: join(privateDir, `${wallet}.sqlite`),
          seedPath,
          mintUrls: mintNodes.map((mint) => mint.url),
          unit: MINT_UNIT,
          logPath: join(privateDir, `${wallet}.log`),
        });
        await (await world.startActor(wallet)).request({ type: 'addMints' });
      }),
    );
    trace.record('harness', 'world_ready');

    await dispatch(world, planned.steps);
    if (!world.lastVerdict || world.commandFailure) {
      // A command failure ends dispatch early; still report the resulting fund state.
      await checkpoint(world, plan.steps.length);
    }

    await world.captureFiredFaults();
    const unfired = world.installedFaults.filter(({ ruleId }) => !world.faultsFired.has(ruleId));
    if (unfired.length > 0) {
      throw new ScenarioPreconditionError(
        `Faults never fired: ${unfired.map(({ ruleId }) => ruleId)}`,
      );
    }
    await recordGatewayTraffic(world);
    outcome = world.lastVerdict!.status;
    if (world.commandFailure && outcome === 'pass') {
      outcome = 'wallet_failure';
      reason = world.commandFailure;
    } else if (world.commandFailure) {
      reason = world.commandFailure;
    }
  } catch (error) {
    outcome = error instanceof InfrastructureFailure ? 'infrastructure_failure' : 'unresolved';
    reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  try {
    await stopRecoveryObservation(world);
  } catch (error) {
    outcome = error instanceof InfrastructureFailure ? 'infrastructure_failure' : 'unresolved';
    reason = error instanceof Error ? error.message : String(error);
  }

  const expectationMet = plan.expect === 'pass' ? outcome === 'pass' : outcome === 'wallet_failure';
  const run: ScenarioRun = {
    runId,
    outcome,
    expectationMet,
    ...(reason ? { reason } : {}),
    ...(world.lastVerdict ? { verdict: world.lastVerdict } : {}),
    checkpoints: world.checkpoints,
    commands: world.commands,
    races: world.races,
    faultsFired: [...world.faultsFired.values()],
    crashes: world.crashes,
    tracePath,
    secretsChecked: trace.secretCount,
  };
  trace.document.result = {
    outcome,
    expectationMet,
    reason,
    checkpoints: run.checkpoints,
    races: run.races,
    commands: summarizeCommands(run.commands),
    faultsFired: run.faultsFired,
    crashes: run.crashes,
  };
  // Preserve the trace before tearing the environment down. A trace that would leak a secret is
  // not written; the private inputs are kept for diagnosis and the run fails loudly below.
  let redactionError: unknown;
  try {
    trace.write(tracePath);
  } catch (error) {
    redactionError = error;
  }

  await Promise.all(
    [...world.actors.values()].map((actor) => actor.shutdown().catch(() => undefined)),
  );
  for (const mint of world.mints.values()) {
    await mint.gateway?.stop().catch(() => undefined);
    mint.container.stop();
  }
  if (redactionError) throw redactionError;
  if (expectationMet && !process.env.COCO_FAULT_SIM_KEEP_PRIVATE) {
    rmSync(privateDir, { recursive: true, force: true });
  }
  return run;
}

/** Counts of exercised commands by kind and result, for coverage reporting. */
export function summarizeCommands(commands: CommandOutcome[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const command of commands) {
    const key = `${command.kind}:${command.result}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

/**
 * Records what each gateway saw. Wallets only know gateway URLs, so this is their complete mint
 * HTTP traffic; a WebSocket upgrade attempt appears here as a plain `GET /v1/ws` request.
 */
async function recordGatewayTraffic(world: ScenarioWorld): Promise<void> {
  for (const mint of world.mints.values()) {
    const evidence = await mint.gateway.evidence();
    const requests: Record<string, number> = {};
    for (const request of evidence.requests) {
      const key = `${request.method} ${request.path}`;
      requests[key] = (requests[key] ?? 0) + 1;
    }
    world.trace.record('gateway', 'traffic', {
      mint: mint.name,
      inbound: evidence.inbound,
      forwarded: evidence.forwarded,
      responded: evidence.responded,
      dropped: evidence.dropped,
      delayed: evidence.delayed,
      requests,
    });
  }
}

/**
 * Replays the plan recorded in a trace from clean state, with fresh Wallet Seeds. A generated plan
 * is first regenerated from its recorded scenario seed and must match the recorded commands.
 */
export async function replayScenario(tracePath: string): Promise<ScenarioRun> {
  const document = JSON.parse(readFileSync(tracePath, 'utf8')) as TraceDocument;
  if (document.format !== TRACE_FORMAT) {
    throw new Error(`Unsupported trace format ${String(document.format)}`);
  }
  if (document.plan.generator) {
    const { version, ...generatorOptions } = document.plan.generator;
    const regenerated = generateWorkload(generatorOptions);
    if (
      regenerated.generator?.version !== version ||
      JSON.stringify(regenerated.steps) !== JSON.stringify(document.plan.steps)
    ) {
      throw new Error('The recorded scenario seed no longer generates the recorded commands');
    }
  }
  return runScenario(document.plan, { replayOf: document.runId });
}
