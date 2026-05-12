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
      return operation;
    } catch (error) {
      const cancelled: PaymentRequestReceiveOperation = {
        ...operation,
        state: 'cancelled',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      };
      await this.operationRepository.update(cancelled);
      throw error;
    }
  }

  async cancel(operationId: string, reason?: string): Promise<PaymentRequestReceiveOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'active') {
      throw new PaymentRequestError(
        `Cannot cancel payment request receive operation in state '${operation.state}'`,
      );
    }

    await this.deactivateTransport(operation);
    const cancelled: PaymentRequestReceiveOperation = {
      ...operation,
      state: 'cancelled',
      error: reason,
      updatedAt: Date.now(),
    };
    await this.operationRepository.update(cancelled);
    return cancelled;
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
        return this.resultForStoredAttempt(existingByMessage);
      }
    }

    const existingByPayload = await this.attemptRepository.getByRequestIdAndPayloadHash(
      payload.id,
      payloadHash,
    );
    if (existingByPayload) {
      return this.resultForStoredAttempt(existingByPayload);
    }

    const candidates = await this.operationRepository.getActiveByRequestId(payload.id);
    if (candidates.length === 0) {
      throw new PaymentRequestError(`No active payment request found for id ${payload.id}`);
    }
    if (candidates.length > 1) {
      throw new PaymentRequestError(`Multiple active payment requests found for id ${payload.id}`);
    }

    return this.claimPayload(candidates[0]!, payload, source);
  }

  async recoverPendingAttempts(): Promise<void> {
    await this.recoverActiveTransports();

    const interruptedBeforeReceive = [
      ...(await this.attemptRepository.getByState('received')),
      ...(await this.attemptRepository.getByState('validating')),
    ];
    for (const attempt of interruptedBeforeReceive) {
      await this.attemptRepository.delete(attempt.id);
    }

    await this.recoverReceivingAttempts();
    await this.receiveOperationService.recoverPendingOperations();
    await this.recoverReceivingAttempts();
    await this.recoverFinalizedAttempts();
  }

  private async recoverActiveTransports(): Promise<void> {
    const activeOperations = await this.operationRepository.getByState('active');
    for (const operation of activeOperations) {
      await this.activateTransport(operation);
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

  private async deactivateTransport(operation: PaymentRequestReceiveOperation): Promise<void> {
    if (operation.transport === 'inband') return;
    const handler = this.transportHandlers.get(operation.transport);
    if (!handler) {
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
          await this.completeIfSingleUse(currentOperation);
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
      await this.finalizeAttemptFromReceive(attempt, receiveOperation);
    } else if (receiveOperation.state === 'rolled_back') {
      await this.rejectAttempt(
        attempt,
        receiveOperation.error ?? 'Child receive operation rolled back',
      );
    } else if (receiveOperation.state === 'prepared') {
      await this.resumePreparedChildReceive(attempt, receiveOperation);
    } else if (receiveOperation.state === 'init') {
      await this.resumeInitChildReceive(attempt, receiveOperation);
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
      .map((proof, index) => ({
        y: proofYHexes[index] ?? '',
        id: proof.id,
        amount: Amount.from(proof.amount).toString(),
        C: proof.C,
      }))
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
      await this.completeIfSingleUse(operation);
    }
    return finalized;
  }

  private async resumePreparedChildReceive(
    attempt: PaymentRequestReceiveAttempt,
    receiveOperation: PreparedReceiveOperation,
  ): Promise<void> {
    try {
      const finalizedReceive = await this.receiveOperationService.execute(receiveOperation);
      await this.finalizeAttemptFromReceive(attempt, finalizedReceive);
    } catch (error) {
      const latestReceive = await this.receiveOperationService.getOperation(receiveOperation.id);
      if (!latestReceive) {
        await this.rejectAttempt(attempt, 'Child receive operation was not found after resume');
        return;
      }

      if (latestReceive.state === 'finalized') {
        await this.finalizeAttemptFromReceive(attempt, latestReceive);
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
  ): Promise<void> {
    try {
      const preparedReceive = await this.receiveOperationService.prepare(receiveOperation);
      const netAmount = preparedReceive.amount.subtract(preparedReceive.fee);
      const updatedAttempt = await this.updateAttempt({
        ...attempt,
        fee: preparedReceive.fee,
        netAmount,
      });
      await this.resumePreparedChildReceive(updatedAttempt, preparedReceive);
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
        await this.finalizeAttemptFromReceive(attempt, latestReceive);
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
        await this.resumePreparedChildReceive(attempt, latestReceive);
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
    return completed;
  }

  private async resultForAttempt(
    operation: PaymentRequestReceiveOperation,
    attempt: PaymentRequestReceiveAttempt,
  ): Promise<PaymentRequestReceiveClaimResult> {
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
