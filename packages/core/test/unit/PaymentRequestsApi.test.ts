import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PaymentRequest } from '@cashu/cashu-ts';
import { PaymentRequestsApi } from '../../api/PaymentRequestsApi';
import type {
  PaymentRequestExecutionResult,
  PaymentRequestReceiveService,
  PaymentRequestService,
  PreparedPaymentRequest,
  ResolvedPaymentRequest,
} from '../../services';

describe('PaymentRequestsApi', () => {
  let api: PaymentRequestsApi;
  let service: PaymentRequestService;
  let incomingService: PaymentRequestReceiveService;

  const resolvedRequest: ResolvedPaymentRequest = {
    paymentRequest: new PaymentRequest([], 'request-id', 100, 'sat', ['https://mint.test']),
    payableMints: ['https://mint.test'],
    allowedMints: ['https://mint.test'],
    amount: Amount.from(100),
    unit: 'sat',
    transport: { type: 'inband' },
  };

  const preparedRequest: PreparedPaymentRequest = {
    sendOperation: {
      id: 'operation-id',
      state: 'prepared',
      mintUrl: 'https://mint.test',
      amount: Amount.from(100),
      unit: 'sat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsSwap: false,
      fee: Amount.from(0),
      inputAmount: Amount.from(100),
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
    incomingService = {
      create: mock(),
      cancel: mock(),
      get: mock(),
      list: mock(),
      claimPayload: mock(),
      ingestPayload: mock(),
      recoverPendingAttempts: mock(),
      isOperationLocked: mock(),
    } as unknown as PaymentRequestReceiveService;

    api = new PaymentRequestsApi(service, incomingService);
  });

  it('should parse a payment request', async () => {
    const result = await api.parse('creqA...');

    expect(result).toBe(resolvedRequest);
    expect(service.parse).toHaveBeenCalledWith('creqA...');
  });

  it('should prepare a payment request', async () => {
    const result = await api.prepare(resolvedRequest, {
      mintUrl: 'https://mint.test',
      amount: Amount.from(100),
    });

    expect(result).toBe(preparedRequest);
    expect(service.prepare).toHaveBeenCalledWith(resolvedRequest, {
      mintUrl: 'https://mint.test',
      amount: { amount: Amount.from(100), unit: 'sat' },
    });
  });

  it('normalizes object-form payment request amounts at the API boundary', async () => {
    await api.prepare(resolvedRequest, {
      mintUrl: 'https://mint.test',
      amount: { amount: Amount.from(100), unit: 'SAT' },
    });

    expect(service.prepare).toHaveBeenCalledWith(resolvedRequest, {
      mintUrl: 'https://mint.test',
      amount: { amount: Amount.from(100), unit: 'sat' },
    });
  });

  it('should execute a prepared payment request', async () => {
    const result = await api.execute(preparedRequest);

    expect(result).toBe(executionResult);
    expect(service.execute).toHaveBeenCalledWith(preparedRequest);
  });
});
