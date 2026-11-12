/**
 * Independent fund accounting for wallet fault simulation.
 *
 * The checker never trusts Coco's displayed balances to define the expected result. Value is
 * classified from mint proof states, token contents and the mint's keyset input fee rate; Coco's
 * public balance is only corroborated against that classification. Missing or ambiguous evidence
 * yields an unresolved verdict, never a pass.
 */

export type MintProofState = 'UNSPENT' | 'PENDING' | 'SPENT';

/** A proof identified by its public `Y` point, with its mint-reported state when observed. */
export interface ObservedProof {
  y: string;
  amount: number;
  keysetId: string;
  mintState: MintProofState | undefined;
}

/** A proof row read from a Wallet's persistent store. */
export interface StoredProof extends ObservedProof {
  storeState: 'ready' | 'inflight' | 'spent';
  usedByOperationId?: string;
}

export interface WalletAccountingEvidence {
  wallet: string;
  storedProofs: StoredProof[];
  /** Coco's displayed total for the unit, or `undefined` when no session was observed. */
  publicBalance: number | undefined;
}

/** A created token, decoded by the harness rather than reported by the sending Wallet. */
export interface TokenAccountingEvidence {
  ref: string;
  sender: string;
  inputs: ObservedProof[];
}

export interface RequiredOperationOutcome {
  wallet: string;
  operationId: string;
  kind: 'receive';
  expectedState: 'finalized';
  observedState: string | undefined;
  historyEntries: number | undefined;
}

export interface AccountingEvidence {
  unit: string;
  keysetFeePpk: Record<string, number>;
  funding: { wallet: string; amount: number }[];
  wallets: WalletAccountingEvidence[];
  tokens: TokenAccountingEvidence[];
  requiredOutcomes: RequiredOperationOutcome[];
}

export type FindingCode =
  | 'value_deficit'
  | 'value_surplus'
  | 'duplicate_claim'
  | 'stranded_value'
  | 'balance_mismatch'
  | 'outcome_unmet'
  | 'duplicate_history'
  | 'missing_evidence'
  | 'pending_proof'
  | 'partially_spent_token';

export interface AccountingFinding {
  code: FindingCode;
  severity: 'failure' | 'unresolved';
  message: string;
  wallet?: string;
  operationId?: string;
  amount?: number;
}

export interface AccountingLedger {
  funded: number;
  /** Mint-unspent value each Wallet holds; a proof held by two Wallets appears under both. */
  holdings: Record<string, number>;
  /** Value of created tokens whose inputs are still unspent. */
  outstanding: number;
  /** Mint-unspent value a Wallet has locally marked spent. */
  stranded: number;
  /** Legitimate input fees derived from the keyset rate and observed spent inputs. */
  fees: number;
  /** Funded value not explained by the categories above; `null` when evidence is incomplete. */
  unexplained: number | null;
}

export interface AccountingVerdict {
  status: 'pass' | 'wallet_failure' | 'unresolved';
  findings: AccountingFinding[];
  ledger: AccountingLedger;
}

const failure = (finding: Omit<AccountingFinding, 'severity'>): AccountingFinding => ({
  ...finding,
  severity: 'failure',
});
const unresolved = (finding: Omit<AccountingFinding, 'severity'>): AccountingFinding => ({
  ...finding,
  severity: 'unresolved',
});

/** NUT-02 input fee for inputs spent together, or `undefined` when a keyset rate is unknown. */
function inputFee(inputs: ObservedProof[], feePpk: Record<string, number>): number | undefined {
  let ppk = 0;
  for (const input of inputs) {
    const rate = feePpk[input.keysetId];
    if (rate === undefined) return undefined;
    ppk += rate;
  }
  return Math.ceil(ppk / 1000);
}

const sum = (proofs: { amount: number }[]) =>
  proofs.reduce((total, proof) => total + proof.amount, 0);

export function checkFundAccounting(evidence: AccountingEvidence): AccountingVerdict {
  const findings: AccountingFinding[] = [];
  let valueResolved = true;
  const markUnresolved = (finding: Omit<AccountingFinding, 'severity'>) => {
    valueResolved = false;
    findings.push(unresolved(finding));
  };

  const funded = sum(evidence.funding);
  let outstanding = 0;
  let fees = 0;
  const addFee = (inputs: ObservedProof[], context: string) => {
    const fee = inputFee(inputs, evidence.keysetFeePpk);
    if (fee === undefined) {
      markUnresolved({ code: 'missing_evidence', message: `No keyset fee rate for ${context}` });
    } else {
      fees += fee;
    }
  };

  // A token's inputs are one economic claim: outstanding while unspent, otherwise consumed by
  // exactly one swap (receive or reclaim) that charges the keyset input fee.
  const tokenYs = new Set<string>();
  for (const token of evidence.tokens) {
    for (const input of token.inputs) tokenYs.add(input.y);
    const states = new Set(token.inputs.map((input) => input.mintState));
    if (states.has(undefined)) {
      markUnresolved({ code: 'missing_evidence', message: `No mint state for ${token.ref}` });
    } else if (states.has('PENDING')) {
      markUnresolved({ code: 'pending_proof', message: `${token.ref} inputs are mint-pending` });
    } else if (states.size === 1 && states.has('UNSPENT')) {
      outstanding += sum(token.inputs);
    } else if (states.size === 1 && states.has('SPENT')) {
      addFee(token.inputs, token.ref);
    } else {
      markUnresolved({
        code: 'partially_spent_token',
        message: `${token.ref} inputs are only partially spent`,
      });
    }
  }

  const holdings: Record<string, number> = {};
  const claimants = new Map<string, { amount: number; wallets: string[] }>();
  const strandedYs = new Map<string, number>();
  // Spent non-token inputs, grouped by the swap that consumed them, so each pays one rounded fee.
  const swapInputs = new Map<string, Map<string, ObservedProof>>();

  for (const wallet of evidence.wallets) {
    let held = 0;
    let walletResolved = true;
    for (const proof of wallet.storedProofs) {
      if (tokenYs.has(proof.y)) continue;
      if (proof.mintState === undefined) {
        walletResolved = false;
        markUnresolved({
          code: 'missing_evidence',
          wallet: wallet.wallet,
          message: 'Stored proof has no mint state',
        });
      } else if (proof.mintState === 'PENDING') {
        walletResolved = false;
        markUnresolved({
          code: 'pending_proof',
          wallet: wallet.wallet,
          message: 'Stored proof is mint-pending',
        });
      } else if (proof.mintState === 'UNSPENT' && proof.storeState === 'spent') {
        if (!strandedYs.has(proof.y)) {
          strandedYs.set(proof.y, proof.amount);
          findings.push(
            failure({
              code: 'stranded_value',
              wallet: wallet.wallet,
              amount: proof.amount,
              message: 'Mint-unspent proof is locally marked spent',
            }),
          );
        }
      } else if (proof.mintState === 'UNSPENT') {
        held += proof.amount;
        const claim = claimants.get(proof.y) ?? { amount: proof.amount, wallets: [] };
        claim.wallets.push(wallet.wallet);
        claimants.set(proof.y, claim);
      } else {
        const swap = proof.usedByOperationId ?? `${wallet.wallet}:unknown`;
        const inputs = swapInputs.get(swap) ?? new Map<string, ObservedProof>();
        inputs.set(proof.y, proof);
        swapInputs.set(swap, inputs);
      }
    }
    holdings[wallet.wallet] = held;
    if (!walletResolved) continue;
    if (wallet.publicBalance === undefined) {
      findings.push(
        unresolved({
          code: 'missing_evidence',
          wallet: wallet.wallet,
          message: 'Public balance was not observed',
        }),
      );
    } else if (wallet.publicBalance !== held) {
      findings.push(
        failure({
          code: 'balance_mismatch',
          wallet: wallet.wallet,
          amount: Math.abs(wallet.publicBalance - held),
          message: `Displayed balance ${wallet.publicBalance} differs from mint-verified ${held}`,
        }),
      );
    }
  }

  for (const claim of claimants.values()) {
    if (claim.wallets.length > 1) {
      findings.push(
        failure({
          code: 'duplicate_claim',
          amount: claim.amount,
          message: `One proof is held by ${claim.wallets.join(', ')}`,
        }),
      );
    }
  }
  for (const [swap, inputs] of swapInputs) addFee([...inputs.values()], `swap ${swap}`);

  const stranded = sum([...strandedYs.values()].map((amount) => ({ amount })));
  let unexplained: number | null = null;
  if (valueResolved) {
    const held = sum([...claimants.values()]);
    unexplained = funded - held - outstanding - stranded - fees;
    if (unexplained > 0) {
      findings.push(
        failure({
          code: 'value_deficit',
          amount: unexplained,
          message: `${unexplained} funded value is unaccounted for`,
        }),
      );
    } else if (unexplained < 0) {
      findings.push(
        failure({
          code: 'value_surplus',
          amount: -unexplained,
          message: `${-unexplained} more value exists than was funded`,
        }),
      );
    }
  }

  for (const outcome of evidence.requiredOutcomes) {
    const subject = { wallet: outcome.wallet, operationId: outcome.operationId };
    if (outcome.observedState !== outcome.expectedState) {
      findings.push(
        failure({
          ...subject,
          code: 'outcome_unmet',
          message: `${outcome.kind} is ${outcome.observedState ?? 'unobserved'}, expected ${outcome.expectedState}`,
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

  const status = findings.some((finding) => finding.severity === 'failure')
    ? 'wallet_failure'
    : findings.length > 0
      ? 'unresolved'
      : 'pass';
  return {
    status,
    findings,
    ledger: { funded, holdings, outstanding, stranded, fees, unexplained },
  };
}
