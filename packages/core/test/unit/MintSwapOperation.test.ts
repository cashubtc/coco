import { describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';

import {
  assertMintSwapTransition,
  createMintSwapPreparedPlanFingerprint,
  validateMintSwapAccounting,
  validateMintSwapOperation,
  type MintSwapOperationState,
} from '../../operations/mintSwap/MintSwapOperation';
import { makePreparedMintSwapOperation, MINT_SWAP_TEST_NOW as now } from '../fixtures/MintSwap';

describe('MintSwapOperation', () => {
  it('accepts the normative transition graph and rejects terminal regression', () => {
    const legal: Array<[MintSwapOperationState, MintSwapOperationState]> = [
      ['preparing', 'prepared'],
      ['prepared', 'source_inflight'],
      ['source_inflight', 'destination_funded'],
      ['destination_funded', 'issuing'],
      ['issuing', 'completed'],
      ['source_inflight', 'needs_attention'],
      ['needs_attention', 'issuing'],
    ];
    for (const [from, to] of legal) expect(() => assertMintSwapTransition(from, to)).not.toThrow();

    expect(() => assertMintSwapTransition('completed', 'issuing')).toThrow('Illegal');
    expect(() => assertMintSwapTransition('destination_funded', 'failed')).toThrow('Illegal');
  });

  it('validates both settlement equations and exact destination issuance', () => {
    const operation = makePreparedMintSwapOperation({
      state: 'completed',
      sourceDispatchAuthorizedAt: now + 1,
      destinationIssueAuthorizedAt: now + 2,
      settlement: {
        sourcePaymentFee: Amount.from(2),
        totalSourceFee: Amount.from(4),
        sourceMeltChangeAmount: Amount.from(6),
        sourceKeepAmount: Amount.from(0),
        sourceReturnedAmount: Amount.from(6),
        finalSourceDebit: Amount.from(104),
        destinationAmountIssued: Amount.from(100),
      },
      completedAt: now + 3,
      updatedAt: now + 3,
    });

    expect(() => validateMintSwapOperation(operation)).not.toThrow();
    expect(() => validateMintSwapAccounting(operation)).not.toThrow();

    expect(() =>
      validateMintSwapAccounting({
        ...operation,
        settlement: { ...operation.settlement!, finalSourceDebit: Amount.from(105) },
      }),
    ).toThrow('does not reconcile');
  });

  it('rejects incomplete state records and same-mint operations', () => {
    expect(() =>
      validateMintSwapOperation({
        ...makePreparedMintSwapOperation(),
        destinationMintOperationId: undefined,
      }),
    ).toThrow('complete prepared plan');
    expect(() =>
      validateMintSwapOperation({
        ...makePreparedMintSwapOperation(),
        destinationMintUrl: 'https://source.test/',
      }),
    ).toThrow('distinct');
  });

  it('creates stable fingerprints that are sensitive to economic and recovery inputs', () => {
    const base = {
      destinationMintOperationId: 'destination-child',
      sourceMeltOperationId: 'source-child',
      destinationQuoteRef: {
        mintUrl: 'https://destination.test/',
        method: 'bolt11' as const,
        quoteId: 'destination-quote',
      },
      sourceQuoteRef: {
        mintUrl: 'https://source.test',
        method: 'bolt11' as const,
        quoteId: 'source-quote',
      },
      destinationAmount: Amount.from(100),
      unit: 'sat' as const,
      sourceInputProofSecrets: ['secret-a', 'secret-b'],
      destinationOutputData: { send: [{ amount: '64' }, { amount: '32' }, { amount: '4' }] },
      sourceOutputData: { keep: [{ amount: '6' }] },
      maximumSourceDebit: Amount.from(110),
    };
    const first = createMintSwapPreparedPlanFingerprint(base);
    const reorderedKeys = createMintSwapPreparedPlanFingerprint({ ...base });
    const changed = createMintSwapPreparedPlanFingerprint({
      ...base,
      maximumSourceDebit: Amount.from(111),
    });

    expect(first).toBe(reorderedKeys);
    expect(first).not.toBe(changed);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});
