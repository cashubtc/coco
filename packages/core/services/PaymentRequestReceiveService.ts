import {
  Amount,
  JSONInt,
  PaymentRequest,
  type AmountLike,
  type NUT10Option,
  type PaymentRequestPayload,
  type Proof,
  sumProofs,
} from '@cashu/cashu-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { Logger } from '@core/logging';
import { PaymentRequestError, ProofValidationError } from '../models/Error';
import type { MintService } from './MintService';
import type { ReceiveOperationService } from '../operations/receive/ReceiveOperationService';
import type {
  FinalizedReceiveOperation,
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

export interface CreatePaymentRequestReceiveInput {
  amount: AmountLike;
  unit?: string;
  mints?: string[];
  requestId?: string;
  description?: string;
  singleUse?: boolean;
  transport?: PaymentRequestReceiveTransport;
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

  async create(input: CreatePaymentRequestReceiveInput): Promise<PaymentRequestReceiveOperation> {
    const unit = input.unit ?? 'sat';
    if (unit !== 'sat') {
      throw new PaymentRequestError(`Unsupported payment request unit '${unit}'`);
    }
    if (input.nut10) {
      throw new PaymentRequestError('NUT-10 receive requirements are not supported yet');
    }

    const transport = input.transport ?? 'inband';
    if (transport !== 'inband') {
      throw new PaymentRequestError(`Transport '${transport}' is not supported yet`);
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
    const paymentRequest = new PaymentRequest(
      [],
      requestId,
      amount,
      unit,
      mints.length > 0 ? mints : undefined,
      input.description,
      input.singleUse ?? true,
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
      state: 'draft',
      transport,
      amount,
      unit,
      mints,
      singleUse: input.singleUse ?? true,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };

    await this.operationRepository.create(operation);
    return operation;
  }

  async activate(
    operationOrId: PaymentRequestReceiveOperation | string,
  ): Promise<PaymentRequestReceiveOperation> {
    const operation = await this.requireOperation(operationOrId);
    if (operation.state === 'active') {
      return operation;
    }
    if (operation.state !== 'draft') {
      throw new PaymentRequestError(
        `Cannot activate payment request receive operation in state '${operation.state}'`,
      );
    }

    const active: PaymentRequestReceiveOperation = {
      ...operation,
      state: 'active',
      updatedAt: Date.now(),
    };
    await this.operationRepository.update(active);
    return active;
  }

  async cancel(operationId: string, reason?: string): Promise<PaymentRequestReceiveOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'draft' && operation.state !== 'active') {
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
    await this.receiveOperationService.recoverPendingOperations();

    const interruptedBeforeReceive = [
      ...(await this.attemptRepository.getByState('received')),
      ...(await this.attemptRepository.getByState('validating')),
    ];
    for (const attempt of interruptedBeforeReceive) {
      await this.rejectAttempt(attempt, 'Interrupted before child receive operation was created');
    }

    const attempts = await this.attemptRepository.getByState('receiving');
    for (const attempt of attempts) {
      if (!attempt.receiveOperationId) {
        await this.rejectAttempt(attempt, 'Missing child receive operation id');
        continue;
      }

      const receiveOperation = await this.receiveOperationService.getOperation(
        attempt.receiveOperationId,
      );
      if (!receiveOperation) {
        await this.rejectAttempt(attempt, 'Child receive operation was not found');
        continue;
      }

      if (receiveOperation.state === 'finalized') {
        await this.finalizeAttemptFromReceive(attempt, receiveOperation);
      } else if (receiveOperation.state === 'rolled_back') {
        await this.rejectAttempt(
          attempt,
          receiveOperation.error ?? 'Child receive operation rolled back',
        );
      }
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

    try {
      attempt = await this.updateAttempt({ ...attempt, state: 'validating' });
      await this.validatePayload(operation, payload, grossAmount);
      await this.assertSingleUseAvailable(operation);

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
      if (receiveOperation?.state === 'executing') {
        this.logger?.warn('Payment request receive attempt left for recovery', {
          attemptId: attempt.id,
          receiveOperationId: receiveOperation.id,
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

  private async assertSingleUseAvailable(operation: PaymentRequestReceiveOperation): Promise<void> {
    if (!operation.singleUse) return;
    const attempts = await this.attemptRepository.getByRequestOperationId(operation.id);
    if (attempts.some((attempt) => attempt.state === 'finalized')) {
      throw new PaymentRequestError('Single-use payment request has already been paid');
    }
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

  private async finalizeAttemptFromReceive(
    attempt: PaymentRequestReceiveAttempt,
    receiveOperation: FinalizedReceiveOperation,
  ): Promise<void> {
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
