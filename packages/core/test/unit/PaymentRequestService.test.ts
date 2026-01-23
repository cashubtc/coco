import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import {
  PaymentRequest,
  PaymentRequestTransportType,
  type Token,
} from '@cashu/cashu-ts';
import { PaymentRequestService, type PaymentRequestTransaction } from '../../services/PaymentRequestService';
import type { SendOperationService, PreparedSendOperation } from '../../operations/send';
import type { ProofService } from '../../services/ProofService';
import { PaymentRequestError } from '../../models/Error';

describe('PaymentRequestService', () => {
  const testMintUrl = 'https://mint.test';
  const testMintUrl2 = 'https://mint2.test';
  const testHttpTarget = 'https://receiver.test/callback';

  let service: PaymentRequestService;
  let mockSendOperationService: SendOperationService;
  let mockProofService: ProofService;
  const originalFetch = globalThis.fetch;

  const mockToken: Token = {
    mint: testMintUrl,
    proofs: [
      { id: 'keyset-1', amount: 100, secret: 'secret-1', C: 'C-1' },
    ],
  };

  const createMockPreparedSendOperation = (mintUrl: string, amount: number): PreparedSendOperation => ({
    id: 'test-op-id',
    state: 'prepared',
    mintUrl,
    amount,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    needsSwap: false,
    fee: 0,
    inputAmount: amount,
    inputProofSecrets: ['secret-1'],
  });

  beforeEach(() => {
    mockSendOperationService = {
      init: mock(async (mintUrl: string, amount: number) => ({
        id: 'test-op-id',
        state: 'init',
        mintUrl,
        amount,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
      prepare: mock(async (initOp: any) => createMockPreparedSendOperation(initOp.mintUrl, initOp.amount)),
      execute: mock(async () => ({
        operation: { id: 'test-op-id', state: 'pending' },
        token: mockToken,
      })),
    } as unknown as SendOperationService;

    mockProofService = {
      getTrustedBalances: mock(async () => ({
        [testMintUrl]: 1000,
        [testMintUrl2]: 500,
      })),
    } as unknown as ProofService;

    service = new PaymentRequestService(mockSendOperationService, mockProofService);

    // @ts-ignore
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    // @ts-ignore
    globalThis.fetch = originalFetch;
  });

  describe('processPaymentRequest', () => {
    it('should decode an inband payment request (empty transport)', async () => {
      const pr = new PaymentRequest(
        [], // empty transport = inband
        'request-id-1',
        100,
        'sat',
        [testMintUrl],
        'Test payment',
      );
      const encoded = pr.toEncodedRequest();

      const result = await service.processPaymentRequest(encoded);

      expect(result.transport.type).toBe('inband');
      expect(result.amount).toBe(100);
      expect(result.requiredMints).toEqual([testMintUrl]);
      expect(result.matchingMints).toContain(testMintUrl);
    });

    it('should decode an HTTP POST payment request', async () => {
      const pr = new PaymentRequest(
        [{ type: PaymentRequestTransportType.POST, target: testHttpTarget }],
        'request-id-2',
        200,
        'sat',
        [testMintUrl, testMintUrl2],
        'HTTP payment',
      );
      const encoded = pr.toEncodedRequest();

      const result = await service.processPaymentRequest(encoded);

      expect(result.transport.type).toBe('http');
      if (result.transport.type === 'http') {
        expect(result.transport.url).toBe(testHttpTarget);
      }
      expect(result.amount).toBe(200);
      expect(result.requiredMints).toEqual([testMintUrl, testMintUrl2]);
    });

    it('should decode a payment request without amount', async () => {
      const pr = new PaymentRequest(
        [],
        'request-id-3',
        undefined, // no amount
        'sat',
        [testMintUrl],
      );
      const encoded = pr.toEncodedRequest();

      const result = await service.processPaymentRequest(encoded);

      expect(result.transport.type).toBe('inband');
      expect(result.amount).toBeUndefined();
    });

    it('should throw for unsupported transport (nostr)', async () => {
      const pr = new PaymentRequest(
        [{ type: PaymentRequestTransportType.NOSTR, target: 'npub123...' }],
        'request-id-4',
        100,
        'sat',
      );
      const encoded = pr.toEncodedRequest();

      await expect(service.processPaymentRequest(encoded)).rejects.toThrow(PaymentRequestError);
      await expect(service.processPaymentRequest(encoded)).rejects.toThrow(
        'Unsupported transport type',
      );
    });

    it('should find matching mints based on balance', async () => {
      const pr = new PaymentRequest(
        [],
        'request-id-5',
        100,
        'sat',
        [testMintUrl, testMintUrl2],
      );
      const encoded = pr.toEncodedRequest();

      const result = await service.processPaymentRequest(encoded);

      // Both mints have sufficient balance
      expect(result.matchingMints).toContain(testMintUrl);
      expect(result.matchingMints).toContain(testMintUrl2);
    });

    it('should throw if no matching mints found', async () => {
      // Mock low balance
      (mockProofService.getTrustedBalances as any).mockImplementation(async () => ({
        [testMintUrl]: 50, // Not enough
      }));

      const pr = new PaymentRequest(
        [],
        'request-id-6',
        100,
        'sat',
        [testMintUrl],
      );
      const encoded = pr.toEncodedRequest();

      await expect(service.processPaymentRequest(encoded)).rejects.toThrow(PaymentRequestError);
      await expect(service.processPaymentRequest(encoded)).rejects.toThrow('No matching mints found');
    });
  });

  describe('preparePaymentRequestTransaction', () => {
    it('should prepare a transaction for a valid request', async () => {
      const request = {
        paymentRequest: new PaymentRequest([], 'test-id', 100, 'sat', [testMintUrl]),
        matchingMints: [testMintUrl],
        requiredMints: [testMintUrl],
        amount: 100,
        transport: { type: 'inband' as const },
      };

      const transaction = await service.preparePaymentRequestTransaction(testMintUrl, request);

      expect(transaction.sendOperation).toBeDefined();
      expect(transaction.sendOperation.mintUrl).toBe(testMintUrl);
      expect(transaction.request).toBe(request);
      expect(mockSendOperationService.init).toHaveBeenCalledWith(testMintUrl, 100);
      expect(mockSendOperationService.prepare).toHaveBeenCalled();
    });

    it('should use amount from parameter if not in request', async () => {
      const request = {
        paymentRequest: new PaymentRequest([], 'test-id', undefined, 'sat', [testMintUrl]),
        matchingMints: [testMintUrl],
        requiredMints: [testMintUrl],
        amount: undefined,
        transport: { type: 'inband' as const },
      };

      await service.preparePaymentRequestTransaction(testMintUrl, request, 150);

      expect(mockSendOperationService.init).toHaveBeenCalledWith(testMintUrl, 150);
    });

    it('should throw if mint is not in allowed list', async () => {
      const request = {
        paymentRequest: new PaymentRequest([], 'test-id', 100, 'sat', [testMintUrl2]),
        matchingMints: [testMintUrl2],
        requiredMints: [testMintUrl2], // different mint
        amount: 100,
        transport: { type: 'inband' as const },
      };

      await expect(
        service.preparePaymentRequestTransaction(testMintUrl, request),
      ).rejects.toThrow(PaymentRequestError);
      await expect(
        service.preparePaymentRequestTransaction(testMintUrl, request),
      ).rejects.toThrow('is not in the allowed mints list');
    });

    it('should allow any mint if requiredMints list is empty', async () => {
      const request = {
        paymentRequest: new PaymentRequest([], 'test-id', 100, 'sat'),
        matchingMints: [testMintUrl],
        requiredMints: [],
        amount: 100,
        transport: { type: 'inband' as const },
      };

      await service.preparePaymentRequestTransaction(testMintUrl, request);

      expect(mockSendOperationService.init).toHaveBeenCalledWith(testMintUrl, 100);
    });

    it('should throw if no amount provided', async () => {
      const request = {
        paymentRequest: new PaymentRequest([], 'test-id', undefined, 'sat', [testMintUrl]),
        matchingMints: [testMintUrl],
        requiredMints: [testMintUrl],
        amount: undefined,
        transport: { type: 'inband' as const },
      };

      await expect(
        service.preparePaymentRequestTransaction(testMintUrl, request),
      ).rejects.toThrow(PaymentRequestError);
      await expect(
        service.preparePaymentRequestTransaction(testMintUrl, request),
      ).rejects.toThrow('Amount is required');
    });

    it('should throw if amounts do not match', async () => {
      const request = {
        paymentRequest: new PaymentRequest([], 'test-id', 100, 'sat', [testMintUrl]),
        matchingMints: [testMintUrl],
        requiredMints: [testMintUrl],
        amount: 100,
        transport: { type: 'inband' as const },
      };

      await expect(
        service.preparePaymentRequestTransaction(testMintUrl, request, 200),
      ).rejects.toThrow(PaymentRequestError);
      await expect(
        service.preparePaymentRequestTransaction(testMintUrl, request, 200),
      ).rejects.toThrow('Amount mismatch');
    });
  });

  describe('handleInbandPaymentRequest', () => {
    it('should execute send operation and call handler', async () => {
      const handler = mock(() => Promise.resolve());
      const preparedOp = createMockPreparedSendOperation(testMintUrl, 100);
      const transaction: PaymentRequestTransaction = {
        sendOperation: preparedOp,
        request: {
          paymentRequest: new PaymentRequest([], 'test-id', 100, 'sat', [testMintUrl]),
          matchingMints: [testMintUrl],
          requiredMints: [testMintUrl],
          amount: 100,
          transport: { type: 'inband' },
        },
      };

      await service.handleInbandPaymentRequest(transaction, handler);

      expect(mockSendOperationService.execute).toHaveBeenCalledWith(preparedOp);
      expect(handler).toHaveBeenCalledWith(mockToken);
    });

    it('should throw if transport type is not inband', async () => {
      const handler = mock(() => Promise.resolve());
      const preparedOp = createMockPreparedSendOperation(testMintUrl, 100);
      const transaction: PaymentRequestTransaction = {
        sendOperation: preparedOp,
        request: {
          paymentRequest: new PaymentRequest([], 'test-id', 100, 'sat', [testMintUrl]),
          matchingMints: [testMintUrl],
          requiredMints: [testMintUrl],
          amount: 100,
          transport: { type: 'http', url: testHttpTarget },
        },
      };

      await expect(
        service.handleInbandPaymentRequest(transaction, handler),
      ).rejects.toThrow(PaymentRequestError);
      await expect(
        service.handleInbandPaymentRequest(transaction, handler),
      ).rejects.toThrow('Invalid transport type');
    });
  });

  describe('handleHttpPaymentRequest', () => {
    it('should execute send operation and POST token to URL', async () => {
      const fetchCalls: Array<{ input: any; init?: any }> = [];
      // @ts-ignore
      globalThis.fetch = async (input: any, init?: RequestInit) => {
        fetchCalls.push({ input, init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      };

      const preparedOp = createMockPreparedSendOperation(testMintUrl, 100);
      const transaction: PaymentRequestTransaction = {
        sendOperation: preparedOp,
        request: {
          paymentRequest: new PaymentRequest(
            [{ type: PaymentRequestTransportType.POST, target: testHttpTarget }],
            'test-id',
            100,
            'sat',
            [testMintUrl],
          ),
          matchingMints: [testMintUrl],
          requiredMints: [testMintUrl],
          amount: 100,
          transport: { type: 'http', url: testHttpTarget },
        },
      };

      const response = await service.handleHttpPaymentRequest(transaction);

      expect(mockSendOperationService.execute).toHaveBeenCalledWith(preparedOp);
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]?.input).toBe(testHttpTarget);
      expect(fetchCalls[0]?.init?.method).toBe('POST');
      expect(fetchCalls[0]?.init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(response.status).toBe(200);
    });

    it('should return the fetch response', async () => {
      // @ts-ignore
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ received: true, id: 'payment-123' }), {
          status: 201,
          headers: { 'X-Payment-Id': 'payment-123' },
        });
      };

      const preparedOp = createMockPreparedSendOperation(testMintUrl, 100);
      const transaction: PaymentRequestTransaction = {
        sendOperation: preparedOp,
        request: {
          paymentRequest: new PaymentRequest(
            [{ type: PaymentRequestTransportType.POST, target: testHttpTarget }],
            'test-id',
            100,
            'sat',
            [testMintUrl],
          ),
          matchingMints: [testMintUrl],
          requiredMints: [testMintUrl],
          amount: 100,
          transport: { type: 'http', url: testHttpTarget },
        },
      };

      const response = await service.handleHttpPaymentRequest(transaction);

      interface paymentResponse {
        received: boolean,
        id: string,
      }
      expect(response.status).toBe(201);
      const body = await response.json() as paymentResponse;
      expect(body.received).toBe(true);
      expect(body.id).toBe('payment-123');
    });

    it('should throw if transport type is not http', async () => {
      const preparedOp = createMockPreparedSendOperation(testMintUrl, 100);
      const transaction: PaymentRequestTransaction = {
        sendOperation: preparedOp,
        request: {
          paymentRequest: new PaymentRequest([], 'test-id', 100, 'sat', [testMintUrl]),
          matchingMints: [testMintUrl],
          requiredMints: [testMintUrl],
          amount: 100,
          transport: { type: 'inband' },
        },
      };

      await expect(
        service.handleHttpPaymentRequest(transaction),
      ).rejects.toThrow(PaymentRequestError);
      await expect(
        service.handleHttpPaymentRequest(transaction),
      ).rejects.toThrow('Invalid transport type');
    });

    it('should not throw if fetch fails (returns response)', async () => {
      // @ts-ignore
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
      };

      const preparedOp = createMockPreparedSendOperation(testMintUrl, 100);
      const transaction: PaymentRequestTransaction = {
        sendOperation: preparedOp,
        request: {
          paymentRequest: new PaymentRequest(
            [{ type: PaymentRequestTransportType.POST, target: testHttpTarget }],
            'test-id',
            100,
            'sat',
            [testMintUrl],
          ),
          matchingMints: [testMintUrl],
          requiredMints: [testMintUrl],
          amount: 100,
          transport: { type: 'http', url: testHttpTarget },
        },
      };

      const response = await service.handleHttpPaymentRequest(transaction);

      expect(response.status).toBe(500);
    });
  });

  describe('end-to-end: process then prepare then handle', () => {
    it('should process, prepare and handle an inband payment request', async () => {
      const handler = mock(() => Promise.resolve());
      const pr = new PaymentRequest(
        [],
        'e2e-inband',
        500,
        'sat',
        [testMintUrl],
      );
      const encoded = pr.toEncodedRequest();

      const parsed = await service.processPaymentRequest(encoded);
      expect(parsed.transport.type).toBe('inband');

      const transaction = await service.preparePaymentRequestTransaction(testMintUrl, parsed);
      await service.handleInbandPaymentRequest(transaction, handler);

      expect(mockSendOperationService.init).toHaveBeenCalledWith(testMintUrl, 500);
      expect(mockSendOperationService.prepare).toHaveBeenCalled();
      expect(mockSendOperationService.execute).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(mockToken);
    });

    it('should process, prepare and handle an HTTP payment request', async () => {
      // @ts-ignore
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      const pr = new PaymentRequest(
        [{ type: PaymentRequestTransportType.POST, target: testHttpTarget }],
        'e2e-http',
        750,
        'sat',
        [testMintUrl],
      );
      const encoded = pr.toEncodedRequest();

      const parsed = await service.processPaymentRequest(encoded);
      expect(parsed.transport.type).toBe('http');

      const transaction = await service.preparePaymentRequestTransaction(testMintUrl, parsed);
      const response = await service.handleHttpPaymentRequest(transaction);

      expect(response.status).toBe(200);
      expect(mockSendOperationService.init).toHaveBeenCalledWith(testMintUrl, 750);
      expect(mockSendOperationService.prepare).toHaveBeenCalled();
      expect(mockSendOperationService.execute).toHaveBeenCalled();
    });
  });
});
