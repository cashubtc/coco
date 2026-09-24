import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PaymentRequest } from '@cashu/cashu-ts';
import { PaymentRequestsApi } from '../../api/PaymentRequestsApi';
import type {
  PaymentRequestReceiveService,
  PaymentRequestService,
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

  beforeEach(() => {
    service = {
      prepare: mock(),
    } as unknown as PaymentRequestService;
    incomingService = {
      create: mock(),
    } as unknown as PaymentRequestReceiveService;

    api = new PaymentRequestsApi(service, incomingService);
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

  it('normalizes incoming create amounts at the API boundary', async () => {
    await api.incoming.create({
      amount: { amount: Amount.from(5), unit: 'USD' },
      requestId: 'request-id',
    });

    expect(incomingService.create).toHaveBeenCalledWith({
      amount: Amount.from(5),
      unit: 'usd',
      requestId: 'request-id',
    });
  });
});
