import { Amount, type BatchMintPreview, type Proof } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import {
  HttpResponseError,
  MintOperationError,
  NetworkError,
  ProofValidationError,
} from '../../models/Error.ts';
import { mintQuoteFromBolt11Response, mintQuoteToMethodSnapshot } from '../../models/MintQuote.ts';
import { ScriptedMintIssuanceTransport } from '../fixtures/ScriptedMintIssuanceTransport.ts';

describe('ScriptedMintIssuanceTransport', () => {
  it('injects the complete deterministic Mint Batch fault vocabulary', async () => {
    const mintUrl = 'https://mint.test';
    const proof: Proof = {
      id: 'keyset-1',
      amount: Amount.from(20),
      secret: 'full-proof',
      C: 'C_full-proof',
    };
    const partialProof = { ...proof, amount: Amount.from(10), secret: 'partial-proof' };
    const quoteObservation = mintQuoteToMethodSnapshot(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: 'quote-1',
        request: 'lnbc1fixture',
        amount: Amount.from(20),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'ISSUED',
      }),
    );
    const scripted = new ScriptedMintIssuanceTransport(
      [
        { kind: 'return', value: [proof] },
        { kind: 'throw', error: new MintOperationError(20001, 'structured rejection') },
        { kind: 'throw', error: new NetworkError('timeout') },
        { kind: 'throw', error: new NetworkError('disconnect') },
        { kind: 'throw', error: new HttpResponseError('server failure', 503) },
        { kind: 'throw', error: new ProofValidationError('malformed response') },
        { kind: 'throw', error: new ProofValidationError('invalid signature') },
        { kind: 'return', value: [partialProof] },
      ],
      [{ kind: 'return', value: [quoteObservation] }],
      [
        { kind: 'return', value: [proof] },
        { kind: 'return', value: [partialProof] },
        { kind: 'return', value: [] },
      ],
    );
    const preview = {} as BatchMintPreview;

    await expect(scripted.completeBatchMint(preview)).resolves.toEqual([proof]);
    await expect(scripted.completeBatchMint(preview)).rejects.toThrow('structured rejection');
    await expect(scripted.completeBatchMint(preview)).rejects.toThrow('timeout');
    await expect(scripted.completeBatchMint(preview)).rejects.toThrow('disconnect');
    await expect(scripted.completeBatchMint(preview)).rejects.toThrow('server failure');
    await expect(scripted.completeBatchMint(preview)).rejects.toThrow('malformed response');
    await expect(scripted.completeBatchMint(preview)).rejects.toThrow('invalid signature');
    await expect(scripted.completeBatchMint(preview)).resolves.toEqual([partialProof]);
    await expect(scripted.checkMintQuoteBatch(mintUrl, 'bolt11', ['quote-1'])).resolves.toEqual([
      quoteObservation,
    ]);
    await expect(scripted.restoreExactOutputs(mintUrl, {}, {})).resolves.toEqual([proof]);
    await expect(scripted.restoreExactOutputs(mintUrl, {}, {})).resolves.toEqual([partialProof]);
    await expect(scripted.restoreExactOutputs(mintUrl, {}, {})).resolves.toEqual([]);
  });
});
