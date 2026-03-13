import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PaymentRequest, type Token } from '@cashu/cashu-ts';
import { WalletApi } from '../../api/WalletApi';
import type {
  ParsedPaymentRequest,
  PaymentRequestService,
  PaymentRequestTransaction,
} from '../../services';

describe('WalletApi payment request compatibility wrappers', () => {
  let walletApi: WalletApi;
  let paymentRequestService: PaymentRequestService;

  const parsedRequest: ParsedPaymentRequest = {
    paymentRequest: new PaymentRequest([], 'request-id', 100, 'sat', ['https://mint.test']),
    matchingMints: ['https://mint.test'],
    requiredMints: ['https://mint.test'],
    amount: 100,
    transport: { type: 'inband' },
  };

  const transaction: PaymentRequestTransaction = {
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
    request: parsedRequest,
  };

  beforeEach(() => {
    paymentRequestService = {
      processPaymentRequest: mock(async () => parsedRequest),
      preparePaymentRequestTransaction: mock(async () => transaction),
      handleInbandPaymentRequest: mock(
        async (_transaction, handler: (token: Token) => Promise<void>) => {
          await handler({ mint: 'https://mint.test', proofs: [] });
        },
      ),
      handleHttpPaymentRequest: mock(async () => new Response(null, { status: 202 })),
    } as unknown as PaymentRequestService;

    walletApi = new WalletApi(
      {} as never,
      {} as never,
      { getBalances: mock(async () => ({})) } as never,
      {} as never,
      {} as never,
      paymentRequestService,
      { send: mock(async () => ({ mint: 'https://mint.test', proofs: [] })) } as never,
      { receive: mock(async () => undefined) } as never,
      {} as never,
    );
  });

  it('should delegate processPaymentRequest', async () => {
    const result = await walletApi.processPaymentRequest('creqA...');

    expect(result).toBe(parsedRequest);
    expect(paymentRequestService.processPaymentRequest).toHaveBeenCalledWith('creqA...');
  });

  it('should delegate preparePaymentRequestTransaction', async () => {
    const result = await walletApi.preparePaymentRequestTransaction(
      'https://mint.test',
      parsedRequest,
      100,
    );

    expect(result).toBe(transaction);
    expect(paymentRequestService.preparePaymentRequestTransaction).toHaveBeenCalledWith(
      'https://mint.test',
      parsedRequest,
      100,
    );
  });

  it('should delegate handleInbandPaymentRequest', async () => {
    const handler = mock(async () => undefined);

    await walletApi.handleInbandPaymentRequest(transaction, handler);

    expect(paymentRequestService.handleInbandPaymentRequest).toHaveBeenCalledWith(
      transaction,
      handler,
    );
  });

  it('should delegate handleHttpPaymentRequest', async () => {
    const response = await walletApi.handleHttpPaymentRequest(transaction);

    expect(response.status).toBe(202);
    expect(paymentRequestService.handleHttpPaymentRequest).toHaveBeenCalledWith(transaction);
  });
});
