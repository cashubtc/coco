/**
 * Scenario plans are plain data so a recorded trace can replay them from clean state.
 *
 * Token references name secret-bearing tokens without containing them. A fault step installs one
 * gateway rule; a step that depends on it waits for the gateway to report that the rule fired
 * rather than guessing from elapsed time.
 */

export type ScenarioStep =
  | { kind: 'fund'; wallet: string; amount: number }
  | { kind: 'send'; wallet: string; amount: number; token: string }
  /** Hold the next matching mint response at the gateway after the mint has answered. */
  | { kind: 'withholdResponse'; method: 'POST'; path: string }
  /**
   * Receive a token. With `crashWhenFaultFires`, SIGKILL the Wallet as soon as the gateway reports
   * that the preceding fault rule fired, so the withheld response is never delivered.
   */
  | { kind: 'receive'; wallet: string; token: string; crashWhenFaultFires?: boolean }
  /** Remove every fault and establish environment health; the recovery deadline starts here. */
  | { kind: 'heal' }
  /** Start a new Coco Session process over the same store and Wallet Seed. */
  | { kind: 'restart'; wallet: string }
  /** Observe, without invoking recovery, until every requirement holds or the deadline passes. */
  | { kind: 'awaitRequirements' };

export interface ScenarioRequirement {
  wallet: string;
  operation: 'receive';
  token: string;
  state: 'finalized';
}

export interface ScenarioPlan {
  id: string;
  description: string;
  /** Negative controls expect the checker to detect a wallet failure. */
  expect: 'pass' | 'detected-failure';
  /** `automatic` scenarios never call explicit public recovery interfaces. */
  recoveryMode: 'automatic';
  recoveryDeadlineMs: number;
  wallets: string[];
  steps: ScenarioStep[];
  requirements: ScenarioRequirement[];
}

const transferRequirement: ScenarioRequirement = {
  wallet: 'bob',
  operation: 'receive',
  token: 'token-1',
  state: 'finalized',
};

const lostReceiveResponseSteps: ScenarioStep[] = [
  { kind: 'fund', wallet: 'alice', amount: 64 },
  { kind: 'send', wallet: 'alice', amount: 32, token: 'token-1' },
  { kind: 'withholdResponse', method: 'POST', path: '/v1/swap' },
  { kind: 'receive', wallet: 'bob', token: 'token-1', crashWhenFaultFires: true },
  { kind: 'heal' },
];

export const scenarios = {
  healthyTransfer: {
    id: 'healthy-transfer',
    description: 'Fund one Wallet, Send a token and Receive it in a second Wallet without faults.',
    expect: 'pass',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    wallets: ['alice', 'bob'],
    steps: [
      { kind: 'fund', wallet: 'alice', amount: 64 },
      { kind: 'send', wallet: 'alice', amount: 32, token: 'token-1' },
      { kind: 'receive', wallet: 'bob', token: 'token-1' },
      { kind: 'awaitRequirements' },
    ],
    requirements: [transferRequirement],
  },
  lostReceiveResponseCrash: {
    id: 'receive-lost-response-crash-restart',
    description:
      'The mint accepts a Receive swap, its response is withheld, the receiving Wallet is ' +
      'SIGKILLed, and a new Coco Session over the same store must recover automatically.',
    expect: 'pass',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    wallets: ['alice', 'bob'],
    steps: [
      ...lostReceiveResponseSteps,
      { kind: 'restart', wallet: 'bob' },
      { kind: 'awaitRequirements' },
    ],
    requirements: [transferRequirement],
  },
  lostReceiveResponseWithoutRestart: {
    id: 'negative-control-receive-lost-response-no-restart',
    description:
      'Negative control: the same accepted Receive with a lost response, but the crashed Wallet is ' +
      'never restarted. The checker must report the missing value and unmet outcome.',
    expect: 'detected-failure',
    recoveryMode: 'automatic',
    recoveryDeadlineMs: 60_000,
    wallets: ['alice', 'bob'],
    steps: [...lostReceiveResponseSteps, { kind: 'awaitRequirements' }],
    requirements: [transferRequirement],
  },
} satisfies Record<string, ScenarioPlan>;
