import { expect, test } from 'bun:test';
import { Amount, getEncodedToken, type Token } from '@cashu/cashu-ts';
import { tokenToBytes, bytesToToken, bytesToTokenString } from '../../src/cashu';
import { decodeCbor, encodeCbor, encodeBase64Url } from '../../src/encoding';

const token: Token = {
  mint: 'https://mint.example',
  unit: 'sat',
  memo: 'Fountain experiment',
  proofs: [
    {
      id: '009a1f293253e41e',
      amount: Amount.from(1),
      secret: 'test-secret',
      C: '02' + '11'.repeat(32),
    },
  ],
};

test('cashuB text survives conversion to binary and back with its exact CBOR', () => {
  const text = getEncodedToken(token);
  const bytes = tokenToBytes(text);
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('crawB');
  expect(bytesToTokenString(bytes)).toBe(text);
  expect(bytesToToken(bytes)).toEqual(token);
});

test('Cashu object round trips preserve full keyset IDs, large Amount values and proof metadata', () => {
  const full: Token = {
    ...token,
    proofs: [
      {
        ...token.proofs[0]!,
        id: '01' + 'ab'.repeat(32),
        amount: Amount.from(9007199254740993n),
        dleq: { e: '11'.repeat(32), s: '22'.repeat(32), r: '33'.repeat(32) },
        p2pk_e: '03' + '44'.repeat(32),
        witness: '{"signatures":["test-signature"]}',
      },
    ],
  };
  const bytes = tokenToBytes(full);
  expect(bytesToToken(bytes)).toEqual(full);
  expect(bytesToToken(tokenToBytes(bytesToTokenString(bytes)))).toEqual(full);
});

test('recovered UTF-8 cashuB payloads from UR can be read using the same helpers', () => {
  const text = getEncodedToken(token);
  const recovered = new TextEncoder().encode(text);
  expect(bytesToToken(recovered)).toEqual(token);
  expect(bytesToTokenString(recovered)).toBe(text);
});

test('invalid token encodings and unsupported versions fail clearly', () => {
  expect(() => tokenToBytes('cashuAeyJ0b2tlbiI6W119')).toThrow(/cashuB/);
  expect(() => tokenToBytes('cashuB!')).toThrow(/base64url/);
  expect(() => tokenToBytes('cashuBoA')).toThrow(); // Empty CBOR map.
  expect(() => bytesToToken(new TextEncoder().encode('crawA'))).toThrow();
  expect(() => bytesToToken(tokenToBytes('cashuBoWF0gA'))).toThrow(); // {t: []}, no mint.
});

test('a binary token cannot hide trailing data after its CBOR payload', () => {
  const valid = tokenToBytes(token);
  const extra = new Uint8Array(valid.length + 1);
  extra.set(valid);
  expect(() => bytesToToken(extra)).toThrow();
});

for (const witness of [123, 0, true, false, null, [], {}, { signatures: ['signature'] }]) {
  test(`rejects non-text CBOR witness ${JSON.stringify(witness)} through every Cashu input path`, () => {
    const valid = tokenToBytes(token);
    const wire = decodeCbor(valid.subarray(5)) as { t: { p: { w?: unknown }[] }[] };
    wire.t[0]!.p[0]!.w = witness;
    const cbor = encodeCbor(wire);
    const binary = new Uint8Array(5 + cbor.length);
    binary.set(valid.subarray(0, 5));
    binary.set(cbor, 5);
    const text = 'cashuB' + encodeBase64Url(cbor);
    expect(() => bytesToToken(binary)).toThrow(/witness/);
    expect(() => bytesToTokenString(binary)).toThrow(/witness/);
    expect(() => tokenToBytes(text)).toThrow(/witness/);
    expect(() => bytesToToken(new TextEncoder().encode(text))).toThrow(/witness/);
  });
}

test('object witness inputs normalize to text and retain that text CBOR exactly', () => {
  const witness = { signatures: ['test-signature'] };
  const binary = tokenToBytes({ ...token, proofs: [{ ...token.proofs[0]!, witness }] });
  expect(bytesToToken(binary).proofs[0]!.witness).toBe(JSON.stringify(witness));
  expect(tokenToBytes(bytesToTokenString(binary))).toEqual(binary);
});

test('mixed object and serialized witnesses retain their content across grouped keysets', () => {
  const witnessText = '{ "signatures": ["first"] }';
  const htlcText = '{ "preimage": "aabb", "signatures": [] }';
  const input: Token = {
    ...token,
    proofs: [
      { ...token.proofs[0]!, witness: witnessText },
      { ...token.proofs[0]!, id: '01' + 'ab'.repeat(32), witness: { signatures: ['second'] } },
      { ...token.proofs[0]!, witness: htlcText },
    ],
  };
  const bytes = tokenToBytes(input);
  const decoded = bytesToToken(bytes);
  expect(decoded.proofs.map((proof) => proof.witness)).toEqual([
    witnessText,
    htlcText,
    '{"signatures":["second"]}',
  ]);
  expect(input.proofs[0]!.witness).toBe(witnessText);
  expect(input.proofs[1]!.witness).toEqual({ signatures: ['second'] });
  expect(bytesToToken(tokenToBytes(decoded))).toEqual(decoded);
  expect(tokenToBytes(bytesToTokenString(bytes))).toEqual(bytes);
});
