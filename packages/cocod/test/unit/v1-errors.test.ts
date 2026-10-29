import { describe, expect, test } from 'bun:test';
import {
  HttpResponseError,
  MintFetchError,
  MintOperationError,
  MintSwapChildOperationError,
  NetworkError,
  OperationInProgressError,
  OperationNotFoundError,
  OperationStateError,
  PaymentRequestError,
  ProofValidationError,
  ReceiveOperationConflictError,
  SendOperationConflictError,
  UnknownMintError,
} from '@cashu/coco-core';

import { V1HttpError } from '../../src/v1/contract.js';
import { toV1Error } from '../../src/v1/resources/errors.js';

const context = { action: 'do the thing' };

function mapped(cause: unknown, remoteEffect = false) {
  const { status, code, retryable, details, message } = toV1Error(cause, {
    ...context,
    remoteEffect,
  }).options;
  return { status, code, retryable, details, message };
}

describe('Coco error mapping', () => {
  test('maps typed lifecycle errors with their identities and states', () => {
    expect(mapped(new OperationNotFoundError('melt', 'op-1'))).toMatchObject({
      status: 404,
      code: 'not_found',
      details: { operationType: 'melt', operationId: 'op-1' },
    });
    expect(
      mapped(
        new OperationStateError(
          {
            operationType: 'send',
            operationId: 'op-2',
            state: 'pending',
            expectedStates: ['prepared'],
          },
          'Cannot cancel',
        ),
      ),
    ).toMatchObject({
      status: 409,
      code: 'invalid_operation_state',
      retryable: false,
      details: {
        operationType: 'send',
        operationId: 'op-2',
        state: 'pending',
        expectedStates: ['prepared'],
      },
    });
    expect(mapped(new SendOperationConflictError('op-3'))).toMatchObject({
      status: 409,
      code: 'operation_conflict',
      details: { operationType: 'send', operationId: 'op-3' },
    });
    expect(mapped(new ReceiveOperationConflictError('op-4'))).toMatchObject({
      code: 'operation_conflict',
      details: { operationType: 'receive', operationId: 'op-4' },
    });
    expect(mapped(new OperationInProgressError('op-5'))).toMatchObject({
      status: 409,
      code: 'operation_in_progress',
      retryable: true,
    });
    expect(mapped(new MintSwapChildOperationError('swap-1'))).toMatchObject({
      status: 409,
      code: 'operation_coordinated',
      details: { parentOperationId: 'swap-1' },
    });
  });

  test('maps Wallet validation failures without exposing Coco messages', () => {
    for (const cause of [
      new UnknownMintError('Mint https://secret.example is not trusted'),
      new ProofValidationError('Insufficient balance: secret detail'),
      new PaymentRequestError('Malformed encoded payment request'),
    ]) {
      expect(mapped(cause).message).not.toContain('secret');
    }
    expect(mapped(new UnknownMintError('x'))).toMatchObject({
      status: 409,
      code: 'mint_unavailable',
    });
    expect(mapped(new ProofValidationError('x'))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });

  test('separates Mint rejections from unreachable Mints', () => {
    expect(mapped(new MintOperationError(11001, 'Token already spent'))).toMatchObject({
      status: 409,
      code: 'mint_rejected',
      details: { mintErrorCode: 11001 },
    });
    expect(mapped(new HttpResponseError('Not found', 404))).toMatchObject({
      status: 409,
      code: 'mint_rejected',
      details: { mintStatus: 404 },
    });
    for (const cause of [
      new NetworkError('offline'),
      new MintFetchError('https://mint.example.com'),
      new HttpResponseError('Bad gateway', 502),
    ]) {
      expect(mapped(cause)).toMatchObject({
        status: 502,
        code: 'mint_unreachable',
        retryable: true,
      });
    }
  });

  test('marks remote failures of effectful commands as not retryable as-is', () => {
    const effectful = toV1Error(new NetworkError('offline'), { ...context, remoteEffect: true });

    expect(effectful.options).toMatchObject({ code: 'mint_unreachable', retryable: false });
    expect(effectful.options.headers).toBeUndefined();
  });

  test('reports untyped failures as a generic Coco error and passes v1 errors through', () => {
    const passthrough = new V1HttpError({
      status: 404,
      code: 'not_found',
      message: 'missing',
      retryable: false,
    });

    expect(mapped(new Error('database path /secret'))).toEqual({
      status: 500,
      code: 'coco_error',
      retryable: false,
      details: undefined,
      message: 'Coco could not do the thing',
    });
    expect(toV1Error(passthrough, context)).toBe(passthrough);
  });
});
