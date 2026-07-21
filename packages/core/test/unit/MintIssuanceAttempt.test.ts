import { describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import {
  normalizeMintIssuanceAttempt,
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

  it('rejects invalid output recovery material before persistence', () => {
    expect(() =>
      normalizeMintIssuanceAttempt({
        id: 'attempt-1',
        mintUrl: 'https://mint.test',
        unit: 'sat',
        state: 'prepared',
        members: [{ operationId: 'operation-1', quoteId: 'quote-1', amount: Amount.from(1) }],
        outputData: {
          keep: [
            {
              blindedMessage: { amount: '1', id: 'keyset', B_: 'B_' },
              blindingFactor: '01',
              secret: 'not-hex',
            },
          ],
          send: [],
        },
        createdAt: 1,
      }),
    ).toThrow('secret must be hex');
  });

  it('rejects invalid terminal failure metadata before persistence', () => {
    const failedAttempt = {
      id: 'attempt-1',
      mintUrl: 'https://mint.test',
      unit: 'sat',
      state: 'failed',
      members: [{ operationId: 'operation-1', quoteId: 'quote-1', amount: Amount.from(1) }],
      outputData: { keep: [], send: [] },
      createdAt: 1,
      submittedAt: 2,
    } as const;

    expect(() =>
      normalizeMintIssuanceAttempt({
        ...failedAttempt,
        terminalFailure: { message: 'rejected', code: 42 },
      } as never),
    ).toThrow('code must be a string');
    expect(() =>
      normalizeMintIssuanceAttempt({
        ...failedAttempt,
        terminalFailure: { message: 'rejected', details: [] },
      } as never),
    ).toThrow('details must be an object');
  });
});
