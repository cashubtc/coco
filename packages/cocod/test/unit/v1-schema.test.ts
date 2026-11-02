import { expect, test } from 'bun:test';

import { lifecycleStatusSchema } from '../../src/v1/schema.js';
import {
  amountNode,
  positiveAmountNode,
  objectNode,
  stringNode,
  jsonValueNode,
  unionNode,
} from '../../src/v1/schema-nodes.js';

test('lifecycle documents reject inconsistent Wallet state and noncanonical timestamps', () => {
  const cocoSession = { state: 'stopped', startedAt: null, lastFailure: null };
  expect(() =>
    lifecycleStatusSchema.parse({
      daemon: { version: '0.0.17', interfaceVersion: '1' },
      wallet: null,
      seedAccess: { state: 'available', requiresPassphrase: false },
      cocoSession,
    }),
  ).toThrow();
  expect(() =>
    lifecycleStatusSchema.parse({
      daemon: { version: '0.0.17', interfaceVersion: '1' },
      wallet: { configuredAt: '2026-08-16T00:00:00Z' },
      seedAccess: { state: 'available', requiresPassphrase: false },
      cocoSession,
    }),
  ).toThrow();
});

test('decimal amounts preserve precision within the unsigned 64-bit range', () => {
  for (const value of ['1', '9007199254740993', '18446744073709551615']) {
    expect(positiveAmountNode().parse(value, '$')).toBe(value);
  }
  expect(amountNode().parse('0', '$')).toBe('0');
  expect(() => positiveAmountNode().parse('0', '$')).toThrow();
  for (const value of [1, '-1', '01', '1.1', '1e3', '18446744073709551616']) {
    expect(() => amountNode().parse(value, '$')).toThrow();
  }
});

test('object schemas enforce dependent fields and omit undefined optional values', () => {
  const schema = objectNode(
    { first: stringNode(), second: stringNode() },
    {
      optional: ['first', 'second'],
      dependentRequired: { second: ['first'] },
    },
  );
  expect(schema.parse({ first: undefined }, '$')).toEqual({});
  expect(schema.parse({ first: 'a', second: 'b' }, '$')).toEqual({ first: 'a', second: 'b' });
  expect(() => schema.parse({ second: 'b' }, '$')).toThrow();
  expect(() => schema.parse({ unexpected: true }, '$')).toThrow();
  expect(schema.jsonSchema.dependentRequired).toEqual({ second: ['first'] });
});

test('unions distinguish oneOf from anyOf and arbitrary JSON rejects non-JSON values', () => {
  const alternatives = [stringNode(), stringNode({ minLength: 1 })];
  expect(() => unionNode(alternatives).parse('both', '$')).toThrow();
  expect(unionNode(alternatives, 'anyOf').parse('both', '$')).toBe('both');
  expect(jsonValueNode().parse({ nested: [null, true, 1, 'text'] }, '$')).toEqual({
    nested: [null, true, 1, 'text'],
  });
  for (const value of [NaN, Infinity, 1n, undefined, { nested: undefined }]) {
    expect(() => jsonValueNode().parse(value, '$')).toThrow();
  }
});
