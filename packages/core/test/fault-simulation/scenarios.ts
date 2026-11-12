/**
 * Scenario plans are plain data so a recorded trace can replay them from clean state.
 *
 * Wallets and mints are logical names; the runner maps them to processes and URLs. Token
 * references name secret-bearing tokens without containing them. Expected outcomes are not part of
 * the data: {@link planWorkload} derives them from the steps, so a replayed plan carries the same
 * expectations. A fault step installs one gateway rule; a step that depends on it waits for the
 * gateway to report that the rule fired rather than guessing from elapsed time.
 */
import type { WorkloadOptions } from './workload.ts';

export type ScenarioStep =
  /** Initial funding through the mint's fake Lightning backend. */
  | { kind: 'fund'; wallet: string; mint: string; amount: number }
  /** Create a token. Delivering it is a separate step, so it may stay undelivered. */
  | { kind: 'send'; wallet: string; mint: string; amount: number; token: string }
  /**
   * Deliver a token to a Wallet, which prepares and executes a Receive. Delivering a token whose
   * value was already claimed is a duplicate delivery and must be rejected without credit. With
   * `crashWhenFaultFires`, SIGKILL the Wallet as soon as the gateway reports that the preceding
   * fault rule fired, so the withheld response is never delivered.
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
   * disposed gracefully first; this is not a crash.
   */
  | { kind: 'restart'; wallet: string }
  /** Hold the next matching response from one mint at its gateway after the mint has answered. */
  | { kind: 'withholdResponse'; mint: string; method: 'POST'; path: string }
  /** Remove every fault and establish environment health; the recovery deadline starts here. */
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

export interface ScenarioPlan {
  id: string;
  description: string;
  /** Negative controls expect the checker to detect a wallet failure. */
  expect: 'pass' | 'detected-failure';
  /** `automatic` scenarios never call explicit public recovery interfaces. */
  recoveryMode: 'automatic';
  recoveryDeadlineMs: number;
  wallets: string[];
  mints: string[];
  steps: ScenarioStep[];
  /** Present when the steps were generated; the scenario seed is distinct from Wallet Seeds. */
  generator?: WorkloadOptions & { version: number };
  checkerControl?: CheckerControl;
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
} satisfies Record<string, ScenarioPlan>;
