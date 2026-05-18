import {
  Amount,
  JSONInt,
  PaymentRequest,
  PaymentRequestTransportType,
  type AmountLike,
  type NUT10Option,
  type PaymentRequestPayload,
  type PaymentRequestTransport,
  type Proof,
  sumProofs,
} from '@cashu/cashu-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { Logger } from '@core/logging';
import {
  OperationInProgressError,
  PaymentRequestError,
  ProofValidationError,
} from '../models/Error';
import type { MintService } from './MintService';
import type { ReceiveOperationService } from '../operations/receive/ReceiveOperationService';
import type {
  FinalizedReceiveOperation,
  InitReceiveOperation,
  PreparedReceiveOperation,
  ReceiveOperation,
} from '../operations/receive/ReceiveOperation';
import type {
  PaymentRequestReceiveAttempt,
  PaymentRequestReceiveOperation,
  PaymentRequestReceiveSource,
  PaymentRequestReceiveState,
  PaymentRequestReceiveTransport,
  ParsedPaymentRequestPayload,
} from '../operations/paymentRequestReceive/PaymentRequestReceiveOperation';
import type {
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
} from '../repositories';
import { computeYHexForSecrets, generateSubId, normalizeMintUrl } from '../utils';
import { OperationIdLock } from '../operations/OperationIdLock';

type CashuPaymentRequestTransportInput =
  | PaymentRequestTransport
  | {
      type: 'nostr' | 'post' | PaymentRequestTransportType;
      target: string;
      tags?: string[][];
    };

export type PaymentRequestReceiveTransportInput =
  | PaymentRequestReceiveTransport
  | { type: 'inband' }
  | CashuPaymentRequestTransportInput;

export interface PaymentRequestReceiveTransportCreateInput {
  requestId: string;
  amount: Amount;
  unit: string;
  mints: string[];
  description?: string;
  singleUse: boolean;
}

export interface PaymentRequestReceiveTransportHandler {
  readonly type: Exclude<PaymentRequestReceiveTransport, 'inband'>;
  createRequestTransport?(
    input: PaymentRequestReceiveTransportCreateInput,
  ): Promise<PaymentRequestTransport> | PaymentRequestTransport;
  activate(operation: PaymentRequestReceiveOperation): Promise<void> | void;
  deactivate(operation: PaymentRequestReceiveOperation): Promise<void> | void;
}

export interface CreatePaymentRequestReceiveInput {
  amount: AmountLike;
  unit?: string;
  mints?: string[];
  requestId?: string;
  description?: string;
  singleUse?: boolean;
  transport?: PaymentRequestReceiveTransportInput;
  encoding?: 'creqA' | 'creqB';
  nut10?: NUT10Option;
}

export interface PaymentRequestReceiveClaimResult {
  operation: PaymentRequestReceiveOperation;
  attempt: PaymentRequestReceiveAttempt;
  receiveOperation?: ReceiveOperation;
}

export class PaymentRequestReceiveService {
  private readonly lock = new OperationIdLock();
  private readonly transportHandlers = new Map<
    Exclude<PaymentRequestReceiveTransport, 'inband'>,
    PaymentRequestReceiveTransportHandler
  >();

  constructor(
    private readonly operationRepository: PaymentRequestReceiveOperationRepository,
    private readonly attemptRepository: PaymentRequestReceiveAttemptRepository,
    private readonly receiveOperationService: ReceiveOperationService,
    private readonly mintService: MintService,
    private readonly logger?: Logger,
  ) {}

  isOperationLocked(operationId: string): boolean {
    return this.lock.isLocked(operationId);
  }

  registerTransportHandler(handler: PaymentRequestReceiveTransportHandler): () => void {
    if (this.transportHandlers.has(handler.type)) {
      throw new PaymentRequestError(
        `Payment request receive transport handler '${handler.type}' is already registered`,
      );
    }
    this.transportHandlers.set(handler.type, handler);
    return () => {
      if (this.transportHandlers.get(handler.type) === handler) {
        this.transportHandlers.delete(handler.type);
      }
    };
  }

  private async acquireLockWhenAvailable(lockId: string): Promise<() => void> {
    while (this.lock.isLocked(lockId)) {
      await this.lock.waitForUnlock(lockId);
    }
    return this.lock.acquire(lockId);
  }

  async create(input: CreatePaymentRequestReceiveInput): Promise<PaymentRequestReceiveOperation> {
    const unit = input.unit ?? 'sat';
    if (unit !== 'sat') {
      throw new PaymentRequestError(`Unsupported payment request unit '${unit}'`);
    }
    if (input.nut10) {
      throw new PaymentRequestError('NUT-10 receive requirements are not supported yet');
    }

    const amount = Amount.from(input.amount);
    if (amount.isZero()) {
      throw new PaymentRequestError('Payment request amount must be positive');
    }

    const mints = input.mints?.map((mintUrl) => normalizeMintUrl(mintUrl)) ?? [];
    for (const mintUrl of mints) {
      const trusted = await this.mintService.isTrustedMint(mintUrl);
      if (!trusted) {
        throw new PaymentRequestError(`Mint ${mintUrl} is not trusted`);
      }
    }

    const requestId = input.requestId ?? generateSubId();
    const releaseCreateLock = await this.acquireLockWhenAvailable(
      `payment-request-receive:create:${requestId}`,
    );
    try {
      const existingActive = await this.operationRepository.getActiveByRequestId(requestId);
      if (existingActive.length > 0) {
        throw new PaymentRequestError(
          `An active payment request already exists for request id ${requestId}`,
        );
      }

      const singleUse = input.singleUse ?? true;
      const { transport, paymentRequestTransports } = await this.resolveTransportInput(
        input.transport,
        {
          requestId,
          amount,
          unit,
          mints,
          description: input.description,
          singleUse,
        },
      );
      const paymentRequest = new PaymentRequest(
        paymentRequestTransports,
        requestId,
        amount,
        unit,
        mints.length > 0 ? mints : undefined,
        input.description,
        singleUse,
      );
      const encodedRequest =
        input.encoding === 'creqA'
          ? paymentRequest.toEncodedCreqA()
          : paymentRequest.toEncodedCreqB();
      const now = Date.now();
      const operation: PaymentRequestReceiveOperation = {
        id: generateSubId(),
        requestId,
        encodedRequest,
        state: 'active',
        transport,
        amount,
        unit,
        mints,
        singleUse,
        description: input.description,
        createdAt: now,
        updatedAt: now,
      };

      await this.operationRepository.create(operation);
      try {
        await this.activateTransport(operation);
        return (await this.operationRepository.getById(operation.id)) ?? operation;
      } catch (error) {
        const current = await this.operationRepository.getById(operation.id);
        const attempts = await this.attemptRepository.getByRequestOperationId(operation.id);
        const hasClaimToPreserve = attempts.some(
          (attempt) => this.isInFlightAttempt(attempt) || attempt.state === 'finalized',
        );
        if (!current || current.state !== 'active' || hasClaimToPreserve) {
          throw error;
        }
        const cancelled: PaymentRequestReceiveOperation = {
          ...current,
          state: 'cancelled',
          error: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        };
        await this.operationRepository.update(cancelled);
        try {
          await this.deactivateTransport(cancelled, { ignoreMissingHandler: true });
        } catch (deactivationError) {
          this.logger?.warn('Payment request receive transport cleanup failed after activation', {
            operationId: cancelled.id,
            requestId: cancelled.requestId,
            transport: cancelled.transport,
            error: deactivationError,
          });
        }
        throw error;
      }
    } finally {
      releaseCreateLock();
    }
  }

  async cancel(operationId: string, reason?: string): Promise<PaymentRequestReceiveOperation> {
    const releaseLock = await this.lock.acquire(operationId);
    try {
      const operation = await this.requireOperation(operationId);
      if (operation.state !== 'active') {
        throw new PaymentRequestError(
          `Cannot cancel payment request receive operation in state '${operation.state}'`,
        );
      }

      const cancelled: PaymentRequestReceiveOperation = {
        ...operation,
        state: 'cancelled',
        error: reason,
        updatedAt: Date.now(),
      };
      await this.operationRepository.update(cancelled);
      try {
        await this.deactivateTransport(cancelled, { ignoreMissingHandler: true });
      } catch (error) {
        this.logger?.warn('Payment request receive transport deactivation failed after cancel', {
          operationId: cancelled.id,
          requestId: cancelled.requestId,
          transport: cancelled.transport,
          error,
        });
      }
      return cancelled;
    } finally {
      releaseLock();
    }
  }

  async get(operationId: string): Promise<PaymentRequestReceiveOperation | null> {
    return this.operationRepository.getById(operationId);
  }

  async list(filter?: {
    state?: PaymentRequestReceiveState;
  }): Promise<PaymentRequestReceiveOperation[]> {
    return this.operationRepository.list(filter);
  }

  async claimPayload(
    operationOrId: PaymentRequestReceiveOperation | string,
    payloadInput: PaymentRequestPayload | string,
    source?: PaymentRequestReceiveSource,
  ): Promise<PaymentRequestReceiveClaimResult> {
    const operation = await this.requireOperation(operationOrId);
    const releaseLock = await this.lock.acquire(operation.id);
    try {
      return await this.claimPayloadLocked(operation.id, payloadInput, source);
    } finally {
      releaseLock();
    }
  }

  async ingestPayload(
    payloadInput: PaymentRequestPayload | string,
    source?: PaymentRequestReceiveSource,
  ): Promise<PaymentRequestReceiveClaimResult> {
    const payload = this.parsePayload(payloadInput);
    if (!payload.id) {
      throw new PaymentRequestError('Payment request payload id is required for ingestion');
    }

    const payloadHash = this.hashPayload(payload);
    if (source?.transportMessageId) {
      const existingByMessage = await this.attemptRepository.getByTransportMessageId(
        source.transportMessageId,
      );
      if (existingByMessage) {
        if (existingByMessage.payloadHash !== payloadHash) {
          throw new PaymentRequestError(
            `Transport message ${source.transportMessageId} belongs to a different payload`,
          );
        }
        return this.resultForStoredAttempt(existingByMessage);
      }
    }

    const existingByRequestPayload = await this.attemptRepository.getByRequestIdAndPayloadHash(
      payload.id,
      payloadHash,
    );
    if (existingByRequestPayload?.state === 'finalized') {
      return this.resultForStoredAttempt(existingByRequestPayload);
    }

    const candidates = await this.operationRepository.getActiveByRequestId(payload.id);
    if (candidates.length === 0) {
      if (existingByRequestPayload) {
        return this.resultForStoredAttempt(existingByRequestPayload);
      }
      throw new PaymentRequestError(`No active payment request found for id ${payload.id}`);
    }
    if (candidates.length > 1) {
      throw new PaymentRequestError(`Multiple active payment requests found for id ${payload.id}`);
    }

    const operation = candidates[0]!;
    const existingByPayload = await this.attemptRepository.getByPayloadHash(
      operation.id,
      payloadHash,
    );
    if (existingByPayload) {
      return this.resultForAttempt(operation, existingByPayload);
    }

    return this.claimPayload(operation, payload, source);
  }

  async recoverPendingAttempts(): Promise<void> {
    const interruptedBeforeReceive = [
      ...(await this.attemptRepository.getByState('received')),
      ...(await this.attemptRepository.getByState('validating')),
    ];
    for (const attempt of interruptedBeforeReceive) {
      let releaseLock: (() => void) | undefined;
      try {
        releaseLock = await this.lock.acquire(attempt.requestOperationId);
      } catch (error) {
        if (error instanceof OperationInProgressError) {
          this.logger?.debug(
            'Payment request receive operation is in progress, skipping pre-child recovery',
            {
              operationId: attempt.requestOperationId,
              attemptId: attempt.id,
            },
          );
          continue;
        }
        throw error;
      }

      try {
        const currentAttempt = await this.attemptRepository.getById(attempt.id);
        if (
          !currentAttempt ||
          (currentAttempt.state !== 'received' && currentAttempt.state !== 'validating')
        ) {
          continue;
        }

        const childReceive =
          currentAttempt.state === 'validating'
            ? await this.receiveOperationService.getOperationByPaymentRequestAttemptId(
                currentAttempt.id,
              )
            : null;
        if (childReceive) {
          const linkedAttempt = await this.updateAttempt({
            ...currentAttempt,
            state: 'receiving',
            receiveOperationId: childReceive.id,
          });
          await this.recoverReceivingAttemptLocked(linkedAttempt);
          continue;
        }

        await this.recoverPreChildAttemptLocked(currentAttempt);
      } finally {
        releaseLock();
      }
    }

    await this.recoverReceivingAttempts();
    await this.receiveOperationService.recoverPendingOperations();
    await this.recoverReceivingAttempts();
    await this.recoverFinalizedAttempts();
    await this.recoverActiveTransports();
  }

  private async recoverActiveTransports(): Promise<void> {
    const activeOperations = await this.operationRepository.getByState('active');
    for (const operation of activeOperations) {
      try {
        await this.activateTransport(operation);
      } catch (error) {
        this.logger?.warn('Payment request receive transport recovery failed', {
          operationId: operation.id,
          requestId: operation.requestId,
          transport: operation.transport,
          error,
        });
      }
    }
  }

  private async activateTransport(operation: PaymentRequestReceiveOperation): Promise<void> {
    if (operation.transport === 'inband') return;
    const handler = this.transportHandlers.get(operation.transport);
    if (!handler) {
      throw new PaymentRequestError(
        `No payment request receive transport handler registered for '${operation.transport}'`,
      );
    }
    await handler.activate(operation);
  }

  private async deactivateTransport(
    operation: PaymentRequestReceiveOperation,
    options?: { ignoreMissingHandler?: boolean },
  ): Promise<void> {
    if (operation.transport === 'inband') return;
    const handler = this.transportHandlers.get(operation.transport);
    if (!handler) {
      if (options?.ignoreMissingHandler) {
        this.logger?.warn('Payment request receive transport deactivation skipped', {
          operationId: operation.id,
          requestId: operation.requestId,
          transport: operation.transport,
        });
        return;
      }
      throw new PaymentRequestError(
        `No payment request receive transport handler registered for '${operation.transport}'`,
      );
    }
    await handler.deactivate(operation);
  }

  private async recoverFinalizedAttempts(): Promise<void> {
    const attempts = await this.attemptRepository.getByState('finalized');
    for (const attempt of attempts) {
      const operation = await this.operationRepository.getById(attempt.requestOperationId);
      if (!operation || !operation.singleUse || operation.state !== 'active') {
        continue;
      }

      let releaseLock: (() => void) | undefined;
      try {
        releaseLock = await this.lock.acquire(operation.id);
      } catch (error) {
        if (error instanceof OperationInProgressError) {
          this.logger?.debug(
            'Payment request receive operation is in progress, skipping finalized recovery',
            {
              operationId: operation.id,
              attemptId: attempt.id,
            },
          );
          continue;
        }
        throw error;
      }

      try {
        const currentOperation = await this.operationRepository.getById(operation.id);
        if (currentOperation?.singleUse && currentOperation.state === 'active') {
          await this.completeIfSingleUse(currentOperation, { ignoreMissingTransportHandler: true });
        }
      } finally {
        releaseLock();
      }
    }
  }

  private async recoverReceivingAttempts(): Promise<void> {
    const attempts = await this.attemptRepository.getByState('receiving');
    for (const attempt of attempts) {
      let releaseLock: (() => void) | undefined;
      try {
        releaseLock = await this.lock.acquire(attempt.requestOperationId);
      } catch (error) {
        if (error instanceof OperationInProgressError) {
          this.logger?.debug(
            'Payment request receive operation is in progress, skipping recovery',
            {
              operationId: attempt.requestOperationId,
              attemptId: attempt.id,
            },
          );
          continue;
        }
        throw error;
      }

      try {
        const currentAttempt = await this.attemptRepository.getById(attempt.id);
        if (!currentAttempt || currentAttempt.state !== 'receiving') {
          continue;
        }
        await this.recoverReceivingAttemptLocked(currentAttempt);
      } finally {
        releaseLock();
      }
    }
  }

  private async recoverReceivingAttemptLocked(
    attempt: PaymentRequestReceiveAttempt,
  ): Promise<void> {
    if (!attempt.receiveOperationId) {
      await this.dropAttemptForRetryOrReject(attempt, 'Missing child receive operation id');
      return;
    }

    const receiveOperation = await this.receiveOperationService.getOperation(
      attempt.receiveOperationId,
    );
    if (!receiveOperation) {
      await this.dropAttemptForRetryOrReject(attempt, 'Child receive operation was not found');
      return;
    }

    if (receiveOperation.state === 'finalized') {
      await this.finalizeAttemptFromReceive(attempt, receiveOperation, {
        ignoreMissingTransportHandler: true,
      });
    } else if (receiveOperation.state === 'rolled_back') {
      await this.rejectAttempt(
        attempt,
        receiveOperation.error ?? 'Child receive operation rolled back',
      );
    } else if (receiveOperation.state === 'prepared') {
      await this.resumePreparedChildReceive(attempt, receiveOperation, {
        ignoreMissingTransportHandler: true,
      });
    } else if (receiveOperation.state === 'init') {
      await this.resumeInitChildReceive(attempt, receiveOperation, {
        ignoreMissingTransportHandler: true,
      });
    }
  }

  private async recoverPreChildAttemptLocked(attempt: PaymentRequestReceiveAttempt): Promise<void> {
    const operation = await this.operationRepository.getById(attempt.requestOperationId);
    if (!operation) {
      await this.rejectAttempt(attempt, 'Payment request receive operation was not found');
      return;
    }

    if (operation.state !== 'active') {
      await this.rejectAttempt(
        attempt,
        `Cannot recover payload for payment request receive operation in state '${operation.state}'`,
      );
      return;
    }

    if (!attempt.payload) {
      await this.attemptRepository.delete(attempt.id);
      this.logger?.warn('Incomplete payment request receive attempt removed for redelivery retry', {
        operationId: attempt.requestOperationId,
        attemptId: attempt.id,
      });
      return;
    }
    const storedPayload = attempt.payload;

    let currentAttempt =
      attempt.state === 'received'
        ? await this.updateAttempt({ ...attempt, state: 'validating' })
        : attempt;

    try {
      const payload = this.parsePayload(storedPayload);
      const payloadHash = this.hashPayload(payload);
      if (payloadHash !== currentAttempt.payloadHash) {
        await this.rejectAttempt(currentAttempt, 'Stored payment request payload hash mismatch');
        return;
      }

      const grossAmount = sumProofs(payload.proofs);
      await this.validatePayload(operation, payload, grossAmount);
      await this.assertSingleUseAvailable(operation, currentAttempt.id);

      const sourceMetadata = {
        type: 'payment-request' as const,
        requestOperationId: operation.id,
        requestId: operation.requestId,
        attemptId: currentAttempt.id,
        transport: currentAttempt.transport,
        transportMessageId: currentAttempt.transportMessageId,
        senderPubkey: currentAttempt.senderPubkey,
        memo: currentAttempt.memo,
      };
      const initReceive = await this.receiveOperationService.init(
        { mint: payload.mint, unit: payload.unit, proofs: payload.proofs },
        sourceMetadata,
      );
      currentAttempt = await this.updateAttempt({
        ...currentAttempt,
        state: 'receiving',
        receiveOperationId: initReceive.id,
      });
      await this.resumeInitChildReceive(currentAttempt, initReceive, {
        ignoreMissingTransportHandler: true,
      });
    } catch (error) {
      const receiveOperation = currentAttempt.receiveOperationId
        ? await this.receiveOperationService.getOperation(currentAttempt.receiveOperationId)
        : await this.receiveOperationService.getOperationByPaymentRequestAttemptId(
            currentAttempt.id,
          );

      if (receiveOperation?.state === 'finalized') {
        await this.finalizeAttemptFromReceive(currentAttempt, receiveOperation, {
          ignoreMissingTransportHandler: true,
        });
        return;
      }

      if (receiveOperation?.state === 'rolled_back') {
        await this.rejectAttempt(
          currentAttempt,
          receiveOperation.error ?? 'Child receive operation rolled back',
        );
        return;
      }

      if (receiveOperation?.state === 'prepared') {
        await this.resumePreparedChildReceive(currentAttempt, receiveOperation, {
          ignoreMissingTransportHandler: true,
        });
        return;
      }

      if (receiveOperation?.state === 'init') {
        await this.resumeInitChildReceive(currentAttempt, receiveOperation, {
          ignoreMissingTransportHandler: true,
        });
        return;
      }

      if (error instanceof PaymentRequestError || error instanceof ProofValidationError) {
        await this.rejectAttempt(
          currentAttempt,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      this.logger?.warn('Payment request pre-child attempt left for recovery retry', {
        attemptId: currentAttempt.id,
        operationId: currentAttempt.requestOperationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async claimPayloadLocked(
    operationId: string,
    payloadInput: PaymentRequestPayload | string,
    source?: PaymentRequestReceiveSource,
  ): Promise<PaymentRequestReceiveClaimResult> {
    const operation = await this.requireOperation(operationId);
    const payload = this.parsePayload(payloadInput);
    const payloadHash = this.hashPayload(payload);
    if (source?.transportMessageId) {
      const existingByMessage = await this.attemptRepository.getByTransportMessageId(
        source.transportMessageId,
      );
      if (existingByMessage) {
        if (existingByMessage.requestOperationId !== operation.id) {
          throw new PaymentRequestError(
            `Transport message ${source.transportMessageId} belongs to another ` +
              'payment request receive operation',
          );
        }
        if (existingByMessage.payloadHash !== payloadHash) {
          throw new PaymentRequestError(
            `Transport message ${source.transportMessageId} belongs to a different payload`,
          );
        }
        return this.resultForAttempt(operation, existingByMessage);
      }
    }

    const existingByPayload = await this.attemptRepository.getByPayloadHash(
      operation.id,
      payloadHash,
    );
    if (existingByPayload) {
      return this.resultForAttempt(operation, existingByPayload);
    }

    if (operation.state !== 'active') {
      throw new PaymentRequestError(
        `Cannot claim payload for payment request receive operation in state '${operation.state}'`,
      );
    }

    const grossAmount = sumProofs(payload.proofs);
    const now = Date.now();
    let attempt: PaymentRequestReceiveAttempt = {
      id: generateSubId(),
      requestOperationId: operation.id,
      requestId: payload.id,
      transport: source?.transport ?? operation.transport,
      transportMessageId: source?.transportMessageId,
      payloadHash,
      senderPubkey: source?.senderPubkey,
      memo: payload.memo,
      mintUrl: payload.mint,
      unit: payload.unit,
      grossAmount,
      state: 'received',
      payload,
      createdAt: now,
      updatedAt: now,
    };
    await this.attemptRepository.create(attempt);

    let validationCompleted = false;
    try {
      attempt = await this.updateAttempt({ ...attempt, state: 'validating' });
      await this.validatePayload(operation, payload, grossAmount);
      await this.assertSingleUseAvailable(operation, attempt.id);
      validationCompleted = true;

      const sourceMetadata = {
        type: 'payment-request' as const,
        requestOperationId: operation.id,
        requestId: operation.requestId,
        attemptId: attempt.id,
        transport: attempt.transport,
        transportMessageId: attempt.transportMessageId,
        senderPubkey: attempt.senderPubkey,
        memo: attempt.memo,
      };
      const initReceive = await this.receiveOperationService.init(
        { mint: payload.mint, unit: payload.unit, proofs: payload.proofs },
        sourceMetadata,
      );
      attempt = await this.updateAttempt({
        ...attempt,
        state: 'receiving',
        receiveOperationId: initReceive.id,
      });

      const preparedReceive = await this.receiveOperationService.prepare(initReceive);
      const netAmount = preparedReceive.amount.subtract(preparedReceive.fee);
      attempt = await this.updateAttempt({
        ...attempt,
        fee: preparedReceive.fee,
        netAmount,
      });

      const finalizedReceive = await this.receiveOperationService.execute(preparedReceive);
      attempt = await this.updateAttempt({
        ...attempt,
        state: 'finalized',
        fee: finalizedReceive.fee,
        netAmount: finalizedReceive.amount.subtract(finalizedReceive.fee),
        payload: undefined,
      });
      const updatedOperation = await this.completeIfSingleUse(operation);
      return { operation: updatedOperation, attempt, receiveOperation: finalizedReceive };
    } catch (error) {
      const receiveOperation = attempt.receiveOperationId
        ? await this.receiveOperationService.getOperation(attempt.receiveOperationId)
        : undefined;
      if (receiveOperation?.state === 'finalized') {
        attempt = await this.finalizeAttemptFromReceive(attempt, receiveOperation);
        const updatedOperation = await this.operationRepository.getById(operation.id);
        return { operation: updatedOperation ?? operation, attempt, receiveOperation };
      }

      if (receiveOperation?.state === 'prepared' || receiveOperation?.state === 'executing') {
        this.logger?.warn('Payment request receive attempt left for recovery', {
          attemptId: attempt.id,
          receiveOperationId: receiveOperation.id,
          childState: receiveOperation.state,
        });
        throw error;
      }

      if (attempt.state === 'finalized') {
        throw error;
      }

      if (
        validationCompleted &&
        (!receiveOperation || receiveOperation.state === 'init') &&
        attempt.payload
      ) {
        if (this.shouldDropAttemptForRetry(error)) {
          await this.attemptRepository.delete(attempt.id);
          this.logger?.warn('Payment request receive attempt removed for retry', {
            attemptId: attempt.id,
            receiveOperationId: attempt.receiveOperationId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        attempt = await this.rejectAttempt(
          attempt,
          error instanceof Error ? error.message : String(error),
        );
        return { operation, attempt, receiveOperation: receiveOperation ?? undefined };
      }

      if (!validationCompleted && attempt.payload && this.shouldDropAttemptForRetry(error)) {
        await this.attemptRepository.delete(attempt.id);
        this.logger?.warn('Payment request receive attempt removed for retry', {
          attemptId: attempt.id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      attempt = await this.rejectAttempt(
        attempt,
        error instanceof Error ? error.message : String(error),
      );
      return { operation, attempt, receiveOperation: receiveOperation ?? undefined };
    }
  }

  private async resolveTransportInput(
    input: PaymentRequestReceiveTransportInput | undefined,
    createInput: PaymentRequestReceiveTransportCreateInput,
  ): Promise<{
    transport: PaymentRequestReceiveTransport;
    paymentRequestTransports: PaymentRequestTransport[];
  }> {
    if (!input || input === 'inband' || (typeof input === 'object' && input.type === 'inband')) {
      return { transport: 'inband', paymentRequestTransports: [] };
    }

    if (typeof input === 'string') {
      const handler = this.transportHandlers.get(input);
      if (!handler?.createRequestTransport) {
        throw new PaymentRequestError(`Transport '${input}' is not supported yet`);
      }
      const paymentRequestTransport = await handler.createRequestTransport(createInput);
      return {
        transport: input,
        paymentRequestTransports: [this.normalizePaymentRequestTransport(paymentRequestTransport)],
      };
    }

    const paymentRequestTransport = this.normalizePaymentRequestTransport(input);
    return {
      transport: this.toReceiveTransport(paymentRequestTransport.type),
      paymentRequestTransports: [paymentRequestTransport],
    };
  }

  private toReceiveTransport(type: PaymentRequestTransportType): PaymentRequestReceiveTransport {
    switch (type) {
      case PaymentRequestTransportType.NOSTR:
        return 'nostr';
      case PaymentRequestTransportType.POST:
        return 'post';
      default:
        throw new PaymentRequestError(`Unsupported payment request transport '${type}'`);
    }
  }

  private normalizePaymentRequestTransport(
    transport: CashuPaymentRequestTransportInput,
  ): PaymentRequestTransport {
    if (!transport.target || transport.target.trim().length === 0) {
      throw new PaymentRequestError(`Transport '${transport.type}' target is required`);
    }

    switch (transport.type) {
      case 'nostr':
      case PaymentRequestTransportType.NOSTR:
        return {
          type: PaymentRequestTransportType.NOSTR,
          target: transport.target,
          tags: transport.tags,
        };
      case 'post':
      case PaymentRequestTransportType.POST:
        return {
          type: PaymentRequestTransportType.POST,
          target: transport.target,
          tags: transport.tags,
        };
      default:
        throw new PaymentRequestError('Unsupported payment request transport');
    }
  }

  private parsePayload(payloadInput: PaymentRequestPayload | string): ParsedPaymentRequestPayload {
    const raw =
      typeof payloadInput === 'string'
        ? (JSONInt.parse(payloadInput) as Partial<PaymentRequestPayload>)
        : payloadInput;
    if (!raw || typeof raw !== 'object') {
      throw new PaymentRequestError('Payment request payload must be an object');
    }
    if (!raw.mint || typeof raw.mint !== 'string') {
      throw new PaymentRequestError('Payment request payload mint is required');
    }
    if (!raw.unit || typeof raw.unit !== 'string') {
      throw new PaymentRequestError('Payment request payload unit is required');
    }
    if (!Array.isArray(raw.proofs) || raw.proofs.length === 0) {
      throw new PaymentRequestError('Payment request payload proofs are required');
    }

    const proofs: Proof[] = raw.proofs.map((proof) => ({
      ...proof,
      amount: Amount.from(proof.amount),
    }));
    return {
      id: raw.id,
      memo: raw.memo,
      mint: normalizeMintUrl(raw.mint),
      unit: raw.unit,
      proofs,
    };
  }

  private async validatePayload(
    operation: PaymentRequestReceiveOperation,
    payload: ParsedPaymentRequestPayload,
    grossAmount: Amount,
  ): Promise<void> {
    if (operation.requestId && payload.id !== operation.requestId) {
      throw new PaymentRequestError('Payment request payload id does not match request id');
    }
    if (!operation.requestId && !payload.id) {
      this.logger?.debug('Claiming id-less payment request payload by explicit operation id', {
        operationId: operation.id,
      });
    }

    const trusted = await this.mintService.isTrustedMint(payload.mint);
    if (!trusted) {
      throw new PaymentRequestError(`Mint ${payload.mint} is not trusted`);
    }
    if (operation.mints.length > 0 && !operation.mints.includes(payload.mint)) {
      throw new PaymentRequestError(`Mint ${payload.mint} is not allowed for this request`);
    }
    if (payload.unit !== operation.unit) {
      throw new PaymentRequestError(
        `Payment request payload unit '${payload.unit}' does not match request unit '${operation.unit}'`,
      );
    }
    if (payload.unit !== 'sat') {
      throw new ProofValidationError(
        `Unsupported mint unit '${payload.unit}'. Only 'sat' is currently supported.`,
      );
    }
    if (grossAmount.lessThan(operation.amount)) {
      throw new PaymentRequestError('Payment request payload amount is below requested amount');
    }
  }

  private async assertSingleUseAvailable(
    operation: PaymentRequestReceiveOperation,
    currentAttemptId: string,
  ): Promise<void> {
    if (!operation.singleUse) return;
    const attempts = await this.attemptRepository.getByRequestOperationId(operation.id);
    const blockingAttempt = attempts.find(
      (attempt) =>
        attempt.id !== currentAttemptId &&
        (attempt.state === 'received' ||
          attempt.state === 'validating' ||
          attempt.state === 'receiving' ||
          attempt.state === 'finalized'),
    );
    if (!blockingAttempt) return;
    if (blockingAttempt.state === 'finalized') {
      throw new PaymentRequestError('Single-use payment request has already been paid');
    }
    throw new PaymentRequestError('Single-use payment request has an in-flight claim');
  }

  private hashPayload(payload: ParsedPaymentRequestPayload): string {
    const proofYHexes = computeYHexForSecrets(payload.proofs.map((proof) => proof.secret));
    const proofSummaries = payload.proofs
      .map((proof, index) => {
        const {
          id,
          amount,
          C,
          secret: _secret,
          ...proofMetadata
        } = proof as typeof proof & Record<string, unknown>;
        return {
          y: proofYHexes[index] ?? '',
          id,
          amount: Amount.from(amount).toString(),
          C,
          metadata: this.canonicalizePayloadHashValue(proofMetadata),
        };
      })
      .sort((a, b) => a.y.localeCompare(b.y));
    const canonical = JSON.stringify({
      id: payload.id,
      memo: payload.memo,
      mint: payload.mint,
      unit: payload.unit,
      proofs: proofSummaries,
    });
    return bytesToHex(sha256(new TextEncoder().encode(canonical)));
  }

  private canonicalizePayloadHashValue(value: unknown): unknown {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalizePayloadHashValue(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entryValue]) => entryValue !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entryValue]) => [key, this.canonicalizePayloadHashValue(entryValue)]),
      );
    }
    return value;
  }

  private async updateAttempt(
    attempt: PaymentRequestReceiveAttempt,
  ): Promise<PaymentRequestReceiveAttempt> {
    const updated = { ...attempt, updatedAt: Date.now() };
    await this.attemptRepository.update(updated);
    return updated;
  }

  private async rejectAttempt(
    attempt: PaymentRequestReceiveAttempt,
    error: string,
  ): Promise<PaymentRequestReceiveAttempt> {
    return this.updateAttempt({ ...attempt, state: 'rejected', error, payload: undefined });
  }

  private async dropAttemptForRetryOrReject(
    attempt: PaymentRequestReceiveAttempt,
    error: string,
  ): Promise<void> {
    if (attempt.payload) {
      await this.attemptRepository.delete(attempt.id);
      this.logger?.warn('Payment request receive attempt removed for redelivery retry', {
        attemptId: attempt.id,
        receiveOperationId: attempt.receiveOperationId,
        error,
      });
      return;
    }

    await this.rejectAttempt(attempt, error);
  }

  private shouldDropAttemptForRetry(error: unknown): boolean {
    return !(error instanceof PaymentRequestError || error instanceof ProofValidationError);
  }

  private async finalizeAttemptFromReceive(
    attempt: PaymentRequestReceiveAttempt,
    receiveOperation: FinalizedReceiveOperation,
    options?: { ignoreMissingTransportHandler?: boolean },
  ): Promise<PaymentRequestReceiveAttempt> {
    const finalized = await this.updateAttempt({
      ...attempt,
      state: 'finalized',
      fee: receiveOperation.fee,
      netAmount: receiveOperation.amount.subtract(receiveOperation.fee),
      payload: undefined,
    });
    const operation = await this.operationRepository.getById(finalized.requestOperationId);
    if (operation) {
      await this.completeIfSingleUse(operation, {
        ignoreMissingTransportHandler: options?.ignoreMissingTransportHandler,
      });
    }
    return finalized;
  }

  private async resumePreparedChildReceive(
    attempt: PaymentRequestReceiveAttempt,
    receiveOperation: PreparedReceiveOperation,
    options?: { ignoreMissingTransportHandler?: boolean },
  ): Promise<void> {
    try {
      const finalizedReceive = await this.receiveOperationService.execute(receiveOperation);
      await this.finalizeAttemptFromReceive(attempt, finalizedReceive, {
        ignoreMissingTransportHandler: options?.ignoreMissingTransportHandler,
      });
    } catch (error) {
      const latestReceive = await this.receiveOperationService.getOperation(receiveOperation.id);
      if (!latestReceive) {
        await this.rejectAttempt(attempt, 'Child receive operation was not found after resume');
        return;
      }

      if (latestReceive.state === 'finalized') {
        await this.finalizeAttemptFromReceive(attempt, latestReceive, {
          ignoreMissingTransportHandler: options?.ignoreMissingTransportHandler,
        });
        return;
      }

      if (latestReceive.state === 'rolled_back') {
        await this.rejectAttempt(
          attempt,
          latestReceive.error ?? 'Child receive operation rolled back',
        );
        return;
      }

      this.logger?.warn('Payment request prepared child receive left for recovery retry', {
        attemptId: attempt.id,
        receiveOperationId: receiveOperation.id,
        childState: latestReceive.state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resumeInitChildReceive(
    attempt: PaymentRequestReceiveAttempt,
    receiveOperation: InitReceiveOperation,
    options?: { ignoreMissingTransportHandler?: boolean },
  ): Promise<void> {
    try {
      const preparedReceive = await this.receiveOperationService.prepare(receiveOperation);
      const netAmount = preparedReceive.amount.subtract(preparedReceive.fee);
      const updatedAttempt = await this.updateAttempt({
        ...attempt,
        fee: preparedReceive.fee,
        netAmount,
      });
      await this.resumePreparedChildReceive(updatedAttempt, preparedReceive, {
        ignoreMissingTransportHandler: options?.ignoreMissingTransportHandler,
      });
    } catch (error) {
      const latestReceive = await this.receiveOperationService.getOperation(receiveOperation.id);
      if (!latestReceive || latestReceive.state === 'init') {
        const message = error instanceof Error ? error.message : String(error);
        if (this.shouldDropAttemptForRetry(error)) {
          await this.dropAttemptForRetryOrReject(attempt, message);
        } else {
          await this.rejectAttempt(attempt, message);
        }
        return;
      }

      if (latestReceive.state === 'finalized') {
        await this.finalizeAttemptFromReceive(attempt, latestReceive, {
          ignoreMissingTransportHandler: options?.ignoreMissingTransportHandler,
        });
        return;
      }

      if (latestReceive.state === 'rolled_back') {
        await this.rejectAttempt(
          attempt,
          latestReceive.error ?? 'Child receive operation rolled back',
        );
        return;
      }

      if (latestReceive.state === 'prepared') {
        await this.resumePreparedChildReceive(attempt, latestReceive, {
          ignoreMissingTransportHandler: options?.ignoreMissingTransportHandler,
        });
        return;
      }

      this.logger?.warn('Payment request init child receive left for recovery retry', {
        attemptId: attempt.id,
        receiveOperationId: receiveOperation.id,
        childState: latestReceive.state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async completeIfSingleUse(
    operation: PaymentRequestReceiveOperation,
    options?: { ignoreMissingTransportHandler?: boolean },
  ): Promise<PaymentRequestReceiveOperation> {
    if (!operation.singleUse) {
      return operation;
    }
    const completed: PaymentRequestReceiveOperation = {
      ...operation,
      state: 'completed',
      completedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.operationRepository.update(completed);
    try {
      await this.deactivateTransport(completed, {
        ignoreMissingHandler: options?.ignoreMissingTransportHandler,
      });
    } catch (error) {
      this.logger?.warn('Payment request receive transport deactivation failed after completion', {
        operationId: completed.id,
        requestId: completed.requestId,
        transport: completed.transport,
        error,
      });
    }
    return completed;
  }

  private async resultForAttempt(
    operation: PaymentRequestReceiveOperation,
    attempt: PaymentRequestReceiveAttempt,
  ): Promise<PaymentRequestReceiveClaimResult> {
    if (this.isInFlightAttempt(attempt)) {
      throw new OperationInProgressError(operation.id);
    }

    const receiveOperation = attempt.receiveOperationId
      ? await this.receiveOperationService.getOperation(attempt.receiveOperationId)
      : undefined;
    const latestOperation = await this.operationRepository.getById(operation.id);
    return {
      operation: latestOperation ?? operation,
      attempt,
      receiveOperation: receiveOperation ?? undefined,
    };
  }

  private async resultForStoredAttempt(
    attempt: PaymentRequestReceiveAttempt,
  ): Promise<PaymentRequestReceiveClaimResult> {
    const operation = await this.operationRepository.getById(attempt.requestOperationId);
    if (!operation) {
      throw new PaymentRequestError(
        `Payment request receive operation ${attempt.requestOperationId} not found`,
      );
    }
    return this.resultForAttempt(operation, attempt);
  }

  private isInFlightAttempt(attempt: PaymentRequestReceiveAttempt): boolean {
    return (
      attempt.state === 'received' ||
      attempt.state === 'validating' ||
      attempt.state === 'receiving'
    );
  }

  private async requireOperation(
    operationOrId: PaymentRequestReceiveOperation | string,
  ): Promise<PaymentRequestReceiveOperation> {
    if (typeof operationOrId !== 'string') {
      return operationOrId;
    }
    const operation = await this.operationRepository.getById(operationOrId);
    if (!operation) {
      throw new PaymentRequestError(`Payment request receive operation ${operationOrId} not found`);
    }
    return operation;
  }
}
