import {
  Amount,
  PaymentRequest,
  PaymentRequestTransportType,
  type PaymentRequestPayload,
} from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { PaymentRequestReceiveService } from '../../services/PaymentRequestReceiveService';
import {
  OperationInProgressError,
  PaymentRequestError,
  ProofValidationError,
} from '../../models/Error';
import type { MintService } from '../../services/MintService';
import type { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService';
import type {
  FinalizedReceiveOperation,
  InitReceiveOperation,
  PreparedReceiveOperation,
  ReceiveOperation,
  ReceiveOperationSource,
} from '../../operations/receive/ReceiveOperation';
import type { ParsedPaymentRequestPayload } from '../../operations/paymentRequestReceive/PaymentRequestReceiveOperation';
import {
  MemoryPaymentRequestReceiveAttemptRepository,
  MemoryPaymentRequestReceiveOperationRepository,
} from '../../repositories/memory';

describe('PaymentRequestReceiveService', () => {
  const mintUrl = 'https://mint.test';
  const nostrTarget = [
    'nprofile1qqsqzqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgp',
    'zpmhxue69uhhyetvv9ujuar9wd6qymamsk',
  ].join('');
  let operationRepository: MemoryPaymentRequestReceiveOperationRepository;
  let attemptRepository: MemoryPaymentRequestReceiveAttemptRepository;
  let mintService: MintService;
  let receiveOperationService: ReceiveOperationService;
  let service: PaymentRequestReceiveService;

  function createPayload(overrides: Partial<PaymentRequestPayload> = {}): PaymentRequestPayload {
    return {
      id: 'request-id',
      mint: mintUrl,
      unit: 'sat',
      proofs: [{ id: 'keyset-id', amount: Amount.from(100), secret: 'secret-1', C: 'C-1' }],
      ...overrides,
    };
  }

  function createPreparedReceiveOperation(
    overrides: Partial<PreparedReceiveOperation> = {},
  ): PreparedReceiveOperation {
    const now = Date.now();
    return {
      id: 'receive-op-prepared',
      state: 'prepared',
      mintUrl,
      unit: 'sat',
      amount: Amount.from(100),
      inputProofs: createPayload().proofs,
      fee: Amount.from(1),
      outputData: { keep: [], send: [] },
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function createInitReceiveOperation(
    overrides: Partial<InitReceiveOperation> = {},
  ): InitReceiveOperation {
    const now = Date.now();
    return {
      id: 'receive-op-init',
      state: 'init',
      mintUrl,
      unit: 'sat',
      amount: Amount.from(100),
      inputProofs: createPayload().proofs,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  beforeEach(() => {
    operationRepository = new MemoryPaymentRequestReceiveOperationRepository();
    attemptRepository = new MemoryPaymentRequestReceiveAttemptRepository();
    mintService = {
      isTrustedMint: mock(async () => true),
    } as unknown as MintService;
    receiveOperationService = {
      init: mock(async (_token, source?: ReceiveOperationSource): Promise<InitReceiveOperation> => {
        return {
          id: 'receive-op-1',
          state: 'init',
          mintUrl,
          unit: 'sat',
          amount: Amount.from(100),
          inputProofs: createPayload().proofs,
          source,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }),
      prepare: mock(async (operation: InitReceiveOperation): Promise<PreparedReceiveOperation> => {
        return {
          ...operation,
          state: 'prepared',
          fee: Amount.from(1),
          outputData: { keep: [], send: [] },
        };
      }),
      execute: mock(
        async (operation: PreparedReceiveOperation): Promise<FinalizedReceiveOperation> => {
          return {
            ...operation,
            state: 'finalized',
          };
        },
      ),
      getOperation: mock(async () => null),
      getOperationByPaymentRequestAttemptId: mock(async () => null),
      recoverPendingOperations: mock(async () => undefined),
    } as unknown as ReceiveOperationService;

    service = new PaymentRequestReceiveService(
      operationRepository,
      attemptRepository,
      receiveOperationService,
      mintService,
    );
  });

  it('creates active CREQB payment requests by default', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      unit: 'sat',
      mints: [mintUrl],
      requestId: 'request-id',
      description: 'test request',
    });

    expect(operation.state).toBe('active');
    expect(operation.encodedRequest).toStartWith('CREQB');
    expect(operation.requestId).toBe('request-id');
  });

  it('creates custom-unit payment requests from coupled amount input', async () => {
    const operation = await service.create({
      amount: { amount: Amount.from(5), unit: 'USD' },
      mints: [mintUrl],
      requestId: 'request-id',
      description: 'test request',
    });

    const decoded = PaymentRequest.fromEncodedRequest(operation.encodedRequest);
    expect(operation.unit).toBe('usd');
    expect(operation.amount).toEqual(Amount.from(5));
    expect(decoded.unit).toBe('usd');
    expect(decoded.amount).toEqual(Amount.from(5));
  });

  it('rejects duplicate active request ids', async () => {
    await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });

    await expect(
      service.create({
        amount: Amount.from(100),
        mints: [mintUrl],
        requestId: 'request-id',
      }),
    ).rejects.toThrow('An active payment request already exists for request id request-id');
  });

  it('serializes concurrent creates for the same request id', async () => {
    const results = await Promise.allSettled([
      service.create({
        amount: Amount.from(100),
        mints: [mintUrl],
        requestId: 'request-id',
      }),
      service.create({
        amount: Amount.from(100),
        mints: [mintUrl],
        requestId: 'request-id',
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    const active = await operationRepository.getActiveByRequestId('request-id');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(active).toHaveLength(1);
  });

  it('creates and activates Nostr payment requests through a registered handler', async () => {
    const createRequestTransport = mock(async () => ({
      type: PaymentRequestTransportType.NOSTR,
      target: nostrTarget,
      tags: [['n', '17']],
    }));
    const activate = mock(async () => undefined);
    const deactivate = mock(async () => undefined);
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      createRequestTransport,
      activate,
      deactivate,
    });

    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
      transport: 'nostr',
    });

    expect(operation.transport).toBe('nostr');
    expect(operation.state).toBe('active');
    expect(createRequestTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-id',
        unit: 'sat',
        singleUse: true,
      }),
    );
    const decoded = PaymentRequest.fromEncodedRequest(operation.encodedRequest);
    expect(decoded.getTransport(PaymentRequestTransportType.NOSTR)?.target).toBe(nostrTarget);
    expect(decoded.getTransport(PaymentRequestTransportType.NOSTR)?.tags).toEqual([['n', '17']]);
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ id: operation.id }));
    expect(activate).toHaveBeenCalledTimes(1);

    unregister();
  });

  it('passes custom units to registered transport handlers', async () => {
    const createRequestTransport = mock(async () => ({
      type: PaymentRequestTransportType.NOSTR,
      target: nostrTarget,
    }));
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      createRequestTransport,
      activate: mock(async () => undefined),
      deactivate: mock(async () => undefined),
    });

    await service.create({
      amount: Amount.from(5),
      unit: 'USD',
      mints: [mintUrl],
      requestId: 'request-id',
      transport: 'nostr',
    });

    expect(createRequestTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        unit: 'usd',
        amount: Amount.from(5),
      }),
    );

    unregister();
  });

  it('records a cancelled operation when transport activation fails', async () => {
    const createRequestTransport = mock(async () => ({
      type: PaymentRequestTransportType.NOSTR,
      target: nostrTarget,
    }));
    const deactivate = mock(async () => undefined);
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      createRequestTransport,
      activate: mock(async () => {
        throw new Error('subscription failed');
      }),
      deactivate,
    });

    await expect(
      service.create({
        amount: Amount.from(100),
        mints: [mintUrl],
        requestId: 'request-id',
        transport: 'nostr',
      }),
    ).rejects.toThrow('subscription failed');

    const cancelled = await operationRepository.list({ state: 'cancelled' });
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.requestId).toBe('request-id');
    expect(cancelled[0]!.error).toBe('subscription failed');
    expect(deactivate).toHaveBeenCalledWith(expect.objectContaining({ id: cancelled[0]!.id }));

    unregister();
  });

  it('cancels requests when activation only created rejected attempts before failing', async () => {
    const createRequestTransport = mock(async () => ({
      type: PaymentRequestTransportType.NOSTR,
      target: nostrTarget,
    }));
    const deactivate = mock(async () => undefined);
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      createRequestTransport,
      activate: mock(async (operation) => {
        await service.claimPayload(operation.id, createPayload(), {
          transport: 'nostr',
          transportMessageId: 'nostr-event-1',
        });
        throw new Error('subscription failed after rejected payload');
      }),
      deactivate,
    });

    await expect(
      service.create({
        amount: Amount.from(200),
        mints: [mintUrl],
        requestId: 'request-id',
        transport: 'nostr',
      }),
    ).rejects.toThrow('subscription failed after rejected payload');

    const cancelled = await operationRepository.list({ state: 'cancelled' });
    expect(cancelled).toHaveLength(1);
    expect((await attemptRepository.getByRequestOperationId(cancelled[0]!.id))[0]?.state).toBe(
      'rejected',
    );
    expect(deactivate).toHaveBeenCalledWith(expect.objectContaining({ id: cancelled[0]!.id }));

    unregister();
    const recreated = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    expect(recreated.state).toBe('active');
  });

  it('does not cancel a request completed during transport activation', async () => {
    const createRequestTransport = mock(async () => ({
      type: PaymentRequestTransportType.NOSTR,
      target: nostrTarget,
    }));
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      createRequestTransport,
      activate: mock(async (operation) => {
        await service.claimPayload(operation.id, createPayload(), {
          transport: 'nostr',
          transportMessageId: 'nostr-event-1',
        });
        throw new Error('subscription failed after payment');
      }),
      deactivate: mock(async () => undefined),
    });

    await expect(
      service.create({
        amount: Amount.from(100),
        mints: [mintUrl],
        requestId: 'request-id',
        transport: 'nostr',
      }),
    ).rejects.toThrow('subscription failed after payment');

    const completed = await operationRepository.list({ state: 'completed' });
    expect(completed).toHaveLength(1);
    expect(completed[0]!.requestId).toBe('request-id');
    expect((await attemptRepository.getByRequestOperationId(completed[0]!.id))[0]?.state).toBe(
      'finalized',
    );

    unregister();
  });

  it('returns the latest operation when transport activation completes the request', async () => {
    const createRequestTransport = mock(async () => ({
      type: PaymentRequestTransportType.NOSTR,
      target: nostrTarget,
    }));
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      createRequestTransport,
      activate: mock(async (operation) => {
        await service.claimPayload(operation.id, createPayload(), {
          transport: 'nostr',
          transportMessageId: 'nostr-event-1',
        });
      }),
      deactivate: mock(async () => undefined),
    });

    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
      transport: 'nostr',
    });

    expect(operation.state).toBe('completed');
    expect((await operationRepository.getById(operation.id))?.state).toBe('completed');

    unregister();
  });

  it('cancels restored non-inband requests without a transport handler', async () => {
    const now = Date.now();
    await operationRepository.create({
      id: 'operation-1',
      requestId: 'request-id',
      encodedRequest: 'CREQB-test',
      state: 'active',
      transport: 'nostr',
      amount: Amount.from(100),
      unit: 'sat',
      mints: [mintUrl],
      singleUse: true,
      createdAt: now,
      updatedAt: now,
    });

    const cancelled = await service.cancel('operation-1', 'stale plugin request');

    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.error).toBe('stale plugin request');
    expect((await operationRepository.getById('operation-1'))?.state).toBe('cancelled');
  });

  it('persists cancellation before best-effort transport deactivation', async () => {
    const now = Date.now();
    await operationRepository.create({
      id: 'operation-1',
      requestId: 'request-id',
      encodedRequest: 'CREQB-test',
      state: 'active',
      transport: 'nostr',
      amount: Amount.from(100),
      unit: 'sat',
      mints: [mintUrl],
      singleUse: true,
      createdAt: now,
      updatedAt: now,
    });
    const deactivate = mock(async (operation) => {
      expect((await operationRepository.getById(operation.id))?.state).toBe('cancelled');
      throw new Error('unsubscribe failed');
    });
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      activate: mock(async () => undefined),
      deactivate,
    });

    const cancelled = await service.cancel('operation-1', 'user cancelled');

    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.error).toBe('user cancelled');
    expect((await operationRepository.getById('operation-1'))?.state).toBe('cancelled');
    expect(deactivate).toHaveBeenCalledTimes(1);

    unregister();
  });

  it('claims a valid payload through a child receive operation', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });

    const result = await service.claimPayload(operation.id, createPayload(), {
      transport: 'inband',
      transportMessageId: 'message-1',
    });

    expect(result.operation.state).toBe('completed');
    expect(result.attempt.state).toBe('finalized');
    expect(result.attempt.receiveOperationId).toBe('receive-op-1');
    expect(result.attempt.fee?.equals(Amount.from(1))).toBe(true);
    expect(result.attempt.netAmount?.equals(Amount.from(99))).toBe(true);
    expect(receiveOperationService.init).toHaveBeenCalledWith(
      expect.objectContaining({ mint: mintUrl }),
      expect.objectContaining({
        type: 'payment-request',
        requestOperationId: operation.id,
        attemptId: result.attempt.id,
      }),
    );
  });

  it('claims custom-unit payloads through the child receive operation', async () => {
    const operation = await service.create({
      amount: { amount: Amount.from(100), unit: 'USD' },
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload({ unit: 'USD' });

    const result = await service.claimPayload(operation.id, payload);

    expect(result.operation.state).toBe('completed');
    expect(result.operation.unit).toBe('usd');
    expect(result.attempt.state).toBe('finalized');
    expect(result.attempt.unit).toBe('usd');
    expect(receiveOperationService.init).toHaveBeenCalledWith(
      {
        mint: mintUrl,
        unit: 'usd',
        proofs: payload.proofs,
      },
      expect.objectContaining({
        type: 'payment-request',
        requestOperationId: operation.id,
        attemptId: result.attempt.id,
      }),
    );
  });

  it('does not cancel an operation while a payload claim is in progress', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    let resolveInit: ((operation: InitReceiveOperation) => void) | undefined;
    const initBlocked = new Promise<InitReceiveOperation>((resolve) => {
      resolveInit = resolve;
    });
    const initStarted = new Promise<void>((resolve) => {
      (receiveOperationService.init as unknown as ReturnType<typeof mock>).mockImplementationOnce(
        async (_token, source?: ReceiveOperationSource): Promise<InitReceiveOperation> => {
          resolve();
          return {
            ...(await initBlocked),
            source,
          };
        },
      );
    });

    const claim = service.claimPayload(operation.id, createPayload());
    await initStarted;

    await expect(service.cancel(operation.id)).rejects.toThrow(OperationInProgressError);

    resolveInit?.({
      id: 'receive-op-1',
      state: 'init',
      mintUrl,
      unit: 'sat',
      amount: Amount.from(100),
      inputProofs: createPayload().proofs,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const result = await claim;

    expect(result.operation.state).toBe('completed');
    expect((await operationRepository.getById(operation.id))?.state).toBe('completed');
  });

  it('returns the existing finalized attempt for duplicate payload delivery', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();

    const first = await service.claimPayload(operation.id, payload);
    const second = await service.claimPayload(operation.id, payload);

    expect(second.attempt.id).toBe(first.attempt.id);
    expect(receiveOperationService.init).toHaveBeenCalledTimes(1);
  });

  it('returns the finalized attempt for duplicate payload ingestion after completion', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();

    const first = await service.ingestPayload(payload);
    expect(first.operation.state).toBe('completed');

    const second = await service.ingestPayload(payload);

    expect(second.operation.id).toBe(operation.id);
    expect(second.operation.state).toBe('completed');
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(receiveOperationService.init).toHaveBeenCalledTimes(1);
  });

  it('does not return in-flight attempts for duplicate payload ingestion', async () => {
    await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    let resolveInit: ((operation: InitReceiveOperation) => void) | undefined;
    const initBlocked = new Promise<InitReceiveOperation>((resolve) => {
      resolveInit = resolve;
    });
    const initStarted = new Promise<void>((resolve) => {
      (receiveOperationService.init as unknown as ReturnType<typeof mock>).mockImplementationOnce(
        async (_token, source?: ReceiveOperationSource): Promise<InitReceiveOperation> => {
          resolve();
          return {
            ...(await initBlocked),
            source,
          };
        },
      );
    });
    const payload = createPayload();

    const first = service.ingestPayload(payload, {
      transport: 'nostr',
      transportMessageId: 'nostr-event-1',
    });
    await initStarted;

    await expect(service.ingestPayload(payload)).rejects.toThrow(OperationInProgressError);

    resolveInit?.({
      id: 'receive-op-1',
      state: 'init',
      mintUrl,
      unit: 'sat',
      amount: Amount.from(100),
      inputProofs: createPayload().proofs,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const result = await first;
    expect(result.attempt.state).toBe('finalized');
  });

  it('scopes ingestion payload dedupe to the active operation when request ids are reused', async () => {
    const oldOperation = await service.create({
      amount: Amount.from(200),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();

    const rejected = await service.claimPayload(oldOperation.id, payload);
    expect(rejected.attempt.state).toBe('rejected');
    await service.cancel(oldOperation.id);

    const newOperation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });

    const result = await service.ingestPayload(payload);

    expect(result.operation.id).toBe(newOperation.id);
    expect(result.operation.state).toBe('completed');
    expect(result.attempt.state).toBe('finalized');
    expect(result.attempt.requestOperationId).toBe(newOperation.id);
  });

  it('returns old finalized attempts before binding reused request ids to active operations', async () => {
    const oldOperation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();

    const first = await service.ingestPayload(payload);
    expect(first.operation.state).toBe('completed');

    const newOperation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const redelivery = await service.ingestPayload(payload);

    expect(redelivery.operation.id).toBe(oldOperation.id);
    expect(redelivery.operation.state).toBe('completed');
    expect(redelivery.attempt.id).toBe(first.attempt.id);
    expect((await operationRepository.getById(newOperation.id))?.state).toBe('active');
    expect(receiveOperationService.init).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused transport message id with a different payload during ingestion', async () => {
    await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });

    await service.ingestPayload(createPayload(), {
      transport: 'inband',
      transportMessageId: 'message-1',
    });

    await expect(
      service.ingestPayload(
        createPayload({
          proofs: [{ id: 'keyset-id', amount: Amount.from(100), secret: 'secret-2', C: 'C-2' }],
        }),
        {
          transport: 'inband',
          transportMessageId: 'message-1',
        },
      ),
    ).rejects.toThrow('belongs to a different payload');
  });

  it('records a rejected attempt for an underpaid payload', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });

    const result = await service.claimPayload(
      operation.id,
      createPayload({
        proofs: [{ id: 'keyset-id', amount: Amount.from(50), secret: 'secret-2', C: 'C-2' }],
      }),
    );

    expect(result.operation.state).toBe('active');
    expect(result.attempt.state).toBe('rejected');
    expect(result.attempt.error).toContain('below requested amount');
    expect(receiveOperationService.init).not.toHaveBeenCalled();
  });

  it('blocks new payloads while a single-use request has an in-flight attempt', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const now = Date.now();
    await attemptRepository.create({
      id: 'attempt-in-flight',
      requestOperationId: operation.id,
      requestId: operation.requestId,
      transport: 'inband',
      payloadHash: 'in-flight-payload-hash',
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      state: 'receiving',
      receiveOperationId: 'receive-op-in-flight',
      createdAt: now,
      updatedAt: now,
    });

    const result = await service.claimPayload(
      operation.id,
      createPayload({
        proofs: [{ id: 'keyset-id', amount: Amount.from(100), secret: 'secret-2', C: 'C-2' }],
      }),
    );

    expect(result.attempt.state).toBe('rejected');
    expect(result.attempt.error).toContain('in-flight claim');
    expect(receiveOperationService.init).not.toHaveBeenCalled();
  });

  it('rejects a reused transport message id from a different request', async () => {
    const firstOperation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const secondOperation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id-2',
    });

    await service.claimPayload(firstOperation.id, createPayload(), {
      transport: 'inband',
      transportMessageId: 'message-1',
    });

    await expect(
      service.claimPayload(
        secondOperation.id,
        createPayload({
          id: 'request-id-2',
          proofs: [{ id: 'keyset-id', amount: Amount.from(100), secret: 'secret-2', C: 'C-2' }],
        }),
        {
          transport: 'inband',
          transportMessageId: 'message-1',
        },
      ),
    ).rejects.toThrow('belongs to another payment request receive operation');
  });

  it('rejects a reused transport message id with a different payload during direct claim', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });

    await service.claimPayload(operation.id, createPayload(), {
      transport: 'inband',
      transportMessageId: 'message-1',
    });

    await expect(
      service.claimPayload(
        operation.id,
        createPayload({
          proofs: [{ id: 'keyset-id', amount: Amount.from(100), secret: 'secret-2', C: 'C-2' }],
        }),
        {
          transport: 'inband',
          transportMessageId: 'message-1',
        },
      ),
    ).rejects.toThrow('belongs to a different payload');
  });

  it('deactivates non-inband transports when single-use requests complete', async () => {
    const createRequestTransport = mock(async () => ({
      type: PaymentRequestTransportType.NOSTR,
      target: nostrTarget,
    }));
    const activate = mock(async () => undefined);
    const deactivate = mock(async () => undefined);
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      createRequestTransport,
      activate,
      deactivate,
    });

    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
      transport: 'nostr',
    });

    const result = await service.claimPayload(operation.id, createPayload(), {
      transport: 'nostr',
      transportMessageId: 'nostr-event-1',
    });

    expect(result.operation.state).toBe('completed');
    expect(deactivate).toHaveBeenCalledWith(expect.objectContaining({ id: operation.id }));
    expect(deactivate).toHaveBeenCalledTimes(1);

    unregister();
  });

  it('persists completion before best-effort transport deactivation', async () => {
    const createRequestTransport = mock(async () => ({
      type: PaymentRequestTransportType.NOSTR,
      target: nostrTarget,
    }));
    const activate = mock(async () => undefined);
    const deactivate = mock(async (completedOperation) => {
      expect((await operationRepository.getById(completedOperation.id))?.state).toBe('completed');
      throw new Error('unsubscribe failed');
    });
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      createRequestTransport,
      activate,
      deactivate,
    });

    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
      transport: 'nostr',
    });

    const result = await service.claimPayload(operation.id, createPayload(), {
      transport: 'nostr',
      transportMessageId: 'nostr-event-1',
    });

    expect(result.operation.state).toBe('completed');
    expect((await operationRepository.getById(operation.id))?.state).toBe('completed');
    expect(deactivate).toHaveBeenCalledTimes(1);

    unregister();
  });

  it('continues startup recovery when an active transport cannot reactivate', async () => {
    const now = Date.now();
    await operationRepository.create({
      id: 'operation-1',
      requestId: 'request-id',
      encodedRequest: 'CREQB-test',
      state: 'active',
      transport: 'nostr',
      amount: Amount.from(100),
      unit: 'sat',
      mints: [mintUrl],
      singleUse: true,
      createdAt: now,
      updatedAt: now,
    });

    await service.recoverPendingAttempts();

    expect(receiveOperationService.recoverPendingOperations).toHaveBeenCalledTimes(1);
    expect((await operationRepository.getById('operation-1'))?.state).toBe('active');
  });

  it('preserves attempts created during transport reactivation', async () => {
    const now = Date.now();
    const order: string[] = [];
    await operationRepository.create({
      id: 'operation-1',
      requestId: 'request-id',
      encodedRequest: 'CREQB-test',
      state: 'active',
      transport: 'nostr',
      amount: Amount.from(100),
      unit: 'sat',
      mints: [mintUrl],
      singleUse: true,
      createdAt: now,
      updatedAt: now,
    });

    let resolveInit: ((operation: InitReceiveOperation) => void) | undefined;
    const initBlocked = new Promise<InitReceiveOperation>((resolve) => {
      resolveInit = resolve;
    });
    const initStarted = new Promise<void>((resolve) => {
      (receiveOperationService.init as unknown as ReturnType<typeof mock>).mockImplementationOnce(
        async (_token, source?: ReceiveOperationSource): Promise<InitReceiveOperation> => {
          resolve();
          return initBlocked.then((operation) => ({ ...operation, source }));
        },
      );
    });
    let ingestPromise: ReturnType<PaymentRequestReceiveService['ingestPayload']> | undefined;
    (
      receiveOperationService.recoverPendingOperations as unknown as ReturnType<typeof mock>
    ).mockImplementationOnce(async () => {
      order.push('generic');
    });

    const unregister = service.registerTransportHandler({
      type: 'nostr',
      createRequestTransport: mock(async () => ({
        type: PaymentRequestTransportType.NOSTR,
        target: nostrTarget,
      })),
      activate: mock(async () => {
        order.push('activate');
        ingestPromise = service.ingestPayload(createPayload(), {
          transport: 'nostr',
          transportMessageId: 'nostr-event-1',
        });
        await initStarted;
      }),
      deactivate: mock(async () => undefined),
    });

    await service.recoverPendingAttempts();

    expect(order).toEqual(['generic', 'activate']);
    expect(await attemptRepository.getByState('validating')).toHaveLength(1);

    resolveInit!({
      id: 'receive-op-1',
      state: 'init',
      mintUrl,
      unit: 'sat',
      amount: Amount.from(100),
      inputProofs: createPayload().proofs,
      createdAt: now,
      updatedAt: now,
    });
    const result = await ingestPromise!;

    expect(result.attempt.state).toBe('finalized');
    unregister();
  });

  it('completes finalized single-use requests during recovery without a transport handler', async () => {
    const now = Date.now();
    await operationRepository.create({
      id: 'operation-1',
      requestId: 'request-id',
      encodedRequest: 'CREQB-test',
      state: 'active',
      transport: 'nostr',
      amount: Amount.from(100),
      unit: 'sat',
      mints: [mintUrl],
      singleUse: true,
      createdAt: now,
      updatedAt: now,
    });
    await attemptRepository.create({
      id: 'attempt-finalized',
      requestOperationId: 'operation-1',
      requestId: 'request-id',
      transport: 'nostr',
      payloadHash: 'payload-hash',
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      fee: Amount.from(1),
      netAmount: Amount.from(99),
      state: 'finalized',
      receiveOperationId: 'receive-op-finalized',
      createdAt: now,
      updatedAt: now,
    });

    await service.recoverPendingAttempts();

    expect((await operationRepository.getById('operation-1'))?.state).toBe('completed');
  });

  it('does not abort recovery when finalized completion deactivation fails', async () => {
    const now = Date.now();
    await operationRepository.create({
      id: 'operation-1',
      requestId: 'request-id',
      encodedRequest: 'CREQB-test',
      state: 'active',
      transport: 'nostr',
      amount: Amount.from(100),
      unit: 'sat',
      mints: [mintUrl],
      singleUse: true,
      createdAt: now,
      updatedAt: now,
    });
    await attemptRepository.create({
      id: 'attempt-finalized',
      requestOperationId: 'operation-1',
      requestId: 'request-id',
      transport: 'nostr',
      payloadHash: 'payload-hash',
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      fee: Amount.from(1),
      netAmount: Amount.from(99),
      state: 'finalized',
      receiveOperationId: 'receive-op-finalized',
      createdAt: now,
      updatedAt: now,
    });
    const deactivate = mock(async () => {
      throw new Error('unsubscribe failed');
    });
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      activate: mock(async () => undefined),
      deactivate,
    });

    await service.recoverPendingAttempts();

    expect((await operationRepository.getById('operation-1'))?.state).toBe('completed');
    expect(deactivate).toHaveBeenCalledTimes(1);

    unregister();
  });

  it('completes finalized receiving children during recovery without a transport handler', async () => {
    const now = Date.now();
    await operationRepository.create({
      id: 'operation-1',
      requestId: 'request-id',
      encodedRequest: 'CREQB-test',
      state: 'active',
      transport: 'nostr',
      amount: Amount.from(100),
      unit: 'sat',
      mints: [mintUrl],
      singleUse: true,
      createdAt: now,
      updatedAt: now,
    });
    await attemptRepository.create({
      id: 'attempt-receiving',
      requestOperationId: 'operation-1',
      requestId: 'request-id',
      transport: 'nostr',
      payloadHash: 'payload-hash',
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      state: 'receiving',
      receiveOperationId: 'receive-op-finalized',
      payload: createPayload(),
      createdAt: now,
      updatedAt: now,
    });
    const finalizedReceive: FinalizedReceiveOperation = {
      ...createPreparedReceiveOperation({ id: 'receive-op-finalized' }),
      state: 'finalized',
    };
    (receiveOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValue(
      finalizedReceive,
    );

    await service.recoverPendingAttempts();

    expect((await attemptRepository.getById('attempt-receiving'))?.state).toBe('finalized');
    expect((await operationRepository.getById('operation-1'))?.state).toBe('completed');
  });

  it('rejects unsupported transports at create time', async () => {
    await expect(service.create({ amount: Amount.from(100), transport: 'nostr' })).rejects.toThrow(
      PaymentRequestError,
    );
  });

  it('resumes stored pre-child payloads during recovery', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();
    const payloadHash = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload(payload);
    const now = Date.now();
    await attemptRepository.create({
      id: 'attempt-1',
      requestOperationId: operation.id,
      requestId: operation.requestId,
      transport: 'inband',
      payloadHash,
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      state: 'validating',
      payload,
      createdAt: now,
      updatedAt: now,
    });

    await service.recoverPendingAttempts();

    const storedAttempt = await attemptRepository.getById('attempt-1');
    const storedOperation = await operationRepository.getById(operation.id);
    expect(storedAttempt?.state).toBe('finalized');
    expect(storedAttempt?.receiveOperationId).toBe('receive-op-1');
    expect(storedAttempt?.payload).toBeUndefined();
    expect(storedOperation?.state).toBe('completed');
    expect(receiveOperationService.init).toHaveBeenCalledTimes(1);
  });

  it('drops incomplete pre-child attempts during recovery so redelivery can retry', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();
    const payloadHash = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload(payload);
    const now = Date.now();
    await attemptRepository.create({
      id: 'attempt-1',
      requestOperationId: operation.id,
      requestId: operation.requestId,
      transport: 'inband',
      payloadHash,
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      state: 'received',
      createdAt: now,
      updatedAt: now,
    });

    await service.recoverPendingAttempts();

    expect(await attemptRepository.getById('attempt-1')).toBeNull();
    expect(receiveOperationService.init).not.toHaveBeenCalled();

    const result = await service.claimPayload(operation.id, payload);
    expect(result.attempt.id).not.toBe('attempt-1');
    expect(result.attempt.state).toBe('finalized');
  });

  it('links validating attempts to persisted child receive operations during recovery', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();
    const payloadHash = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload(payload);
    const now = Date.now();
    await attemptRepository.create({
      id: 'attempt-1',
      requestOperationId: operation.id,
      requestId: operation.requestId,
      transport: 'inband',
      payloadHash,
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      state: 'validating',
      payload,
      createdAt: now,
      updatedAt: now,
    });
    const finalizedReceive: FinalizedReceiveOperation = {
      ...createPreparedReceiveOperation({
        id: 'receive-op-orphaned',
        source: {
          type: 'payment-request',
          requestOperationId: operation.id,
          requestId: operation.requestId,
          attemptId: 'attempt-1',
          transport: 'inband',
        },
      }),
      state: 'finalized',
    };
    (
      receiveOperationService.getOperationByPaymentRequestAttemptId as unknown as ReturnType<
        typeof mock
      >
    ).mockResolvedValue(finalizedReceive);
    (receiveOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValue(
      finalizedReceive,
    );

    await service.recoverPendingAttempts();

    const storedAttempt = await attemptRepository.getById('attempt-1');
    const storedOperation = await operationRepository.getById(operation.id);
    expect(storedAttempt?.state).toBe('finalized');
    expect(storedAttempt?.receiveOperationId).toBe('receive-op-orphaned');
    expect(storedAttempt?.payload).toBeUndefined();
    expect(storedOperation?.state).toBe('completed');
  });

  it('skips locked pre-child attempts during recovery', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });

    let resolveInit: ((operation: InitReceiveOperation) => void) | undefined;
    const initBlocked = new Promise<InitReceiveOperation>((resolve) => {
      resolveInit = resolve;
    });
    const initStarted = new Promise<void>((resolve) => {
      (receiveOperationService.init as unknown as ReturnType<typeof mock>).mockImplementationOnce(
        async (_token, source?: ReceiveOperationSource): Promise<InitReceiveOperation> => {
          resolve();
          return initBlocked.then((receiveOperation) => ({ ...receiveOperation, source }));
        },
      );
    });

    const claimPromise = service.claimPayload(operation.id, createPayload());
    await initStarted;

    expect(service.isOperationLocked(operation.id)).toBe(true);

    await service.recoverPendingAttempts();

    const attempts = await attemptRepository.getByState('validating');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.requestOperationId).toBe(operation.id);

    resolveInit!({
      id: 'receive-op-1',
      state: 'init',
      mintUrl,
      unit: 'sat',
      amount: Amount.from(100),
      inputProofs: createPayload().proofs,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const result = await claimPromise;
    expect(result.attempt.state).toBe('finalized');
  });

  it('completes single-use parents for already-finalized attempts during recovery', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const now = Date.now();
    await attemptRepository.create({
      id: 'attempt-finalized',
      requestOperationId: operation.id,
      requestId: operation.requestId,
      transport: 'inband',
      payloadHash: 'payload-hash',
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      fee: Amount.from(1),
      netAmount: Amount.from(99),
      state: 'finalized',
      receiveOperationId: 'receive-op-finalized',
      createdAt: now,
      updatedAt: now,
    });

    await service.recoverPendingAttempts();

    const storedOperation = await operationRepository.getById(operation.id);
    expect(storedOperation?.state).toBe('completed');
  });

  it('resumes prepared child receive operations during recovery', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();
    const payloadHash = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload(payload);
    const preparedReceive = createPreparedReceiveOperation();
    const now = Date.now();
    await attemptRepository.create({
      id: 'attempt-1',
      requestOperationId: operation.id,
      requestId: operation.requestId,
      transport: 'inband',
      payloadHash,
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      state: 'receiving',
      receiveOperationId: preparedReceive.id,
      payload,
      createdAt: now,
      updatedAt: now,
    });
    (
      receiveOperationService.getOperation as unknown as ReturnType<typeof mock>
    ).mockResolvedValueOnce(preparedReceive);

    await service.recoverPendingAttempts();

    expect(receiveOperationService.execute).toHaveBeenCalledWith(preparedReceive);
    const storedAttempt = await attemptRepository.getById('attempt-1');
    expect(storedAttempt?.state).toBe('finalized');
    expect(storedAttempt?.fee?.equals(Amount.from(1))).toBe(true);
    expect(storedAttempt?.netAmount?.equals(Amount.from(99))).toBe(true);
    expect(storedAttempt?.payload).toBeUndefined();
    const storedOperation = await operationRepository.getById(operation.id);
    expect(storedOperation?.state).toBe('completed');
  });

  it('resumes init child receive operations before generic receive cleanup', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();
    const payloadHash = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload(payload);
    const initReceive = createInitReceiveOperation();
    let currentReceive: ReceiveOperation | null = initReceive;
    const order: string[] = [];
    const now = Date.now();
    await attemptRepository.create({
      id: 'attempt-1',
      requestOperationId: operation.id,
      requestId: operation.requestId,
      transport: 'inband',
      payloadHash,
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      state: 'receiving',
      receiveOperationId: initReceive.id,
      payload,
      createdAt: now,
      updatedAt: now,
    });
    (receiveOperationService.getOperation as unknown as ReturnType<typeof mock>).mockImplementation(
      async () => currentReceive,
    );
    (receiveOperationService.prepare as unknown as ReturnType<typeof mock>).mockImplementation(
      async (receiveOperation: InitReceiveOperation): Promise<PreparedReceiveOperation> => {
        order.push('prepare');
        const preparedReceive = {
          ...receiveOperation,
          state: 'prepared' as const,
          fee: Amount.from(1),
          outputData: { keep: [], send: [] },
        };
        currentReceive = preparedReceive;
        return preparedReceive;
      },
    );
    (receiveOperationService.execute as unknown as ReturnType<typeof mock>).mockImplementation(
      async (receiveOperation: PreparedReceiveOperation): Promise<FinalizedReceiveOperation> => {
        order.push('execute');
        const finalizedReceive = { ...receiveOperation, state: 'finalized' as const };
        currentReceive = finalizedReceive;
        return finalizedReceive;
      },
    );
    (
      receiveOperationService.recoverPendingOperations as unknown as ReturnType<typeof mock>
    ).mockImplementation(async () => {
      order.push('generic');
      if (currentReceive?.state === 'init') {
        currentReceive = null;
      }
    });

    await service.recoverPendingAttempts();

    expect(order).toEqual(['prepare', 'execute', 'generic']);
    const storedAttempt = await attemptRepository.getById('attempt-1');
    expect(storedAttempt?.state).toBe('finalized');
    expect(storedAttempt?.payload).toBeUndefined();
    const storedOperation = await operationRepository.getById(operation.id);
    expect(storedOperation?.state).toBe('completed');
  });

  it('drops receiving attempts with missing child operations so redelivery can retry', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();
    const payloadHash = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload(payload);
    const now = Date.now();
    await attemptRepository.create({
      id: 'attempt-1',
      requestOperationId: operation.id,
      requestId: operation.requestId,
      transport: 'inband',
      payloadHash,
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      state: 'receiving',
      receiveOperationId: 'missing-receive-op',
      payload,
      createdAt: now,
      updatedAt: now,
    });

    await service.recoverPendingAttempts();

    expect(await attemptRepository.getById('attempt-1')).toBeNull();

    const result = await service.claimPayload(operation.id, payload);
    expect(result.attempt.id).not.toBe('attempt-1');
    expect(result.attempt.state).toBe('finalized');
  });

  it('does not pin payloads when pre-child validation has a transient failure', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      requestId: 'request-id',
    });
    const payload = createPayload();
    const payloadHash = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload(payload);
    (mintService.isTrustedMint as unknown as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('temporary trusted mint lookup failure'),
    );

    await expect(service.claimPayload(operation.id, payload)).rejects.toThrow(
      'temporary trusted mint lookup failure',
    );

    expect(await attemptRepository.getByPayloadHash(operation.id, payloadHash)).toBeNull();

    const result = await service.claimPayload(operation.id, payload);
    expect(result.attempt.state).toBe('finalized');
  });

  it('does not pin validated payloads when child receive init fails', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();
    const payloadHash = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload(payload);
    (receiveOperationService.init as unknown as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('temporary mint metadata failure'),
    );

    await expect(service.claimPayload(operation.id, payload)).rejects.toThrow(
      'temporary mint metadata failure',
    );

    expect(await attemptRepository.getByPayloadHash(operation.id, payloadHash)).toBeNull();

    const result = await service.claimPayload(operation.id, payload);
    expect(result.attempt.state).toBe('finalized');
  });

  it('rejects permanent child receive init validation failures', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();
    const payloadHash = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload(payload);
    (receiveOperationService.init as unknown as ReturnType<typeof mock>).mockRejectedValueOnce(
      new ProofValidationError('Only P2PK locking scripts are supported'),
    );

    const result = await service.claimPayload(operation.id, payload);

    expect(result.attempt.state).toBe('rejected');
    expect(result.attempt.error).toBe('Only P2PK locking scripts are supported');
    expect(await attemptRepository.getByPayloadHash(operation.id, payloadHash)).toBeDefined();
  });

  it('does not pin corrected proof metadata behind a rejected attempt', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const missingWitnessPayload = createPayload();
    const correctedPayload = createPayload({
      proofs: [
        {
          ...missingWitnessPayload.proofs[0]!,
          witness: JSON.stringify({ signatures: ['valid-signature'] }),
        },
      ],
    });
    const hashPayload = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload.bind(service);
    const missingWitnessHash = hashPayload(missingWitnessPayload);
    const correctedHash = hashPayload(correctedPayload);
    (receiveOperationService.init as unknown as ReturnType<typeof mock>).mockImplementation(
      async (token: PaymentRequestPayload, source?: ReceiveOperationSource) => {
        if (!token.proofs[0]?.witness) {
          throw new ProofValidationError('Locked proof witness is required');
        }
        return {
          id: 'receive-op-1',
          state: 'init',
          mintUrl: token.mint,
          unit: token.unit ?? 'sat',
          amount: Amount.from(100),
          inputProofs: token.proofs,
          source,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      },
    );

    const rejected = await service.claimPayload(operation.id, missingWitnessPayload);
    const accepted = await service.claimPayload(operation.id, correctedPayload);

    expect(missingWitnessHash).not.toBe(correctedHash);
    expect(rejected.attempt.state).toBe('rejected');
    expect(accepted.attempt.state).toBe('finalized');
    expect(accepted.attempt.id).not.toBe(rejected.attempt.id);
    expect(receiveOperationService.init).toHaveBeenCalledTimes(2);
  });

  it('rejects recovering attempts when prepared child receive execution rolls back', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
    });
    const payload = createPayload();
    const payloadHash = (
      service as unknown as {
        hashPayload(payload: ParsedPaymentRequestPayload): string;
      }
    ).hashPayload(payload);
    const preparedReceive = createPreparedReceiveOperation();
    const rolledBackReceive = {
      ...preparedReceive,
      state: 'rolled_back' as const,
      error: 'Child receive operation rolled back by mint',
    };
    const now = Date.now();
    await attemptRepository.create({
      id: 'attempt-1',
      requestOperationId: operation.id,
      requestId: operation.requestId,
      transport: 'inband',
      payloadHash,
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      state: 'receiving',
      receiveOperationId: preparedReceive.id,
      payload,
      createdAt: now,
      updatedAt: now,
    });
    (receiveOperationService.getOperation as unknown as ReturnType<typeof mock>)
      .mockResolvedValueOnce(preparedReceive)
      .mockResolvedValueOnce(rolledBackReceive);
    (receiveOperationService.execute as unknown as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('receive failed'),
    );

    await service.recoverPendingAttempts();

    const storedAttempt = await attemptRepository.getById('attempt-1');
    expect(storedAttempt?.state).toBe('rejected');
    expect(storedAttempt?.error).toBe('Child receive operation rolled back by mint');
    expect(storedAttempt?.payload).toBeUndefined();
    const storedOperation = await operationRepository.getById(operation.id);
    expect(storedOperation?.state).toBe('active');
  });
});
