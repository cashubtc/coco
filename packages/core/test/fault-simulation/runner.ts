/**
 * Executes a scenario plan in a fresh world and classifies its outcome.
 *
 * World: one pinned mint container per logical mint, one pinned Fault Lab gateway in front of each
 * mint, one transport link, and one Wallet actor process per Wallet. Wallets know only canonical
 * mint URLs that the transport link alone can reach: their HTTP passes through the mint's gateway
 * and their WebSockets through a link tunnel. Every Wallet trusts every mint; transfers stay
 * within the token's mint.
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
import {
  FaultController,
  ScenarioPreconditionError,
  waitForFaultTrigger,
  type FaultMint,
  type FiredFault,
  type MintRestartRecord,
} from './faults.ts';
import type { CheckerControl, ScenarioPlan, ScenarioStep } from './scenarios.ts';
import { TransportLink, canonicalMintUrl, prepareTransportLink } from './transportLink.ts';
import { ScenarioTrace, readTraceFile } from './trace.ts';
import {
  ActorCommandError,
  WalletActor,
  type ActorResults,
  type WalletActorOptions,
} from './walletActor.ts';
import {
  expectedReceiveStates,
  expectedSendStates,
  planWorkload,
  type Exposure,
  type PlannedStep,
  type ReceiveExpectation,
  type TokenFate,
} from './workload.ts';

export type ScenarioOutcome = 'pass' | 'wallet_failure' | 'unresolved' | 'infrastructure_failure';

export type { FiredFault, MintRestartRecord } from './faults.ts';

export interface CrashRecord {
  wallet: string;
  signal: string | null;
  step?: number;
  /** `fault_fired`: SIGKILL once the withheld response's rule fired; `step`: a `crash` step. */
  trigger?: 'fault_fired' | 'step';
  /** Direct mint evidence that the request whose response was withheld took effect. */
  mintAcceptedRequest?: boolean;
  /** The interrupted operation's state in the store after the crash, read without a Session. */
  persistedOperationState?: string | undefined;
}

/**
 * What an exposed command did under its fault, corroborated outside the Wallet: the mint's view
 * of the operation's inputs, the persisted operation state and the Wallet's link traffic.
 */
export interface ExchangeRecord {
  step: number;
  wallet: string;
  mint: string;
  command: 'send' | 'receive';
  fault: Exposure['fault'];
  result: 'completed' | 'interrupted';
  /** For an interrupted command: whether the mint had spent the operation's inputs. */
  mintAcceptedRequest?: boolean;
  /** For an interrupted command: the operation's persisted state, read without a Session. */
  persistedOperationState?: string;
  /** Swap and restore requests the Wallet sent to the mint during the command. */
  swapAttempts: number;
  restoreRequests: number;
}

/** An explicit public recovery call and the operation states it changed. */
export interface RecoveryRecord {
  step: number;
  wallet: string;
  observed: number;
  transitions: {
    operationId: string;
    kind: 'receive' | 'send';
    before: string | undefined;
    after: string | undefined;
  }[];
}

/** One Wallet's traffic to one mint through the transport link. */
export interface TransportRecord {
  wallet: string;
  mint: string;
  requests: number;
  failedRequests: number;
  refusedConnections: number;
  connectionsClosedByFault: number;
  webSocketUpgrades: number;
  webSocketsClosedByFault: number;
  /** Requests from this Wallet that named no known mint or bypassed the proxy. */
  unrouted: number;
}

/** Observed result of one foreground command, judged against the plan's expectation. */
export interface CommandOutcome {
  step: number;
  kind: ScenarioStep['kind'];
  wallets: string[];
  token?: string;
  /**
   * `rejected` is a pass when the plan expects rejection, such as a duplicate delivery.
   * `interrupted` means the command failed or the Wallet was crashed under a planned fault; its
   * operation must still reach the expected state.
   */
  result: 'completed' | 'rejected' | 'interrupted';
  /** The planned fault the command ran under. */
  exposure?: Exposure['fault'];
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
  exchanges: ExchangeRecord[];
  recoveries: RecoveryRecord[];
  mintRestarts: MintRestartRecord[];
  transport: TransportRecord[];
  tracePath: string;
  /** Number of secrets the redaction check verified to be absent from the trace. */
  secretsChecked: number;
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

/** A mint, its gateway and probe; `url` is the canonical URL only the transport link reaches. */
type MintNode = FaultMint;

interface TokenRecord {
  ref: string;
  sender: string;
  mint: string;
  inputs: Omit<ObservedProof, 'mintState'>[];
  /** Absent while an interrupted Send has not recovered; fetched from the sender afterwards. */
  encoded?: string;
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
  link!: TransportLink;
  readonly mintByUrl = new Map<string, string>();
  readonly tokens = new Map<string, TokenRecord>();
  readonly receiveAttempts: ReceiveAttempt[] = [];
  readonly funding: { wallet: string; mint: string; amount: number }[] = [];
  faults!: FaultController;
  readonly crashes: CrashRecord[] = [];
  readonly exchanges: ExchangeRecord[] = [];
  readonly recoveries: RecoveryRecord[] = [];
  readonly commands: CommandOutcome[] = [];
  readonly races: RaceRecord[] = [];
  readonly checkpoints: CheckpointRecord[] = [];
  lastVerdict: AccountingVerdict | undefined;
  commandFailure: string | undefined;
  /** Set once a command failure or a failed checkpoint ends dispatch of further steps. */
  stopped = false;
  healthyAt = Date.now();
  healedSinceCheckpoint = false;

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
      ...(planned.exposure ? { exposure: planned.exposure.fault } : {}),
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
        ...(planned.exposure ? { exposure: planned.exposure.fault } : {}),
      });
      const actor = world.actor(step.wallet);
      const { operationId } = await actor.request({
        type: 'prepareSend',
        mintUrl: mint.url,
        amount: step.amount,
      });
      const token: TokenRecord = {
        ref: step.token,
        sender: step.wallet,
        mint: step.mint,
        inputs: [],
        sendOperationId: operationId,
        fate: planned.fateAfter!,
      };
      world.tokens.set(step.token, token);
      const traffic = await world.faults.walletEvidence(step.wallet, step.mint);
      const execution = settle(actor.request({ type: 'executeSend', operationId }));
      if (step.crashWhenFaultFires) {
        await crashWhenFaultFires(world, planned, 'send', operationId, execution);
        completed('interrupted', step.token);
        return;
      }
      const settled = await execution;
      if ('error' in settled) {
        if (!planned.exposure || !rejection(settled.error)) throw settled.error;
        trace.record(step.wallet, 'interrupted', {
          step: index,
          type: 'executeSend',
          error: settled.error.remote.name,
        });
        await recordExchange(world, planned, 'send', operationId, 'interrupted', traffic);
        completed('interrupted', step.token);
        return;
      }
      await registerToken(world, token, settled.result.token);
      trace.record(step.wallet, 'result', {
        step: index,
        type: 'send',
        operationId,
        token: step.token,
        tokenAmount: tokenAmount(token),
        tokenProofs: token.inputs.length,
      });
      if (tokenAmount(token) !== step.amount) {
        throw new WalletOutcomeError(
          `${step.token} carries ${tokenAmount(token)}, not ${step.amount}`,
        );
      }
      if (planned.exposure) {
        await recordExchange(world, planned, 'send', operationId, 'completed', traffic);
      }
      completed('completed', step.token);
      return;
    }
    case 'receive': {
      const token = world.token(step.token);
      const encoded = await ensureToken(world, token);
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
        ...(planned.exposure ? { exposure: planned.exposure.fault } : {}),
      });
      let prepared: ActorResults['prepareReceive'];
      try {
        prepared = await actor.request({ type: 'prepareReceive', token: encoded });
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
      const traffic = await world.faults.walletEvidence(step.wallet, token.mint);
      const execution = settle(
        actor.request({ type: 'executeReceive', operationId: prepared.operationId }),
      );
      if (step.crashWhenFaultFires) {
        await crashWhenFaultFires(world, planned, 'receive', prepared.operationId, execution);
        completed('interrupted', step.token);
        return;
      }
      const settled = await execution;
      if ('error' in settled) {
        if (planned.exposure && rejection(settled.error) && attempt.expectation === 'finalized') {
          trace.record(step.wallet, 'interrupted', {
            step: index,
            type: 'executeReceive',
            error: settled.error.remote.name,
          });
          await recordExchange(
            world,
            planned,
            'receive',
            prepared.operationId,
            'interrupted',
            traffic,
          );
          completed('interrupted', step.token);
          return;
        }
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
      if (planned.exposure) {
        await recordExchange(world, planned, 'receive', prepared.operationId, 'completed', traffic);
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
      await fetchRecoveredTokens(world, step.wallet);
      completed('completed');
      return;
    }
    case 'crash': {
      const actor = world.actor(step.wallet);
      const { signal } = await actor.crash();
      const crash: CrashRecord = { wallet: step.wallet, signal, step: index, trigger: 'step' };
      world.crashes.push(crash);
      trace.record(step.wallet, 'crashed', { step: index, pid: actor.pid, signal });
      completed('completed');
      return;
    }
    case 'recover':
      await recover(world, index, step.wallet);
      completed('completed');
      return;
    case 'withholdResponse':
    case 'dropRequest':
    case 'dropResponse':
    case 'delayResponses':
      await world.faults.install(step, index);
      return;
    case 'disconnect':
      await world.faults.disconnect(step.wallet, step.mint, index);
      return;
    case 'reconnect':
      await world.faults.reconnect(step.wallet, step.mint, index);
      return;
    case 'dropWebSockets':
      await world.faults.dropWebSockets(step.wallet, step.mint, index);
      return;
    case 'restartMint':
      await world.faults.restartMint(step.mint, index, knownProofYs(world, step.mint));
      return;
    case 'heal':
      await world.faults.heal(index);
      world.healthyAt = Date.now();
      world.healedSinceCheckpoint = true;
      return;
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
    await recipient.request({ type: 'prepareReceive', token: await ensureToken(world, token) })
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
    await waitForFaultTrigger(
      'race lead swap committed',
      async () => {
        if (leadSettled) throw new ScenarioPreconditionError('Race lead settled before its hold');
        const evidence = await mint.gateway.evidence();
        return (evidence.rules.find((rule) => rule.id === ruleId)?.applied ?? 0) > 0;
      },
      30_000,
      10,
    );
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

type Settled<T> = { result: T } | { error: Error };

const settle = <T>(request: Promise<T>): Promise<Settled<T>> =>
  request.then(
    (result) => ({ result }),
    (error: Error) => ({ error }),
  );

const tokenAmount = (token: TokenRecord) =>
  token.inputs.reduce((total, input) => total + input.amount, 0);

/** Decodes a created token's inputs independently of the Wallet and registers its secrets. */
async function registerToken(world: ScenarioWorld, token: TokenRecord, encoded: string) {
  world.trace.registerSecret(encoded);
  const keysetIds = (await world.mint(token.mint).probe.keysets()).map((keyset) => keyset.id);
  const decoded = decodeTokenInputs(encoded, token.mint, keysetIds);
  world.trace.registerSecret(...decoded.secrets);
  token.inputs = decoded.inputs;
  token.encoded = encoded;
}

/**
 * The token to deliver. An interrupted Send's token exists only once Coco has recovered the Send,
 * so it is read from the sender through the public interface; a Send that is still not pending
 * by then is a wallet failure, because the plan delivers it only after the sender's recovery.
 */
async function ensureToken(world: ScenarioWorld, token: TokenRecord): Promise<string> {
  if (token.encoded) return token.encoded;
  const { state, token: encoded } = await world
    .actor(token.sender)
    .request({ type: 'sendToken', operationId: token.sendOperationId });
  if (!encoded) {
    throw new WalletOutcomeError(`${token.ref} is not available: its Send is ${state}`);
  }
  await registerToken(world, token, encoded);
  world.trace.record(token.sender, 'token_recovered', {
    token: token.ref,
    operationId: token.sendOperationId,
    state,
    tokenAmount: tokenAmount(token),
  });
  return encoded;
}

/** After a Wallet's restart or explicit recovery, reads the tokens of its recovered Sends. */
async function fetchRecoveredTokens(world: ScenarioWorld, wallet: string): Promise<void> {
  for (const token of world.tokens.values()) {
    if (token.sender !== wallet || token.encoded) continue;
    await ensureToken(world, token).catch(() => undefined);
  }
}

/** Every proof `Y` the harness knows at a mint: token inputs and every Wallet's stored proofs. */
function knownProofYs(world: ScenarioWorld, mint: string): string[] {
  const ys = new Set<string>();
  for (const token of world.tokens.values()) {
    if (token.mint === mint) for (const input of token.inputs) ys.add(input.y);
  }
  for (const wallet of world.plan.wallets) {
    const { proofs, secrets } = readStoredProofs(
      world.actorOptions.get(wallet)!.dbPath,
      MINT_UNIT,
      world.mintOfUrl,
    );
    world.trace.registerSecret(...secrets);
    for (const proof of proofs) if (proof.mint === mint) ys.add(proof.y);
  }
  return [...ys];
}

/** The `Y`s an operation spends: a Receive's token inputs, or a Send's persisted inputs. */
function operationInputYs(
  world: ScenarioWorld,
  wallet: string,
  kind: 'send' | 'receive',
  operationId: string,
  token: TokenRecord,
): string[] {
  if (kind === 'receive') return token.inputs.map((input) => input.y);
  const { proofs, secrets } = readStoredProofs(
    world.actorOptions.get(wallet)!.dbPath,
    MINT_UNIT,
    world.mintOfUrl,
  );
  world.trace.registerSecret(...secrets);
  return proofs.filter((proof) => proof.usedByOperationId === operationId).map((proof) => proof.y);
}

/** Whether the mint spent every input of the operation, read directly from the mint. */
async function mintSpent(world: ScenarioWorld, mint: string, ys: string[]): Promise<boolean> {
  if (ys.length === 0) throw new ScenarioPreconditionError('The operation has no known inputs');
  const states = await world.mint(mint).probe.proofStates(ys);
  return ys.every((y) => states.get(y) === 'SPENT');
}

/**
 * Corroborates what an exposed command did: whether its exchange fault fired, whether the mint
 * spent the operation's inputs, the persisted operation state, and the Wallet's swap and restore
 * traffic during the command. A request lost before the mint must leave the inputs unspent, and
 * a response lost after it must follow a spend; otherwise the fault did not establish its
 * scenario.
 */
async function recordExchange(
  world: ScenarioWorld,
  planned: PlannedStep,
  command: 'send' | 'receive',
  operationId: string,
  result: 'completed' | 'interrupted',
  trafficBefore: { requestsByPath: Record<string, number> },
): Promise<void> {
  const exposure = planned.exposure!;
  const wallet = planned.wallets[0]!;
  const token = world.token(planned.tokens[0]!);
  if (exposure.fault === 'dropRequest' || exposure.fault === 'dropResponse') {
    const rule = world.faults.ruleOf(exposure.faultStep);
    if ((await world.faults.applied(rule)) === 0) {
      throw new ScenarioPreconditionError(`The ${exposure.fault} for ${wallet} never fired`);
    }
    await world.faults.captureFired();
  }
  const after = await world.faults.walletEvidence(wallet, exposure.mint);
  const delta = (path: string) =>
    (after.requestsByPath[path] ?? 0) - (trafficBefore.requestsByPath[path] ?? 0);
  const record: ExchangeRecord = {
    step: planned.index,
    wallet,
    mint: exposure.mint,
    command,
    fault: exposure.fault,
    result,
    swapAttempts: delta('POST /v1/swap'),
    restoreRequests: delta('POST /v1/restore'),
  };
  if (result === 'interrupted') {
    const ys = operationInputYs(world, wallet, command, operationId, token);
    record.mintAcceptedRequest = await mintSpent(world, exposure.mint, ys);
    record.persistedOperationState = readPersistedOperationState(
      world.actorOptions.get(wallet)!.dbPath,
      command,
      operationId,
    );
    const expectedEffect = exposure.fault === 'dropResponse';
    if (record.mintAcceptedRequest !== expectedEffect) {
      throw new ScenarioPreconditionError(
        `The ${exposure.fault} interrupted ${command} with mint effect ${record.mintAcceptedRequest}`,
      );
    }
  }
  world.exchanges.push(record);
  world.trace.record('harness', 'exchange_corroborated', { ...record });
}

/**
 * Crashes the Wallet as soon as the gateway reports that the armed withheld-response rule fired,
 * so the mint has answered and the answer can never be delivered. Corroborates directly at the
 * mint that the request took effect, and from the store that the operation was interrupted.
 */
async function crashWhenFaultFires(
  world: ScenarioWorld,
  planned: PlannedStep,
  kind: 'send' | 'receive',
  operationId: string,
  execution: Promise<Settled<unknown>>,
): Promise<void> {
  const wallet = planned.wallets[0]!;
  const token = world.token(planned.tokens[0]!);
  const rule = world.faults.ruleOf(planned.exposure!.faultStep);
  let settledEarly = false;
  void execution.then(() => (settledEarly = true));
  await world.faults.awaitFired(rule, () => settledEarly);

  const actor = world.actor(wallet);
  const { signal } = await actor.crash();
  const settled = await execution;
  world.trace.record(wallet, 'crashed', {
    step: planned.index,
    pid: actor.pid,
    signal,
    pendingCommandInterrupted: 'error' in settled && settled.error.name === 'ActorTerminatedError',
  });

  const ys = operationInputYs(world, wallet, kind, operationId, token);
  const mintAcceptedRequest = await mintSpent(world, rule.mint, ys);
  const dbPath = world.actorOptions.get(wallet)!.dbPath;
  const persistedOperationState = readPersistedOperationState(dbPath, kind, operationId);
  const crash: CrashRecord = {
    wallet,
    signal,
    step: planned.index,
    trigger: 'fault_fired',
    mintAcceptedRequest,
    persistedOperationState,
  };
  world.crashes.push(crash);
  world.trace.record('harness', 'crash_corroborated', { ...crash });
  if (!mintAcceptedRequest) {
    throw new ScenarioPreconditionError('The mint did not accept the withheld request');
  }
  if (persistedOperationState !== 'executing') {
    throw new ScenarioPreconditionError(
      `The crash did not interrupt the ${kind} (${persistedOperationState})`,
    );
  }
}

/**
 * Explicit public recovery in an explicit-recovery scenario. The call returning proves nothing;
 * the record shows which operation states it changed, and checkpoints judge the outcome.
 */
async function recover(world: ScenarioWorld, step: number, wallet: string): Promise<void> {
  const actor = world.actor(wallet);
  const ids = (kind: 'receive' | 'send') =>
    world
      .expectedOutcomes()
      .filter((outcome) => outcome.wallet === wallet && outcome.kind === kind)
      .map((outcome) => outcome.operationId);
  const query = { type: 'observe' as const, receiveIds: ids('receive'), sendIds: ids('send') };
  const before = await actor.request(query);
  world.trace.record(wallet, 'command', { step, type: 'recover' });
  await actor.request({ type: 'recover' });
  const after = await actor.request(query);
  const record: RecoveryRecord = {
    step,
    wallet,
    observed: before.operations.length,
    transitions: before.operations.flatMap((operation) => {
      const later = after.operations.find((candidate) => candidate.id === operation.id)?.state;
      return later === operation.state
        ? []
        : [
            {
              operationId: operation.id,
              kind: operation.kind,
              before: operation.state,
              after: later,
            },
          ];
    }),
  };
  world.recoveries.push(record);
  world.trace.record(wallet, 'recovery_observed', { ...record });
  await fetchRecoveredTokens(world, wallet);
}

/**
 * Observes, without invoking any recovery interface, until every expected operation state holds
 * in every running Wallet or the recovery deadline passes. The deadline starts at the last heal
 * when one happened since the previous checkpoint, otherwise now: the environment was healthy.
 */
async function awaitExpectedOutcomes(world: ScenarioWorld, step: number) {
  const start = world.healedSinceCheckpoint ? world.healthyAt : Date.now();
  const deadline = start + world.plan.recoveryDeadlineMs;
  const expected = world.expectedOutcomes();
  const pending = new Map<string, string | undefined>();
  await Promise.all(
    world.plan.wallets.map(async (wallet) => {
      const outcomes = expected.filter((outcome) => outcome.wallet === wallet);
      if (outcomes.length === 0) return;
      const actor = world.actors.get(wallet);
      if (!actor?.running) {
        for (const outcome of outcomes) pending.set(outcome.operationId, undefined);
        world.trace.record(wallet, 'outcomes_unobservable', {
          step,
          reason: 'Wallet process is not running',
        });
        return;
      }
      const ids = (kind: 'receive' | 'send') =>
        outcomes.filter((outcome) => outcome.kind === kind).map((outcome) => outcome.operationId);
      while (true) {
        const view = await actor.request({
          type: 'observe',
          receiveIds: ids('receive'),
          sendIds: ids('send'),
        });
        const unmet = outcomes.filter((outcome) => {
          const state = view.operations.find((op) => op.id === outcome.operationId)?.state;
          return state === undefined || !outcome.expectedStates.includes(state);
        });
        if (unmet.length === 0 || Date.now() >= deadline) {
          for (const outcome of unmet) {
            pending.set(
              outcome.operationId,
              view.operations.find((op) => op.id === outcome.operationId)?.state,
            );
          }
          return;
        }
        await Bun.sleep(250);
      }
    }),
  );
  const msAwaitingOutcomes = Date.now() - start;
  world.trace.record('harness', 'outcomes_awaited', {
    step,
    expected: expected.length,
    unmet: [...pending].map(([operationId, state]) => ({ operationId, state })),
    msAwaitingOutcomes,
  });
  return {
    msAwaitingOutcomes,
    met: pending.size === 0,
    missedDeadlineIds: new Set(pending.keys()),
  };
}

async function checkpoint(world: ScenarioWorld, step: number): Promise<void> {
  world.faults.requireProcesses();
  const awaited = await awaitExpectedOutcomes(world, step);
  // An interrupted Send's token becomes known once Coco has recovered the Send.
  for (const token of world.tokens.values()) {
    if (!token.encoded && world.actors.get(token.sender)?.running) {
      await ensureToken(world, token).catch(() => undefined);
    }
  }
  const verdict = await evaluate(world, step, awaited.missedDeadlineIds);
  world.healedSinceCheckpoint = false;
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
  // A token that does not exist yet is not an economic claim; its Send stays a required outcome.
  const createdTokens = [...world.tokens.values()].filter((token) => {
    if (token.encoded) return true;
    trace.record('harness', 'token_unavailable', { step, token: token.ref });
    return false;
  });
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
    tokens: createdTokens.map((token) => ({
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
  let transport: TransportRecord[] = [];
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
          url: canonicalMintUrl(name),
        };
        world.mints.set(name, node);
        world.mintByUrl.set(normalizeMintUrl(node.url), name);
      }),
    );
    world.link = await TransportLink.start({
      bundlePath: await prepareTransportLink(artifactsRoot()),
      mints: plan.mints.map((name) => ({
        name,
        gateway: world.mint(name).gateway.url,
        direct: world.mint(name).container.directUrl,
      })),
      wallets: plan.wallets,
      logPath: join(runDir, 'transport-link.log'),
    });
    world.faults = new FaultController({
      mints: world.mints,
      link: world.link,
      wallets: plan.wallets,
      trace,
      ...(plan.infrastructureControl ? { infrastructureControl: plan.infrastructureControl } : {}),
    });
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
          transport:
            'Wallets reach this mint only through the transport link: HTTP via its Fault Lab ' +
            'gateway, WebSockets tunnelled to the mint',
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
          proxyUrl: world.link.proxyFor(wallet),
          recoveryMode: plan.recoveryMode,
          logPath: join(privateDir, `${wallet}.log`),
        });
        await (await world.startActor(wallet)).request({ type: 'addMints' });
      }),
    );
    trace.record('harness', 'world_ready');
    world.healthyAt = Date.now();

    await dispatch(world, planned.steps);
    if (!world.lastVerdict || world.commandFailure) {
      // A command failure ends dispatch early; still report the resulting fund state.
      await checkpoint(world, plan.steps.length);
    }

    await world.faults.captureFired();
    const unfired = world.faults.unfired();
    if (unfired.length > 0) {
      throw new ScenarioPreconditionError(`Faults never fired: ${unfired.join(', ')}`);
    }
    transport = await recordTransportTraffic(world);
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

  const expectationMet =
    outcome ===
    {
      pass: 'pass',
      'detected-failure': 'wallet_failure',
      'infrastructure-failure': 'infrastructure_failure',
    }[plan.expect];
  const run: ScenarioRun = {
    runId,
    outcome,
    expectationMet,
    ...(reason ? { reason } : {}),
    ...(world.lastVerdict ? { verdict: world.lastVerdict } : {}),
    checkpoints: world.checkpoints,
    commands: world.commands,
    races: world.races,
    faultsFired: [...(world.faults?.fired.values() ?? [])],
    crashes: world.crashes,
    exchanges: world.exchanges,
    recoveries: world.recoveries,
    mintRestarts: world.faults?.mintRestarts ?? [],
    transport,
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
    exchanges: run.exchanges,
    recoveries: run.recoveries,
    mintRestarts: run.mintRestarts,
    transport: run.transport,
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
  await world.link?.stop().catch(() => undefined);
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
 * Records what the transport link and each gateway saw. Wallets reach mints only through the link,
 * so this is their complete mint traffic: HTTP per Wallet and mint, WebSocket tunnels, refused
 * connections and requests that named no known mint (`unrouted`, refused).
 */
async function recordTransportTraffic(world: ScenarioWorld): Promise<TransportRecord[]> {
  const records: TransportRecord[] = [];
  const link = await world.link.evidence();
  for (const [wallet, { unrouted, mints }] of Object.entries(link.wallets)) {
    world.trace.record('link', 'traffic', { wallet, unrouted, mints });
    for (const [mint, evidence] of Object.entries(mints)) {
      records.push({
        wallet,
        mint,
        requests: evidence.requests,
        failedRequests: evidence.failedRequests,
        refusedConnections: evidence.refusedConnections,
        connectionsClosedByFault: evidence.connectionsClosedByFault,
        webSocketUpgrades: evidence.webSocketUpgrades,
        webSocketsClosedByFault: evidence.webSocketsClosedByFault,
        unrouted,
      });
    }
  }
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
  return records;
}

/**
 * Replays the plan recorded in a trace from clean state, with fresh Wallet Seeds. Runs the recorded
 * commands exactly; see `replay.ts` for provenance and comparison with the original.
 */
export async function replayScenario(tracePath: string): Promise<ScenarioRun> {
  // replay.ts imports this module lazily; a dynamic import here avoids a static cycle.
  const { prepareReplay } = await import('./replay.ts');
  const original = readTraceFile(tracePath);
  return runScenario(prepareReplay(original).plan, { replayOf: original.runId });
}
