import { expect, test } from 'bun:test';
import { encodeBase64Url, decodeBase64Url } from '../../src/encoding';

test('base64url encodes binary using the URL-safe alphabet and no padding', () => {
  const bytes = new Uint8Array([251, 255, 239]);
  expect(encodeBase64Url(bytes)).toBe('-__v');
  expect(decodeBase64Url('-__v')).toEqual(bytes);
});

test('base64url rejects invalid alphabet, padding, length and nonzero pad bits', () => {
  for (const invalid of ['a', 'Z g', 'Zg=', 'Zg===', 'Zh', '+/8=']) {
    expect(() => decodeBase64Url(invalid)).toThrow(/base64url/i);
  }
  expect(decodeBase64Url('Zg==')).toEqual(new Uint8Array([102]));
  expect(decodeBase64Url('')).toEqual(new Uint8Array());
});

import { encodeCbor, decodeCbor } from '../../src/encoding';

test('CBOR helpers interoperate with the RFC 8949 example [1, 2, 3]', () => {
  const cbor = new Uint8Array([0x83, 0x01, 0x02, 0x03]);
  expect(encodeCbor([1, 2, 3])).toEqual(cbor);
  expect(decodeCbor(cbor)).toEqual([1, 2, 3]);
  expect(() => decodeCbor(new Uint8Array([0x83, 0x01]))).toThrow();
  expect(() => decodeCbor(new Uint8Array([0x01, 0x02]))).toThrow();
});
