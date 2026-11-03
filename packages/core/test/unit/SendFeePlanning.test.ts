import { Amount, selectProofsRGLI } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { createKeyChain } from '../../proofs/KeysetSelection.ts';
import {
  calculateProofFee,
  feeCoveredSendAmount,
  selectProofInputs,
} from '../../proofs/ProofSelection.ts';
import { testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';
const keyset = (feePpk: number, active = true) => ({
  mintUrl,
  id: testMintKeysetId('sat', { input_fee_ppk: feePpk }),
  unit: 'sat',
  active,
  feePpk,
  updatedAt: 0,
  keypairs: testMintKeypairs,
});

describe('Send fee calculations', () => {
  it('re-evaluates the allowance when it adds an outgoing denomination', () => {
    const issuing = keyset(1000);
    const gross = feeCoveredSendAmount(
      Amount.from(8),
      { id: issuing.id, unit: 'sat', keys: issuing.keypairs },
      createKeyChain(mintUrl, 'sat', [issuing]),
    );
    // 9 = 8+1 requires a 2-sat fee; 10 = 8+2 leaves the requested 8 sats.
    expect(gross).toEqual(Amount.from(10));
  });

  it.each([
    [900, 1, 7],
    [901, 2, 6],
  ])('rounds mixed-keyset fees once at %i ppk', (secondRate, fee, net) => {
    const keysets = [keyset(100), keyset(secondRate, false)];
    const chain = createKeyChain(mintUrl, 'sat', keysets);
    const proofs = keysets.map(({ id }, index) => ({
      id,
      unit: 'sat',
      amount: Amount.from(4),
      secret: `proof-${index}`,
      C: testMintKeypairs['4'],
    }));
    expect(calculateProofFee(proofs, chain)).toEqual(Amount.from(fee));
    const selected = selectProofInputs(
      { amount: Amount.from(net + 1), unit: 'sat' },
      proofs,
      chain,
      selectProofsRGLI,
      false,
      { amount: Amount.from(net) },
    );
    expect(selected).toEqual({
      proofs,
      fee: Amount.zero(),
      needsSwap: false,
      sendAmount: Amount.from(8),
    });
  });

  it.each([8000, 16000])('rejects a %i-ppk fee that consumes every denomination', (feePpk) => {
    const issuing = keyset(feePpk);
    expect(() =>
      feeCoveredSendAmount(
        Amount.from(7),
        { id: issuing.id, unit: 'sat', keys: issuing.keypairs },
        createKeyChain(mintUrl, 'sat', [issuing]),
      ),
    ).toThrow('Unable to fund receiver input fees');
  });
});
