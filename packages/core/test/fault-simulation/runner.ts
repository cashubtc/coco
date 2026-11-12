/**
 * Executes a scenario plan in a fresh world and classifies its outcome.
 *
 * World: one pinned mint, one pinned Fault Lab gateway in front of it, and one Wallet actor process
 * per Wallet. Wallets only know the gateway URL, so all their mint HTTP traffic passes through it.
 *
 * Outcomes: `pass`, `wallet_failure` (a required guarantee is missing in a healthy environment),
 * `unresolved` (evidence or a scenario precondition is missing) and `infrastructure_failure` (the
 * environment could not be established). Only `pass` counts as passing, except that negative
 * controls expect `wallet_failure`.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkFundAccounting,
  type AccountingVerdict,
  type ObservedProof,
  type RequiredOperationOutcome,
  type StoredProof,
  type WalletAccountingEvidence,
} from './accounting.ts';
import {
  InfrastructureFailure,
  MINT_IMAGE,
  MINT_INPUT_FEE_PPK,
  MINT_UNIT,
  MintContainer,
  waitUntil,
} from './environment.ts';
import {
  MintProbe,
  decodeTokenInputs,
  readPersistedReceiveState,
  readStoredProofs,
} from './evidence.ts';
import {
  FAULT_LAB_REPOSITORY,
  FAULT_LAB_REVISION,
  FaultLabGateway,
  nodeVersion,
  preparePinnedGateway,
} from './faultLabGateway.ts';
import type { ScenarioPlan, ScenarioStep } from './scenarios.ts';
import { TRACE_FORMAT, ScenarioTrace, type TraceDocument } from './trace.ts';
import {
  ActorCommandError,
  WalletActor,
  type ActorResults,
  type WalletActorOptions,
} from './walletActor.ts';

export type ScenarioOutcome = 'pass' | 'wallet_failure' | 'unresolved' | 'infrastructure_failure';

export interface FiredFault {
  ruleId: string;
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

export interface ScenarioRun {
  runId: string;
  outcome: ScenarioOutcome;
  expectationMet: boolean;
  reason?: string;
  verdict?: AccountingVerdict;
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

interface TokenRecord {
  sender: string;
  inputs: Omit<ObservedProof, 'mintState'>[];
  encoded: string;
  receiveOperationId?: string;
}

/** Mutable state of one run. Kept in one place so steps read as the scenario's workflow. */
class ScenarioWorld {
  readonly actors = new Map<string, WalletActor>();
  readonly actorOptions = new Map<string, WalletActorOptions>();
  readonly tokens = new Map<string, TokenRecord>();
  readonly funding: { wallet: string; amount: number }[] = [];
  readonly installedFaults: string[] = [];
  readonly faultsFired = new Map<string, FiredFault>();
  readonly crashes: CrashRecord[] = [];
  commandFailure: string | undefined;
  healthyAt = Date.now();

  constructor(
    readonly plan: ScenarioPlan,
    readonly trace: ScenarioTrace,
    readonly mint: MintContainer,
    readonly probe: MintProbe,
    readonly gateway: FaultLabGateway,
  ) {}

  actor(wallet: string): WalletActor {
    const actor = this.actors.get(wallet);
    if (!actor) throw new Error(`Unknown Wallet ${wallet}`);
    return actor;
  }

  async captureFiredFaults(): Promise<void> {
    const evidence = await this.gateway.evidence();
    for (const rule of evidence.rules) {
      if (rule.applied === 0) continue;
      this.faultsFired.set(rule.id, {
        ruleId: rule.id,
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
}

async function runStep(world: ScenarioWorld, step: ScenarioStep): Promise<void> {
  const { trace } = world;
  switch (step.kind) {
    case 'fund': {
      trace.record(step.wallet, 'command', { type: 'fund', amount: step.amount });
      const result = await world.actor(step.wallet).request({ type: 'fund', amount: step.amount });
      world.funding.push({ wallet: step.wallet, amount: step.amount });
      trace.record(step.wallet, 'result', { type: 'fund', ...result });
      return;
    }
    case 'send': {
      trace.record(step.wallet, 'command', {
        type: 'send',
        amount: step.amount,
        token: step.token,
      });
      const result = await world.actor(step.wallet).request({ type: 'send', amount: step.amount });
      trace.registerSecret(result.token);
      const keysetIds = (await world.probe.keysets()).map((keyset) => keyset.id);
      const decoded = decodeTokenInputs(result.token, keysetIds);
      trace.registerSecret(...decoded.secrets);
      world.tokens.set(step.token, {
        sender: step.wallet,
        inputs: decoded.inputs,
        encoded: result.token,
      });
      trace.record(step.wallet, 'result', {
        type: 'send',
        operationId: result.operationId,
        token: step.token,
        tokenAmount: decoded.inputs.reduce((total, input) => total + input.amount, 0),
        tokenProofs: decoded.inputs.length,
      });
      return;
    }
    case 'withholdResponse': {
      // The held response is lost when the Wallet process dies; the long hold outlasts the run.
      const ruleId = await world.gateway.addRule({
        phase: 'after_downstream_response',
        action: 'delay',
        delayMs: 600_000,
        count: 1,
        match: { method: step.method, path: step.path },
      });
      world.installedFaults.push(ruleId);
      trace.record('gateway', 'fault_installed', { ruleId, ...step });
      return;
    }
    case 'receive': {
      const token = world.tokens.get(step.token);
      if (!token) throw new Error(`Unknown token ${step.token}`);
      const actor = world.actor(step.wallet);
      trace.record(step.wallet, 'command', { type: 'prepareReceive', token: step.token });
      const { operationId } = await actor.request({ type: 'prepareReceive', token: token.encoded });
      token.receiveOperationId = operationId;
      trace.record(step.wallet, 'command', { type: 'executeReceive', operationId });
      const execution = actor.request({ type: 'executeReceive', operationId }).then(
        (result) => ({ result }),
        (error: Error) => ({ error }),
      );
      if (!step.crashWhenFaultFires) {
        const settled = await execution;
        if ('error' in settled) throw settled.error;
        trace.record(step.wallet, 'result', { type: 'executeReceive', ...settled.result });
        return;
      }
      await crashWhenFaultFires(world, step.wallet, token, execution);
      return;
    }
    case 'heal': {
      await world.captureFiredFaults();
      await world.gateway.clearRules();
      const evidence = await world.gateway.evidence();
      if (evidence.rules.length !== 0) throw new InfrastructureFailure('Fault rules remain');
      await waitUntil('healthy mint and gateway paths', 10_000, async () => {
        const direct = await fetch(`${world.mint.directUrl}/v1/info`);
        const proxied = await fetch(`${world.gateway.url}/v1/info`);
        return direct.ok && proxied.ok;
      });
      world.healthyAt = Date.now();
      trace.record('harness', 'environment_healthy');
      return;
    }
    case 'restart': {
      const previous = world.actors.get(step.wallet);
      if (previous?.running) throw new Error(`${step.wallet} is still running`);
      trace.record(step.wallet, 'restart', { sameStore: true, sameWalletSeed: true });
      await world.startActor(step.wallet);
      return;
    }
    case 'awaitRequirements': {
      const deadline = world.healthyAt + world.plan.recoveryDeadlineMs;
      for (const requirement of world.plan.requirements) {
        const actor = world.actors.get(requirement.wallet);
        const operationId = world.tokens.get(requirement.token)?.receiveOperationId;
        if (!operationId) continue;
        if (!actor?.running) {
          trace.record(requirement.wallet, 'requirement_unobservable', {
            operationId,
            reason: 'Wallet process is not running',
          });
          continue;
        }
        let state: string | undefined;
        while (Date.now() < deadline) {
          const observed = await actor.request({ type: 'observe', operationIds: [operationId] });
          state = observed.operations[0]?.state;
          if (state === requirement.state) break;
          await Bun.sleep(250);
        }
        trace.record(requirement.wallet, 'requirement_observed', {
          operationId,
          state,
          msAfterHealthy: Date.now() - world.healthyAt,
        });
      }
      return;
    }
  }
}

async function crashWhenFaultFires(
  world: ScenarioWorld,
  wallet: string,
  token: TokenRecord,
  execution: Promise<{ result: unknown } | { error: Error }>,
): Promise<void> {
  const ruleId = world.installedFaults.at(-1);
  if (!ruleId) throw new Error('No fault precedes the crash trigger');
  let settledEarly = false;
  void execution.then(() => (settledEarly = true));
  // Event trigger: the gateway has received the mint's response and is withholding it.
  await waitUntil(
    'fault trigger',
    30_000,
    async () => {
      if (settledEarly) throw new ScenarioPreconditionError('Receive settled before the fault');
      const evidence = await world.gateway.evidence();
      return (evidence.rules.find((rule) => rule.id === ruleId)?.applied ?? 0) > 0;
    },
    10,
  ).catch((error: unknown) => {
    if (error instanceof ScenarioPreconditionError) throw error;
    throw new ScenarioPreconditionError('The withheld-response fault never fired');
  });
  await world.captureFiredFaults();
  world.trace.record('gateway', 'fault_fired', { ruleId });

  const actor = world.actor(wallet);
  const { signal } = await actor.crash();
  const settled = await execution;
  world.trace.record(wallet, 'crashed', {
    pid: actor.pid,
    signal,
    pendingCommandInterrupted: 'error' in settled && settled.error.name === 'ActorTerminatedError',
  });

  const states = await world.probe.proofStates(token.inputs.map((input) => input.y));
  const mintAcceptedRequest = token.inputs.every((input) => states.get(input.y) === 'SPENT');
  const dbPath = world.actorOptions.get(wallet)!.dbPath;
  const persistedOperationState = readPersistedReceiveState(dbPath, token.receiveOperationId!);
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

async function evaluate(world: ScenarioWorld): Promise<AccountingVerdict> {
  const { plan, trace, probe } = world;
  const feePpk = await probe.keysetFeePpk(MINT_UNIT);
  const operationsByWallet = new Map<string, string[]>();
  for (const requirement of plan.requirements) {
    const operationId = world.tokens.get(requirement.token)?.receiveOperationId;
    if (!operationId) continue;
    operationsByWallet.set(requirement.wallet, [
      ...(operationsByWallet.get(requirement.wallet) ?? []),
      operationId,
    ]);
  }

  const stored = new Map<string, Omit<StoredProof, 'mintState'>[]>();
  const publicViews = new Map<string, ActorResults['observe']>();
  for (const wallet of plan.wallets) {
    const { proofs, secrets } = readStoredProofs(world.actorOptions.get(wallet)!.dbPath, MINT_UNIT);
    trace.registerSecret(...secrets);
    stored.set(wallet, proofs);
    const actor = world.actors.get(wallet);
    if (actor?.running) {
      publicViews.set(
        wallet,
        await actor.request({
          type: 'observe',
          operationIds: operationsByWallet.get(wallet) ?? [],
        }),
      );
    }
  }

  const ys = [
    ...[...stored.values()].flat().map((proof) => proof.y),
    ...[...world.tokens.values()].flatMap((token) => token.inputs.map((input) => input.y)),
  ];
  const states = await probe.proofStates(ys);
  const withState = <T extends { y: string }>(proof: T) => ({
    ...proof,
    mintState: states.get(proof.y),
  });

  const wallets: WalletAccountingEvidence[] = plan.wallets.map((wallet) => ({
    wallet,
    storedProofs: stored.get(wallet)!.map(withState),
    publicBalance: publicViews.get(wallet)?.balance,
  }));
  const requiredOutcomes: RequiredOperationOutcome[] = [];
  for (const requirement of plan.requirements) {
    const operationId = world.tokens.get(requirement.token)?.receiveOperationId;
    if (!operationId) continue;
    const view = publicViews
      .get(requirement.wallet)
      ?.operations.find((op) => op.id === operationId);
    // Without a running Coco Session, fall back to the read-only persisted state.
    const observedState =
      view?.state ??
      readPersistedReceiveState(world.actorOptions.get(requirement.wallet)!.dbPath, operationId);
    requiredOutcomes.push({
      wallet: requirement.wallet,
      operationId,
      kind: requirement.operation,
      expectedState: requirement.state,
      observedState,
      historyEntries: view?.historyEntries,
    });
    trace.record('harness', 'outcome_observed', {
      wallet: requirement.wallet,
      operationId,
      state: observedState,
      provenance: view ? 'public_session' : 'persisted_read_only',
    });
  }

  const verdict = checkFundAccounting({
    unit: MINT_UNIT,
    keysetFeePpk: feePpk,
    funding: world.funding,
    wallets,
    tokens: [...world.tokens].map(([ref, token]) => ({
      ref,
      sender: token.sender,
      inputs: token.inputs.map(withState),
    })),
    requiredOutcomes,
  });
  trace.record('checker', 'verdict', { ...verdict });
  return verdict;
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
  let verdict: AccountingVerdict | undefined;
  let world: ScenarioWorld | undefined;
  let mint: MintContainer | undefined;
  let gateway: FaultLabGateway | undefined;

  try {
    Object.assign(trace.document.components, componentVersions());
    const bundlePath = await preparePinnedGateway(artifactsRoot());
    mint = await MintContainer.start(`coco-faultsim-${runId.slice(-8)}-${process.pid}`);
    gateway = await FaultLabGateway.start({
      bundlePath,
      downstream: mint.directUrl,
      logPath: join(runDir, 'gateway.log'),
    });
    world = new ScenarioWorld(plan, trace, mint, new MintProbe(mint.directUrl), gateway);
    Object.assign(trace.document.components, {
      mint: { image: MINT_IMAGE, imageId: mint.imageDigest, paymentBackend: 'fakewallet' },
    });
    trace.document.configuration = {
      unit: MINT_UNIT,
      inputFeePpk: MINT_INPUT_FEE_PPK,
      mints: 1,
      wallets: plan.wallets.map((wallet) => ({
        wallet,
        storage: 'SQLite file (bun:sqlite through sql-storage)',
        backgroundOwners: 'Coco defaults: Background Watchers and Processors enabled',
      })),
      recoveryMode: plan.recoveryMode,
      recoveryDeadlineMs: plan.recoveryDeadlineMs,
      transport: 'Every Wallet uses the gateway URL as its mint URL',
    };

    for (const wallet of plan.wallets) {
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
        mintUrl: gateway.url,
        unit: MINT_UNIT,
        logPath: join(privateDir, `${wallet}.log`),
      });
      await (await world.startActor(wallet)).request({ type: 'addMint' });
    }
    trace.record('harness', 'world_ready');
    world.healthyAt = Date.now();

    for (const [index, step] of plan.steps.entries()) {
      trace.record('harness', 'step', { index, kind: step.kind });
      try {
        await runStep(world, step);
      } catch (error) {
        if (!(error instanceof ActorCommandError)) throw error;
        // A rejected command in a step that expects success is a wallet failure. Keep evaluating
        // so the report still shows the resulting fund state.
        world.commandFailure = error.message;
        trace.record('harness', 'command_failed', { step: index, message: error.message });
        break;
      }
    }

    await world.captureFiredFaults();
    const unfired = world.installedFaults.filter((ruleId) => !world!.faultsFired.has(ruleId));
    if (unfired.length > 0) throw new ScenarioPreconditionError(`Faults never fired: ${unfired}`);
    await recordGatewayTraffic(world);
    verdict = await evaluate(world);
    outcome = verdict.status;
    if (world.commandFailure && outcome === 'pass') {
      outcome = 'wallet_failure';
      reason = world.commandFailure;
    }
  } catch (error) {
    outcome = error instanceof InfrastructureFailure ? 'infrastructure_failure' : 'unresolved';
    reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  const expectationMet = plan.expect === 'pass' ? outcome === 'pass' : outcome === 'wallet_failure';
  const run: ScenarioRun = {
    runId,
    outcome,
    expectationMet,
    ...(reason ? { reason } : {}),
    ...(verdict ? { verdict } : {}),
    faultsFired: [...(world?.faultsFired.values() ?? [])],
    crashes: world?.crashes ?? [],
    tracePath,
    secretsChecked: trace.secretCount,
  };
  trace.document.result = {
    outcome,
    expectationMet,
    reason,
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

  for (const actor of world?.actors.values() ?? []) {
    await actor.shutdown().catch(() => undefined);
  }
  await gateway?.stop().catch(() => undefined);
  mint?.stop();
  if (redactionError) throw redactionError;
  if (expectationMet && !process.env.COCO_FAULT_SIM_KEEP_PRIVATE) {
    rmSync(privateDir, { recursive: true, force: true });
  }
  return run;
}

/**
 * Records what the gateway saw. Wallets only know the gateway URL, so this is their complete mint
 * HTTP traffic; a WebSocket upgrade attempt appears here as a plain `GET /v1/ws` request.
 */
async function recordGatewayTraffic(world: ScenarioWorld): Promise<void> {
  const evidence = await world.gateway.evidence();
  const requests: Record<string, number> = {};
  for (const request of evidence.requests) {
    const key = `${request.method} ${request.path}`;
    requests[key] = (requests[key] ?? 0) + 1;
  }
  world.trace.record('gateway', 'traffic', {
    inbound: evidence.inbound,
    forwarded: evidence.forwarded,
    responded: evidence.responded,
    dropped: evidence.dropped,
    delayed: evidence.delayed,
    requests,
  });
}

/** Replays the plan recorded in a trace from clean state, with fresh Wallet Seeds. */
export async function replayScenario(tracePath: string): Promise<ScenarioRun> {
  const document = JSON.parse(readFileSync(tracePath, 'utf8')) as TraceDocument;
  if (document.format !== TRACE_FORMAT) {
    throw new Error(`Unsupported trace format ${String(document.format)}`);
  }
  return runScenario(document.plan, { replayOf: document.runId });
}
