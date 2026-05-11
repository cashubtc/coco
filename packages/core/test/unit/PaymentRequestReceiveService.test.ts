import { Amount, type PaymentRequestPayload } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { PaymentRequestReceiveService } from '../../services/PaymentRequestReceiveService';
import { PaymentRequestError } from '../../models/Error';
import type { MintService } from '../../services/MintService';
import type { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService';
import type {
  FinalizedReceiveOperation,
  InitReceiveOperation,
  PreparedReceiveOperation,
  ReceiveOperationSource,
} from '../../operations/receive/ReceiveOperation';
import {
  MemoryPaymentRequestReceiveAttemptRepository,
  MemoryPaymentRequestReceiveOperationRepository,
} from '../../repositories/memory';

describe('PaymentRequestReceiveService', () => {
  const mintUrl = 'https://mint.test';
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

  it('creates CREQB payment requests and activates them', async () => {
    const operation = await service.create({
      amount: Amount.from(100),
      unit: 'sat',
      mints: [mintUrl],
      requestId: 'request-id',
      description: 'test request',
    });

    expect(operation.state).toBe('draft');
    expect(operation.encodedRequest).toStartWith('CREQB');
    expect(operation.requestId).toBe('request-id');

    const active = await service.activate(operation.id);
    expect(active.state).toBe('active');
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

  it('rejects unsupported transports at create time', async () => {
    await expect(service.create({ amount: Amount.from(100), transport: 'nostr' })).rejects.toThrow(
      PaymentRequestError,
    );
  });

  it('rejects interrupted pre-child attempts during recovery', async () => {
    const operation = await service.activate(
      await service.create({ amount: Amount.from(100), mints: [mintUrl], requestId: 'request-id' }),
    );
    const now = Date.now();
    await attemptRepository.create({
      id: 'attempt-1',
      requestOperationId: operation.id,
      requestId: operation.requestId,
      transport: 'inband',
      payloadHash: 'payload-hash-1',
      mintUrl,
      unit: 'sat',
      grossAmount: Amount.from(100),
      state: 'validating',
      payload: createPayload(),
      createdAt: now,
      updatedAt: now,
    });

    await service.recoverPendingAttempts();

    const attempt = await attemptRepository.getById('attempt-1');
    expect(attempt?.state).toBe('rejected');
    expect(attempt?.payload).toBeUndefined();
    expect(attempt?.error).toContain('Interrupted before child receive operation');
  });
});
