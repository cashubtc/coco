import {
  Amount,
  PaymentRequest,
  PaymentRequestTransportType,
  type PaymentRequestPayload,
} from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { PaymentRequestReceiveService } from '../../services/PaymentRequestReceiveService';
import { PaymentRequestError, ProofValidationError } from '../../models/Error';
import type { MintService } from '../../services/MintService';
import type { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService';
import type {
  FinalizedReceiveOperation,
  InitReceiveOperation,
  PreparedReceiveOperation,
  ReceiveOperation,
  ReceiveOperationSource,
} from '../../operations/receive/ReceiveOperation';
import type {
  ParsedPaymentRequestPayload,
} from '../../operations/paymentRequestReceive/PaymentRequestReceiveOperation';
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

  it('can create draft payment requests when activation is explicitly disabled', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      mints: [mintUrl],
      requestId: 'request-id',
      activate: false,
    });

    expect(operation.state).toBe('draft');
    const active = await service.activate(operation.id);
    expect(active.state).toBe('active');
  });

  it('creates and activates Nostr payment requests through a registered handler', async () => {
    const createRequestTransport = mock(async () => ({
      type: PaymentRequestTransportType.NOSTR,
      target: nostrTarget,
      tags: [['n', '17']],
    }));
    const activate = mock(async () => undefined);
    const unregister = service.registerTransportHandler({
      type: 'nostr',
      createRequestTransport,
      activate,
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

  it('claims a valid payload through a child receive operation', async () => {
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );

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

  it('returns the existing finalized attempt for duplicate payload delivery', async () => {
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
    const payload = createPayload();

    const first = await service.claimPayload(operation.id, payload);
    const second = await service.claimPayload(operation.id, payload);

    expect(second.attempt.id).toBe(first.attempt.id);
    expect(receiveOperationService.init).toHaveBeenCalledTimes(1);
  });

  it('returns the finalized attempt for duplicate payload ingestion after completion', async () => {
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
    const payload = createPayload();

    const first = await service.ingestPayload(payload);
    expect(first.operation.state).toBe('completed');

    const second = await service.ingestPayload(payload);

    expect(second.operation.id).toBe(operation.id);
    expect(second.operation.state).toBe('completed');
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(receiveOperationService.init).toHaveBeenCalledTimes(1);
  });

  it('records a rejected attempt for an underpaid payload', async () => {
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );

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
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
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
    const firstOperation = await service.activate(
      await service.create({
        amount: Amount.from(100),
        mints: [mintUrl],
        requestId: 'request-id',
      }),
    );
    const secondOperation = await service.activate(
      await service.create({
        amount: Amount.from(100),
        mints: [mintUrl],
        requestId: 'request-id-2',
      }),
    );

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

  it('rejects unsupported transports at create time', async () => {
    await expect(service.create({ amount: Amount.from(100), transport: 'nostr' })).rejects.toThrow(
      PaymentRequestError,
    );
  });

  it('removes interrupted pre-child attempts during recovery so payloads can retry', async () => {
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
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

    expect(await attemptRepository.getById('attempt-1')).toBeNull();

    const result = await service.claimPayload(operation.id, payload);
    expect(result.attempt.id).not.toBe('attempt-1');
    expect(result.attempt.state).toBe('finalized');
    expect(result.attempt.receiveOperationId).toBe('receive-op-1');
    expect(receiveOperationService.init).toHaveBeenCalledTimes(1);
  });

  it('completes single-use parents for already-finalized attempts during recovery', async () => {
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
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
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
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
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
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
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
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

  it('does not pin validated payloads when child receive init fails', async () => {
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
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
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
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

  it('rejects recovering attempts when prepared child receive execution rolls back', async () => {
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
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
