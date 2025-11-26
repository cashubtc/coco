import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import {
  PaymentRequest,
  PaymentRequestTransportType,
  type Token,
} from '@cashu/cashu-ts';
import { PaymentRequestService } from '../../services/PaymentRequestService';
import type { TransactionService } from '../../services/TransactionService';
import { PaymentRequestError } from '../../models/Error';

describe('PaymentRequestService', () => {
  const testMintUrl = 'https://mint.test';
  const testMintUrl2 = 'https://mint2.test';
  const testHttpTarget = 'https://receiver.test/callback';

  let service: PaymentRequestService;
  let mockTransactionService: TransactionService;
  const originalFetch = globalThis.fetch;

  const mockToken: Token = {
    mint: testMintUrl,
    proofs: [
      { id: 'keyset-1', amount: 100, secret: 'secret-1', C: 'C-1' },
    ],
  };

  beforeEach(() => {
    mockTransactionService = {
      send: mock(() => Promise.resolve(mockToken)),
      receive: mock(() => Promise.resolve()),
    } as unknown as TransactionService;

    service = new PaymentRequestService(mockTransactionService);

    // @ts-ignore
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    // @ts-ignore
    globalThis.fetch = originalFetch;
  });

  describe('readPaymentRequest', () => {
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

      const result = await service.readPaymentRequest(encoded);

      expect(result.transport.type).toBe('inband');
      expect(result.amount).toBe(100);
      expect(result.mints).toEqual([testMintUrl]);
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

      const result = await service.readPaymentRequest(encoded);

      expect(result.transport.type).toBe('http');
      if (result.transport.type === 'http') {
        expect(result.transport.url).toBe(testHttpTarget);
      }
      expect(result.amount).toBe(200);
      expect(result.mints).toEqual([testMintUrl, testMintUrl2]);
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

      const result = await service.readPaymentRequest(encoded);

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

      await expect(service.readPaymentRequest(encoded)).rejects.toThrow(PaymentRequestError);
      await expect(service.readPaymentRequest(encoded)).rejects.toThrow(
        'Unsupported transport type',
      );
    });

    it('should throw for payment request with NUT-10 (locked tokens)', async () => {
      const pr = new PaymentRequest(
        [],
        'request-id-5',
        100,
        'sat',
        [testMintUrl],
        'Locked payment',
        false, // singleUse
        { kind: 'P2PK', data: '02abc...pubkey', tags: [] }, // nut10
      );
      const encoded = pr.toEncodedRequest();

      await expect(service.readPaymentRequest(encoded)).rejects.toThrow(PaymentRequestError);
      await expect(service.readPaymentRequest(encoded)).rejects.toThrow(
        'Locked tokens (NUT-10) are not supported',
      );
    });
  });

  describe('handleInbandPaymentRequest', () => {
    it('should send token and call handler with amount from request', async () => {
      const handler = mock(() => Promise.resolve());
      const request = {
        transport: { type: 'inband' as const },
        amount: 100,
        mints: [testMintUrl],
      };

      await service.handleInbandPaymentRequest(testMintUrl, request, handler);

      expect(mockTransactionService.send).toHaveBeenCalledWith(testMintUrl, 100);
      expect(handler).toHaveBeenCalledWith(mockToken);
    });

    it('should send token and call handler with amount from parameter', async () => {
      const handler = mock(() => Promise.resolve());
      const request = {
        transport: { type: 'inband' as const },
        amount: undefined,
        mints: [testMintUrl],
      };

      await service.handleInbandPaymentRequest(testMintUrl, request, handler, 150);

      expect(mockTransactionService.send).toHaveBeenCalledWith(testMintUrl, 150);
      expect(handler).toHaveBeenCalledWith(mockToken);
    });

    it('should throw if mint is not in allowed list', async () => {
      const handler = mock(() => Promise.resolve());
      const request = {
        transport: { type: 'inband' as const },
        amount: 100,
        mints: [testMintUrl2], // different mint
      };

      await expect(
        service.handleInbandPaymentRequest(testMintUrl, request, handler),
      ).rejects.toThrow(PaymentRequestError);
      await expect(
        service.handleInbandPaymentRequest(testMintUrl, request, handler),
      ).rejects.toThrow('is not in the allowed mints list');
    });

    it('should allow any mint if mints list is undefined', async () => {
      const handler = mock(() => Promise.resolve());
      const request = {
        transport: { type: 'inband' as const },
        amount: 100,
        mints: undefined,
      };

      await service.handleInbandPaymentRequest(testMintUrl, request, handler);

      expect(mockTransactionService.send).toHaveBeenCalledWith(testMintUrl, 100);
    });

    it('should throw if no amount provided', async () => {
      const handler = mock(() => Promise.resolve());
      const request = {
        transport: { type: 'inband' as const },
        amount: undefined,
        mints: [testMintUrl],
      };

      await expect(
        // @ts-ignore - testing runtime behavior
        service.handleInbandPaymentRequest(testMintUrl, request, handler),
      ).rejects.toThrow(PaymentRequestError);
      await expect(
        // @ts-ignore
        service.handleInbandPaymentRequest(testMintUrl, request, handler),
      ).rejects.toThrow('Amount is required');
    });

    it('should throw if amounts do not match', async () => {
      const handler = mock(() => Promise.resolve());
      const request = {
        transport: { type: 'inband' as const },
        amount: 100,
        mints: [testMintUrl],
      };

      await expect(
        // @ts-ignore - testing runtime behavior with mismatched amounts
        service.handleInbandPaymentRequest(testMintUrl, request, handler, 200),
      ).rejects.toThrow(PaymentRequestError);
      await expect(
        // @ts-ignore
        service.handleInbandPaymentRequest(testMintUrl, request, handler, 200),
      ).rejects.toThrow('Amount mismatch');
    });
  });

  describe('handleHttpPaymentRequest', () => {
    it('should send token via HTTP POST with amount from request', async () => {
      const fetchCalls: Array<{ input: any; init?: any }> = [];
      // @ts-ignore
      globalThis.fetch = async (input: any, init?: RequestInit) => {
        fetchCalls.push({ input, init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      };

      const request = {
        transport: { type: 'http' as const, url: testHttpTarget },
        amount: 100,
        mints: [testMintUrl],
      };

      const response = await service.handleHttpPaymentRequest(testMintUrl, request);

      expect(mockTransactionService.send).toHaveBeenCalledWith(testMintUrl, 100);
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]?.input).toBe(testHttpTarget);
      expect(fetchCalls[0]?.init?.method).toBe('POST');
      expect(fetchCalls[0]?.init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(fetchCalls[0]?.init?.body).toBe(JSON.stringify(mockToken));
      expect(response.status).toBe(200);
    });

    it('should send token via HTTP POST with amount from parameter', async () => {
      const fetchCalls: Array<{ input: any; init?: any }> = [];
      // @ts-ignore
      globalThis.fetch = async (input: any, init?: RequestInit) => {
        fetchCalls.push({ input, init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      };

      const request = {
        transport: { type: 'http' as const, url: testHttpTarget },
        amount: undefined,
        mints: [testMintUrl],
      };

      await service.handleHttpPaymentRequest(testMintUrl, request, 250);

      expect(mockTransactionService.send).toHaveBeenCalledWith(testMintUrl, 250);
      expect(fetchCalls.length).toBe(1);
    });

    it('should return the fetch response', async () => {
      // @ts-ignore
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ received: true, id: 'payment-123' }), {
          status: 201,
          headers: { 'X-Payment-Id': 'payment-123' },
        });
      };

      const request = {
        transport: { type: 'http' as const, url: testHttpTarget },
        amount: 100,
      };

      const response = await service.handleHttpPaymentRequest(testMintUrl, request);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.received).toBe(true);
      expect(body.id).toBe('payment-123');
    });

    it('should throw if mint is not in allowed list', async () => {
      const request = {
        transport: { type: 'http' as const, url: testHttpTarget },
        amount: 100,
        mints: [testMintUrl2],
      };

      await expect(
        service.handleHttpPaymentRequest(testMintUrl, request),
      ).rejects.toThrow(PaymentRequestError);
    });

    it('should throw if no amount provided', async () => {
      const request = {
        transport: { type: 'http' as const, url: testHttpTarget },
        amount: undefined,
      };

      await expect(
        // @ts-ignore
        service.handleHttpPaymentRequest(testMintUrl, request),
      ).rejects.toThrow('Amount is required');
    });

    it('should throw if amounts do not match', async () => {
      const request = {
        transport: { type: 'http' as const, url: testHttpTarget },
        amount: 100,
      };

      await expect(
        // @ts-ignore
        service.handleHttpPaymentRequest(testMintUrl, request, 300),
      ).rejects.toThrow('Amount mismatch');
    });

    it('should not throw if fetch fails (returns response)', async () => {
      // @ts-ignore
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
      };

      const request = {
        transport: { type: 'http' as const, url: testHttpTarget },
        amount: 100,
      };

      const response = await service.handleHttpPaymentRequest(testMintUrl, request);

      expect(response.status).toBe(500);
    });
  });

  describe('end-to-end: read then handle', () => {
    it('should read and handle an inband payment request', async () => {
      const handler = mock(() => Promise.resolve());
      const pr = new PaymentRequest(
        [],
        'e2e-inband',
        500,
        'sat',
        [testMintUrl],
      );
      const encoded = pr.toEncodedRequest();

      const prepared = await service.readPaymentRequest(encoded);

      expect(prepared.transport.type).toBe('inband');
      if (prepared.transport.type === 'inband') {
        await service.handleInbandPaymentRequest(
          testMintUrl,
          prepared as typeof prepared & { amount: number },
          handler,
        );
      }

      expect(mockTransactionService.send).toHaveBeenCalledWith(testMintUrl, 500);
      expect(handler).toHaveBeenCalledWith(mockToken);
    });

    it('should read and handle an HTTP payment request', async () => {
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

      const prepared = await service.readPaymentRequest(encoded);

      expect(prepared.transport.type).toBe('http');
      if (prepared.transport.type === 'http') {
        const response = await service.handleHttpPaymentRequest(
          testMintUrl,
          prepared as typeof prepared & { amount: number },
        );
        expect(response.status).toBe(200);
      }

      expect(mockTransactionService.send).toHaveBeenCalledWith(testMintUrl, 750);
    });
  });
});

