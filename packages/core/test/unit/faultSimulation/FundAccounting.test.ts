import { describe, expect, it } from 'bun:test';
import {
  checkFundAccounting,
  type AccountingEvidence,
  type StoredProof,
} from '../../fault-simulation/accounting.ts';

// One keyset charging 100 ppk: any swap of 1..10 inputs costs exactly 1.
const keysetId = '00aa';
const feePpk = { [keysetId]: 100 };

function proof(y: string, amount: number, mintState: StoredProof['mintState']) {
  return { y, amount, keysetId, mintState };
}

function stored(
  y: string,
  amount: number,
  mintState: StoredProof['mintState'],
  storeState: StoredProof['storeState'],
  usedByOperationId?: string,
): StoredProof {
  return { ...proof(y, amount, mintState), storeState, usedByOperationId };
}

/**
 * Alice funds 64, swaps her 64 proof (fee 1) into a 32 token plus 31 change, and Bob receives the
 * token (fee 1) into 31. Mint states are the independent evidence for every claim.
 */
function completedTransfer(): AccountingEvidence {
  return {
    unit: 'sat',
    keysetFeePpk: feePpk,
    funding: [{ wallet: 'alice', amount: 64 }],
    wallets: [
      {
        wallet: 'alice',
        storedProofs: [
          stored('a-funded', 64, 'SPENT', 'spent', 'send-1'),
          stored('t-32', 32, 'SPENT', 'inflight', 'send-1'),
          stored('a-change-16', 16, 'UNSPENT', 'ready'),
          stored('a-change-15', 15, 'UNSPENT', 'ready'),
        ],
        publicBalance: 31,
      },
      {
        wallet: 'bob',
        storedProofs: [
          stored('b-16', 16, 'UNSPENT', 'ready'),
          stored('b-15', 15, 'UNSPENT', 'ready'),
        ],
        publicBalance: 31,
      },
    ],
    tokens: [{ ref: 'token-1', sender: 'alice', inputs: [proof('t-32', 32, 'SPENT')] }],
    requiredOutcomes: [
      {
        wallet: 'bob',
        operationId: 'receive-1',
        kind: 'receive',
        expectedState: 'finalized',
        observedState: 'finalized',
        historyEntries: 1,
      },
    ],
  };
}

describe('checkFundAccounting', () => {
  it('fails recovered funds that remain reserved despite finalized operations and matching total balances', () => {
    const evidence = completedTransfer();
    for (const proof of evidence.wallets[1]!.storedProofs) {
      proof.reservedByOperationId = 'receive-1';
    }
    const verdict = checkFundAccounting(evidence);
    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.ledger.stranded).toBe(31);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'stranded_value', wallet: 'bob' }),
    );
  });

  it('retains a missed recovery deadline even when a later observation is finalized', () => {
    const evidence = completedTransfer();
    evidence.requiredOutcomes[0]!.missedDeadline = true;
    const verdict = checkFundAccounting(evidence);
    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'outcome_unmet', wallet: 'bob' }),
    );
  });

  it('leaves released spent inputs without a proven swap boundary unresolved', () => {
    const evidence = completedTransfer();
    delete evidence.wallets[0]!.storedProofs[0]!.usedByOperationId;
    const verdict = checkFundAccounting(evidence);
    expect(verdict.status).toBe('unresolved');
    expect(verdict.findings).toContainEqual(expect.objectContaining({ code: 'missing_evidence' }));
  });

  it('passes a completed transfer whose value, fees and outcome are all corroborated', () => {
    const verdict = checkFundAccounting(completedTransfer());

    expect(verdict.findings).toEqual([]);
    expect(verdict.status).toBe('pass');
    expect(verdict.ledger).toEqual({
      funded: 64,
      holdings: { alice: 31, bob: 31 },
      outstanding: 0,
      stranded: 0,
      fees: 2,
      unexplained: 0,
    });
  });

  it('accounts for an undelivered token as outstanding value rather than a deficit', () => {
    const evidence = completedTransfer();
    evidence.tokens = [{ ref: 'token-1', sender: 'alice', inputs: [proof('t-32', 32, 'UNSPENT')] }];
    evidence.wallets[0]!.storedProofs[1] = stored('t-32', 32, 'UNSPENT', 'inflight', 'send-1');
    evidence.wallets[1] = { wallet: 'bob', storedProofs: [], publicBalance: 0 };
    evidence.requiredOutcomes = [];

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('pass');
    expect(verdict.ledger).toMatchObject({ outstanding: 32, fees: 1, unexplained: 0 });
  });

  it('fails with a deficit when a claimed token never reaches the recipient', () => {
    const evidence = completedTransfer();
    evidence.wallets[1] = { wallet: 'bob', storedProofs: [], publicBalance: undefined };

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.ledger.unexplained).toBe(31);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'value_deficit', amount: 31 }),
    );
  });

  it('fails with a surplus when value is credited twice', () => {
    const evidence = completedTransfer();
    evidence.wallets[1]!.storedProofs.push(stored('b-dup-31', 31, 'UNSPENT', 'ready'));
    evidence.wallets[1]!.publicBalance = 62;

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'value_surplus', amount: 31 }),
    );
  });

  it('counts one economic claim once and fails when two wallets hold the same proof', () => {
    const evidence = completedTransfer();
    evidence.wallets[0]!.storedProofs.push(stored('b-16', 16, 'UNSPENT', 'ready'));
    evidence.wallets[0]!.publicBalance = 47;

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.ledger.unexplained).toBe(0);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'duplicate_claim', amount: 16 }),
    );
  });

  it('fails when a required operation outcome was not reached', () => {
    const evidence = completedTransfer();
    evidence.requiredOutcomes[0]!.observedState = 'executing';

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'outcome_unmet', wallet: 'bob', operationId: 'receive-1' }),
    );
  });

  it('fails when an operation outcome is recorded more than once in history', () => {
    const evidence = completedTransfer();
    evidence.requiredOutcomes[0]!.historyEntries = 2;

    expect(checkFundAccounting(evidence).findings).toContainEqual(
      expect.objectContaining({ code: 'duplicate_history', operationId: 'receive-1' }),
    );
  });

  it('fails when the displayed balance disagrees with mint-verified holdings', () => {
    const evidence = completedTransfer();
    evidence.wallets[1]!.publicBalance = 40;

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'balance_mismatch', wallet: 'bob', amount: 9 }),
    );
  });

  it('fails when mint-unspent value is locally marked spent and therefore stranded', () => {
    const evidence = completedTransfer();
    evidence.wallets[1]!.storedProofs[1] = stored('b-15', 15, 'UNSPENT', 'spent');
    evidence.wallets[1]!.publicBalance = 16;

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.ledger).toMatchObject({ stranded: 15, unexplained: 0 });
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'stranded_value', wallet: 'bob', amount: 15 }),
    );
  });

  it('derives fees from the mint keyset rate rather than accepting any shortfall', () => {
    const evidence = completedTransfer();
    // A 2 sat shortfall on Alice's change is not explained by a 1 sat legitimate fee.
    evidence.wallets[0]!.storedProofs[3] = stored('a-change-13', 13, 'UNSPENT', 'ready');
    evidence.wallets[0]!.publicBalance = 29;

    const verdict = checkFundAccounting(evidence);

    expect(verdict.ledger.fees).toBe(2);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'value_deficit', amount: 2 }),
    );
  });

  it('leaves missing mint evidence unresolved instead of passing or inventing a deficit', () => {
    const evidence = completedTransfer();
    evidence.wallets[1]!.storedProofs[0] = stored('b-16', 16, undefined, 'ready');

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('unresolved');
    expect(verdict.findings).toEqual([
      expect.objectContaining({ code: 'missing_evidence', wallet: 'bob' }),
    ]);
  });

  it('leaves mint-pending proofs unresolved', () => {
    const evidence = completedTransfer();
    evidence.tokens[0]!.inputs[0] = proof('t-32', 32, 'PENDING');
    evidence.wallets[0]!.storedProofs[1] = stored('t-32', 32, 'PENDING', 'inflight', 'send-1');

    expect(checkFundAccounting(evidence).status).toBe('unresolved');
  });

  it('leaves an unknown keyset fee unresolved', () => {
    const evidence = completedTransfer();
    evidence.keysetFeePpk = {};

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('unresolved');
    expect(verdict.findings).toContainEqual(expect.objectContaining({ code: 'missing_evidence' }));
  });

  it('keeps a wallet failure ahead of unrelated unresolved observations', () => {
    const evidence = completedTransfer();
    evidence.wallets[1] = { wallet: 'bob', storedProofs: [], publicBalance: undefined };
    evidence.requiredOutcomes[0]!.observedState = 'executing';
    evidence.requiredOutcomes[0]!.historyEntries = undefined;

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['value_deficit', 'outcome_unmet', 'missing_evidence']),
    );
  });
});
