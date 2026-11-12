import { describe, expect, it } from 'bun:test';
import {
  checkFundAccounting,
  type AccountingEvidence,
  type ObservedProof,
  type StoredProof,
  type TokenAccountingEvidence,
} from '../../fault-simulation/accounting.ts';

// One keyset per mint. Both mints deliberately reuse the keyset ID: IDs are only unique within a
// mint. Mint A charges 100 ppk (1..10 inputs cost 1); mint B charges 1000 ppk (1 per input).
const keysetId = '00aa';
const feePpk = { 'mint-a': { [keysetId]: 100 }, 'mint-b': { [keysetId]: 1000 } };

function proof(
  y: string,
  amount: number,
  mintState: ObservedProof['mintState'],
  mint = 'mint-a',
): ObservedProof {
  return { mint, y, amount, keysetId, mintState };
}

function stored(
  y: string,
  amount: number,
  mintState: StoredProof['mintState'],
  storeState: StoredProof['storeState'],
  usedByOperationId?: string,
  mint = 'mint-a',
): StoredProof {
  return { ...proof(y, amount, mintState, mint), storeState, usedByOperationId };
}

/**
 * Alice funds 64, swaps her 64 proof (fee 1) into a 32 token plus 31 change, and Bob receives the
 * token (fee 1) into 31. Mint states are the independent evidence for every claim.
 */
function completedTransfer(): AccountingEvidence {
  return {
    unit: 'sat',
    mints: ['mint-a'],
    keysetFeePpk: feePpk,
    funding: [{ wallet: 'alice', mint: 'mint-a', amount: 64 }],
    wallets: [
      {
        wallet: 'alice',
        storedProofs: [
          stored('a-funded', 64, 'SPENT', 'spent', 'send-1'),
          stored('t-32', 32, 'SPENT', 'inflight', 'send-1'),
          stored('a-change-16', 16, 'UNSPENT', 'ready'),
          stored('a-change-15', 15, 'UNSPENT', 'ready'),
        ],
        publicBalances: { 'mint-a': 31 },
      },
      {
        wallet: 'bob',
        storedProofs: [
          stored('b-16', 16, 'UNSPENT', 'ready'),
          stored('b-15', 15, 'UNSPENT', 'ready'),
        ],
        publicBalances: { 'mint-a': 31 },
      },
    ],
    tokens: [
      {
        ref: 'token-1',
        mint: 'mint-a',
        sender: 'alice',
        inputs: [proof('t-32', 32, 'SPENT')],
        expectedFate: { kind: 'received', recipient: 'bob' },
        send: { wallet: 'alice', operationId: 'send-1', state: 'finalized' },
        receives: [{ wallet: 'bob', operationId: 'receive-1', state: 'finalized' }],
      },
    ],
    requiredOutcomes: [
      {
        wallet: 'bob',
        operationId: 'receive-1',
        kind: 'receive',
        expectedStates: ['finalized'],
        observedState: 'finalized',
        historyEntries: 1,
      },
    ],
  };
}

const token = (evidence: AccountingEvidence, index = 0) => evidence.tokens[index]!;

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

  it('passes a completed transfer whose value, fees and outcome are all corroborated', () => {
    const verdict = checkFundAccounting(completedTransfer());

    expect(verdict.findings).toEqual([]);
    expect(verdict.status).toBe('pass');
    expect(verdict.ledger).toEqual({
      funded: 64,
      held: 62,
      holdings: { alice: 31, bob: 31 },
      outstanding: 0,
      stranded: 0,
      fees: 2,
      unexplained: 0,
      mints: {
        'mint-a': { funded: 64, held: 62, outstanding: 0, stranded: 0, fees: 2, unexplained: 0 },
      },
      wallets: {
        alice: { 'mint-a': { expected: 31, held: 31, stranded: 0 } },
        bob: { 'mint-a': { expected: 31, held: 31, stranded: 0 } },
      },
    });
  });

  it('accounts for an undelivered token as outstanding value rather than a deficit', () => {
    const evidence = completedTransfer();
    evidence.tokens[0] = {
      ...token(evidence),
      inputs: [proof('t-32', 32, 'UNSPENT')],
      expectedFate: { kind: 'outstanding' },
      send: { wallet: 'alice', operationId: 'send-1', state: 'pending' },
      receives: [],
    };
    evidence.wallets[0]!.storedProofs[1] = stored('t-32', 32, 'UNSPENT', 'inflight', 'send-1');
    evidence.wallets[1] = { wallet: 'bob', storedProofs: [], publicBalances: { 'mint-a': 0 } };
    evidence.requiredOutcomes = [];

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('pass');
    expect(verdict.ledger).toMatchObject({ outstanding: 32, fees: 1, unexplained: 0 });
  });

  it('fails with a deficit when a claimed token never reaches the recipient', () => {
    const evidence = completedTransfer();
    evidence.wallets[1] = { wallet: 'bob', storedProofs: [], publicBalances: {} };

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.ledger.unexplained).toBe(31);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'value_deficit', mint: 'mint-a', amount: 31 }),
    );
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'wallet_value_mismatch', wallet: 'bob', amount: 31 }),
    );
  });

  it('fails with a surplus when value is credited twice', () => {
    const evidence = completedTransfer();
    evidence.wallets[1]!.storedProofs.push(stored('b-dup-31', 31, 'UNSPENT', 'ready'));
    evidence.wallets[1]!.publicBalances['mint-a'] = 62;

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'value_surplus', amount: 31 }),
    );
  });

  it('counts one economic claim once and fails when two wallets hold the same proof', () => {
    const evidence = completedTransfer();
    evidence.wallets[0]!.storedProofs.push(stored('b-16', 16, 'UNSPENT', 'ready'));
    evidence.wallets[0]!.publicBalances['mint-a'] = 47;

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
    evidence.wallets[1]!.publicBalances['mint-a'] = 40;

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'balance_mismatch', wallet: 'bob', amount: 9 }),
    );
  });

  it('fails when mint-unspent value is locally marked spent and therefore stranded', () => {
    const evidence = completedTransfer();
    evidence.wallets[1]!.storedProofs[1] = stored('b-15', 15, 'UNSPENT', 'spent');
    evidence.wallets[1]!.publicBalances['mint-a'] = 16;

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.ledger).toMatchObject({ stranded: 15, unexplained: 0 });
    expect(verdict.ledger.wallets.bob!['mint-a']).toEqual({ expected: 31, held: 16, stranded: 15 });
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'stranded_value', wallet: 'bob', amount: 15 }),
    );
  });

  it('fails when a Wallet presents a proof the mint reports spent as ready', () => {
    const evidence = completedTransfer();
    evidence.wallets[1]!.storedProofs[1] = stored('b-15', 15, 'SPENT', 'ready');
    evidence.wallets[1]!.publicBalances['mint-a'] = 31;

    expect(checkFundAccounting(evidence).findings).toContainEqual(
      expect.objectContaining({ code: 'spent_proof_held', wallet: 'bob', amount: 15 }),
    );
  });

  it('derives fees from the mint keyset rate rather than accepting any shortfall', () => {
    const evidence = completedTransfer();
    // A 2 sat shortfall on Alice's change is not explained by a 1 sat legitimate fee.
    evidence.wallets[0]!.storedProofs[3] = stored('a-change-13', 13, 'UNSPENT', 'ready');
    evidence.wallets[0]!.publicBalances['mint-a'] = 29;

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
    token(evidence).inputs[0] = proof('t-32', 32, 'PENDING');
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
    evidence.wallets[1] = { wallet: 'bob', storedProofs: [], publicBalances: {} };
    evidence.requiredOutcomes[0]!.observedState = 'executing';
    evidence.requiredOutcomes[0]!.historyEntries = undefined;
    token(evidence).receives[0]!.state = 'executing';

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['value_deficit', 'outcome_unmet', 'claim_unmet', 'missing_evidence']),
    );
  });
});

/**
 * A race at mint A: Alice's 20 token (one input) is claimed either by Carol's Receive or by
 * Alice's reclaim. Fee 1 either way. Alice's 64 funding was swapped (fee 1) into the token and 43.
 */
function race(winner: 'carol' | 'alice'): AccountingEvidence {
  const carolWins = winner === 'carol';
  return {
    unit: 'sat',
    mints: ['mint-a'],
    keysetFeePpk: feePpk,
    funding: [{ wallet: 'alice', mint: 'mint-a', amount: 64 }],
    wallets: [
      {
        wallet: 'alice',
        storedProofs: [
          stored('a-funded', 64, 'SPENT', 'spent', 'send-1'),
          stored('t-20', 20, 'SPENT', 'spent', 'send-1'),
          stored('a-43', 43, 'UNSPENT', 'ready'),
          ...(carolWins ? [] : [stored('a-reclaimed-19', 19, 'UNSPENT', 'ready')]),
        ],
        publicBalances: { 'mint-a': carolWins ? 43 : 62 },
      },
      {
        wallet: 'carol',
        storedProofs: carolWins ? [stored('c-19', 19, 'UNSPENT', 'ready')] : [],
        publicBalances: { 'mint-a': carolWins ? 19 : 0 },
      },
    ],
    tokens: [
      {
        ref: 'token-1',
        mint: 'mint-a',
        sender: 'alice',
        inputs: [proof('t-20', 20, 'SPENT')],
        expectedFate: { kind: 'raced', recipient: 'carol' },
        send: {
          wallet: 'alice',
          operationId: 'send-1',
          state: carolWins ? 'finalized' : 'rolled_back',
        },
        receives: [
          {
            wallet: 'carol',
            operationId: 'receive-1',
            state: carolWins ? 'finalized' : 'rolled_back',
          },
        ],
      },
    ],
    requiredOutcomes: [],
  };
}

describe('checkFundAccounting claim attribution', () => {
  it('accepts either supported winner of a receive-versus-reclaim race, with its fee', () => {
    for (const winner of ['carol', 'alice'] as const) {
      const verdict = checkFundAccounting(race(winner));

      expect({ winner, findings: verdict.findings }).toEqual({ winner, findings: [] });
      expect(verdict.ledger).toMatchObject({ fees: 2, unexplained: 0 });
    }
  });

  it('fails when both claimants of a race report success', () => {
    const evidence = race('carol');
    token(evidence).send.state = 'rolled_back';

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('wallet_failure');
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'duplicate_outcome', token: 'token-1' }),
    );
  });

  it('fails when a token was spent but no claimant reports it', () => {
    const evidence = race('carol');
    token(evidence).receives[0]!.state = 'rolled_back';

    expect(checkFundAccounting(evidence).findings).toContainEqual(
      expect.objectContaining({ code: 'claim_unmet', token: 'token-1' }),
    );
  });

  it('fails when a duplicate delivery is reported as a second successful Receive', () => {
    const evidence = completedTransfer();
    token(evidence).receives.push({ wallet: 'bob', operationId: 'receive-2', state: 'finalized' });

    expect(checkFundAccounting(evidence).findings).toContainEqual(
      expect.objectContaining({ code: 'duplicate_outcome', token: 'token-1' }),
    );
  });

  it('fails when the winning claimant is not one the plan allows', () => {
    const evidence = race('alice');
    token(evidence).expectedFate = { kind: 'received', recipient: 'carol' };

    expect(checkFundAccounting(evidence).findings).toContainEqual(
      expect.objectContaining({ code: 'unexpected_claim', token: 'token-1', wallet: 'alice' }),
    );
  });

  it('fails when an undelivered token is spent', () => {
    const evidence = race('alice');
    token(evidence).expectedFate = { kind: 'outstanding' };

    expect(checkFundAccounting(evidence).findings).toContainEqual(
      expect.objectContaining({ code: 'unexpected_claim', token: 'token-1' }),
    );
  });

  it('fails when a claimant reports success while the mint still reports the token unspent', () => {
    const evidence = completedTransfer();
    token(evidence).inputs[0] = proof('t-32', 32, 'UNSPENT');
    evidence.wallets[0]!.storedProofs[1] = stored('t-32', 32, 'UNSPENT', 'inflight', 'send-1');

    const findings = checkFundAccounting(evidence).findings.map((finding) => finding.code);

    expect(findings).toContain('unsupported_claim');
    expect(findings).toContain('claim_unmet');
  });

  it('attributes value per Wallet so a claim credited to the wrong Wallet fails', () => {
    // Value conserved globally, but Carol holds the outputs while the reclaim is reported won.
    const evidence = race('carol');
    token(evidence).send.state = 'rolled_back';
    token(evidence).receives[0]!.state = 'rolled_back';

    const verdict = checkFundAccounting(evidence);

    expect(verdict.ledger.unexplained).toBe(0);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'wallet_value_mismatch', wallet: 'carol', amount: 19 }),
    );
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ code: 'wallet_value_mismatch', wallet: 'alice', amount: 19 }),
    );
  });

  it('leaves attribution unresolved while a claimant operation is unobserved', () => {
    const evidence = race('carol');
    token(evidence).receives[0]!.state = undefined;

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('unresolved');
    expect(verdict.ledger.wallets.alice!['mint-a']!.expected).toBeNull();
  });
});

describe('checkFundAccounting across mints and long sequences', () => {
  /** Alice funds 32 at each mint and sends a 10 token at each; Bob receives both. */
  function twoMintTransfers(): AccountingEvidence {
    const tokenAt = (mint: string, ref: string, op: string): TokenAccountingEvidence => ({
      ref,
      mint,
      sender: 'alice',
      // Same Y at both mints: identities are only unique within a mint.
      inputs: [proof('t-8', 8, 'SPENT', mint), proof('t-2', 2, 'SPENT', mint)],
      expectedFate: { kind: 'received', recipient: 'bob' },
      send: { wallet: 'alice', operationId: op, state: 'finalized' },
      receives: [{ wallet: 'bob', operationId: `${op}-receive`, state: 'finalized' }],
    });
    return {
      unit: 'sat',
      mints: ['mint-a', 'mint-b'],
      keysetFeePpk: feePpk,
      funding: [
        { wallet: 'alice', mint: 'mint-a', amount: 32 },
        { wallet: 'alice', mint: 'mint-b', amount: 32 },
      ],
      wallets: [
        {
          wallet: 'alice',
          storedProofs: ['mint-a', 'mint-b'].flatMap((mint) => [
            // The same operation ID at both mints must still form two separate swaps.
            stored('a-32', 32, 'SPENT', 'spent', 'op-1', mint),
            stored('t-8', 8, 'SPENT', 'spent', 'op-1', mint),
            stored('t-2', 2, 'SPENT', 'spent', 'op-1', mint),
          ]),
          publicBalances: { 'mint-a': 21, 'mint-b': 21 },
        },
        {
          wallet: 'bob',
          storedProofs: [
            // Mint A: 10 - 1 fee. Mint B: 10 - 2 fee (1000 ppk per input).
            stored('b-9', 9, 'UNSPENT', 'ready', undefined, 'mint-a'),
            stored('b-8', 8, 'UNSPENT', 'ready', undefined, 'mint-b'),
          ],
          publicBalances: { 'mint-a': 9, 'mint-b': 8 },
        },
      ],
      tokens: [tokenAt('mint-a', 'token-a', 'op-1'), tokenAt('mint-b', 'token-b', 'op-1')],
      requiredOutcomes: [],
    };
  }

  it('scopes proof identities, keyset fee rates and operations by mint', () => {
    const evidence = twoMintTransfers();
    // Alice's change: 32 - 10 - fee (1 at A, 1 at B for one input).
    evidence.wallets[0]!.storedProofs.push(
      stored('a-21', 21, 'UNSPENT', 'ready', undefined, 'mint-a'),
      stored('a-21', 21, 'UNSPENT', 'ready', undefined, 'mint-b'),
    );

    const verdict = checkFundAccounting(evidence);

    expect(verdict.findings).toEqual([]);
    expect(verdict.ledger.mints).toEqual({
      'mint-a': { funded: 32, held: 30, outstanding: 0, stranded: 0, fees: 2, unexplained: 0 },
      'mint-b': { funded: 32, held: 29, outstanding: 0, stranded: 0, fees: 3, unexplained: 0 },
    });
    expect(verdict.ledger.holdings).toEqual({ alice: 42, bob: 17 });
  });

  it('does not let a token at one mint hide a held proof with the same Y at another mint', () => {
    const evidence = twoMintTransfers();
    evidence.wallets[0]!.storedProofs.push(
      stored('a-21', 21, 'UNSPENT', 'ready', undefined, 'mint-a'),
      stored('a-21', 21, 'UNSPENT', 'ready', undefined, 'mint-b'),
    );
    // Bob's mint B holding shares its Y with a token input at mint A only.
    evidence.wallets[1]!.storedProofs[1] = stored(
      't-mint-a-only',
      8,
      'UNSPENT',
      'ready',
      undefined,
      'mint-b',
    );
    token(evidence, 0).inputs[0] = proof('t-mint-a-only', 8, 'SPENT', 'mint-a');
    evidence.wallets[0]!.storedProofs[1] = stored(
      't-mint-a-only',
      8,
      'SPENT',
      'spent',
      'op-1',
      'mint-a',
    );

    const verdict = checkFundAccounting(evidence);

    expect(verdict.findings).toEqual([]);
    expect(verdict.ledger.holdings.bob).toBe(17);
  });

  it('reports a deficit at the mint where value went missing', () => {
    const evidence = twoMintTransfers();
    evidence.wallets[0]!.storedProofs.push(
      stored('a-21', 21, 'UNSPENT', 'ready', undefined, 'mint-a'),
    );
    evidence.wallets[0]!.publicBalances['mint-b'] = 0;

    const deficits = checkFundAccounting(evidence).findings.filter(
      (finding) => finding.code === 'value_deficit',
    );

    expect(deficits).toEqual([expect.objectContaining({ mint: 'mint-b', amount: 21 })]);
  });

  it('rounds the input fee once per swap across a long sequence of swaps', () => {
    // Twelve one-input self swaps at 100 ppk each cost 1 (12 in total), while one swap of eleven
    // inputs costs ceil(1100 / 1000) = 2. Fee rounding is per transaction, not per run.
    const singles = Array.from({ length: 12 }, (_, index) =>
      stored(`s-${index}`, 4, 'SPENT', 'spent', `op-${index}`),
    );
    const batch = Array.from({ length: 11 }, (_, index) =>
      stored(`m-${index}`, 4, 'SPENT', 'spent', 'op-batch'),
    );
    const evidence: AccountingEvidence = {
      unit: 'sat',
      mints: ['mint-a'],
      keysetFeePpk: feePpk,
      funding: [{ wallet: 'alice', mint: 'mint-a', amount: 92 }],
      wallets: [
        {
          wallet: 'alice',
          storedProofs: [...singles, ...batch, stored('kept', 78, 'UNSPENT', 'ready')],
          publicBalances: { 'mint-a': 78 },
        },
      ],
      tokens: [],
      requiredOutcomes: [],
    };

    const verdict = checkFundAccounting(evidence);

    expect(verdict.ledger.fees).toBe(14);
    expect(verdict.findings).toEqual([]);
  });

  it('leaves spent inputs without swap attribution unresolved instead of merging their fees', () => {
    // Two separate one-input swaps cost 1 each. Merging unattributed inputs into one swap would
    // charge ceil(200 / 1000) = 1 and invent a 1 sat deficit, or hide one in other evidence.
    const evidence: AccountingEvidence = {
      unit: 'sat',
      mints: ['mint-a'],
      keysetFeePpk: feePpk,
      funding: [{ wallet: 'alice', mint: 'mint-a', amount: 16 }],
      wallets: [
        {
          wallet: 'alice',
          storedProofs: [
            stored('in-1', 8, 'SPENT', 'spent'),
            stored('in-2', 8, 'SPENT', 'spent'),
            stored('out', 14, 'UNSPENT', 'ready'),
          ],
          publicBalances: { 'mint-a': 14 },
        },
      ],
      tokens: [],
      requiredOutcomes: [],
    };

    const verdict = checkFundAccounting(evidence);

    expect(verdict.status).toBe('unresolved');
    expect(verdict.ledger.unexplained).toBeNull();
    const unattributed = expect.objectContaining({
      code: 'missing_evidence',
      wallet: 'alice',
      mint: 'mint-a',
    });
    expect(verdict.findings).toEqual([unattributed, unattributed]);
  });

  it('keeps swaps of different Wallets apart even when operation IDs collide', () => {
    const evidence: AccountingEvidence = {
      unit: 'sat',
      mints: ['mint-a'],
      keysetFeePpk: feePpk,
      funding: [
        { wallet: 'alice', mint: 'mint-a', amount: 8 },
        { wallet: 'bob', mint: 'mint-a', amount: 8 },
      ],
      wallets: ['alice', 'bob'].map((wallet) => ({
        wallet,
        storedProofs: [
          stored(`${wallet}-in`, 8, 'SPENT', 'spent', 'same-op'),
          stored(`${wallet}-out`, 7, 'UNSPENT', 'ready'),
        ],
        publicBalances: { 'mint-a': 7 },
      })),
      tokens: [],
      requiredOutcomes: [],
    };

    const verdict = checkFundAccounting(evidence);

    expect(verdict.ledger.fees).toBe(2);
    expect(verdict.findings).toEqual([]);
  });
});
