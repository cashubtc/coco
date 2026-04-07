import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { PaymentRequest, PaymentRequestTransportType, type Token } from '@cashu/cashu-ts';
import {
  PaymentRequestService,
  type PreparedPaymentRequest,
  type ResolvedPaymentRequest,
} from '../../services/PaymentRequestService';
import type {
  PendingSendOperation,
  PreparedSendOperation,
  SendOperationService,
} from '../../operations/send';
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

  const mockPendingOperation: PendingSendOperation = {
    id: 'test-op-id',
    state: 'pending',
    mintUrl: testMintUrl,
    amount: 100,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    needsSwap: false,
    fee: 0,
    inputAmount: 100,
    inputProofSecrets: ['secret-1'],
    method: 'default',
    methodData: {},
  };

  const mockToken: Token = {
    mint: testMintUrl,
    proofs: [{ id: 'keyset-1', amount: 100, secret: 'secret-1', C: 'C-1' }],
  };

  const createMockPreparedSendOperation = (
    mintUrl: string,
    amount: number,
  ): PreparedSendOperation => ({
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
    method: 'default',
    methodData: {},
  });

  const createResolvedRequest = (
    options: {
      amount?: number;
      allowedMints?: string[];
      transport?: ResolvedPaymentRequest['transport'];
    } = {},
  ): ResolvedPaymentRequest => {
    const transport = options.transport ?? { type: 'inband' as const };
    const allowedMints = options.allowedMints ?? [testMintUrl];
    const paymentRequestTransport =
      transport.type === 'http'
        ? [{ type: PaymentRequestTransportType.POST, target: transport.url }]
        : [];

    return {
      paymentRequest: new PaymentRequest(
        paymentRequestTransport,
        'test-id',
        options.amount,
        'sat',
        allowedMints,
      ),
      payableMints: [...allowedMints],
      allowedMints,
      amount: options.amount,
      transport,
    };
  };

  const createPreparedRequest = (
    request: ResolvedPaymentRequest,
    mintUrl = testMintUrl,
  ): PreparedPaymentRequest => ({
    sendOperation: createMockPreparedSendOperation(mintUrl, request.amount ?? 100),
    request,
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
      prepare: mock(async (initOp: { mintUrl: string; amount: number }) =>
        createMockPreparedSendOperation(initOp.mintUrl, initOp.amount),
      ),
      execute: mock(async () => ({
        operation: mockPendingOperation,
        token: mockToken,
      })),
    } as unknown as SendOperationService;

    mockProofService = {
      getBalancesByMint: mock(async () => ({
        [testMintUrl]: { spendable: 1000, reserved: 0, total: 1000 },
        [testMintUrl2]: { spendable: 500, reserved: 0, total: 500 },
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

  describe('parse', () => {
    it('should decode an inband payment request', async () => {
      const pr = new PaymentRequest([], 'request-id-1', 100, 'sat', [testMintUrl], 'Test payment');
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.transport.type).toBe('inband');
      expect(result.amount).toBe(100);
      expect(result.allowedMints).toEqual([testMintUrl]);
      expect(result.payableMints).toContain(testMintUrl);
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

      const result = await service.parse(encoded);

      expect(result.transport.type).toBe('http');
      if (result.transport.type === 'http') {
        expect(result.transport.url).toBe(testHttpTarget);
      }
      expect(result.amount).toBe(200);
      expect(result.allowedMints).toEqual([testMintUrl, testMintUrl2]);
    });

    it('should decode a payment request without amount', async () => {
      const pr = new PaymentRequest([], 'request-id-3', undefined, 'sat', [testMintUrl]);
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.transport.type).toBe('inband');
      expect(result.amount).toBeUndefined();
    });

    it('should throw for unsupported transport', async () => {
      const pr = new PaymentRequest(
        [{ type: PaymentRequestTransportType.NOSTR, target: 'npub123...' }],
        'request-id-4',
        100,
        'sat',
      );
      const encoded = pr.toEncodedRequest();

      await expect(service.parse(encoded)).rejects.toThrow(PaymentRequestError);
      await expect(service.parse(encoded)).rejects.toThrow('Unsupported transport type');
    });

    it('should return an empty payable mint list if no matching mints are found', async () => {
      (mockProofService.getBalancesByMint as unknown as ReturnType<typeof mock>).mockImplementation(
        async () => ({
          [testMintUrl]: { spendable: 50, reserved: 0, total: 50 },
        }),
      );

      const pr = new PaymentRequest([], 'request-id-6', 100, 'sat', [testMintUrl]);
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.payableMints).toEqual([]);
      expect(result.allowedMints).toEqual([testMintUrl]);
      expect(result.amount).toBe(100);
    });
  });

  describe('prepare', () => {
    it('should prepare a transaction for a valid request', async () => {
      const request = createResolvedRequest({ amount: 100 });

      const transaction = await service.prepare(request, { mintUrl: testMintUrl });

      expect(transaction.sendOperation).toBeDefined();
      expect(transaction.sendOperation.mintUrl).toBe(testMintUrl);
      expect(transaction.request).toBe(request);
      expect(mockSendOperationService.init).toHaveBeenCalledWith(testMintUrl, 100);
      expect(mockSendOperationService.prepare).toHaveBeenCalled();
    });

    it('should use amount from options if not in request', async () => {
      const request = createResolvedRequest({
        amount: undefined,
        allowedMints: [testMintUrl, testMintUrl2],
      });

      const transaction = await service.prepare(request, { mintUrl: testMintUrl, amount: 750 });

      expect(mockSendOperationService.init).toHaveBeenCalledWith(testMintUrl, 750);
      expect(transaction.request).not.toBe(request);
      expect(transaction.request.amount).toBe(750);
      expect(transaction.request.paymentRequest.amount).toBe(750);
      expect(transaction.request.payableMints).toEqual([testMintUrl]);
    });

    it('should throw if mint is not in allowed list', async () => {
      const request = createResolvedRequest({ amount: 100, allowedMints: [testMintUrl2] });

      await expect(service.prepare(request, { mintUrl: testMintUrl })).rejects.toThrow(
        PaymentRequestError,
      );
      await expect(service.prepare(request, { mintUrl: testMintUrl })).rejects.toThrow(
        'is not in the allowed mints list',
      );
    });

    it('should allow any mint if allowedMints is empty', async () => {
      const request = createResolvedRequest({ amount: 100, allowedMints: [] });

      await service.prepare(request, { mintUrl: testMintUrl });

      expect(mockSendOperationService.init).toHaveBeenCalledWith(testMintUrl, 100);
    });

    it('should throw if no amount is provided anywhere', async () => {
      const request = createResolvedRequest({ amount: undefined });

      await expect(service.prepare(request, { mintUrl: testMintUrl })).rejects.toThrow(
        PaymentRequestError,
      );
      await expect(service.prepare(request, { mintUrl: testMintUrl })).rejects.toThrow(
        'Amount is required',
      );
    });

    it('should throw if amounts do not match', async () => {
      const request = createResolvedRequest({ amount: 100 });

      await expect(service.prepare(request, { mintUrl: testMintUrl, amount: 200 })).rejects.toThrow(
        PaymentRequestError,
      );
      await expect(service.prepare(request, { mintUrl: testMintUrl, amount: 200 })).rejects.toThrow(
        'Amount mismatch',
      );
    });
  });

  describe('execute', () => {
    it('should execute an inband payment request and return the token', async () => {
      const prepared = createPreparedRequest(createResolvedRequest({ amount: 100 }));

      const result = await service.execute(prepared);

      expect(mockSendOperationService.execute).toHaveBeenCalledWith(prepared.sendOperation);
      expect(result.type).toBe('inband');
      if (result.type === 'inband') {
        expect(result.token).toBe(mockToken);
        expect(result.operation).toBe(mockPendingOperation);
      }
    });

    it('should execute an HTTP payment request and POST the token', async () => {
      const fetchCalls: Array<{ input: string; init?: RequestInit }> = [];
      // @ts-ignore
      globalThis.fetch = async (input: string, init?: RequestInit) => {
        fetchCalls.push({ input, init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      };

      const prepared = createPreparedRequest(
        createResolvedRequest({
          amount: 100,
          transport: { type: 'http', url: testHttpTarget },
        }),
      );

      const result = await service.execute(prepared);

      expect(mockSendOperationService.execute).toHaveBeenCalledWith(prepared.sendOperation);
      expect(result.type).toBe('http');
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.input).toBe(testHttpTarget);
      expect(fetchCalls[0]?.init?.method).toBe('POST');
      expect(fetchCalls[0]?.init?.headers).toEqual({ 'Content-Type': 'application/json' });
      if (result.type === 'http') {
        expect(result.response.status).toBe(200);
        expect(result.operation).toBe(mockPendingOperation);
      }
    });

    it('should return fetch error responses without throwing', async () => {
      // @ts-ignore
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });

      const prepared = createPreparedRequest(
        createResolvedRequest({
          amount: 100,
          transport: { type: 'http', url: testHttpTarget },
        }),
      );

      const result = await service.execute(prepared);

      expect(result.type).toBe('http');
      if (result.type === 'http') {
        expect(result.response.status).toBe(500);
      }
    });
  });
});
