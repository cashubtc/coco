import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PaymentRequest } from '@cashu/cashu-ts';
import { PaymentRequestsApi } from '../../api/PaymentRequestsApi';
import type {
  PaymentRequestExecutionResult,
  PaymentRequestService,
  PreparedPaymentRequest,
  ResolvedPaymentRequest,
} from '../../services';

describe('PaymentRequestsApi', () => {
  let api: PaymentRequestsApi;
  let service: PaymentRequestService;

  const resolvedRequest: ResolvedPaymentRequest = {
    paymentRequest: new PaymentRequest([], 'request-id', 100, 'sat', ['https://mint.test']),
    payableMints: ['https://mint.test'],
    allowedMints: ['https://mint.test'],
    amount: 100,
    transport: { type: 'inband' },
  };

  const preparedRequest: PreparedPaymentRequest = {
    sendOperation: {
      id: 'operation-id',
      state: 'prepared',
      mintUrl: 'https://mint.test',
      amount: 100,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsSwap: false,
      fee: 0,
      inputAmount: 100,
      inputProofSecrets: ['secret-1'],
      method: 'default',
      methodData: {},
    },
    request: resolvedRequest,
  };

  const executionResult: PaymentRequestExecutionResult = {
    type: 'inband',
    token: { mint: 'https://mint.test', proofs: [] },
    operation: {
      ...preparedRequest.sendOperation,
      state: 'pending',
    },
    request: resolvedRequest,
  };

  beforeEach(() => {
    service = {
      parse: mock(async () => resolvedRequest),
      prepare: mock(async () => preparedRequest),
      execute: mock(async () => executionResult),
    } as unknown as PaymentRequestService;

    api = new PaymentRequestsApi(service);
  });

  it('should parse a payment request', async () => {
    const result = await api.parse('creqA...');

    expect(result).toBe(resolvedRequest);
    expect(service.parse).toHaveBeenCalledWith('creqA...');
  });

  it('should prepare a payment request', async () => {
    const result = await api.prepare(resolvedRequest, {
      mintUrl: 'https://mint.test',
      amount: 100,
    });

    expect(result).toBe(preparedRequest);
    expect(service.prepare).toHaveBeenCalledWith(resolvedRequest, {
      mintUrl: 'https://mint.test',
      amount: 100,
    });
  });

  it('should execute a prepared payment request', async () => {
    const result = await api.execute(preparedRequest);

    expect(result).toBe(executionResult);
    expect(service.execute).toHaveBeenCalledWith(preparedRequest);
  });
});
