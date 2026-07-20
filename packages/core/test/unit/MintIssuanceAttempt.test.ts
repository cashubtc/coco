import { describe, expect, it } from 'bun:test';
import {
  parseMintIssuanceAttemptFailure,
  parseMintIssuanceAttemptMembers,
  parseMintIssuanceAttemptOutputData,
} from '../../operations/mint/MintIssuanceAttempt.ts';

describe('Mint Issuance Attempt persisted recovery material', () => {
  it('rejects malformed members, outputs, and terminal failure metadata', () => {
    expect(() =>
      parseMintIssuanceAttemptMembers([{ operationId: 'op', quoteId: 'quote' }]),
    ).toThrow('amount is invalid');
    expect(() =>
      parseMintIssuanceAttemptOutputData({
        keep: [
          {
            blindedMessage: { amount: '1', id: 'keyset', B_: 'B_' },
            blindingFactor: '01',
            secret: 'not-hex',
          },
        ],
        send: [],
      }),
    ).toThrow('secret must be hex');
    expect(() =>
      parseMintIssuanceAttemptFailure({ message: 'rejected', details: ['not', 'an', 'object'] }),
    ).toThrow('details must be an object');
  });
});
