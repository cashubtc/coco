import { Amount, JSONInt } from '@cashu/cashu-ts';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  PaymentRequest,
  PaymentRequestTransportType,
  type NUT10Option,
  type Token,
} from '@cashu/cashu-ts';
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
import type { MintService } from '../../services/MintService';
import { PaymentRequestError } from '../../models/Error';

describe('PaymentRequestService', () => {
  const testMintUrl = 'https://mint.test';
  const testMintUrl2 = 'https://mint2.test';
  const testHttpTarget = 'https://receiver.test/callback';

  let service: PaymentRequestService;
  let mockSendOperationService: SendOperationService;
  let mockProofService: ProofService;
  let mockMintService: MintService;
  const originalFetch = globalThis.fetch;

  const testPubkey = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
  const p2pkNut10 = (overrides: Partial<NUT10Option> = {}): NUT10Option => ({
    kind: 'P2PK',
    data: testPubkey,
    tags: [['sigflag', 'SIG_INPUTS']],
    ...overrides,
  });

  const mockPendingOperation: PendingSendOperation = {
    id: 'test-op-id',
    state: 'pending',
    mintUrl: testMintUrl,
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
  };

  const mockToken: Token = {
    mint: testMintUrl,
    proofs: [{ id: 'keyset-1', amount: Amount.from(100), secret: 'secret-1', C: 'C-1' }],
    unit: 'sat',
  };

  const createMockPreparedSendOperation = (
    mintUrl: string,
    amount: Amount,
    unit = 'sat',
    method: PreparedSendOperation['method'] = 'default',
    methodData: PreparedSendOperation['methodData'] = {},
  ): PreparedSendOperation => ({
    id: 'test-op-id',
    state: 'prepared',
    mintUrl,
    amount,
    unit,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    needsSwap: false,
    fee: Amount.from(0),
    inputAmount: amount,
    inputProofSecrets: ['secret-1'],
    method,
    methodData,
  });

  const createResolvedRequest = (
    options: {
      amount?: Amount;
      allowedMints?: string[];
      transport?: ResolvedPaymentRequest['transport'];
      unit?: string;
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
        options.unit ?? 'sat',
        allowedMints,
      ),
      payableMints: [...allowedMints],
      allowedMints,
      amount: options.amount,
      unit: options.unit ?? 'sat',
      transport,
    };
  };

  const createP2pkResolvedRequest = (
    options: {
      amount?: Amount;
      allowedMints?: string[];
      transport?: ResolvedPaymentRequest['transport'];
      unit?: string;
    } = {},
  ): ResolvedPaymentRequest => {
    const resolved = createResolvedRequest(options);
    return {
      ...resolved,
      paymentRequest: new PaymentRequest(
        resolved.paymentRequest.transport,
        resolved.paymentRequest.id,
        resolved.amount,
        resolved.unit,
        resolved.allowedMints,
        resolved.paymentRequest.description,
        resolved.paymentRequest.singleUse,
        p2pkNut10(),
      ),
      spendingCondition: {
        kind: 'P2PK',
        p2pk: {
          kind: 'P2PK',
          options: { pubkey: testPubkey },
          rawNut10: p2pkNut10(),
        },
      },
    };
  };

  const createPreparedRequest = (
    request: ResolvedPaymentRequest,
    mintUrl = testMintUrl,
  ): PreparedPaymentRequest => ({
    sendOperation: createMockPreparedSendOperation(mintUrl, request.amount ?? Amount.from(100)),
    request,
  });

  beforeEach(() => {
    mockSendOperationService = {
      init: mock(
        async (
          mintUrl: string,
          amountInput: { amount: Amount; unit: string },
          options: {
            method: PreparedSendOperation['method'];
            methodData: PreparedSendOperation['methodData'];
          } = { method: 'default', methodData: {} },
        ) => ({
          id: 'test-op-id',
          state: 'init',
          mintUrl,
          amount: amountInput.amount,
          unit: amountInput.unit,
          method: options.method,
          methodData: options.methodData,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      ),
      prepare: mock(
        async (initOp: {
          mintUrl: string;
          amount: Amount;
          unit: string;
          method?: PreparedSendOperation['method'];
          methodData?: PreparedSendOperation['methodData'];
        }) =>
          createMockPreparedSendOperation(
            initOp.mintUrl,
            initOp.amount,
            initOp.unit,
            initOp.method ?? 'default',
            initOp.methodData ?? {},
          ),
      ),
      execute: mock(async () => ({
        operation: mockPendingOperation,
        token: mockToken,
      })),
      rollback: mock(async () => undefined),
    } as unknown as SendOperationService;

    mockProofService = {
      getBalancesByMint: mock(async () => ({
        [testMintUrl]: {
          spendable: Amount.from(1000),
          reserved: Amount.zero(),
          total: Amount.from(1000),
          unit: 'sat',
        },
        [testMintUrl2]: {
          spendable: Amount.from(500),
          reserved: Amount.zero(),
          total: Amount.from(500),
          unit: 'sat',
        },
      })),
    } as unknown as ProofService;

    mockMintService = {
      supportsNut: mock(async (mintUrl: string, nut: 11) => nut === 11 && mintUrl === testMintUrl),
      assertNutSupported: mock(async (mintUrl: string, nut: 11) => {
        if (nut === 11 && mintUrl === testMintUrl) {
          return;
        }
        throw new Error(`NUT-11 unsupported by ${mintUrl}`);
      }),
    } as unknown as MintService;

    service = new PaymentRequestService(
      mockSendOperationService,
      mockProofService,
      mockMintService,
    );

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
      expect(result.amount).toEqual(Amount.from(100));
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
      expect(result.amount).toEqual(Amount.from(200));
      expect(result.allowedMints).toEqual([testMintUrl, testMintUrl2]);
    });

    it('should decode a payment request without amount', async () => {
      const pr = new PaymentRequest([], 'request-id-3', undefined, 'sat', [testMintUrl]);
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.transport.type).toBe('inband');
      expect(result.amount).toBeUndefined();
    });

    it('should expose a normalized P2PK spending condition requirement', async () => {
      const pr = new PaymentRequest(
        [],
        'request-id-p2pk',
        100,
        'sat',
        [testMintUrl],
        'P2PK payment',
        false,
        p2pkNut10(),
      );
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.spendingCondition).toEqual({
        kind: 'P2PK',
        p2pk: {
          kind: 'P2PK',
          options: { pubkey: testPubkey },
          rawNut10: p2pkNut10(),
        },
      });
      expect(result.payableMints).toEqual([testMintUrl]);
    });

    it('filters P2PK payable mints to trusted sufficient allowed mints with NUT-11 support', async () => {
      const pr = new PaymentRequest(
        [],
        'request-id-p2pk-filter',
        100,
        'sat',
        [testMintUrl, testMintUrl2],
        undefined,
        false,
        p2pkNut10(),
      );
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.payableMints).toEqual([testMintUrl]);
      expect(mockMintService.supportsNut).toHaveBeenCalledWith(testMintUrl, 11);
      expect(mockMintService.supportsNut).toHaveBeenCalledWith(testMintUrl2, 11);
    });

    it('returns no payable mints for P2PK requests when no matching mint advertises NUT-11', async () => {
      (mockMintService.supportsNut as unknown as ReturnType<typeof mock>).mockImplementation(
        async () => false,
      );
      const pr = new PaymentRequest(
        [],
        'request-id-p2pk-no-mints',
        100,
        'sat',
        [testMintUrl, testMintUrl2],
        undefined,
        false,
        p2pkNut10(),
      );
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.spendingCondition?.kind).toBe('P2PK');
      expect(result.payableMints).toEqual([]);
    });

    it('keeps unsupported NUT-10 requirements as diagnostics and returns no payable mints', async () => {
      const unsupportedNut10: NUT10Option = {
        kind: 'UNKNOWN',
        data: 'value',
        tags: [],
      };
      const pr = new PaymentRequest(
        [],
        'request-id-unsupported',
        100,
        'sat',
        [testMintUrl],
        undefined,
        false,
        unsupportedNut10,
      );
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.spendingCondition).toEqual({
        kind: 'unsupported',
        nut10Kind: 'UNKNOWN',
        reason: "Unsupported NUT-10 spending condition 'UNKNOWN'",
        rawNut10: unsupportedNut10,
      });
      expect(result.payableMints).toEqual([]);
      expect(mockMintService.supportsNut).not.toHaveBeenCalled();
    });

    it('keeps malformed P2PK requirements as diagnostics and returns no payable mints', async () => {
      const malformedNut10 = p2pkNut10({ data: '' });
      const pr = new PaymentRequest(
        [],
        'request-id-malformed',
        100,
        'sat',
        [testMintUrl],
        undefined,
        false,
        malformedNut10,
      );
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.spendingCondition).toEqual({
        kind: 'malformed',
        nut10Kind: 'P2PK',
        reason: 'NUT-10 P2PK option is missing its data field',
        rawNut10: malformedNut10,
      });
      expect(result.payableMints).toEqual([]);
      expect(mockMintService.supportsNut).not.toHaveBeenCalled();
    });

    it('should decode a Nostr payment request for plugin delivery', async () => {
      const pr = new PaymentRequest(
        [{ type: PaymentRequestTransportType.NOSTR, target: 'npub123...' }],
        'request-id-4',
        100,
        'sat',
      );
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.transport.type).toBe('nostr');
      if (result.transport.type === 'nostr') {
        expect(result.transport.target).toBe('npub123...');
      }
    });

    it('should require a plugin to execute Nostr payment requests', async () => {
      const request = createResolvedRequest({
        transport: { type: 'nostr', target: 'npub123...' },
      });
      const prepared = await service.prepare(request, {
        mintUrl: testMintUrl,
        amount: { amount: Amount.from(100), unit: 'sat' },
      });

      let thrown: unknown;
      try {
        await service.execute(prepared);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(PaymentRequestError);
      expect((thrown as Error).message).toBe(
        'Nostr payment request execution requires a transport plugin',
      );
      expect(mockSendOperationService.rollback).toHaveBeenCalledWith(
        prepared.sendOperation.id,
        'Nostr payment request execution requires a transport plugin',
      );
      expect(mockSendOperationService.execute).not.toHaveBeenCalled();
    });

    it('should return an empty payable mint list if no matching mints are found', async () => {
      (mockProofService.getBalancesByMint as unknown as ReturnType<typeof mock>).mockImplementation(
        async () => ({
          [testMintUrl]: {
            spendable: Amount.from(50),
            reserved: Amount.zero(),
            total: Amount.from(50),
            unit: 'sat',
          },
        }),
      );

      const pr = new PaymentRequest([], 'request-id-6', 100, 'sat', [testMintUrl]);
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.payableMints).toEqual([]);
      expect(result.allowedMints).toEqual([testMintUrl]);
      expect(result.amount).toEqual(Amount.from(100));
    });

    it('matches custom-unit payment requests against balances for that unit only', async () => {
      const pr = new PaymentRequest([], 'request-id-usd', 100, 'USD', [testMintUrl]);
      const encoded = pr.toEncodedRequest();

      const result = await service.parse(encoded);

      expect(result.unit).toBe('usd');
      expect(mockProofService.getBalancesByMint).toHaveBeenCalledWith({
        trustedOnly: true,
        units: ['usd'],
      });
      expect(result.payableMints).toEqual([testMintUrl]);
    });
  });

  describe('prepare', () => {
    it('should prepare a transaction for a valid request', async () => {
      const request = createResolvedRequest({ amount: Amount.from(100) });

      const transaction = await service.prepare(request, { mintUrl: testMintUrl });

      expect(transaction.sendOperation).toBeDefined();
      expect(transaction.sendOperation.mintUrl).toBe(testMintUrl);
      expect(transaction.request).toBe(request);
      expect(mockSendOperationService.init).toHaveBeenCalledWith(
        testMintUrl,
        {
          amount: Amount.from(100),
          unit: 'sat',
        },
        undefined,
      );
      expect(mockSendOperationService.prepare).toHaveBeenCalled();
    });

    it('should use amount from options if not in request', async () => {
      const request = createResolvedRequest({
        amount: undefined,
        allowedMints: [testMintUrl, testMintUrl2],
      });

      const transaction = await service.prepare(request, {
        mintUrl: testMintUrl,
        amount: { amount: Amount.from(750), unit: 'sat' },
      });

      expect(mockSendOperationService.init).toHaveBeenCalledWith(
        testMintUrl,
        {
          amount: Amount.from(750),
          unit: 'sat',
        },
        undefined,
      );
      expect(transaction.request).not.toBe(request);
      expect(transaction.request.amount).toEqual(Amount.from(750));
      expect(transaction.request.paymentRequest.amount).toEqual(Amount.from(750));
      expect(transaction.request.payableMints).toEqual([testMintUrl]);
    });

    it('recomputes P2PK-aware payable mints when preparing amountless requests', async () => {
      const paymentRequest = new PaymentRequest(
        [],
        'request-id-amountless-p2pk',
        undefined,
        'sat',
        [testMintUrl, testMintUrl2],
        undefined,
        false,
        p2pkNut10(),
      );
      const request: ResolvedPaymentRequest = {
        paymentRequest,
        payableMints: [],
        allowedMints: [testMintUrl, testMintUrl2],
        unit: 'sat',
        transport: { type: 'inband' },
        spendingCondition: {
          kind: 'P2PK',
          p2pk: {
            kind: 'P2PK',
            options: { pubkey: testPubkey },
            rawNut10: p2pkNut10(),
          },
        },
      };

      const transaction = await service.prepare(request, {
        mintUrl: testMintUrl,
        amount: { amount: Amount.from(100), unit: 'sat' },
      });

      expect(transaction.request).not.toBe(request);
      expect(transaction.request.amount).toEqual(Amount.from(100));
      expect(transaction.request.spendingCondition).toEqual(request.spendingCondition);
      expect(transaction.request.payableMints).toEqual([testMintUrl]);
      expect(mockMintService.supportsNut).toHaveBeenCalledWith(testMintUrl, 11);
      expect(mockMintService.supportsNut).toHaveBeenCalledWith(testMintUrl2, 11);
      expect(mockMintService.assertNutSupported).toHaveBeenCalledWith(
        testMintUrl,
        11,
        'payment request P2PK',
      );
      expect(mockSendOperationService.init).toHaveBeenCalledWith(
        testMintUrl,
        {
          amount: Amount.from(100),
          unit: 'sat',
        },
        {
          method: 'p2pk',
          methodData: {
            options: { pubkey: testPubkey },
          },
        },
      );
    });

    it('initializes P2PK send operations for valid P2PK payment requests', async () => {
      const paymentRequest = new PaymentRequest(
        [],
        'request-id-prepare-p2pk',
        100,
        'sat',
        [testMintUrl],
        undefined,
        false,
        p2pkNut10(),
      );
      const request: ResolvedPaymentRequest = {
        paymentRequest,
        payableMints: [testMintUrl],
        allowedMints: [testMintUrl],
        amount: Amount.from(100),
        unit: 'sat',
        transport: { type: 'inband' },
        spendingCondition: {
          kind: 'P2PK',
          p2pk: {
            kind: 'P2PK',
            options: { pubkey: testPubkey },
            rawNut10: p2pkNut10(),
          },
        },
      };

      const transaction = await service.prepare(request, { mintUrl: testMintUrl });

      expect(mockMintService.assertNutSupported).toHaveBeenCalledWith(
        testMintUrl,
        11,
        'payment request P2PK',
      );
      expect(mockSendOperationService.init).toHaveBeenCalledWith(
        testMintUrl,
        {
          amount: Amount.from(100),
          unit: 'sat',
        },
        {
          method: 'p2pk',
          methodData: {
            options: { pubkey: testPubkey },
          },
        },
      );
      expect(transaction.sendOperation.method).toBe('p2pk');
      expect(transaction.sendOperation.methodData).toEqual({ options: { pubkey: testPubkey } });
    });

    it('re-derives P2PK requirements during prepare when the cached condition is missing', async () => {
      const paymentRequest = new PaymentRequest(
        [],
        'request-id-prepare-p2pk-missing-condition',
        100,
        'sat',
        [testMintUrl],
        undefined,
        false,
        p2pkNut10(),
      );
      const request: ResolvedPaymentRequest = {
        paymentRequest,
        payableMints: [testMintUrl],
        allowedMints: [testMintUrl],
        amount: Amount.from(100),
        unit: 'sat',
        transport: { type: 'inband' },
      };

      const transaction = await service.prepare(request, { mintUrl: testMintUrl });

      expect(transaction.request).not.toBe(request);
      expect(transaction.request.spendingCondition?.kind).toBe('P2PK');
      expect(mockMintService.assertNutSupported).toHaveBeenCalledWith(
        testMintUrl,
        11,
        'payment request P2PK',
      );
      expect(mockSendOperationService.init).toHaveBeenCalledWith(
        testMintUrl,
        {
          amount: Amount.from(100),
          unit: 'sat',
        },
        {
          method: 'p2pk',
          methodData: {
            options: { pubkey: testPubkey },
          },
        },
      );
    });

    it('ignores stale cached spending conditions when the payment request has no NUT-10', async () => {
      const request: ResolvedPaymentRequest = {
        ...createResolvedRequest({ amount: Amount.from(100) }),
        spendingCondition: {
          kind: 'P2PK',
          p2pk: {
            kind: 'P2PK',
            options: { pubkey: testPubkey },
            rawNut10: p2pkNut10(),
          },
        },
      };

      const transaction = await service.prepare(request, { mintUrl: testMintUrl });

      expect(transaction.request).not.toBe(request);
      expect(transaction.request.spendingCondition).toBeUndefined();
      expect(mockMintService.assertNutSupported).not.toHaveBeenCalled();
      expect(mockSendOperationService.init).toHaveBeenCalledWith(
        testMintUrl,
        {
          amount: Amount.from(100),
          unit: 'sat',
        },
        undefined,
      );
    });

    it('rejects unsupported NUT-10 requirements before initializing a send operation', async () => {
      const unsupportedNut10: NUT10Option = { kind: 'UNKNOWN', data: 'value', tags: [] };
      const request: ResolvedPaymentRequest = {
        paymentRequest: new PaymentRequest(
          [],
          'request-id-unsupported-prepare',
          100,
          'sat',
          [testMintUrl],
          undefined,
          false,
          unsupportedNut10,
        ),
        payableMints: [],
        allowedMints: [testMintUrl],
        amount: Amount.from(100),
        unit: 'sat',
        transport: { type: 'inband' },
        spendingCondition: {
          kind: 'unsupported',
          nut10Kind: 'UNKNOWN',
          reason: "Unsupported NUT-10 spending condition 'UNKNOWN'",
          rawNut10: unsupportedNut10,
        },
      };

      await expect(service.prepare(request, { mintUrl: testMintUrl })).rejects.toThrow(
        "Unsupported NUT-10 spending condition 'UNKNOWN'",
      );
      expect(mockSendOperationService.init).not.toHaveBeenCalled();
      expect(mockMintService.assertNutSupported).not.toHaveBeenCalled();
    });

    it('rejects HTLC requirements before initializing a send operation', async () => {
      const htlcNut10: NUT10Option = { kind: 'HTLC', data: 'hash', tags: [] };
      const request: ResolvedPaymentRequest = {
        paymentRequest: new PaymentRequest(
          [],
          'request-id-htlc-prepare',
          100,
          'sat',
          [testMintUrl],
          undefined,
          false,
          htlcNut10,
        ),
        payableMints: [],
        allowedMints: [testMintUrl],
        amount: Amount.from(100),
        unit: 'sat',
        transport: { type: 'inband' },
      };

      await expect(service.prepare(request, { mintUrl: testMintUrl })).rejects.toThrow(
        "Unsupported NUT-10 spending condition 'HTLC'",
      );
      expect(mockSendOperationService.init).not.toHaveBeenCalled();
      expect(mockMintService.assertNutSupported).not.toHaveBeenCalled();
    });

    it('rejects malformed P2PK requirements before initializing a send operation', async () => {
      const malformedNut10 = p2pkNut10({ data: '' });
      const request: ResolvedPaymentRequest = {
        paymentRequest: new PaymentRequest(
          [],
          'request-id-malformed-prepare',
          100,
          'sat',
          [testMintUrl],
          undefined,
          false,
          malformedNut10,
        ),
        payableMints: [],
        allowedMints: [testMintUrl],
        amount: Amount.from(100),
        unit: 'sat',
        transport: { type: 'inband' },
        spendingCondition: {
          kind: 'malformed',
          nut10Kind: 'P2PK',
          reason: 'NUT-10 P2PK option is missing its data field',
          rawNut10: malformedNut10,
        },
      };

      await expect(service.prepare(request, { mintUrl: testMintUrl })).rejects.toThrow(
        "Malformed NUT-10 spending condition 'P2PK': NUT-10 P2PK option is missing its data field",
      );
      expect(mockSendOperationService.init).not.toHaveBeenCalled();
      expect(mockMintService.assertNutSupported).not.toHaveBeenCalled();
    });

    it('wraps malformed P2PK helper failures as PaymentRequestError causes during prepare', async () => {
      const malformedNut10 = p2pkNut10({ data: '' });
      const request: ResolvedPaymentRequest = {
        paymentRequest: new PaymentRequest(
          [],
          'request-id-malformed-helper',
          100,
          'sat',
          [testMintUrl],
          undefined,
          false,
          malformedNut10,
        ),
        payableMints: [testMintUrl],
        allowedMints: [testMintUrl],
        amount: Amount.from(100),
        unit: 'sat',
        transport: { type: 'inband' },
        spendingCondition: {
          kind: 'P2PK',
          p2pk: {
            kind: 'P2PK',
            options: { pubkey: testPubkey },
            rawNut10: malformedNut10,
          },
        },
      };

      let thrown: unknown;
      try {
        await service.prepare(request, { mintUrl: testMintUrl });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PaymentRequestError);
      expect((thrown as Error).message).toBe(
        "Malformed NUT-10 spending condition 'P2PK': NUT-10 P2PK option is missing its data field",
      );
      expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(Error);
      expect(mockSendOperationService.init).not.toHaveBeenCalled();
    });

    it('rejects selected mints without NUT-11 support before initializing a send operation', async () => {
      const unsupportedError = new Error('NUT-11 unsupported');
      (mockMintService.assertNutSupported as unknown as ReturnType<typeof mock>).mockRejectedValue(
        unsupportedError,
      );
      const paymentRequest = new PaymentRequest(
        [],
        'request-id-p2pk-mint-unsupported',
        100,
        'sat',
        [testMintUrl],
        undefined,
        false,
        p2pkNut10(),
      );
      const request: ResolvedPaymentRequest = {
        paymentRequest,
        payableMints: [testMintUrl],
        allowedMints: [testMintUrl],
        amount: Amount.from(100),
        unit: 'sat',
        transport: { type: 'inband' },
        spendingCondition: {
          kind: 'P2PK',
          p2pk: {
            kind: 'P2PK',
            options: { pubkey: testPubkey },
            rawNut10: p2pkNut10(),
          },
        },
      };

      let thrown: unknown;
      try {
        await service.prepare(request, { mintUrl: testMintUrl });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PaymentRequestError);
      expect((thrown as Error).message).toBe(
        `Mint ${testMintUrl} does not support NUT-11 required by payment request P2PK`,
      );
      expect((thrown as { cause?: unknown }).cause).toBe(unsupportedError);
      expect(mockSendOperationService.init).not.toHaveBeenCalled();
    });

    it('should throw if mint is not in allowed list', async () => {
      const request = createResolvedRequest({
        amount: Amount.from(100),
        allowedMints: [testMintUrl2],
      });

      await expect(service.prepare(request, { mintUrl: testMintUrl })).rejects.toThrow(
        PaymentRequestError,
      );
      await expect(service.prepare(request, { mintUrl: testMintUrl })).rejects.toThrow(
        'is not in the allowed mints list',
      );
    });

    it('should allow any mint if allowedMints is empty', async () => {
      const request = createResolvedRequest({ amount: Amount.from(100), allowedMints: [] });

      await service.prepare(request, { mintUrl: testMintUrl });

      expect(mockSendOperationService.init).toHaveBeenCalledWith(
        testMintUrl,
        {
          amount: Amount.from(100),
          unit: 'sat',
        },
        undefined,
      );
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
      const request = createResolvedRequest({ amount: Amount.from(100) });

      await expect(
        service.prepare(request, {
          mintUrl: testMintUrl,
          amount: { amount: Amount.from(200), unit: 'sat' },
        }),
      ).rejects.toThrow(PaymentRequestError);
      await expect(
        service.prepare(request, {
          mintUrl: testMintUrl,
          amount: { amount: Amount.from(200), unit: 'sat' },
        }),
      ).rejects.toThrow('Amount mismatch');
    });

    it('rejects a sat amount override for a custom-unit request', async () => {
      const request = createResolvedRequest({ amount: undefined, unit: 'usd' });

      await expect(
        service.prepare(request, {
          mintUrl: testMintUrl,
          amount: { amount: Amount.from(100), unit: 'sat' },
        }),
      ).rejects.toThrow('Unit mismatch');
    });

    it('prepares send operations in the request unit', async () => {
      const request = createResolvedRequest({ amount: Amount.from(100), unit: 'usd' });

      const transaction = await service.prepare(request, { mintUrl: testMintUrl });

      expect(mockSendOperationService.init).toHaveBeenCalledWith(
        testMintUrl,
        {
          amount: Amount.from(100),
          unit: 'usd',
        },
        undefined,
      );
      expect(transaction.sendOperation.unit).toBe('usd');
    });
  });

  describe('execute', () => {
    it('should execute an inband payment request and return the token', async () => {
      const prepared = createPreparedRequest(createResolvedRequest({ amount: Amount.from(100) }));

      const result = await service.execute(prepared);

      expect(mockSendOperationService.execute).toHaveBeenCalledWith(prepared.sendOperation);
      expect(result.type).toBe('inband');
      if (result.type === 'inband') {
        expect(result.token).toBe(mockToken);
        expect(result.operation).toBe(mockPendingOperation);
      }
    });

    it('should execute an inband P2PK payment request without changing token delivery', async () => {
      const request = createP2pkResolvedRequest({ amount: Amount.from(100) });
      const prepared: PreparedPaymentRequest = {
        sendOperation: createMockPreparedSendOperation(
          testMintUrl,
          Amount.from(100),
          'sat',
          'p2pk',
          { options: { pubkey: testPubkey } },
        ),
        request,
      };

      const result = await service.execute(prepared);

      expect(mockSendOperationService.execute).toHaveBeenCalledWith(prepared.sendOperation);
      expect(mockSendOperationService.rollback).not.toHaveBeenCalled();
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
          amount: Amount.from(100),
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
      expect(fetchCalls[0]?.init?.body).toBe(JSONInt.stringify(mockToken));
      expect(fetchCalls[0]?.init?.body).not.toContain('"amount":"100"');
      if (result.type === 'http') {
        expect(result.response.status).toBe(200);
        expect(result.operation).toBe(mockPendingOperation);
      }
    });

    it('should execute an HTTP P2PK payment request without changing POST payload format', async () => {
      const fetchCalls: Array<{ input: string; init?: RequestInit }> = [];
      // @ts-ignore
      globalThis.fetch = async (input: string, init?: RequestInit) => {
        fetchCalls.push({ input, init });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      };

      const request = createP2pkResolvedRequest({
        amount: Amount.from(100),
        transport: { type: 'http', url: testHttpTarget },
      });
      const prepared: PreparedPaymentRequest = {
        sendOperation: createMockPreparedSendOperation(
          testMintUrl,
          Amount.from(100),
          'sat',
          'p2pk',
          { options: { pubkey: testPubkey } },
        ),
        request,
      };

      const result = await service.execute(prepared);

      expect(mockSendOperationService.execute).toHaveBeenCalledWith(prepared.sendOperation);
      expect(result.type).toBe('http');
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.input).toBe(testHttpTarget);
      expect(fetchCalls[0]?.init?.method).toBe('POST');
      expect(fetchCalls[0]?.init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(fetchCalls[0]?.init?.body).toBe(JSONInt.stringify(mockToken));
      if (result.type === 'http') {
        expect(result.response.status).toBe(200);
        expect(result.operation).toBe(mockPendingOperation);
      }
    });

    it('should keep Nostr P2PK payment request execution plugin-owned and roll back', async () => {
      const request = createP2pkResolvedRequest({
        amount: Amount.from(100),
        transport: { type: 'nostr', target: 'npub123...' },
      });
      const prepared: PreparedPaymentRequest = {
        sendOperation: createMockPreparedSendOperation(
          testMintUrl,
          Amount.from(100),
          'sat',
          'p2pk',
          { options: { pubkey: testPubkey } },
        ),
        request,
      };

      let thrown: unknown;
      try {
        await service.execute(prepared);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PaymentRequestError);
      expect((thrown as Error).message).toBe(
        'Nostr payment request execution requires a transport plugin',
      );
      expect(mockSendOperationService.rollback).toHaveBeenCalledWith(
        prepared.sendOperation.id,
        'Nostr payment request execution requires a transport plugin',
      );
      expect(mockSendOperationService.execute).not.toHaveBeenCalled();
    });

    it('should return fetch error responses without throwing', async () => {
      // @ts-ignore
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });

      const prepared = createPreparedRequest(
        createResolvedRequest({
          amount: Amount.from(100),
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
