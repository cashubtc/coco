/**
 * State-aware workload model for wallet fault simulation.
 *
 * {@link planWorkload} gives each plan step its meaning: the state preconditions it requires, the
 * Wallets and tokens it occupies, the outcome Coco must produce, and the economic fate of the token
 * it touches. The runner schedules and judges steps from this model, and the generator only emits
 * steps the model accepts, so a recorded plan always replays with the same expectations.
 *
 * The model is independent of Coco. Its spendable amounts are conservative lower bounds used only
 * to keep generated commands meaningful; they never define an expected balance. Fund accounting is
 * checked from mint and token evidence in `accounting.ts`.
 */
import { MINT_INPUT_FEE_PPK } from './environment.ts';
import type { ScenarioPlan, ScenarioStep } from './scenarios.ts';

/** Where a token's value is expected to end up. */
export type TokenFate =
  | { kind: 'outstanding' }
  | { kind: 'received'; recipient: string }
  | { kind: 'reclaimed' }
  /** A coordinated receive-versus-reclaim race: either claimant may win, exactly one must. */
  | { kind: 'raced'; recipient: string };

/** Expected result of a delivered token's Receive. */
export type ReceiveExpectation = 'finalized' | 'rejected' | 'either';
/** Expected result of the sender's reclaim. */
export type ReclaimExpectation = 'rolled_back' | 'rejected' | 'either';

export interface PlannedToken {
  ref: string;
  sender: string;
  mint: string;
  amount: number;
  /** Fate after every step of the plan. */
  fate: TokenFate;
}

/** A fault that may interrupt a command, and the step that introduced it. */
export interface Exposure {
  fault: 'dropRequest' | 'dropResponse' | 'withholdResponse' | 'outage';
  mint: string;
  faultStep: number;
}

export interface PlannedStep {
  index: number;
  step: ScenarioStep;
  /** Wallets with a foreground command in this step. Each Wallet runs one at a time. */
  wallets: string[];
  /** Tokens this step depends on or changes; steps on one token run in plan order. */
  tokens: string[];
  /** Barrier steps wait for all earlier steps, and every later step waits for them. */
  barrier: boolean;
  receive?: ReceiveExpectation;
  reclaim?: ReclaimExpectation;
  /** Fate of the step's token once the step has completed. */
  fateAfter?: TokenFate;
  /**
   * The command runs while this fault targets its traffic. It may fail without that being a
   * wallet failure; its operation must still reach the expected state after healing.
   */
  exposure?: Exposure;
  /**
   * The interrupted operation needs this Wallet's restart (startup recovery) or explicit recovery
   * to make progress. Until then the model refuses further commands on the step's token.
   */
  awaitsRecovery?: string;
}

export interface PlannedWorkload {
  steps: PlannedStep[];
  tokens: Map<string, PlannedToken>;
  /** Conservative lower bound of value a Wallet can spend at a mint after the whole plan. */
  spendable(wallet: string, mint: string): number;
}

/** A plan step lacks a state precondition, so it would not exercise meaningful wallet behavior. */
export class PlanPreconditionError extends Error {
  override readonly name = 'PlanPreconditionError';
}

/**
 * Upper bound assumed for the input fee of the swap a Send may perform. At 100 ppk it covers up to
 * 40 inputs; spending more inputs than that in one Send would make the bound unsound.
 */
export const SEND_FEE_RESERVE = 4;

/** Worst-case input fee to claim a token: every unit of its amount a separate proof. */
export function claimFeeBound(amount: number, feePpk = MINT_INPUT_FEE_PPK): number {
  return Math.ceil((amount * feePpk) / 1000);
}

export function expectedSendStates(fate: TokenFate): string[] {
  switch (fate.kind) {
    case 'outstanding':
      return ['pending'];
    case 'received':
      return ['finalized'];
    case 'reclaimed':
      return ['rolled_back'];
    case 'raced':
      return ['finalized', 'rolled_back'];
  }
}

/** A rejected Receive must settle as rolled back when Coco created an operation for it. */
export function expectedReceiveStates(expectation: ReceiveExpectation): string[] {
  switch (expectation) {
    case 'finalized':
      return ['finalized'];
    case 'rejected':
      return ['rolled_back'];
    case 'either':
      return ['finalized', 'rolled_back'];
  }
}

/** Mutable model state shared by plan validation and generation. */
export class WorkloadModel {
  readonly tokens = new Map<string, PlannedToken>();
  private readonly spendableBy = new Map<string, number>();
  private readonly walletSet: Set<string>;
  private readonly mintSet: Set<string>;
  /** Exchange faults armed for a Wallet's next swap at a mint, by `wallet|mint` (`*` for any). */
  private readonly armed = new Map<string, { fault: Exposure['fault']; index: number }>();
  /** Wallet-to-mint outages, by `wallet|mint`, with the step that started them. */
  private readonly offline = new Map<string, number>();
  private readonly delayed = new Set<string>();
  private readonly crashed = new Set<string>();
  /** `wallet|mint` pairs whose WebSocket was lost; Coco reopens one on restart or repair. */
  private readonly webSocketLost = new Set<string>();
  /** Tokens whose interrupted operation awaits a Wallet's recovery, by token reference. */
  private readonly awaiting = new Map<string, string>();

  constructor(
    readonly wallets: string[],
    readonly mints: string[],
    readonly feePpk = MINT_INPUT_FEE_PPK,
    readonly recoveryMode: ScenarioPlan['recoveryMode'] = 'automatic',
  ) {
    this.walletSet = new Set(wallets);
    this.mintSet = new Set(mints);
  }

  spendable(wallet: string, mint: string): number {
    return this.spendableBy.get(`${wallet}|${mint}`) ?? 0;
  }

  /** Faults that keep the environment unhealed: armed exchanges, outages and delays. */
  get activeFaults(): number {
    return this.armed.size + this.offline.size + this.delayed.size;
  }

  isCrashed(wallet: string): boolean {
    return this.crashed.has(wallet);
  }

  isOffline(wallet: string, mint: string): boolean {
    return this.offline.has(`${wallet}|${mint}`);
  }

  isDelayed(wallet: string, mint: string): boolean {
    return this.delayed.has(`${wallet}|${mint}`);
  }

  hasArmed(wallet: string, mint: string): boolean {
    return this.armed.has(`${wallet}|${mint}`) || this.armed.has(`*|${mint}`);
  }

  awaitsRecovery(token: string): string | undefined {
    return this.awaiting.get(token);
  }

  webSocketLostAt(wallet: string, mint: string): boolean {
    return this.webSocketLost.has(`${wallet}|${mint}`);
  }

  /** The plan must end in a healed environment: a final, fault-free healing phase. */
  finish(): void {
    if (this.activeFaults > 0) {
      throw new PlanPreconditionError('Faults remain active: a plan must end with a healing phase');
    }
  }

  /** Smallest token whose claim is certain to leave value after the worst-case claim fee. */
  get minimumTokenAmount(): number {
    let amount = 1;
    while (amount <= claimFeeBound(amount, this.feePpk)) amount++;
    return amount;
  }

  /** Validates one step against the current state and applies its effects. */
  apply(step: ScenarioStep, index: number): PlannedStep {
    const planned: PlannedStep = { index, step, wallets: [], tokens: [], barrier: false };
    switch (step.kind) {
      case 'fund':
        this.requireWallet(step.wallet);
        this.requireMint(step.mint);
        this.requirePositive(step.amount);
        this.requireUnfaulted(step.wallet, step.mint, 'fund');
        this.credit(step.wallet, step.mint, step.amount);
        planned.wallets = [step.wallet];
        return planned;
      case 'send': {
        this.requireWallet(step.wallet);
        this.requireMint(step.mint);
        this.requirePositive(step.amount);
        this.requireRunning(step.wallet);
        if (this.tokens.has(step.token)) {
          throw new PlanPreconditionError(`Token reference ${step.token} is already used`);
        }
        if (step.amount < this.minimumTokenAmount) {
          throw new PlanPreconditionError(
            `A ${step.amount} token cannot be claimed after its worst-case input fee`,
          );
        }
        const required = step.amount + SEND_FEE_RESERVE;
        if (this.spendable(step.wallet, step.mint) < required) {
          throw new PlanPreconditionError(
            `${step.wallet} may not hold ${required} spendable at ${step.mint}`,
          );
        }
        const exposure = this.expose(step.wallet, step.mint, step.crashWhenFaultFires);
        this.credit(step.wallet, step.mint, -required);
        const token: PlannedToken = {
          ref: step.token,
          sender: step.wallet,
          mint: step.mint,
          amount: step.amount,
          fate: { kind: 'outstanding' },
        };
        this.tokens.set(step.token, token);
        const send = {
          ...planned,
          wallets: [step.wallet],
          tokens: [step.token],
          fateAfter: token.fate,
        };
        if (!exposure) return send;
        // Send has no inline recovery: an interrupted execution stays executing until recovered.
        this.awaiting.set(step.token, step.wallet);
        return { ...send, exposure, awaitsRecovery: step.wallet };
      }
      case 'receive': {
        this.requireWallet(step.wallet);
        const token = this.requireToken(step.token);
        this.requireRunning(step.wallet);
        this.requireNotAwaiting(token);
        planned.wallets = [step.wallet];
        planned.tokens = [token.ref];
        if (token.fate.kind !== 'outstanding') {
          this.requireUnfaulted(step.wallet, token.mint, 'duplicate delivery');
          return { ...planned, receive: 'rejected', fateAfter: token.fate };
        }
        if (step.wallet === token.sender) {
          throw new PlanPreconditionError(`${token.ref} cannot be delivered to its own sender`);
        }
        const exposure = this.expose(step.wallet, token.mint, step.crashWhenFaultFires);
        token.fate = { kind: 'received', recipient: step.wallet };
        this.credit(step.wallet, token.mint, this.claimedValue(token));
        const receive = { ...planned, receive: 'finalized' as const, fateAfter: token.fate };
        if (!exposure) return receive;
        // Receive recovers a lost exchange inline; an outage or a crash leaves it executing.
        if (exposure.fault === 'dropRequest' || exposure.fault === 'dropResponse') {
          return { ...receive, exposure };
        }
        this.awaiting.set(token.ref, step.wallet);
        return { ...receive, exposure, awaitsRecovery: step.wallet };
      }
      case 'reclaim': {
        const token = this.requireToken(step.token);
        this.requireRunning(token.sender);
        this.requireNotAwaiting(token);
        this.requireUnfaulted(token.sender, token.mint, 'reclaim');
        planned.wallets = [token.sender];
        planned.tokens = [token.ref];
        if (token.fate.kind !== 'outstanding') {
          return { ...planned, reclaim: 'rejected', fateAfter: token.fate };
        }
        token.fate = { kind: 'reclaimed' };
        this.credit(token.sender, token.mint, this.claimedValue(token));
        return { ...planned, reclaim: 'rolled_back', fateAfter: token.fate };
      }
      case 'raceReclaim': {
        this.requireWallet(step.recipient);
        const token = this.requireToken(step.token);
        if (token.fate.kind !== 'outstanding') {
          throw new PlanPreconditionError(`${token.ref} is no longer outstanding`);
        }
        if (step.recipient === token.sender) {
          throw new PlanPreconditionError(`${token.ref} cannot race its own sender`);
        }
        for (const wallet of [step.recipient, token.sender]) {
          this.requireRunning(wallet);
          this.requireUnfaulted(wallet, token.mint, 'race');
          if (this.isDelayed(wallet, token.mint)) {
            // The delay rule would take the led race's response hold first.
            throw new PlanPreconditionError(`${wallet}'s responses from ${token.mint} are delayed`);
          }
        }
        this.requireNotAwaiting(token);
        const race = { ...planned, wallets: [step.recipient, token.sender], tokens: [token.ref] };
        if (step.lead === 'recipient') {
          token.fate = { kind: 'received', recipient: step.recipient };
          this.credit(step.recipient, token.mint, this.claimedValue(token));
          return {
            ...race,
            barrier: true,
            receive: 'finalized',
            reclaim: 'rejected',
            fateAfter: token.fate,
          };
        }
        if (step.lead === 'sender') {
          token.fate = { kind: 'reclaimed' };
          this.credit(token.sender, token.mint, this.claimedValue(token));
          return {
            ...race,
            barrier: true,
            receive: 'rejected',
            reclaim: 'rolled_back',
            fateAfter: token.fate,
          };
        }
        // Neither claimant is credited: the winner is decided by the mint, not the plan.
        token.fate = { kind: 'raced', recipient: step.recipient };
        return { ...race, receive: 'either', reclaim: 'either', fateAfter: token.fate };
      }
      case 'restart':
        this.requireWallet(step.wallet);
        this.crashed.delete(step.wallet);
        for (const mint of this.mints) this.webSocketLost.delete(`${step.wallet}|${mint}`);
        // Startup recovery reaches every mint the Wallet is not cut off from. The restart
        // occupies the tokens it releases, so their later commands are ordered after it.
        for (const [ref, wallet] of this.awaiting) {
          if (wallet === step.wallet && !this.isOffline(wallet, this.tokens.get(ref)!.mint)) {
            this.awaiting.delete(ref);
            planned.tokens.push(ref);
          }
        }
        return { ...planned, wallets: [step.wallet] };
      case 'recover':
        this.requireWallet(step.wallet);
        if (this.recoveryMode !== 'explicit') {
          throw new PlanPreconditionError(
            'Only explicit-recovery scenarios may call public recovery interfaces',
          );
        }
        this.requireRunning(step.wallet);
        if (this.activeFaults > 0) {
          throw new PlanPreconditionError(
            'Explicit recovery runs only once every fault has healed',
          );
        }
        for (const mint of this.mints) this.webSocketLost.delete(`${step.wallet}|${mint}`);
        for (const [ref, wallet] of this.awaiting) {
          if (wallet !== step.wallet) continue;
          this.awaiting.delete(ref);
          planned.tokens.push(ref);
        }
        return { ...planned, wallets: [step.wallet] };
      case 'withholdResponse':
      case 'dropRequest':
      case 'dropResponse': {
        this.requireMint(step.mint);
        if (step.path !== '/v1/swap') {
          throw new PlanPreconditionError(`Exchange faults on ${step.path} are not modelled`);
        }
        const wallet = 'wallet' in step && step.wallet !== undefined ? step.wallet : '*';
        if (wallet !== '*') {
          this.requireWallet(wallet);
          this.requireRunning(wallet);
        }
        const key = `${wallet}|${step.mint}`;
        if (this.armed.has(key) || this.armed.has(`*|${step.mint}`)) {
          throw new PlanPreconditionError(`A fault is already armed for ${key}`);
        }
        if (
          step.kind !== 'dropRequest' &&
          [...this.delayed].some((delayed) =>
            wallet === '*' ? delayed.endsWith(`|${step.mint}`) : delayed === key,
          )
        ) {
          // A delay rule would take the response first and the fault would never fire.
          throw new PlanPreconditionError(`Responses for ${key} are already delayed`);
        }
        this.armed.set(key, { fault: step.kind, index });
        return wallet === '*' ? { ...planned, barrier: true } : { ...planned, wallets: [wallet] };
      }
      case 'delayResponses': {
        this.requireWallet(step.wallet);
        this.requireMint(step.mint);
        this.requirePositive(step.count);
        if (!Number.isSafeInteger(step.delayMs) || step.delayMs < 1 || step.delayMs > 30_000) {
          throw new PlanPreconditionError(`Delay ${step.delayMs} ms is not between 1 and 30000`);
        }
        const key = `${step.wallet}|${step.mint}`;
        const armed = this.armed.get(key) ?? this.armed.get(`*|${step.mint}`);
        if (this.delayed.has(key) || (armed && armed.fault !== 'dropRequest')) {
          throw new PlanPreconditionError(`Responses for ${key} are already faulted`);
        }
        this.delayed.add(key);
        return { ...planned, wallets: [step.wallet] };
      }
      case 'disconnect': {
        this.requireWallet(step.wallet);
        this.requireMint(step.mint);
        const key = `${step.wallet}|${step.mint}`;
        if (this.offline.has(key)) throw new PlanPreconditionError(`${key} is already offline`);
        this.offline.set(key, index);
        this.webSocketLost.add(key);
        return { ...planned, wallets: [step.wallet], barrier: true };
      }
      case 'reconnect': {
        const key = `${step.wallet}|${step.mint}`;
        if (!this.offline.delete(key)) throw new PlanPreconditionError(`${key} is not offline`);
        return { ...planned, wallets: [step.wallet], barrier: true };
      }
      case 'dropWebSockets': {
        this.requireWallet(step.wallet);
        this.requireMint(step.mint);
        this.requireRunning(step.wallet);
        const key = `${step.wallet}|${step.mint}`;
        if (this.offline.has(key)) throw new PlanPreconditionError(`${key} is offline`);
        // A pending Send keeps a proof-state subscription, so Coco holds a socket to its mint.
        const subscribed = [...this.tokens.values()].some(
          (token) =>
            token.sender === step.wallet &&
            token.mint === step.mint &&
            token.fate.kind === 'outstanding' &&
            !this.awaiting.has(token.ref),
        );
        if (!subscribed || this.webSocketLost.has(key)) {
          throw new PlanPreconditionError(`${key} holds no open subscription socket to drop`);
        }
        this.webSocketLost.add(key);
        return { ...planned, wallets: [step.wallet], barrier: true };
      }
      case 'crash':
        this.requireWallet(step.wallet);
        this.requireRunning(step.wallet);
        this.crashed.add(step.wallet);
        return { ...planned, wallets: [step.wallet], barrier: true };
      case 'restartMint':
        this.requireMint(step.mint);
        if ([...this.armed.keys()].some((key) => key.endsWith(`|${step.mint}`))) {
          throw new PlanPreconditionError(`A fault is armed at ${step.mint}`);
        }
        for (const wallet of this.wallets) this.webSocketLost.add(`${wallet}|${step.mint}`);
        return { ...planned, barrier: true };
      case 'heal':
        if (this.armed.size > 0) {
          throw new PlanPreconditionError(
            `Armed faults were never consumed: ${[...this.armed.keys()].join(', ')}`,
          );
        }
        this.offline.clear();
        this.delayed.clear();
        return { ...planned, barrier: true };
      case 'checkpoint':
        if (this.activeFaults > 0) {
          throw new PlanPreconditionError('A checkpoint requires a healed environment');
        }
        return { ...planned, barrier: true };
    }
  }

  /**
   * The fault a Wallet's swap at a mint runs under, consuming an armed exchange fault. A command
   * that crashes the Wallet when its fault fires needs an armed `withholdResponse`.
   */
  private expose(
    wallet: string,
    mint: string,
    crashWhenFaultFires?: boolean,
  ): Exposure | undefined {
    const key = this.armed.has(`${wallet}|${mint}`) ? `${wallet}|${mint}` : `*|${mint}`;
    const armed = this.armed.get(key);
    if (Boolean(crashWhenFaultFires) !== (armed?.fault === 'withholdResponse')) {
      throw new PlanPreconditionError(
        'A withheld response needs a command that crashes when it fires, and only it',
      );
    }
    if (armed) {
      this.armed.delete(key);
      if (crashWhenFaultFires) this.crashed.add(wallet);
      return { fault: armed.fault, mint, faultStep: armed.index };
    }
    const outage = this.offline.get(`${wallet}|${mint}`);
    return outage === undefined ? undefined : { fault: 'outage', mint, faultStep: outage };
  }

  private requireRunning(wallet: string): void {
    if (this.crashed.has(wallet)) {
      throw new PlanPreconditionError(`${wallet} has crashed and must restart first`);
    }
  }

  private requireNotAwaiting(token: PlannedToken): void {
    const wallet = this.awaiting.get(token.ref);
    if (wallet) {
      throw new PlanPreconditionError(`${token.ref} awaits recovery by ${wallet}`);
    }
  }

  /** Commands whose behavior under a fault is not modelled must run without one. */
  private requireUnfaulted(wallet: string, mint: string, what: string): void {
    this.requireRunning(wallet);
    if (this.hasArmed(wallet, mint)) {
      throw new PlanPreconditionError(
        `A fault armed for ${wallet} at ${mint} would be consumed by a ${what}`,
      );
    }
    if (this.isOffline(wallet, mint)) {
      throw new PlanPreconditionError(`A ${what} by ${wallet} while offline is not modelled`);
    }
  }

  private claimedValue(token: PlannedToken): number {
    return token.amount - claimFeeBound(token.amount, this.feePpk);
  }

  private credit(wallet: string, mint: string, amount: number): void {
    this.spendableBy.set(`${wallet}|${mint}`, this.spendable(wallet, mint) + amount);
  }

  private requireWallet(wallet: string): void {
    if (!this.walletSet.has(wallet)) throw new PlanPreconditionError(`Unknown Wallet ${wallet}`);
  }

  private requireMint(mint: string): void {
    if (!this.mintSet.has(mint)) throw new PlanPreconditionError(`Unknown mint ${mint}`);
  }

  private requirePositive(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new PlanPreconditionError(`Amount ${amount} is not a positive integer`);
    }
  }

  private requireToken(ref: string): PlannedToken {
    const token = this.tokens.get(ref);
    if (!token) throw new PlanPreconditionError(`Unknown token ${ref}`);
    return token;
  }
}

/** Validates a plan and derives each step's scheduling and expected outcome. */
export function planWorkload(plan: ScenarioPlan): PlannedWorkload {
  const model = new WorkloadModel(plan.wallets, plan.mints, MINT_INPUT_FEE_PPK, plan.recoveryMode);
  const steps = plan.steps.map((step, index) => {
    const planned = model.apply(step, index);
    // Snapshot the fate: later steps mutate the model's token in place.
    return planned.fateAfter ? { ...planned, fateAfter: { ...planned.fateAfter } } : planned;
  });
  model.finish();
  return {
    steps,
    tokens: model.tokens,
    spendable: (wallet, mint) => model.spendable(wallet, mint),
  };
}

/** Inputs to {@link generateWorkload}. Recorded in the plan so its choices can be regenerated. */
export interface WorkloadOptions {
  /** Scenario seed: an unsigned 32-bit integer, distinct from any Wallet Seed. */
  seed: number;
  wallets: string[];
  mints: string[];
  /** Generated commands after initial funding, excluding checkpoints. */
  commands: number;
  /** Initial funding of every Wallet at every mint. */
  initialFunding: number;
  maxAmount: number;
  /** Insert a checkpoint after this many generated commands. */
  checkpointEvery: number;
  /**
   * Also generate fault interactions: lost exchanges, delays, outages, WebSocket drops, Wallet
   * crashes and mint restarts, each closed within its own interaction. Off by default, which
   * leaves fault-free generation unchanged.
   */
  faults?: boolean;
  /** Recovery mode of the generated plan; explicit plans recover interrupted work explicitly. */
  recoveryMode?: ScenarioPlan['recoveryMode'];
}

/**
 * Version 1 choices are unchanged: fault interactions are generated only with `faults: true`,
 * which version 1 did not accept.
 */
export const WORKLOAD_GENERATOR_VERSION = 1;

/** Step kinds that inject a fault; a checkpoint after one is preceded by healing. */
const FAULT_STEP_KINDS = new Set<ScenarioStep['kind']>([
  'dropRequest',
  'dropResponse',
  'withholdResponse',
  'delayResponses',
  'disconnect',
  'dropWebSockets',
  'crash',
  'restartMint',
]);

/** Small, well-distributed PRNG; the generator's only source of choice. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Generates a state-aware workload from a scenario seed.
 *
 * Every choice is drawn from the seeded PRNG among commands whose preconditions hold in the
 * workload model, so the same options always yield the same plan. Some tokens are withheld from
 * delivery and remain outstanding. The seed reproduces the choices, not process scheduling.
 */
export function generateWorkload(options: WorkloadOptions): ScenarioPlan {
  const { seed, wallets, mints } = options;
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
    throw new RangeError(`Scenario seed ${seed} is not an unsigned 32-bit integer`);
  }
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const recoveryMode = options.recoveryMode ?? 'automatic';
  const model = new WorkloadModel(wallets, mints, MINT_INPUT_FEE_PPK, recoveryMode);
  const steps: ScenarioStep[] = [];
  let faultSinceHeal = false;
  const add = (step: ScenarioStep) => {
    model.apply(step, steps.length);
    steps.push(step);
    if (step.kind === 'heal') faultSinceHeal = false;
    else if (FAULT_STEP_KINDS.has(step.kind)) faultSinceHeal = true;
  };
  /** Every checkpoint after a fault follows a healing step, which starts its recovery deadline. */
  const checkpoint = () => {
    if (faultSinceHeal) add({ kind: 'heal' });
    add({ kind: 'checkpoint' });
  };
  for (const wallet of wallets) {
    for (const mint of mints) add({ kind: 'fund', wallet, mint, amount: options.initialFunding });
  }

  const withheld = new Set<string>();
  const maxRestarts = Math.max(1, Math.floor(options.commands / 8));
  let restarts = 0;
  let mintRestarts = 0;
  let nextToken = 1;
  const tokens = () => [...model.tokens.values()];
  const deliverable = () =>
    tokens().filter((token) => token.fate.kind === 'outstanding' && !withheld.has(token.ref));
  const sendable = () =>
    wallets.flatMap((wallet) =>
      mints
        .map((mint) => ({ wallet, mint, budget: model.spendable(wallet, mint) - SEND_FEE_RESERVE }))
        .filter(({ budget }) => budget >= model.minimumTokenAmount),
    );
  const send = (withhold: boolean) => {
    const { wallet, mint, budget } = pick(sendable());
    const ceiling = Math.min(options.maxAmount, budget);
    const amount =
      model.minimumTokenAmount + Math.floor(random() * (ceiling - model.minimumTokenAmount + 1));
    const token = `t${nextToken++}`;
    if (withhold) withheld.add(token);
    add({ kind: 'send', wallet, mint, amount, token });
  };

  // Each candidate kind is offered only while its precondition holds; weights shape the mix.
  const candidates: { weight: number; ready: () => boolean; make: () => void }[] = [
    { weight: 6, ready: () => sendable().length > 0, make: () => send(random() < 0.2) },
    {
      weight: 5,
      ready: () => deliverable().length > 0,
      make: () => {
        const token = pick(deliverable());
        add({
          kind: 'receive',
          wallet: pick(wallets.filter((w) => w !== token.sender)),
          token: token.ref,
        });
      },
    },
    {
      weight: 2,
      ready: () => tokens().some((token) => token.fate.kind !== 'outstanding'),
      make: () => {
        const token = pick(tokens().filter((t) => t.fate.kind !== 'outstanding'));
        // Retry to the first recipient as often as delivery to anyone else.
        const recipient = 'recipient' in token.fate ? token.fate.recipient : undefined;
        const wallet = recipient && random() < 0.5 ? recipient : pick(wallets);
        add({ kind: 'receive', wallet, token: token.ref });
      },
    },
    {
      weight: 2,
      ready: () => deliverable().length > 0,
      make: () => add({ kind: 'reclaim', token: pick(deliverable()).ref }),
    },
    {
      weight: 1,
      ready: () => tokens().some((token) => token.fate.kind === 'received'),
      make: () =>
        add({
          kind: 'reclaim',
          token: pick(tokens().filter((t) => t.fate.kind === 'received')).ref,
        }),
    },
    {
      weight: 2,
      ready: () => deliverable().length > 0,
      make: () => {
        const token = pick(deliverable());
        const lead = pick([undefined, 'recipient', 'sender'] as const);
        add({
          kind: 'raceReclaim',
          token: token.ref,
          recipient: pick(wallets.filter((w) => w !== token.sender)),
          ...(lead ? { lead } : {}),
        });
      },
    },
    {
      weight: 1,
      ready: () => restarts < maxRestarts,
      make: () => {
        restarts++;
        add({ kind: 'restart', wallet: pick(wallets) });
      },
    },
  ];

  if (options.faults) candidates.push(...faultCandidates());

  /**
   * Fault interactions. Each closes its own faults before it ends, so every other command runs
   * in a healthy environment, and interrupted work makes progress through the scenario's recovery
   * mode: explicit recovery, or a restart's startup recovery. Interrupted Sends are left to fixed
   * scenarios, because an exact-match Send does no swap and its fault would never fire.
   */
  function faultCandidates(): typeof candidates {
    const others = (wallet: string) => wallets.filter((candidate) => candidate !== wallet);
    const progress = (wallet: string) =>
      add(recoveryMode === 'explicit' ? { kind: 'recover', wallet } : { kind: 'restart', wallet });
    const delivery = () => {
      const token = pick(deliverable());
      return { token, wallet: pick(others(token.sender)) };
    };
    const subscribed = () =>
      deliverable().filter((token) => !model.webSocketLostAt(token.sender, token.mint));
    return [
      {
        // A Receive whose swap request or successful response is lost recovers inline.
        weight: 2,
        ready: () => deliverable().length > 0,
        make: () => {
          const { token, wallet } = delivery();
          const kind = pick(['dropRequest', 'dropResponse'] as const);
          add({ kind, wallet, mint: token.mint, path: '/v1/swap' });
          add({ kind: 'receive', wallet, token: token.ref });
        },
      },
      {
        // The mint answers a Receive, the answer is withheld and the Wallet is SIGKILLed.
        weight: 1,
        ready: () => deliverable().length > 0,
        make: () => {
          const { token, wallet } = delivery();
          add({
            kind: 'withholdResponse',
            wallet,
            mint: token.mint,
            method: 'POST',
            path: '/v1/swap',
          });
          add({ kind: 'receive', wallet, token: token.ref, crashWhenFaultFires: true });
          add({ kind: 'restart', wallet });
        },
      },
      {
        // Delayed responses while the Wallet claims a token.
        weight: 1,
        ready: () => deliverable().length > 0,
        make: () => {
          const { token, wallet } = delivery();
          const delayMs = 200 + Math.floor(random() * 1_300);
          const count = 1 + Math.floor(random() * 4);
          add({ kind: 'delayResponses', wallet, mint: token.mint, delayMs, count });
          add({ kind: 'receive', wallet, token: token.ref });
          add({ kind: 'heal' });
        },
      },
      {
        // An outage interrupts the recipient's Receive with no remote effect.
        weight: 1,
        ready: () => deliverable().length > 0,
        make: () => {
          const { token, wallet } = delivery();
          add({ kind: 'disconnect', wallet, mint: token.mint });
          add({ kind: 'receive', wallet, token: token.ref });
          add({ kind: 'reconnect', wallet, mint: token.mint });
          progress(wallet);
        },
      },
      {
        // The sender is offline while its token is claimed; its Send finalizes after reconnect.
        weight: 1,
        ready: () => deliverable().length > 0,
        make: () => {
          const { token, wallet } = delivery();
          add({ kind: 'disconnect', wallet: token.sender, mint: token.mint });
          add({ kind: 'receive', wallet, token: token.ref });
          add({ kind: 'reconnect', wallet: token.sender, mint: token.mint });
        },
      },
      {
        // The sender's subscription socket drops while its token is outstanding.
        weight: 1,
        ready: () => subscribed().length > 0,
        make: () => {
          const token = pick(subscribed());
          add({ kind: 'dropWebSockets', wallet: token.sender, mint: token.mint });
        },
      },
      {
        // The sender is SIGKILLed while idle, its token is claimed, and it restarts.
        weight: 1,
        ready: () => deliverable().length > 0,
        make: () => {
          const { token, wallet } = delivery();
          add({ kind: 'crash', wallet: token.sender });
          add({ kind: 'receive', wallet, token: token.ref });
          add({ kind: 'restart', wallet: token.sender });
        },
      },
      {
        // A mint restart over its committed storage; bounded, as each one takes seconds.
        weight: 1,
        ready: () => mintRestarts < Math.max(1, Math.floor(options.commands / 12)),
        make: () => {
          mintRestarts++;
          add({ kind: 'restartMint', mint: pick(mints) });
        },
      },
    ];
  }

  for (let command = 1; command <= options.commands; command++) {
    const ready = candidates.filter((candidate) => candidate.ready());
    if (ready.length === 0) {
      throw new PlanPreconditionError('No generated command has its preconditions satisfied');
    }
    let draw = random() * ready.reduce((total, candidate) => total + candidate.weight, 0);
    const chosen = ready.find((candidate) => (draw -= candidate.weight) < 0) ?? ready.at(-1)!;
    chosen.make();
    if (command % options.checkpointEvery === 0) checkpoint();
  }
  if (!tokens().some((token) => token.fate.kind === 'outstanding') && sendable().length > 0) {
    send(true);
  }
  if (steps.at(-1)?.kind !== 'checkpoint') checkpoint();
  model.finish();

  return {
    id: options.faults ? `generated-faults-${recoveryMode}-seed-${seed}` : `generated-seed-${seed}`,
    description:
      `Generated workload: ${options.commands} state-aware commands` +
      (options.faults ? ` with fault interactions (${recoveryMode} recovery)` : '') +
      ` for ${wallets.length} Wallets at ${mints.length} mints from scenario seed ${seed}.`,
    expect: 'pass',
    recoveryMode,
    recoveryDeadlineMs: 60_000,
    wallets,
    mints,
    steps,
    generator: { ...options, version: WORKLOAD_GENERATOR_VERSION },
  };
}
