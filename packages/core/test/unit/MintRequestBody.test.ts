import { expect, test } from 'bun:test';
import { parseRequestBody } from '../fixtures/MintRequestBody.ts';

test('preserves large integer amounts in serialized mint request bodies', () => {
  const body = parseRequestBody('{"amount":9007199254740993}');

  expect(body?.amount).toBe(9007199254740993n);
});
