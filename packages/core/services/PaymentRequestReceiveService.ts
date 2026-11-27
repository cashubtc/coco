import {
  Amount,
  JSONInt,
  PaymentRequest,
  PaymentRequestTransportType,
  type NUT10Option,
  type PaymentRequestPayload,
  type PaymentRequestTransport,
  type Proof,
  sumProofs,
} from '@cashu/cashu-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { Logger } from '@core/logging';
import { DEFAULT_UNIT, normalizeUnit, parseUnitAmount, type UnitAmountLike } from '../amounts.ts';
import {
  OperationInProgressError,
  PaymentRequestError,
  ProofValidationError,
  UnknownMintError,
} from '../models/Error';
import type { CoreTransactionRunner } from '../transactions/CoreTransaction.ts';
import {
  acceptPaymentRequestDelivery,
  type AcceptDeliveryInput,
  cancelAfterActivationFailure,
  cancelPaymentRequestReceive,
  createPaymentRequestReceive,
  beginPaymentRequestAttempt,
  loadPaymentRequestAttempt,
  prepareAndLinkPaymentRequestChild,
  repairPaymentRequestSettlement,
  resolvePreSubmissionFailure,
} from '../operations/paymentRequestReceive/PaymentRequestReceiveTransitions.ts';
import type { MintService } from './MintService';
import { StaleOutputKeysetError } from '../transactions/outputs/ScopedOutputs.ts';
import type { ReceivePreparation } from '../operations/receive/ReceivePreparation.ts';
import type { ReceiveOperationService } from '../operations/receive/ReceiveOperationService';
import type { ReceiveOperation } from '../operations/receive/ReceiveOperation';
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
import type {
  PaymentRequestReceiveTransportCreateInput,
  PaymentRequestReceiveTransportHandler,
  PaymentRequestReceiveTransportHandlerProvider,
} from '../infra/handlers/paymentRequestReceive';

export type {
  PaymentRequestReceiveTransportCreateInput,
  PaymentRequestReceiveTransportHandler,
} from '../infra/handlers/paymentRequestReceive';

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

export interface CreatePaymentRequestReceiveInput {
  amount: UnitAmountLike;
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
  private readonly activating = new Map<string, Set<Promise<unknown>>>();

  constructor(
    private readonly transactionRunner: CoreTransactionRunner,
    private readonly operationRepository: PaymentRequestReceiveOperationRepository,
    private readonly attemptRepository: PaymentRequestReceiveAttemptRepository,
    private readonly receiveOperationService: ReceiveOperationService,
    private readonly preparation: ReceivePreparation,
    private readonly mintService: MintService,
    private readonly transportHandlerProvider: PaymentRequestReceiveTransportHandlerProvider,
    private readonly logger?: Logger,
  ) {}

  isOperationLocked(operationId: string): boolean {
    return this.lock.isLocked(operationId);
  }

  registerTransportHandler(handler: PaymentRequestReceiveTransportHandler): () => void {
    return this.transportHandlerProvider.register(handler);
  }

  private async acquireLockWhenAvailable(lockId: string): Promise<() => void> {
    while (this.lock.isLocked(lockId)) {
      await this.lock.waitForUnlock(lockId);
    }
    return this.lock.acquire(lockId);
  }

  async create(input: CreatePaymentRequestReceiveInput): Promise<PaymentRequestReceiveOperation> {
    const { amount, unit } = parseUnitAmount(input.amount, { explicitUnit: input.unit });
    if (input.nut10) {
      throw new PaymentRequestError('NUT-10 receive requirements are not supported yet');
    }

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

    if (input.requestId !== undefined && input.requestId.trim() === '') {
      throw new PaymentRequestError('Payment request id must not be blank');
    }

    const requestId = input.requestId ?? generateSubId();
    const releaseCreateLock = await this.acquireLockWhenAvailable(
      `payment-request-receive:create:${requestId}`,
    );
    try {
      const duplicateRequest = () =>
        new PaymentRequestError(
          `An active payment request already exists for request id ${requestId}`,
        );
      // Avoid preparing a transport for an already active ID. Creation rechecks under the write lock.
      const existingActive = await this.operationRepository.getActiveByRequestId(requestId);
      if (existingActive.length > 0) throw duplicateRequest();

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
      const operation = {
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
      } satisfies PaymentRequestReceiveOperation;

      try {
        const created = await this.transactionRunner.run((tx) =>
          tx.perform(createPaymentRequestReceive, operation),
        );
        if (!created) throw duplicateRequest();
      } catch (error) {
        if (error instanceof UnknownMintError) throw new PaymentRequestError(error.message, error);
        throw error;
      }
      const deliveries = new Set<Promise<unknown>>();
      this.activating.set(requestId, deliveries);
      try {
        await this.activateTransport(operation);
        return (await this.operationRepository.getById(operation.id)) ?? operation;
      } catch (error) {
        // A transport can start ingestion and throw before acceptance commits. Wait only for
        // the local decision: child preparation and mint settlement can continue independently.
        await Promise.allSettled(deliveries);
        const cancellation = {
          operationId: operation.id,
          reason: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        };
        const cancelled = await this.transactionRunner.run((tx) =>
          tx.perform(cancelAfterActivationFailure, cancellation),
        );
        if (!cancelled) throw error;
        await this.transportHandlerProvider.deactivate(cancelled, this.logger);
        throw error;
      } finally {
        this.activating.delete(requestId);
      }
    } finally {
      releaseCreateLock();
    }
  }

  async cancel(operationId: string, reason?: string): Promise<PaymentRequestReceiveOperation> {
    const releaseLock = await this.lock.acquire(operationId);
    try {
      const cancellation = { operationId, reason, updatedAt: Date.now() };
      const cancelled = await this.transactionRunner.run((tx) =>
        tx.perform(cancelPaymentRequestReceive, cancellation),
      );
      await this.transportHandlerProvider.deactivate(cancelled, this.logger);
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
    const operationId = typeof operationOrId === 'string' ? operationOrId : operationOrId.id;
    return this.receiveDelivery(this.parsePayload(payloadInput), source, operationId);
  }

  async ingestPayload(
    payloadInput: PaymentRequestPayload | string,
    source?: PaymentRequestReceiveSource,
  ): Promise<PaymentRequestReceiveClaimResult> {
    const payload = this.parsePayload(payloadInput);
    if (!payload.id)
      throw new PaymentRequestError('Payment request payload id is required for ingestion');
    return this.receiveDelivery(payload, source);
  }

  private async receiveDelivery(
    payload: ParsedPaymentRequestPayload,
    source?: PaymentRequestReceiveSource,
    operationId?: string,
  ): Promise<PaymentRequestReceiveClaimResult> {
    const acceptance = this.acceptDelivery({
      operationId,
      payload,
      source: source && { ...source },
      payloadHash: this.hashPayload(payload),
      grossAmount: sumProofs(payload.proofs),
      attemptId: generateSubId(),
      now: Date.now(),
    });
    const activating = payload.id ? this.activating.get(payload.id) : undefined;
    activating?.add(acceptance);
    const { result, release } = await acceptance.finally(() => activating?.delete(acceptance));
    try {
      if (result.kind === 'stored')
        return await this.resultForAttempt(result.operation, result.attempt);
      const attempt =
        (await this.advanceAttempt(result.attempt.id, 'claim')) ??
        (await this.attemptRepository.getById(result.attempt.id));
      if (!attempt) throw new OperationInProgressError(result.operation.id);
      return await this.resultForAttempt(result.operation, attempt);
    } catch (error) {
      if (result.kind === 'accepted') {
        // A competing session or the child itself may have finished before a local failure.
        const settled = await this.advanceAttempt(result.attempt.id, 'claim', true);
        if (settled) return await this.resultForAttempt(result.operation, settled);
      }
      throw error;
    } finally {
      release?.();
    }
  }

  private async acceptDelivery(input: AcceptDeliveryInput) {
    let operationId = input.operationId;
    if (operationId === undefined && input.payload.id) {
      // This lookup only selects a session lock. The transition resolves the authoritative
      // request and any settled replay again before writing, including after request ID reuse.
      const [active] = await this.operationRepository.getActiveByRequestId(input.payload.id);
      if (active && !this.lock.isLocked(active.id)) operationId = active.id;
    }
    for (;;) {
      const release = operationId === undefined ? undefined : await this.lock.acquire(operationId);
      try {
        const lockedOperationId = operationId;
        const result = await this.transactionRunner.run((tx) =>
          tx.perform(acceptPaymentRequestDelivery, { ...input, lockedOperationId }),
        );
        if (result.kind !== 'lock') return { result, release };
        operationId = result.operationId;
      } catch (error) {
        release?.();
        throw error;
      }
      release?.();
    }
  }

  async recoverPendingAttempts(): Promise<void> {
    await this.recoverAttempts(['received', 'validating', 'receiving']);
    await this.receiveOperationService.recoverPendingOperations();
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
    const handler = this.transportHandlerProvider.get(operation.transport);
    await handler.activate(operation);
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
        await this.repairSettlement(attempt.id, true);
      } finally {
        releaseLock();
      }
    }
  }

  private async recoverAttempts(states: PaymentRequestReceiveAttempt['state'][]): Promise<void> {
    // Snapshot before advancing: an attempt can change state during this pass.
    const attempts = (
      await Promise.all(states.map((state) => this.attemptRepository.getByState(state)))
    ).flat();
    for (const attempt of attempts) {
      let release: (() => void) | undefined;
      try {
        release = await this.lock.acquire(attempt.requestOperationId);
        await this.advanceAttempt(attempt.id, 'recovery');
      } catch (error) {
        if (!(error instanceof OperationInProgressError))
          this.logger?.warn('Payment request receive recovery deferred', {
            attemptId: attempt.id,
            error,
          });
      } finally {
        release?.();
      }
    }
  }

  private async advanceAttempt(
    attemptId: string,
    mode: 'claim' | 'recovery',
    terminalOnly = false,
  ): Promise<PaymentRequestReceiveAttempt | null | undefined> {
    const lookup = { attemptId, findLegacyChild: mode === 'recovery' };
    const resolveFailure = async (childId?: string, error?: string) => {
      const input = { ...lookup, childId, error, updatedAt: Date.now() };
      const cancelled = await this.transactionRunner.run((tx) =>
        tx.perform(resolvePreSubmissionFailure, input),
      );
      if (cancelled) await this.preparation.publishRollback(cancelled);
    };
    const checkpoint = { ...lookup, updatedAt: Date.now() };
    let stored;
    try {
      stored = await this.transactionRunner.run((tx) =>
        terminalOnly
          ? tx.perform(loadPaymentRequestAttempt, lookup)
          : tx.perform(beginPaymentRequestAttempt, checkpoint),
      );
    } catch (error) {
      if (mode === 'claim' && !terminalOnly) await resolveFailure();
      throw error;
    }
    if (!stored) return;
    const { operation, attempt, child } = stored;
    if (!this.isInFlightAttempt(attempt)) {
      if (attempt.state === 'finalized' && operation?.state === 'active' && operation.singleUse)
        return this.repairSettlement(attemptId, lookup.findLegacyChild);
      return attempt;
    }
    if (child?.state === 'finalized' || child?.state === 'rolled_back')
      return this.repairSettlement(attemptId, lookup.findLegacyChild);
    if (terminalOnly) return;
    if (!operation) {
      await resolveFailure(child?.id, 'Payment request receive operation was not found');
      return;
    }

    let linked;
    try {
      if (!child || child.state === 'init') {
        if (!child && !attempt.payload) {
          await resolveFailure();
          return;
        }
        if (operation.state !== 'active')
          throw new PaymentRequestError(
            `Cannot prepare payment for request in state '${operation.state}'`,
          );
        const draft =
          child ?? (await this.draftFromStoredPayload(operation, attempt, attempt.payload!));
        linked = await this.preparation.withInput(draft, (preparation) =>
          this.transactionRunner.run((tx) =>
            tx.perform(prepareAndLinkPaymentRequestChild, {
              ...lookup,
              preparation,
              updatedAt: preparation.updatedAt,
            }),
          ),
        );
      } else {
        const input = { ...lookup, updatedAt: Date.now() };
        linked = await this.transactionRunner.run((tx) =>
          tx.perform(prepareAndLinkPaymentRequestChild, input),
        );
      }
    } catch (error) {
      if (
        error instanceof PaymentRequestError ||
        (error instanceof ProofValidationError && !(error instanceof StaleOutputKeysetError))
      ) {
        await resolveFailure(child?.id, error.message);
        return;
      }
      if (mode === 'claim' && !child) await resolveFailure();
      throw error;
    }

    if (!linked) return this.attemptRepository.getById(attemptId); // A competing session already finished.
    if (linked.prepared) await this.preparation.publish(linked.prepared);
    let receive = linked.child;
    if (receive.state === 'prepared') {
      try {
        receive = await this.receiveOperationService.execute(receive);
      } catch (error) {
        const latest = await this.receiveOperationService.getOperation(receive.id);
        if (latest?.state !== 'finalized' && latest?.state !== 'rolled_back') throw error;
        receive = latest;
      }
    }
    if (receive.state === 'finalized' || receive.state === 'rolled_back') {
      const current = await this.attemptRepository.getById(attemptId);
      if (current && !this.isInFlightAttempt(current)) return current;
      return this.repairSettlement(attemptId, lookup.findLegacyChild);
    }
  }

  private async draftFromStoredPayload(
    request: PaymentRequestReceiveOperation,
    attempt: PaymentRequestReceiveAttempt,
    savedPayload: PaymentRequestPayload,
  ) {
    let payload: ParsedPaymentRequestPayload;
    let hash: string;
    try {
      payload = this.parsePayload(savedPayload);
      hash = this.hashPayload(payload);
    } catch (error) {
      throw new PaymentRequestError('Invalid stored payment request payload', error);
    }
    if (hash !== attempt.payloadHash)
      throw new PaymentRequestError('Stored payment request payload hash mismatch');
    await this.validatePayload(request, payload, sumProofs(payload.proofs));
    return this.receiveOperationService.init(
      { mint: payload.mint, unit: payload.unit, proofs: payload.proofs },
      {
        type: 'payment-request',
        requestOperationId: request.id,
        requestId: request.requestId,
        attemptId: attempt.id,
        transport: attempt.transport,
        transportMessageId: attempt.transportMessageId,
        senderPubkey: attempt.senderPubkey,
        memo: attempt.memo,
      },
    );
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
      const handler = this.transportHandlerProvider.getOptional(input);
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
      unit: normalizeUnit(raw.unit, { defaultUnit: DEFAULT_UNIT }),
      proofs,
    };
  }

  private async validatePayload(
    operation: PaymentRequestReceiveOperation,
    payload: ParsedPaymentRequestPayload,
    grossAmount: Amount,
  ): Promise<void> {
    if (operation.requestId !== undefined && payload.id !== operation.requestId) {
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
    if (grossAmount.lessThan(operation.amount)) {
      throw new PaymentRequestError('Payment request payload amount is below requested amount');
    }
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

  private async repairSettlement(attemptId: string, findLegacyChild: boolean) {
    const input = { attemptId, findLegacyChild, updatedAt: Date.now() };
    const result = await this.transactionRunner.run((tx) =>
      tx.perform(repairPaymentRequestSettlement, input),
    );
    if (result?.completed)
      await this.transportHandlerProvider.deactivate(result.completed, this.logger);
    return result?.attempt;
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

  private isInFlightAttempt(attempt: PaymentRequestReceiveAttempt): boolean {
    return (
      attempt.state === 'received' ||
      attempt.state === 'validating' ||
      attempt.state === 'receiving'
    );
  }
}
