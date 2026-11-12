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

  constructor(
    readonly wallets: string[],
    readonly mints: string[],
    readonly feePpk = MINT_INPUT_FEE_PPK,
  ) {
    this.walletSet = new Set(wallets);
    this.mintSet = new Set(mints);
  }

  spendable(wallet: string, mint: string): number {
    return this.spendableBy.get(`${wallet}|${mint}`) ?? 0;
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
        this.credit(step.wallet, step.mint, step.amount);
        planned.wallets = [step.wallet];
        return planned;
      case 'send': {
        this.requireWallet(step.wallet);
        this.requireMint(step.mint);
        this.requirePositive(step.amount);
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
        this.credit(step.wallet, step.mint, -required);
        const token: PlannedToken = {
          ref: step.token,
          sender: step.wallet,
          mint: step.mint,
          amount: step.amount,
          fate: { kind: 'outstanding' },
        };
        this.tokens.set(step.token, token);
        return { ...planned, wallets: [step.wallet], tokens: [step.token], fateAfter: token.fate };
      }
      case 'receive': {
        this.requireWallet(step.wallet);
        const token = this.requireToken(step.token);
        planned.wallets = [step.wallet];
        planned.tokens = [token.ref];
        if (token.fate.kind !== 'outstanding') {
          return { ...planned, receive: 'rejected', fateAfter: token.fate };
        }
        if (step.wallet === token.sender) {
          throw new PlanPreconditionError(`${token.ref} cannot be delivered to its own sender`);
        }
        token.fate = { kind: 'received', recipient: step.wallet };
        this.credit(step.wallet, token.mint, this.claimedValue(token));
        return { ...planned, receive: 'finalized', fateAfter: token.fate };
      }
      case 'reclaim': {
        const token = this.requireToken(step.token);
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
        return { ...planned, wallets: [step.wallet] };
      case 'withholdResponse':
        this.requireMint(step.mint);
        return { ...planned, barrier: true };
      case 'heal':
      case 'checkpoint':
        return { ...planned, barrier: true };
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
  const model = new WorkloadModel(plan.wallets, plan.mints);
  const steps = plan.steps.map((step, index) => {
    const planned = model.apply(step, index);
    // Snapshot the fate: later steps mutate the model's token in place.
    return planned.fateAfter ? { ...planned, fateAfter: { ...planned.fateAfter } } : planned;
  });
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
}

export const WORKLOAD_GENERATOR_VERSION = 1;

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
  const model = new WorkloadModel(wallets, mints);
  const steps: ScenarioStep[] = [];
  const add = (step: ScenarioStep) => {
    model.apply(step, steps.length);
    steps.push(step);
  };
  for (const wallet of wallets) {
    for (const mint of mints) add({ kind: 'fund', wallet, mint, amount: options.initialFunding });
  }

  const withheld = new Set<string>();
  const maxRestarts = Math.max(1, Math.floor(options.commands / 8));
  let restarts = 0;
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

  for (let command = 1; command <= options.commands; command++) {
    const ready = candidates.filter((candidate) => candidate.ready());
    if (ready.length === 0) {
      throw new PlanPreconditionError('No generated command has its preconditions satisfied');
    }
    let draw = random() * ready.reduce((total, candidate) => total + candidate.weight, 0);
    const chosen = ready.find((candidate) => (draw -= candidate.weight) < 0) ?? ready.at(-1)!;
    chosen.make();
    if (command % options.checkpointEvery === 0) add({ kind: 'checkpoint' });
  }
  if (!tokens().some((token) => token.fate.kind === 'outstanding') && sendable().length > 0) {
    send(true);
  }
  if (steps.at(-1)?.kind !== 'checkpoint') add({ kind: 'checkpoint' });

  return {
    id: `generated-seed-${seed}`,
    description:
      `Generated workload: ${options.commands} state-aware commands for ` +
      `${wallets.length} Wallets at ${mints.length} mints from scenario seed ${seed}.`,
    expect: 'pass',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    wallets,
    mints,
    steps,
    generator: { ...options, version: WORKLOAD_GENERATOR_VERSION },
  };
}
