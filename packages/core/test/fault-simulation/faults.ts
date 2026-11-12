/**
 * Fault control for wallet fault simulation: installs the transport and mint faults of a plan,
 * proves that each one fired, restarts mints over their committed storage and heals the
 * environment.
 *
 * Exchange faults and delays are Fault Lab gateway rules scoped to one Wallet through the tag the
 * transport link adds to its HTTP. Outages and WebSocket drops are transport link controls. Every
 * fault is triggered by a request or an event, never by elapsed time alone; a fault that never
 * fires leaves the scenario unresolved, because its precondition was not established.
 *
 * Healing removes every fault, ends every outage and then proves health: each mint answers
 * directly, and every Wallet's link path reaches it over HTTP and WebSocket. Failure to establish
 * health is an infrastructure failure. Wallet processes are not part of healing; a crashed Wallet
 * restarts through its own plan step.
 */
import { InfrastructureFailure, waitUntil, type MintContainer } from './environment.ts';
import type { MintProbe } from './evidence.ts';
import type { FaultLabGateway, GatewayRule } from './faultLabGateway.ts';
import type { InfrastructureControl, ScenarioStep } from './scenarios.ts';
import type { ScenarioTrace } from './trace.ts';
import {
  PROBE_HEADERS,
  walletTag,
  type TransportLink,
  type WalletLinkEvidence,
} from './transportLink.ts';

/** A scenario precondition (such as a fault that never fired) was not established. */
export class ScenarioPreconditionError extends Error {
  override readonly name = 'ScenarioPreconditionError';
}

/** Evidence that an installed fault actually affected traffic or processes. */
export interface FiredFault {
  ruleId: string;
  mint: string;
  phase: string;
  action: string;
  method?: string;
  path?: string;
  /** How often it applied: gateway rule applications, or connections it closed or refused. */
  applied: number;
  /** The plan step kind that installed it. */
  kind?: ScenarioStep['kind'];
  wallet?: string;
  step?: number;
}

export interface MintRestartRecord {
  step: number;
  mint: string;
  startedAtBefore: string;
  startedAtAfter: string;
  downMs: number;
  /** The mint reports the same keysets after the restart. */
  keysetsRetained: boolean;
  /** Every known proof has the same mint state after the restart as before it. */
  proofStatesRetained: boolean;
  proofsChecked: number;
  spentProofsChecked: number;
}

export interface FaultMint {
  name: string;
  container: MintContainer;
  gateway: FaultLabGateway;
  probe: MintProbe;
  /** Canonical URL Wallets use for this mint. */
  url: string;
}

type ExchangeStep = Extract<
  ScenarioStep,
  { kind: 'dropRequest' | 'dropResponse' | 'withholdResponse' | 'delayResponses' }
>;

interface InstalledRule {
  active: boolean;
  ruleId: string;
  mint: string;
  wallet?: string;
  kind: ExchangeStep['kind'];
  step: number;
}

interface Outage {
  wallet: string;
  mint: string;
  step: number;
  closed: number;
  refusedBefore: number;
}

/** Bound for waiting on a fault's trigger event. */
const TRIGGER_TIMEOUT_MS = 30_000;
/** Holding a withheld response for longer than any run means it is never delivered. */
const WITHHOLD_MS = 600_000;

export class FaultController {
  readonly fired = new Map<string, FiredFault>();
  readonly mintRestarts: MintRestartRecord[] = [];
  private readonly rules: InstalledRule[] = [];
  private readonly outages = new Map<string, Outage>();

  constructor(
    private readonly options: {
      mints: Map<string, FaultMint>;
      link: TransportLink;
      wallets: string[];
      trace: ScenarioTrace;
      infrastructureControl?: InfrastructureControl;
    },
  ) {}

  private mint(name: string): FaultMint {
    const mint = this.options.mints.get(name);
    if (!mint) throw new Error(`Unknown mint ${name}`);
    return mint;
  }

  /** Arms a gateway exchange fault or a response delay, scoped to one Wallet when it names one. */
  async install(step: ExchangeStep, index: number): Promise<void> {
    const wallet = 'wallet' in step ? step.wallet : undefined;
    const operationId = wallet === undefined ? {} : { operationId: walletTag(wallet) };
    const rule: GatewayRule =
      step.kind === 'delayResponses'
        ? {
            phase: 'after_downstream_response',
            action: 'delay',
            delayMs: step.delayMs,
            count: step.count,
            match: operationId,
          }
        : {
            phase: step.kind === 'dropRequest' ? 'before_forward' : 'after_downstream_response',
            action: step.kind === 'withholdResponse' ? 'delay' : 'drop',
            count: 1,
            match: { method: 'POST', path: step.path, ...operationId },
            ...(step.kind === 'withholdResponse' ? { delayMs: WITHHOLD_MS } : {}),
          };
    const ruleId = await this.mint(step.mint).gateway.addRule(rule);
    this.rules.push({
      active: true,
      ruleId,
      mint: step.mint,
      ...(wallet === undefined ? {} : { wallet }),
      kind: step.kind,
      step: index,
    });
    this.options.trace.record('gateway', 'fault_installed', { step: index, ruleId, ...step });
  }

  /** The gateway rule armed by a plan step. */
  ruleOf(step: number): InstalledRule {
    const rule = this.rules.find((candidate) => candidate.step === step);
    if (!rule) throw new Error(`No fault was installed by step ${step}`);
    return rule;
  }

  async applied(rule: InstalledRule): Promise<number> {
    const evidence = await this.mint(rule.mint).gateway.evidence();
    return evidence.rules.find((candidate) => candidate.id === rule.ruleId)?.applied ?? 0;
  }

  /** Event trigger: resolves once the gateway reports that the rule fired. */
  async awaitFired(rule: InstalledRule, settledEarly: () => boolean): Promise<void> {
    await waitUntil(
      `fault ${rule.ruleId} trigger`,
      TRIGGER_TIMEOUT_MS,
      async () => {
        if (settledEarly()) {
          throw new ScenarioPreconditionError(`The command settled before ${rule.kind} fired`);
        }
        return (await this.applied(rule)) > 0;
      },
      10,
    ).catch((error: unknown) => {
      if (error instanceof ScenarioPreconditionError) throw error;
      throw new ScenarioPreconditionError(`The ${rule.kind} fault never fired`);
    });
    await this.captureFired();
    this.options.trace.record('gateway', 'fault_fired', { ruleId: rule.ruleId, mint: rule.mint });
  }

  async captureFired(): Promise<void> {
    for (const rule of this.rules.filter((candidate) => candidate.active)) {
      const evidence = await this.mint(rule.mint).gateway.evidence();
      const state = evidence.rules.find((candidate) => candidate.id === rule.ruleId);
      if (!state || state.applied === 0) continue;
      // Rule IDs are per gateway, so they are only unique together with the mint.
      this.fired.set(`${rule.mint}:${rule.ruleId}`, {
        ruleId: rule.ruleId,
        mint: rule.mint,
        phase: state.phase,
        action: state.action,
        ...(state.method ? { method: state.method } : {}),
        ...(state.path ? { path: state.path } : {}),
        applied: state.applied,
        kind: rule.kind,
        ...(rule.wallet ? { wallet: rule.wallet } : {}),
        step: rule.step,
      });
    }
  }

  /** Installed gateway faults that have not fired. */
  unfired(): string[] {
    return this.rules
      .filter(({ mint, ruleId }) => !this.fired.has(`${mint}:${ruleId}`))
      .map(({ mint, ruleId }) => `${ruleId}@${mint}`);
  }

  async walletEvidence(wallet: string, mint: string): Promise<WalletLinkEvidence> {
    return (await this.options.link.evidence()).wallets[wallet]!.mints[mint]!;
  }

  /** Starts a Wallet-to-mint outage. */
  async disconnect(wallet: string, mint: string, step: number): Promise<void> {
    this.options.trace.record('link', 'fault_installed', {
      step,
      ruleId: `link-outage-${step}`,
      kind: 'disconnect',
      wallet,
      mint,
    });
    const refusedBefore = (await this.walletEvidence(wallet, mint)).refusedConnections;
    const [result] = await this.options.link.disconnect({ wallets: [wallet], mints: [mint] });
    const closed = result!.closedConnections + result!.closedWebSockets;
    this.outages.set(`${wallet}|${mint}`, { wallet, mint, step, closed, refusedBefore });
    this.options.trace.record('link', 'outage_started', { step, wallet, mint, ...result });
  }

  /**
   * Ends an outage once it has affected the Wallet: it closed a connection, or a connection
   * attempt was refused during it. An outage that touched nothing establishes nothing.
   */
  async reconnect(wallet: string, mint: string, step: number): Promise<void> {
    const outage = this.outages.get(`${wallet}|${mint}`);
    if (!outage) throw new Error(`${wallet} is not offline from ${mint}`);
    let refused = 0;
    await waitUntil('outage affecting Wallet traffic', TRIGGER_TIMEOUT_MS, async () => {
      refused = (await this.walletEvidence(wallet, mint)).refusedConnections - outage.refusedBefore;
      return outage.closed + refused > 0;
    }).catch(() => {
      throw new ScenarioPreconditionError(`The ${wallet} outage at ${mint} affected no traffic`);
    });
    await this.options.link.reconnect({ wallets: [wallet], mints: [mint] });
    this.outages.delete(`${wallet}|${mint}`);
    this.fired.set(`link-outage-${outage.step}`, {
      ruleId: `link-outage-${outage.step}`,
      mint,
      phase: 'connection',
      action: 'disconnect',
      applied: outage.closed + refused,
      kind: 'disconnect',
      wallet,
      step: outage.step,
    });
    this.options.trace.record('link', 'outage_ended', {
      step,
      wallet,
      mint,
      closed: outage.closed,
      refused,
    });
  }

  /** Event trigger: waits for an open WebSocket, then closes it abruptly. */
  async dropWebSockets(wallet: string, mint: string, step: number): Promise<void> {
    this.options.trace.record('link', 'fault_installed', {
      step,
      ruleId: `link-websocket-${step}`,
      kind: 'dropWebSockets',
      wallet,
      mint,
    });
    await waitUntil('an open Wallet WebSocket', TRIGGER_TIMEOUT_MS, async () => {
      return (await this.walletEvidence(wallet, mint)).webSocketsOpen > 0;
    }).catch(() => {
      throw new ScenarioPreconditionError(`${wallet} never held an open WebSocket to ${mint}`);
    });
    const closed = await this.options.link.dropWebSockets(wallet, mint);
    if (closed === 0) {
      throw new ScenarioPreconditionError(`No WebSocket of ${wallet} to ${mint} was closed`);
    }
    this.fired.set(`link-websocket-${step}`, {
      ruleId: `link-websocket-${step}`,
      mint,
      phase: 'connection',
      action: 'drop_websockets',
      applied: closed,
      kind: 'dropWebSockets',
      wallet,
      step,
    });
    this.options.trace.record('link', 'websockets_dropped', { step, wallet, mint, closed });
  }

  /**
   * SIGKILLs a mint and starts it again over its committed storage. Wallet connections to it are
   * refused meanwhile, as a mint that is not listening would refuse them. The mint must report
   * the same keysets and the same state for every known proof afterwards; anything else means
   * the environment did not preserve committed state, an infrastructure failure.
   */
  async restartMint(name: string, step: number, knownYs: string[]): Promise<void> {
    const mint = this.mint(name);
    const keysetsBefore = JSON.stringify(await mint.probe.keysets());
    const statesBefore = await mint.probe.proofStates(knownYs);
    const startedAtBefore = mint.container.startedAt();
    const offlineElsewhere = new Set(
      [...this.outages.values()].filter((outage) => outage.mint === name).map((o) => o.wallet),
    );
    await this.options.link.disconnect({ mints: [name] });
    const downAt = Date.now();
    mint.container.kill();
    this.options.trace.record('mint', 'mint_killed', { step, mint: name });
    if (this.options.infrastructureControl === 'mintDoesNotRestart') {
      this.options.trace.record('harness', 'infrastructure_control_applied', {
        control: this.options.infrastructureControl,
        mint: name,
      });
      await mint.container.waitReady(10_000);
    } else {
      await mint.container.restart();
    }
    const downMs = Date.now() - downAt;
    const restored = this.options.wallets.filter((wallet) => !offlineElsewhere.has(wallet));
    if (restored.length > 0) {
      await this.options.link.reconnect({ wallets: restored, mints: [name] });
    }
    const statesAfter = await mint.probe.proofStates(knownYs);
    const record: MintRestartRecord = {
      step,
      mint: name,
      startedAtBefore,
      startedAtAfter: mint.container.startedAt(),
      downMs,
      keysetsRetained: JSON.stringify(await mint.probe.keysets()) === keysetsBefore,
      proofStatesRetained: knownYs.every((y) => statesBefore.get(y) === statesAfter.get(y)),
      proofsChecked: knownYs.length,
      spentProofsChecked: knownYs.filter((y) => statesBefore.get(y) === 'SPENT').length,
    };
    this.mintRestarts.push(record);
    this.options.trace.record('mint', 'mint_restarted', { ...record });
    if (!record.keysetsRetained || !record.proofStatesRetained) {
      throw new InfrastructureFailure(`${name} did not retain its committed state across restart`);
    }
  }

  /**
   * Removes every fault and ends every outage, then establishes health. Delays that have not yet
   * applied get a bounded chance to fire on the Wallet's own traffic first.
   */
  async heal(step: number): Promise<void> {
    for (const rule of this.rules.filter(
      (candidate) => candidate.active && candidate.kind === 'delayResponses',
    )) {
      await waitUntil('delayed response', TRIGGER_TIMEOUT_MS, async () => {
        return (await this.applied(rule)) > 0;
      }).catch(() => undefined);
    }
    for (const outage of [...this.outages.values()]) {
      await this.reconnect(outage.wallet, outage.mint, step);
    }
    await this.captureFired();
    for (const mint of this.options.mints.values()) {
      await mint.gateway.clearRules();
      if ((await mint.gateway.evidence()).rules.length !== 0) {
        throw new InfrastructureFailure(`Fault rules remain at ${mint.name}`);
      }
      // Keep historical rules for unfired-fault accounting, but never await cleared triggers.
      for (const rule of this.rules) {
        if (rule.mint === mint.name) rule.active = false;
      }
    }
    await this.options.link.reconnect();
    await this.establishHealth();
    this.options.trace.record('harness', 'environment_healthy', { step });
  }

  /**
   * Establishes that every intended process and network path is healthy: each mint answers
   * directly, and every Wallet's link path reaches it over HTTP (through the gateway) and
   * WebSocket. Probes are marked so the link counts them apart from Wallet traffic.
   */
  async establishHealth(): Promise<void> {
    const { link, mints, wallets } = this.options;
    await waitUntil('healthy mints, gateways and Wallet transport paths', 30_000, async () => {
      this.requireProcesses();
      const evidence = await link.evidence();
      for (const mint of mints.values()) {
        if (!(await fetch(`${mint.container.directUrl}/v1/info`)).ok) return false;
        for (const wallet of wallets) {
          if (evidence.wallets[wallet]!.mints[mint.name]!.offline) return false;
          const proxy = link.proxyFor(wallet);
          const http = await fetch(`${mint.url}/v1/info`, { proxy, headers: PROBE_HEADERS });
          if (!http.ok) return false;
          if (!(await probeWebSocket(`${mint.url.replace('http', 'ws')}/v1/ws`, proxy))) {
            return false;
          }
        }
      }
      return true;
    });
  }

  /** The gateway and link processes must still be running. */
  requireProcesses(): void {
    if (!this.options.link.running) throw new InfrastructureFailure('Transport link exited');
    for (const mint of this.options.mints.values()) {
      if (!mint.gateway.running) {
        throw new InfrastructureFailure(`Fault Lab gateway for ${mint.name} exited`);
      }
    }
  }
}

async function probeWebSocket(url: string, proxy: string): Promise<boolean> {
  const socket = new WebSocket(url, { proxy, headers: PROBE_HEADERS } as never);
  const opened = await Promise.race([
    new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(true));
      socket.addEventListener('error', () => resolve(false));
      socket.addEventListener('close', () => resolve(false));
    }),
    Bun.sleep(5_000).then(() => false),
  ]);
  socket.close();
  return opened;
}
