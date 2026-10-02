import { expect, test } from 'bun:test';

import { V1HttpError } from '../../src/v1/contract.js';
import {
  createMeltQuoteRequestSchema,
  createMintQuoteRequestSchema,
  createSendOperationRequestSchema,
  historyPageSchema,
  lifecycleStatusSchema,
  mintInformationSchema,
  startSessionRequestSchema,
  stopSessionRequestSchema,
  type CreateSendOperationRequest,
  type StopSessionRequest,
} from '../../src/v1/schema.js';

test('keeps strict, empty, union, and open object behavior', () => {
  expect(startSessionRequestSchema.parse({ passphrase: 'secret' })).toEqual({
    passphrase: 'secret',
  });
  expect(() => startSessionRequestSchema.parse({ unexpected: true })).toThrow();

  expect(stopSessionRequestSchema.parse({})).toEqual({});
  expect(() => stopSessionRequestSchema.parse({ unexpected: true })).toThrow();

  expect(
    createSendOperationRequestSchema.parse({ amount: '1', unit: 'sat', forceSwap: true }),
  ).toEqual({ amount: '1', unit: 'sat', forceSwap: true });
  expect(() =>
    createSendOperationRequestSchema.parse({
      amount: '1',
      unit: 'sat',
      source: { type: 'payment-request', request: 'creqA' },
      forceSwap: true,
    }),
  ).toThrow();

  expect(
    mintInformationSchema.parse({
      mintUrl: 'https://mint.example.com',
      info: { custom: { retained: true } },
    }),
  ).toEqual({
    mintUrl: 'https://mint.example.com',
    info: { custom: { retained: true } },
  });
});

test('keeps exact timestamps, safe integers, decimal amounts, and sensitive metadata', () => {
  const status = {
    daemon: { version: '0.0.17', interfaceVersion: '1' },
    wallet: null,
    seedAccess: null,
    cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
  } as const;

  expect(lifecycleStatusSchema.parse(status)).toEqual(status);
  expect(() =>
    lifecycleStatusSchema.parse({
      ...status,
      cocoSession: {
        ...status.cocoSession,
        lastFailure: {
          code: 'failed',
          message: 'failed',
          occurredAt: '2023-02-29T00:00:00.000Z',
        },
      },
    }),
  ).toThrow();
  expect(() =>
    lifecycleStatusSchema.parse({
      ...status,
      cocoSession: {
        ...status.cocoSession,
        lastFailure: {
          code: 'failed',
          message: 'failed',
          occurredAt: '2024-02-29T00:00:00Z',
        },
      },
    }),
  ).toThrow();

  expect(() => historyPageSchema.parse({ items: [], offset: 0, limit: 1.5 })).toThrow();
  expect(() =>
    historyPageSchema.parse({ items: [], offset: 0, limit: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow();
  expect(() =>
    createMintQuoteRequestSchema.parse({ method: 'bolt11', amount: '01', unit: 'sat' }),
  ).toThrow();

  expect(startSessionRequestSchema.jsonSchema).toMatchObject({
    properties: { passphrase: { 'x-sensitive': true } },
  });
});

test('keeps unsupported Quote methods outside generic Zod failures', () => {
  expect(() =>
    createMintQuoteRequestSchema.parse({ method: 'custom', amount: '1', unit: 'sat' }),
  ).toThrow(V1HttpError);

  try {
    createMintQuoteRequestSchema.parse({ method: 'custom', amount: '1', unit: 'sat' });
  } catch (error) {
    expect(error).toBeInstanceOf(V1HttpError);
    if (!(error instanceof V1HttpError)) throw error;
    expect(error.options).toMatchObject({
      status: 409,
      code: 'unsupported_behavior',
      details: { type: 'mint', method: 'custom' },
    });
  }
});

test('validates sat-denominated Melt payment amounts independently of the funding unit', () => {
  for (const target of [
    { method: 'bolt11', invoice: 'lnbc1test' },
    { method: 'bolt12', offer: 'lno1test' },
    { method: 'onchain', address: 'bc1qtest' },
  ] as const) {
    const input = { mintUrl: 'https://mint.example.com', ...target, unit: 'msat' };
    const exact = { ...input, amountSats: '9007199254740993' };
    expect(createMeltQuoteRequestSchema.parse(exact)).toEqual(exact);
    for (const amountSats of ['0', '-1', '1.5', '01', 1]) {
      expect(() => createMeltQuoteRequestSchema.parse({ ...input, amountSats })).toThrow();
    }
    if (input.method === 'onchain') {
      expect(() => createMeltQuoteRequestSchema.parse(input)).toThrow();
    } else {
      expect(createMeltQuoteRequestSchema.parse(input)).toEqual(input);
    }
  }
});

const emptyRequest = {} satisfies StopSessionRequest;
void emptyRequest;

type AssertFalse<Value extends false> = Value;
type InvalidEmptyRequestIsRejected = AssertFalse<
  { unexpected: true } extends StopSessionRequest ? true : false
>;
type InvalidSendRequestIsRejected = AssertFalse<
  {
    amount: '1';
    unit: 'sat';
    source: { type: 'payment-request'; request: 'creqA' };
    forceSwap: true;
  } extends CreateSendOperationRequest
    ? true
    : false
>;
