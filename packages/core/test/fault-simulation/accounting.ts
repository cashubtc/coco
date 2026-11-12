/**
 * Independent fund accounting for wallet fault simulation.
 *
 * The checker never trusts Coco's displayed balances to define the expected result. Value is
 * classified from mint proof states, the harness's own token decoding and each mint's keyset input
 * fee rates; Coco's public balances and operation states are corroborated against that
 * classification. Missing or ambiguous evidence yields an unresolved verdict, never a pass.
 *
 * Every proof identity, keyset fee rate and swap is scoped by mint: `Y` points and keyset IDs are
 * only unique within one mint, and operation IDs only within one Wallet.
 */
import type { TokenFate } from './workload.ts';

export type MintProofState = 'UNSPENT' | 'PENDING' | 'SPENT';

/** A proof at one mint identified by its public `Y` point, with its mint-reported state. */
export interface ObservedProof {
  mint: string;
  y: string;
  amount: number;
  keysetId: string;
  mintState: MintProofState | undefined;
}

/** A proof row read from a Wallet's persistent store. */
export interface StoredProof extends ObservedProof {
  storeState: 'ready' | 'inflight' | 'spent';
  /**
   * The operation whose swap consumed or reserved this proof, from persisted proof or operation
   * records. Spent inputs without it cannot be assigned to a swap, so their fee stays unresolved.
   */
  usedByOperationId?: string;
}

export interface WalletAccountingEvidence {
  wallet: string;
  storedProofs: StoredProof[];
  /** Coco's displayed total per mint for the unit; absent when no session was observed. */
  publicBalances: Record<string, number | undefined>;
}

/** One Wallet's observed state of an operation; `undefined` when it was not observed. */
export interface OperationObservation {
  wallet: string;
  operationId: string;
  state: string | undefined;
}

/**
 * A created token: its inputs decoded by the harness rather than reported by the sending Wallet,
 * the plan's expected fate, and every operation that could claim its value.
 */
export interface TokenAccountingEvidence {
  ref: string;
  mint: string;
  sender: string;
  inputs: ObservedProof[];
  expectedFate: TokenFate;
  /** The sender's Send; `rolled_back` claims the value for the sender. */
  send: OperationObservation;
  /** Every delivered Receive of this token; `finalized` claims the value for that Wallet. */
  receives: OperationObservation[];
}

export interface RequiredOperationOutcome {
  wallet: string;
  operationId: string;
  kind: 'receive' | 'send';
  expectedStates: string[];
  observedState: string | undefined;
  historyEntries: number | undefined;
}

export interface AccountingEvidence {
  unit: string;
  mints: string[];
  /** Input fee rate by mint, then keyset ID. */
  keysetFeePpk: Record<string, Record<string, number>>;
  funding: { wallet: string; mint: string; amount: number }[];
  wallets: WalletAccountingEvidence[];
  tokens: TokenAccountingEvidence[];
  requiredOutcomes: RequiredOperationOutcome[];
}

export type FindingCode =
  | 'value_deficit'
  | 'value_surplus'
  | 'wallet_value_mismatch'
  | 'duplicate_claim'
  | 'stranded_value'
  | 'spent_proof_held'
  | 'balance_mismatch'
  | 'outcome_unmet'
  | 'duplicate_history'
  | 'claim_unmet'
  | 'duplicate_outcome'
  | 'unexpected_claim'
  | 'unsupported_claim'
  | 'missing_evidence'
  | 'pending_proof'
  | 'partially_spent_token';

export interface AccountingFinding {
  code: FindingCode;
  severity: 'failure' | 'unresolved';
  message: string;
  wallet?: string;
  mint?: string;
  token?: string;
  operationId?: string;
  amount?: number;
}

/** Conservation terms: `funded = held + outstanding + stranded + fees + unexplained`. */
export interface ValueLedger {
  funded: number;
  /** Mint-unspent value held by Wallets, counting a proof held by two Wallets once. */
  held: number;
  /** Value of created tokens whose inputs are still unspent. */
  outstanding: number;
  /** Mint-unspent value a Wallet has locally marked spent. */
  stranded: number;
  /** Legitimate input fees derived from the keyset rate, rounded once per swap. */
  fees: number;
  /** Funded value not explained by the categories above; `null` when evidence is incomplete. */
  unexplained: number | null;
}

export interface WalletMintLedger {
  /**
   * Value this Wallet should hold at this mint from its funding, its tokens, the claims it won
   * and its own swap fees; `null` while claim attribution or fees are unresolved.
   */
  expected: number | null;
  held: number;
  stranded: number;
}

export interface AccountingLedger extends ValueLedger {
  /** Mint-unspent value each Wallet holds across mints; a duplicated proof appears under both. */
  holdings: Record<string, number>;
  mints: Record<string, ValueLedger>;
  wallets: Record<string, Record<string, WalletMintLedger>>;
}

export interface AccountingVerdict {
  status: 'pass' | 'wallet_failure' | 'unresolved';
  findings: AccountingFinding[];
  ledger: AccountingLedger;
}

type FindingInput = Omit<AccountingFinding, 'severity'>;
const failure = (finding: FindingInput): AccountingFinding => ({ ...finding, severity: 'failure' });
const unresolved = (finding: FindingInput): AccountingFinding => ({
  ...finding,
  severity: 'unresolved',
});

const sum = (items: { amount: number }[]) => items.reduce((total, item) => total + item.amount, 0);
const proofKey = (proof: { mint: string; y: string }) => `${proof.mint}|${proof.y}`;

/** Value terms and per-Wallet attribution for one mint, built while walking the evidence. */
class MintAccount {
  funded = 0;
  outstanding = 0;
  fees = 0;
  valueResolved = true;
  attributionResolved = true;
  readonly heldProofs = new Map<string, number>();
  readonly strandedProofs = new Map<string, number>();
  /** Per-Wallet expected value before held and stranded proofs are compared with it. */
  readonly expected = new Map<string, number>();
  readonly held = new Map<string, number>();
  readonly stranded = new Map<string, number>();

  adjust(map: Map<string, number>, wallet: string, amount: number): void {
    map.set(wallet, (map.get(wallet) ?? 0) + amount);
  }
}

export function checkFundAccounting(evidence: AccountingEvidence): AccountingVerdict {
  const findings: AccountingFinding[] = [];
  const mintNames = [
    ...new Set([
      ...evidence.mints,
      ...evidence.funding.map((funding) => funding.mint),
      ...evidence.tokens.map((token) => token.mint),
      ...evidence.wallets.flatMap((wallet) => wallet.storedProofs.map((proof) => proof.mint)),
    ]),
  ];
  const accounts = new Map(mintNames.map((mint) => [mint, new MintAccount()]));
  const account = (mint: string) => accounts.get(mint)!;
  const markUnresolved = (mint: string, finding: FindingInput) => {
    account(mint).valueResolved = false;
    findings.push(unresolved({ ...finding, mint }));
  };

  /** NUT-02 input fee for inputs spent in one swap, or `undefined` when a rate is unknown. */
  const swapFee = (mint: string, inputs: ObservedProof[], context: string): number | undefined => {
    let ppk = 0;
    for (const input of inputs) {
      const rate = evidence.keysetFeePpk[mint]?.[input.keysetId];
      if (rate === undefined) {
        markUnresolved(mint, {
          code: 'missing_evidence',
          message: `No keyset fee rate for ${context}`,
        });
        return undefined;
      }
      ppk += rate;
    }
    return Math.ceil(ppk / 1000);
  };

  for (const funding of evidence.funding) {
    account(funding.mint).funded += funding.amount;
    account(funding.mint).adjust(account(funding.mint).expected, funding.wallet, funding.amount);
  }

  // A token's inputs are one economic claim: outstanding while unspent, otherwise consumed by
  // exactly one swap (a Receive or a reclaim) that charges the keyset input fee once.
  const tokenProofs = new Set<string>();
  for (const token of evidence.tokens) {
    for (const input of token.inputs) tokenProofs.add(proofKey(input));
    checkToken(token);
  }

  function checkToken(token: TokenAccountingEvidence): void {
    const mint = account(token.mint);
    const amount = sum(token.inputs);
    const subject = { mint: token.mint, token: token.ref };
    mint.adjust(mint.expected, token.sender, -amount);

    const claimants = [
      ...token.receives.map((receive) => ({
        ...receive,
        won: receive.state === undefined ? undefined : receive.state === 'finalized',
      })),
      {
        ...token.send,
        won: token.send.state === undefined ? undefined : token.send.state === 'rolled_back',
      },
    ];
    const winners = claimants.filter((claimant) => claimant.won === true);
    const unobserved = claimants.filter((claimant) => claimant.won === undefined);

    const states = new Set(token.inputs.map((input) => input.mintState));
    if (states.has(undefined)) {
      mint.attributionResolved = false;
      markUnresolved(token.mint, {
        ...subject,
        code: 'missing_evidence',
        message: `No mint state for ${token.ref}`,
      });
      return;
    }
    if (states.has('PENDING')) {
      mint.attributionResolved = false;
      markUnresolved(token.mint, {
        ...subject,
        code: 'pending_proof',
        message: `${token.ref} inputs are mint-pending`,
      });
      return;
    }
    if (states.size !== 1) {
      mint.attributionResolved = false;
      markUnresolved(token.mint, {
        ...subject,
        code: 'partially_spent_token',
        message: `${token.ref} inputs are only partially spent`,
      });
      return;
    }

    if (states.has('UNSPENT')) {
      mint.outstanding += amount;
      for (const winner of winners) {
        findings.push(
          failure({
            ...subject,
            wallet: winner.wallet,
            operationId: winner.operationId,
            code: 'unsupported_claim',
            message: `${winner.wallet} reports claiming ${token.ref}, but the mint reports it unspent`,
          }),
        );
      }
      if (token.expectedFate.kind !== 'outstanding' && token.expectedFate.kind !== 'raced') {
        findings.push(
          failure({
            ...subject,
            code: 'claim_unmet',
            message: `${token.ref} was expected ${token.expectedFate.kind} but is still unspent`,
          }),
        );
      } else if (token.expectedFate.kind === 'raced') {
        findings.push(
          failure({
            ...subject,
            code: 'claim_unmet',
            message: `Neither claimant of the ${token.ref} race spent it`,
          }),
        );
      }
      return;
    }

    // Spent: exactly one claimant must report winning, and the plan must allow that claimant.
    const fee = swapFee(token.mint, token.inputs, token.ref);
    if (fee !== undefined) mint.fees += fee;
    if (winners.length > 1) {
      mint.attributionResolved = false;
      findings.push(
        failure({
          ...subject,
          amount,
          code: 'duplicate_outcome',
          message: `${winners.map((w) => w.wallet).join(' and ')} each report claiming ${token.ref}`,
        }),
      );
      return;
    }
    if (unobserved.length > 0) {
      mint.attributionResolved = false;
      findings.push(
        unresolved({
          ...subject,
          code: 'missing_evidence',
          message: `Claimant operations for ${token.ref} were not observed`,
        }),
      );
      return;
    }
    const winner = winners[0];
    if (!winner) {
      mint.attributionResolved = false;
      findings.push(
        failure({
          ...subject,
          amount,
          code: 'claim_unmet',
          message: `${token.ref} was spent but no claimant reports it`,
        }),
      );
      return;
    }
    const viaReclaim = winner.operationId === token.send.operationId;
    const fate = token.expectedFate;
    const allowed =
      (fate.kind === 'reclaimed' && viaReclaim) ||
      (fate.kind === 'received' && !viaReclaim && winner.wallet === fate.recipient) ||
      (fate.kind === 'raced' && (viaReclaim || winner.wallet === fate.recipient));
    if (!allowed) {
      findings.push(
        failure({
          ...subject,
          wallet: winner.wallet,
          operationId: winner.operationId,
          code: 'unexpected_claim',
          message: `${winner.wallet} claimed ${token.ref}, which was expected ${fate.kind}`,
        }),
      );
    }
    if (fee === undefined) mint.attributionResolved = false;
    else mint.adjust(mint.expected, winner.wallet, amount - fee);
  }

  // Spent non-token inputs, grouped by the swap that consumed them, so each pays one rounded fee.
  const swapInputs = new Map<
    string,
    { wallet: string; mint: string; inputs: Map<string, ObservedProof> }
  >();
  const holdings: Record<string, number> = {};

  for (const wallet of evidence.wallets) {
    holdings[wallet.wallet] = 0;
    const walletResolved = new Map<string, boolean>();
    for (const proof of wallet.storedProofs) {
      const key = proofKey(proof);
      if (tokenProofs.has(key)) continue;
      const mint = account(proof.mint);
      const subject = { wallet: wallet.wallet, mint: proof.mint };
      if (proof.mintState === undefined || proof.mintState === 'PENDING') {
        walletResolved.set(proof.mint, false);
        markUnresolved(proof.mint, {
          ...subject,
          code: proof.mintState === undefined ? 'missing_evidence' : 'pending_proof',
          message:
            proof.mintState === undefined
              ? 'Stored proof has no mint state'
              : 'Stored proof is mint-pending',
        });
      } else if (proof.mintState === 'UNSPENT' && proof.storeState === 'spent') {
        mint.adjust(mint.stranded, wallet.wallet, proof.amount);
        if (!mint.strandedProofs.has(key)) {
          mint.strandedProofs.set(key, proof.amount);
          findings.push(
            failure({
              ...subject,
              code: 'stranded_value',
              amount: proof.amount,
              message: 'Mint-unspent proof is locally marked spent',
            }),
          );
        }
      } else if (proof.mintState === 'UNSPENT') {
        mint.adjust(mint.held, wallet.wallet, proof.amount);
        holdings[wallet.wallet]! += proof.amount;
        if (mint.heldProofs.has(key)) {
          findings.push(
            failure({
              ...subject,
              code: 'duplicate_claim',
              amount: proof.amount,
              message: 'One proof is held by more than one Wallet',
            }),
          );
        } else {
          mint.heldProofs.set(key, proof.amount);
        }
      } else if (proof.storeState === 'ready') {
        findings.push(
          failure({
            ...subject,
            code: 'spent_proof_held',
            amount: proof.amount,
            message: 'A proof the mint reports spent is stored as ready',
          }),
        );
      } else if (proof.usedByOperationId === undefined) {
        // Fees round once per swap, so guessing a grouping could invent or hide a deficit.
        markUnresolved(proof.mint, {
          ...subject,
          code: 'missing_evidence',
          message: 'A spent input cannot be attributed to the swap that consumed it',
        });
      } else {
        const swap = `${wallet.wallet}|${proof.mint}|${proof.usedByOperationId}`;
        const group = swapInputs.get(swap) ?? {
          wallet: wallet.wallet,
          mint: proof.mint,
          inputs: new Map<string, ObservedProof>(),
        };
        group.inputs.set(key, proof);
        swapInputs.set(swap, group);
      }
    }

    // Every Wallet trusts every mint of the world, so each displayed balance must be observed.
    for (const mintName of mintNames) {
      if (walletResolved.get(mintName) === false) continue;
      const held = account(mintName).held.get(wallet.wallet) ?? 0;
      const balance = wallet.publicBalances[mintName];
      const subject = { wallet: wallet.wallet, mint: mintName };
      if (balance === undefined) {
        findings.push(
          unresolved({
            ...subject,
            code: 'missing_evidence',
            message: 'Public balance was not observed',
          }),
        );
      } else if (balance !== held) {
        findings.push(
          failure({
            ...subject,
            code: 'balance_mismatch',
            amount: Math.abs(balance - held),
            message: `Displayed balance ${balance} differs from mint-verified ${held}`,
          }),
        );
      }
    }
  }

  for (const group of swapInputs.values()) {
    const mint = account(group.mint);
    const fee = swapFee(group.mint, [...group.inputs.values()], `a ${group.wallet} swap`);
    if (fee === undefined) {
      mint.attributionResolved = false;
      continue;
    }
    mint.fees += fee;
    mint.adjust(mint.expected, group.wallet, -fee);
  }

  const mintLedgers: Record<string, ValueLedger> = {};
  for (const [mintName, mint] of accounts) {
    const held = sum([...mint.heldProofs.values()].map((amount) => ({ amount })));
    const stranded = sum([...mint.strandedProofs.values()].map((amount) => ({ amount })));
    let unexplained: number | null = null;
    if (mint.valueResolved) {
      unexplained = mint.funded - held - mint.outstanding - stranded - mint.fees;
      if (unexplained !== 0) {
        findings.push(
          failure({
            mint: mintName,
            code: unexplained > 0 ? 'value_deficit' : 'value_surplus',
            amount: Math.abs(unexplained),
            message:
              unexplained > 0
                ? `${unexplained} funded value is unaccounted for at ${mintName}`
                : `${-unexplained} more value exists at ${mintName} than was funded`,
          }),
        );
      }
    }
    mintLedgers[mintName] = {
      funded: mint.funded,
      held,
      outstanding: mint.outstanding,
      stranded,
      fees: mint.fees,
      unexplained,
    };
  }

  // Per-Wallet attribution catches value conserved overall but credited to the wrong Wallet.
  const walletLedgers: Record<string, Record<string, WalletMintLedger>> = {};
  const walletNames = [
    ...new Set([
      ...evidence.wallets.map((wallet) => wallet.wallet),
      ...[...accounts.values()].flatMap((mint) => [...mint.expected.keys()]),
    ]),
  ];
  for (const wallet of walletNames) {
    walletLedgers[wallet] = {};
    for (const [mintName, mint] of accounts) {
      const resolved = mint.valueResolved && mint.attributionResolved;
      const held = mint.held.get(wallet) ?? 0;
      const stranded = mint.stranded.get(wallet) ?? 0;
      const expected = resolved ? (mint.expected.get(wallet) ?? 0) : null;
      if (expected === null && held === 0 && stranded === 0 && !mint.expected.has(wallet)) continue;
      walletLedgers[wallet][mintName] = { expected, held, stranded };
      if (expected !== null && expected !== held + stranded) {
        findings.push(
          failure({
            wallet,
            mint: mintName,
            code: 'wallet_value_mismatch',
            amount: Math.abs(expected - held - stranded),
            message: `${wallet} holds ${held + stranded} at ${mintName}, attributed ${expected}`,
          }),
        );
      }
    }
  }

  for (const outcome of evidence.requiredOutcomes) {
    const subject = { wallet: outcome.wallet, operationId: outcome.operationId };
    if (
      outcome.observedState === undefined ||
      !outcome.expectedStates.includes(outcome.observedState)
    ) {
      findings.push(
        failure({
          ...subject,
          code: 'outcome_unmet',
          message:
            `${outcome.kind} is ${outcome.observedState ?? 'unobserved'}, expected ` +
            outcome.expectedStates.join(' or '),
        }),
      );
    }
    if (outcome.historyEntries === undefined) {
      findings.push(
        unresolved({ ...subject, code: 'missing_evidence', message: 'History was not observed' }),
      );
    } else if (outcome.historyEntries > 1) {
      findings.push(
        failure({
          ...subject,
          code: 'duplicate_history',
          message: `${outcome.historyEntries} history entries for one operation`,
        }),
      );
    }
  }

  const totals = Object.values(mintLedgers);
  const total = (field: Exclude<keyof ValueLedger, 'unexplained'>) =>
    totals.reduce((value, ledger) => value + ledger[field], 0);
  const status = findings.some((finding) => finding.severity === 'failure')
    ? 'wallet_failure'
    : findings.length > 0
      ? 'unresolved'
      : 'pass';
  return {
    status,
    findings,
    ledger: {
      funded: total('funded'),
      held: total('held'),
      holdings,
      outstanding: total('outstanding'),
      stranded: total('stranded'),
      fees: total('fees'),
      unexplained: totals.some((ledger) => ledger.unexplained === null)
        ? null
        : totals.reduce((value, ledger) => value + ledger.unexplained!, 0),
      mints: mintLedgers,
      wallets: walletLedgers,
    },
  };
}
