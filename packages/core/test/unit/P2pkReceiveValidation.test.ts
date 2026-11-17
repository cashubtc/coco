import { describe, expect, it } from 'bun:test';
import { ProofValidationError } from '../../models/Error.ts';
import { getReceiveSigningKeys } from '../../proofs/P2pkReceiveValidation.ts';

const primary = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const cosigner = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const refund = '03fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556';
const locktime = 1_800_000_000;
const secret = (tags: string[][] = [], data = primary) =>
  JSON.stringify(['P2PK', { nonce: 'nonce', data, tags }]);

// Pure protocol policy: explicit time makes the exact second and malformed conditions deterministic.
describe('P2PK receive condition validation', () => {
  it.each([
    [locktime - 1, [primary]],
    [locktime, [primary]],
    [locktime + 1, []],
  ] as const)('resolves the no-refund path at %i', (now, expected) => {
    expect(getReceiveSigningKeys(secret([['locktime', String(locktime)]]), now)).toEqual([
      ...expected,
    ]);
  });

  it('requires the primary key without locktime and leaves ordinary proofs unsigned', () => {
    expect(getReceiveSigningKeys(secret(), locktime + 1)).toEqual([primary]);
    expect(getReceiveSigningKeys('ordinary-proof', locktime + 1)).toEqual([]);
  });

  it('keeps an equal preparation timestamp locked even when the SDK clock has passed it', () => {
    expect(getReceiveSigningKeys(secret([['locktime', '1']]), 1)).toEqual([primary]);
  });

  it.each(['no-time', '-1', '1.5', '1e3', '123abc', '9007199254740992'])(
    'treats invalid locktime %s as permanent',
    (value) => {
      expect(getReceiveSigningKeys(secret([['locktime', value]]), locktime + 1)).toEqual([primary]);
    },
  );

  it('does not require original multisig signatures after no-refund expiry', () => {
    const locked = secret([
      ['pubkeys', cosigner],
      ['n_sigs', '2'],
      ['locktime', String(locktime)],
    ]);
    expect(() => getReceiveSigningKeys(locked, locktime)).toThrow('Multisig');
    expect(getReceiveSigningKeys(locked, locktime + 1)).toEqual([]);
  });

  it('retains primary authorization after expiry with refund keys', () => {
    expect(
      getReceiveSigningKeys(
        secret([
          ['locktime', String(locktime)],
          ['refund', refund],
        ]),
        locktime + 1,
      ),
    ).toEqual([primary, refund]);
  });

  it.each([locktime - 1, locktime])('does not offer a refund key at %i', (now) => {
    expect(
      getReceiveSigningKeys(
        secret([
          ['locktime', String(locktime)],
          ['refund', refund],
        ]),
        now,
      ),
    ).toEqual([primary]);
  });

  it('offers a single refund key independently of the original multisig threshold', () => {
    expect(
      getReceiveSigningKeys(
        secret([
          ['pubkeys', cosigner],
          ['n_sigs', '2'],
          ['refund', refund],
          ['n_sigs_refund', '1'],
          ['locktime', String(locktime)],
        ]),
        locktime + 1,
      ),
    ).toEqual([refund]);
  });

  it('keeps multiple refund keys unsupported without blocking the original single-key path', () => {
    const tags = [
      ['refund', refund, cosigner],
      ['n_sigs_refund', '2'],
      ['locktime', '1'],
    ];
    expect(getReceiveSigningKeys(secret(tags), locktime)).toEqual([primary]);
    expect(() =>
      getReceiveSigningKeys(secret([...tags, ['pubkeys', cosigner], ['n_sigs', '2']]), locktime),
    ).toThrow('Multisig');
  });

  it('does not activate a refund path without a valid locktime', () => {
    for (const tags of [
      [['refund', refund]],
      [
        ['refund', refund],
        ['locktime', '1trailing'],
      ],
    ]) {
      expect(getReceiveSigningKeys(secret(tags), locktime)).toEqual([primary]);
    }
  });

  it.each([
    [
      ['locktime', '1'],
      ['locktime', '2'],
    ],
    [['refund']],
    [['pubkeys']],
    [['pubkeys', primary]],
    [['pubkeys', '03' + primary.slice(2).toUpperCase()]],
    [['refund', refund, refund]],
    [['n_sigs', '2']],
    [['n_sigs', '0']],
    [['n_sigs', '1trailing']],
    [['n_sigs', '1', '2']],
    [['n_sigs_refund', '1']],
    [
      ['refund', refund],
      ['n_sigs_refund', '2'],
    ],
    [
      ['refund', refund],
      ['n_sigs_refund', '1.5'],
    ],
    [['refund', 'invalid-key']],
    [['sigflag', 'UNKNOWN']],
    [['sigflag', 'SIG_INPUTS', 'SIG_ALL']],
  ])('rejects malformed conditions even after expiry: %j', (...tags) => {
    const conditions = tags as string[][];
    const allTags = conditions.some((tag) => tag[0] === 'locktime')
      ? conditions
      : [...conditions, ['locktime', '1']];
    expect(() => getReceiveSigningKeys(secret(allTags), locktime)).toThrow(ProofValidationError);
  });

  it('rejects invalid public keys and unsupported kinds even after expiry', () => {
    for (const key of [primary.slice(2), '02' + 'ff'.repeat(32)]) {
      expect(() => getReceiveSigningKeys(secret([['locktime', '1']], key), locktime)).toThrow(
        ProofValidationError,
      );
    }
    expect(() => getReceiveSigningKeys(secret().replace('P2PK', 'HTLC'), locktime)).toThrow(
      'Only P2PK',
    );
  });

  it('rejects SIG_ALL even when the proof otherwise needs no signature', () => {
    expect(() =>
      getReceiveSigningKeys(
        secret([
          ['sigflag', 'SIG_ALL'],
          ['locktime', '1'],
        ]),
        locktime,
      ),
    ).toThrow('SIG_ALL');
  });
});
