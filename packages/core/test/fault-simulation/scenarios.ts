/**
 * Scenario plans are plain data so a recorded trace can replay them from clean state.
 *
 * Wallets and mints are logical names; the runner maps them to processes and URLs. Token
 * references name secret-bearing tokens without containing them. Expected outcomes are not part of
 * the data: {@link planWorkload} derives them from the steps, so a replayed plan carries the same
 * expectations. Fault steps are triggered by requests and events rather than elapsed time: exchange
 * faults arm a gateway rule for the targeted Wallet's next swap, and a step that depends on a fault
 * waits for the gateway or transport link to report that it fired.
 */
import type { WorkloadOptions } from './workload.ts';

export type ScenarioStep =
  /** Initial funding through the mint's fake Lightning backend. */
  | { kind: 'fund'; wallet: string; mint: string; amount: number }
  /**
   * Create a token. Delivering it is a separate step, so it may stay undelivered. With
   * `crashWhenFaultFires`, SIGKILL the Wallet as soon as the gateway reports that its armed
   * `withholdResponse` fired, so the withheld response is never delivered.
   */
  | {
      kind: 'send';
      wallet: string;
      mint: string;
      amount: number;
      token: string;
      crashWhenFaultFires?: boolean;
    }
  /**
   * Deliver a token to a Wallet, which prepares and executes a Receive. Delivering a token whose
   * value was already claimed is a duplicate delivery and must be rejected without credit. With
   * `crashWhenFaultFires`, SIGKILL the Wallet as soon as the gateway reports that the armed
   * `withholdResponse` fired, so the withheld response is never delivered.
   */
  | { kind: 'receive'; wallet: string; token: string; crashWhenFaultFires?: boolean }
  /** The token's sender reclaims it through the public Send reclaim interface. */
  | { kind: 'reclaim'; token: string }
  /**
   * Coordinated race: the recipient prepares a Receive, then its execution and the sender's
   * reclaim overlap. Without `lead` both start together and either claimant may win; exactly one
   * must. With `lead`, the lead's swap reaches the mint first and its committed response is held at
   * the gateway while the other claimant runs, so the lead must win. A led race runs exclusively
   * so the gateway rule can only match the lead's swap.
   */
  | { kind: 'raceReclaim'; token: string; recipient: string; lead?: 'recipient' | 'sender' }
  /**
   * Start a new Coco Session process over the same store and Wallet Seed. A running Wallet is
   * disposed gracefully first; this is not a crash. Session start runs Operation Recovery.
   */
  | { kind: 'restart'; wallet: string }
  /**
   * Hold the next matching swap response from one mint at its gateway after the mint has answered:
   * the response is never delivered. Scoped to one Wallet's traffic when `wallet` is given;
   * otherwise it applies to whichever Wallet swaps next and runs exclusively. The exposed command
   * must use `crashWhenFaultFires`.
   */
  | { kind: 'withholdResponse'; mint: string; method: 'POST'; path: string; wallet?: string }
  /** Drop the Wallet's next swap request at the gateway before it reaches the mint. */
  | { kind: 'dropRequest'; wallet: string; mint: string; path: string }
  /**
   * Forward the Wallet's next swap to the mint, then drop the connection instead of delivering the
   * mint's successful response.
   */
  | { kind: 'dropResponse'; wallet: string; mint: string; path: string }
  /** Delay the next `count` responses from the mint to the Wallet; until the next `heal`. */
  | { kind: 'delayResponses'; wallet: string; mint: string; delayMs: number; count: number }
  /**
   * Start a Wallet-to-mint outage: close the Wallet's connections to the mint, including
   * WebSockets, and refuse new ones until `reconnect` or `heal`.
   */
  | { kind: 'disconnect'; wallet: string; mint: string }
  /** End a Wallet-to-mint outage. */
  | { kind: 'reconnect'; wallet: string; mint: string }
  /**
   * Abruptly close the Wallet's open WebSockets to the mint once one is open. Coco falls back to
   * polling and opens a new socket only on networking repair or a new Session.
   */
  | { kind: 'dropWebSockets'; wallet: string; mint: string }
  /** SIGKILL the Wallet process. It stays down until a `restart` step. */
  | { kind: 'crash'; wallet: string }
  /**
   * SIGKILL the mint process and start it again over its committed storage. Wallets' connections
   * to it are refused while it is down, as they would be by a mint that is not listening.
   */
  | { kind: 'restartMint'; mint: string }
  /**
   * Explicit public recovery in a Wallet: networking repair and the Send and Receive recovery
   * sweeps. Only in `explicit` scenarios, after every fault has healed.
   */
  | { kind: 'recover'; wallet: string }
  /**
   * Remove every fault, end every outage and establish environment health; the recovery deadline
   * starts here.
   */
  | { kind: 'heal' }
  /**
   * Barrier: wait until every Wallet is idle, observe (without invoking recovery) until every
   * expected operation state holds or the recovery deadline passes, then check fund accounting.
   */
  | { kind: 'checkpoint' };

/**
 * A deliberate checker control. The runner tampers with the collected evidence, never with Wallet
 * state, so the checker must report the resulting lost or duplicated value.
 */
export type CheckerControl = 'hideHeldProof' | 'duplicateHeldProof';

/**
 * A deliberate environment control: `mintDoesNotRestart` removes a restarted mint instead of
 * starting it again, so environment readiness cannot be established.
 */
export type InfrastructureControl = 'mintDoesNotRestart';

export interface ScenarioPlan {
  id: string;
  description: string;
  /**
   * Negative controls expect the checker to detect a wallet failure, or the harness to classify an
   * unestablished environment as an infrastructure failure.
   */
  expect: 'pass' | 'detected-failure' | 'infrastructure-failure';
  /**
   * `automatic` scenarios never call explicit public recovery interfaces: progress must come from
   * Coco itself, including startup recovery after a restart. `explicit` scenarios may use the
   * `recover` step after healing.
   */
  recoveryMode: 'automatic' | 'explicit';
  recoveryDeadlineMs: number;
  wallets: string[];
  mints: string[];
  steps: ScenarioStep[];
  /** Present when the steps were generated; the scenario seed is distinct from Wallet Seeds. */
  generator?: WorkloadOptions & { version: number };
  checkerControl?: CheckerControl;
  infrastructureControl?: InfrastructureControl;
}

const lostReceiveResponseSteps: ScenarioStep[] = [
  { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
  { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 32, token: 'token-1' },
  { kind: 'withholdResponse', mint: 'mint-a', method: 'POST', path: '/v1/swap' },
  { kind: 'receive', wallet: 'bob', token: 'token-1', crashWhenFaultFires: true },
  { kind: 'heal' },
];

const twoWalletsOneMint = { wallets: ['alice', 'bob'], mints: ['mint-a'] };

const threeWallets = ['alice', 'bob', 'carol'];
const twoMints = ['mint-a', 'mint-b'];

/**
 * Every workload command at both mints: transfers, an intentionally undelivered token, duplicate
 * deliveries to the recipient and to a third Wallet, an uncontested reclaim, a late reclaim after
 * the recipient claimed, led receive-versus-reclaim races won by each claimant, an unled race, and
 * graceful restarts. Steps for different Wallets run concurrently.
 */
const healthyWorkloadSteps: ScenarioStep[] = [
  ...threeWallets.flatMap((wallet) =>
    twoMints.map((mint): ScenarioStep => ({ kind: 'fund', wallet, mint, amount: 128 })),
  ),
  { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 21, token: 'a1' },
  { kind: 'send', wallet: 'bob', mint: 'mint-b', amount: 13, token: 'b1' },
  { kind: 'send', wallet: 'carol', mint: 'mint-a', amount: 9, token: 'c1' },
  { kind: 'receive', wallet: 'bob', token: 'a1' },
  { kind: 'receive', wallet: 'carol', token: 'b1' },
  { kind: 'send', wallet: 'alice', mint: 'mint-b', amount: 17, token: 'a2' },
  { kind: 'reclaim', token: 'c1' },
  { kind: 'receive', wallet: 'bob', token: 'a1' },
  { kind: 'receive', wallet: 'alice', token: 'b1' },
  { kind: 'checkpoint' },
  { kind: 'raceReclaim', token: 'a2', recipient: 'carol', lead: 'recipient' },
  { kind: 'send', wallet: 'bob', mint: 'mint-a', amount: 11, token: 'b2' },
  { kind: 'restart', wallet: 'carol' },
  { kind: 'raceReclaim', token: 'b2', recipient: 'alice', lead: 'sender' },
  { kind: 'send', wallet: 'carol', mint: 'mint-b', amount: 7, token: 'c2' },
  { kind: 'send', wallet: 'carol', mint: 'mint-a', amount: 6, token: 'c3' },
  { kind: 'raceReclaim', token: 'c3', recipient: 'bob' },
  { kind: 'receive', wallet: 'bob', token: 'a2' },
  { kind: 'reclaim', token: 'a1' },
  { kind: 'restart', wallet: 'bob' },
  { kind: 'receive', wallet: 'carol', token: 'c1' },
  { kind: 'checkpoint' },
];

const sendExchangeFaults: ScenarioStep[] = [
  { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
  { kind: 'fund', wallet: 'bob', mint: 'mint-b', amount: 64 },
  { kind: 'dropRequest', wallet: 'alice', mint: 'mint-a', path: '/v1/swap' },
  { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 21, token: 'a1' },
  { kind: 'dropResponse', wallet: 'bob', mint: 'mint-b', path: '/v1/swap' },
  { kind: 'send', wallet: 'bob', mint: 'mint-b', amount: 13, token: 'b1' },
  { kind: 'heal' },
];
const deliverRecoveredTokens: ScenarioStep[] = [
  { kind: 'receive', wallet: 'carol', token: 'a1' },
  { kind: 'receive', wallet: 'carol', token: 'b1' },
  { kind: 'checkpoint' },
];

/** Fixed-scenario defaults for the fault palette: three Wallets at two mints. */
const palette = {
  expect: 'pass',
  recoveryMode: 'automatic',
  recoveryDeadlineMs: 60_000,
  wallets: threeWallets,
  mints: twoMints,
} as const;

export const scenarios = {
  healthyTransfer: {
    id: 'healthy-transfer',
    description: 'Fund one Wallet, Send a token and Receive it in a second Wallet without faults.',
    expect: 'pass',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    ...twoWalletsOneMint,
    steps: [
      { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
      { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 32, token: 'token-1' },
      { kind: 'receive', wallet: 'bob', token: 'token-1' },
      { kind: 'checkpoint' },
    ],
  },
  lostReceiveResponseCrash: {
    id: 'receive-lost-response-crash-restart',
    description:
      'The mint accepts a Receive swap, its response is withheld, the receiving Wallet is ' +
      'SIGKILLed, and a new Coco Session over the same store must recover automatically.',
    expect: 'pass',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    ...twoWalletsOneMint,
    steps: [
      ...lostReceiveResponseSteps,
      { kind: 'restart', wallet: 'bob' },
      { kind: 'checkpoint' },
    ],
  },
  lostReceiveResponseWithoutRestart: {
    id: 'negative-control-receive-lost-response-no-restart',
    description:
      'Negative control: the same accepted Receive with a lost response, but the crashed Wallet is ' +
      'never restarted. The checker must report the missing value and unmet outcome.',
    expect: 'detected-failure',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    ...twoWalletsOneMint,
    steps: [...lostReceiveResponseSteps, { kind: 'checkpoint' }],
  },
  healthyWorkload: {
    id: 'healthy-three-wallet-two-mint-workload',
    description:
      'Three Wallets transfer within each of two mints, with undelivered and duplicate ' +
      'deliveries, reclaims, receive-versus-reclaim races and graceful restarts, without faults.',
    expect: 'pass',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    wallets: threeWallets,
    mints: twoMints,
    steps: healthyWorkloadSteps,
  },
  hiddenHeldProofControl: {
    id: 'negative-control-hidden-held-proof',
    description:
      'Negative control: a healthy transfer whose collected evidence omits one proof the ' +
      'recipient holds. The checker must report the lost value.',
    expect: 'detected-failure',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    wallets: threeWallets,
    mints: twoMints,
    checkerControl: 'hideHeldProof',
    steps: [
      { kind: 'fund', wallet: 'alice', mint: 'mint-b', amount: 64 },
      { kind: 'send', wallet: 'alice', mint: 'mint-b', amount: 24, token: 'token-1' },
      { kind: 'receive', wallet: 'carol', token: 'token-1' },
      { kind: 'checkpoint' },
    ],
  },
  duplicatedHeldProofControl: {
    id: 'negative-control-duplicated-held-proof',
    description:
      'Negative control: a healthy transfer whose collected evidence credits one held proof to a ' +
      'second Wallet as well. The checker must report the duplicated value.',
    expect: 'detected-failure',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    wallets: threeWallets,
    mints: twoMints,
    checkerControl: 'duplicateHeldProof',
    steps: [
      { kind: 'fund', wallet: 'bob', mint: 'mint-a', amount: 64 },
      { kind: 'send', wallet: 'bob', mint: 'mint-a', amount: 24, token: 'token-1' },
      { kind: 'receive', wallet: 'alice', token: 'token-1' },
      { kind: 'checkpoint' },
    ],
  },
  lostReceiveExchanges: {
    ...palette,
    id: 'receive-lost-request-and-response',
    description:
      "Bob's Receive swap request is dropped before the mint and Carol's successful Receive " +
      'response is dropped after it. Coco must recover both inline, without double credit.',
    steps: [
      { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
      { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 21, token: 'a1' },
      { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 13, token: 'a2' },
      { kind: 'dropRequest', wallet: 'bob', mint: 'mint-a', path: '/v1/swap' },
      { kind: 'receive', wallet: 'bob', token: 'a1' },
      { kind: 'dropResponse', wallet: 'carol', mint: 'mint-a', path: '/v1/swap' },
      { kind: 'receive', wallet: 'carol', token: 'a2' },
      { kind: 'heal' },
      { kind: 'checkpoint' },
    ],
  },
  lostSendExchangesExplicit: {
    ...palette,
    recoveryMode: 'explicit',
    id: 'send-lost-request-and-response-explicit-recovery',
    description:
      "Alice's Send swap request is dropped before the mint and Bob's successful Send response " +
      'is dropped after it. After healing, explicit public recovery must make both Sends pending ' +
      'so their tokens can be delivered.',
    steps: [
      ...sendExchangeFaults,
      { kind: 'recover', wallet: 'alice' },
      { kind: 'recover', wallet: 'bob' },
      ...deliverRecoveredTokens,
    ],
  },
  lostSendExchangesAutomatic: {
    ...palette,
    id: 'send-lost-request-and-response-automatic-recovery',
    description:
      'The same interrupted Sends recovered without any explicit call: a new Coco Session over ' +
      'the same store must make both Sends pending during startup recovery.',
    steps: [
      ...sendExchangeFaults,
      { kind: 'restart', wallet: 'alice' },
      { kind: 'restart', wallet: 'bob' },
      ...deliverRecoveredTokens,
    ],
  },
  lostSendResponseUnrecovered: {
    ...palette,
    expect: 'detected-failure',
    id: 'negative-control-send-lost-response-unrecovered',
    description:
      'Negative control: a Send whose successful response is lost, in an automatic scenario ' +
      'with no restart. The environment heals, but the Send stays executing past the recovery ' +
      'deadline, which must fail rather than pass as safely blocked.',
    recoveryDeadlineMs: 15_000,
    steps: [
      { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
      { kind: 'dropResponse', wallet: 'alice', mint: 'mint-a', path: '/v1/swap' },
      { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 21, token: 'a1' },
      { kind: 'heal' },
      { kind: 'checkpoint' },
    ],
  },
  walletOutages: {
    ...palette,
    id: 'wallet-mint-outages',
    description:
      'Alice is cut off from mint-b while Bob claims her pending token there; her Send must ' +
      'finalize once she reconnects. Bob is cut off from mint-a while he receives Carol’s token; ' +
      'the attempt has no remote effect and startup recovery must complete it.',
    steps: [
      { kind: 'fund', wallet: 'alice', mint: 'mint-b', amount: 64 },
      { kind: 'fund', wallet: 'carol', mint: 'mint-a', amount: 64 },
      { kind: 'send', wallet: 'alice', mint: 'mint-b', amount: 21, token: 'a1' },
      { kind: 'send', wallet: 'carol', mint: 'mint-a', amount: 17, token: 'c1' },
      { kind: 'disconnect', wallet: 'alice', mint: 'mint-b' },
      { kind: 'disconnect', wallet: 'bob', mint: 'mint-a' },
      { kind: 'receive', wallet: 'bob', token: 'a1' },
      { kind: 'receive', wallet: 'bob', token: 'c1' },
      { kind: 'reconnect', wallet: 'alice', mint: 'mint-b' },
      { kind: 'reconnect', wallet: 'bob', mint: 'mint-a' },
      { kind: 'restart', wallet: 'bob' },
      { kind: 'heal' },
      { kind: 'checkpoint' },
    ],
  },
  webSocketAndDelays: {
    ...palette,
    recoveryMode: 'explicit',
    id: 'websocket-disconnect-and-delayed-responses',
    description:
      "Alice's subscription WebSocket to mint-a is dropped while her token is outstanding, and " +
      "Bob's responses from mint-a are delayed while he claims it. Coco must finalize the Send by " +
      'polling; explicit networking repair then opens a new WebSocket.',
    steps: [
      { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
      { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 21, token: 'a1' },
      { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 9, token: 'a2' },
      { kind: 'dropWebSockets', wallet: 'alice', mint: 'mint-a' },
      { kind: 'delayResponses', wallet: 'bob', mint: 'mint-a', delayMs: 1_500, count: 4 },
      { kind: 'receive', wallet: 'bob', token: 'a1' },
      { kind: 'heal' },
      { kind: 'checkpoint' },
      { kind: 'recover', wallet: 'alice' },
      { kind: 'receive', wallet: 'carol', token: 'a2' },
      { kind: 'checkpoint' },
    ],
  },
  walletCrashes: {
    ...palette,
    id: 'wallet-crash-during-send-and-idle',
    description:
      "Alice is SIGKILLed while the mint's answer to her Send swap is withheld; Carol is " +
      'SIGKILLed while idle with a pending Send whose token Bob then claims. New Coco Sessions ' +
      'over the same stores must recover both.',
    steps: [
      { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
      { kind: 'fund', wallet: 'carol', mint: 'mint-b', amount: 64 },
      { kind: 'send', wallet: 'carol', mint: 'mint-b', amount: 15, token: 'c1' },
      {
        kind: 'withholdResponse',
        wallet: 'alice',
        mint: 'mint-a',
        method: 'POST',
        path: '/v1/swap',
      },
      {
        kind: 'send',
        wallet: 'alice',
        mint: 'mint-a',
        amount: 21,
        token: 'a1',
        crashWhenFaultFires: true,
      },
      { kind: 'crash', wallet: 'carol' },
      { kind: 'receive', wallet: 'bob', token: 'c1' },
      { kind: 'heal' },
      { kind: 'restart', wallet: 'alice' },
      { kind: 'restart', wallet: 'carol' },
      { kind: 'receive', wallet: 'bob', token: 'a1' },
      { kind: 'checkpoint' },
    ],
  },
  mintRestart: {
    ...palette,
    id: 'mint-restart-retains-state',
    description:
      'Mint-a is SIGKILLed and started again over its committed storage between transfers. ' +
      'Tokens issued before the restart stay claimable, spent proofs stay spent, and transfers ' +
      'continue afterwards.',
    steps: [
      { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
      { kind: 'fund', wallet: 'bob', mint: 'mint-a', amount: 64 },
      { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 21, token: 'a1' },
      { kind: 'receive', wallet: 'carol', token: 'a1' },
      { kind: 'send', wallet: 'bob', mint: 'mint-a', amount: 13, token: 'b1' },
      { kind: 'restartMint', mint: 'mint-a' },
      { kind: 'receive', wallet: 'carol', token: 'b1' },
      { kind: 'receive', wallet: 'bob', token: 'a1' },
      { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 11, token: 'a2' },
      { kind: 'receive', wallet: 'bob', token: 'a2' },
      { kind: 'checkpoint' },
    ],
  },
  mintDoesNotRestartControl: {
    ...palette,
    expect: 'infrastructure-failure',
    id: 'negative-control-mint-does-not-restart',
    description:
      'Negative control: mint-a is stopped and deliberately not started again, so environment ' +
      'readiness cannot be established. This must be an infrastructure failure, never a pass ' +
      'or a wallet failure.',
    infrastructureControl: 'mintDoesNotRestart',
    steps: [
      { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
      { kind: 'restartMint', mint: 'mint-a' },
      { kind: 'checkpoint' },
    ],
  },
} satisfies Record<string, ScenarioPlan>;
