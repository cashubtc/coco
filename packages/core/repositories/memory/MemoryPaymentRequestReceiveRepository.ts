import type {
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
} from '..';
import type {
  PaymentRequestReceiveAttempt,
  PaymentRequestReceiveAttemptState,
  PaymentRequestReceiveOperation,
  PaymentRequestReceiveState,
} from '../../operations/paymentRequestReceive/PaymentRequestReceiveOperation';

function cloneOperation(operation: PaymentRequestReceiveOperation): PaymentRequestReceiveOperation {
  return { ...operation, mints: [...operation.mints] };
}

function cloneAttempt(attempt: PaymentRequestReceiveAttempt): PaymentRequestReceiveAttempt {
  return {
    ...attempt,
    payload: attempt.payload
      ? { ...attempt.payload, proofs: attempt.payload.proofs.map((proof) => ({ ...proof })) }
      : undefined,
  };
}

export class MemoryPaymentRequestReceiveOperationRepository implements PaymentRequestReceiveOperationRepository {
  private readonly operations = new Map<string, PaymentRequestReceiveOperation>();

  async create(operation: PaymentRequestReceiveOperation): Promise<void> {
    if (this.operations.has(operation.id)) {
      throw new Error(`PaymentRequestReceiveOperation with id ${operation.id} already exists`);
    }
    this.operations.set(operation.id, cloneOperation(operation));
  }

  async update(operation: PaymentRequestReceiveOperation): Promise<void> {
    if (!this.operations.has(operation.id)) {
      throw new Error(`PaymentRequestReceiveOperation with id ${operation.id} not found`);
    }
    this.operations.set(operation.id, cloneOperation({ ...operation, updatedAt: Date.now() }));
  }

  async getById(id: string): Promise<PaymentRequestReceiveOperation | null> {
    const operation = this.operations.get(id);
    return operation ? cloneOperation(operation) : null;
  }

  async getByState(state: PaymentRequestReceiveState): Promise<PaymentRequestReceiveOperation[]> {
    return Array.from(this.operations.values())
      .filter((operation) => operation.state === state)
      .map(cloneOperation);
  }

  async getActiveByRequestId(requestId: string): Promise<PaymentRequestReceiveOperation[]> {
    return Array.from(this.operations.values())
      .filter((operation) => operation.state === 'active' && operation.requestId === requestId)
      .map(cloneOperation);
  }

  async list(filter?: {
    state?: PaymentRequestReceiveState;
  }): Promise<PaymentRequestReceiveOperation[]> {
    return Array.from(this.operations.values())
      .filter((operation) => !filter?.state || operation.state === filter.state)
      .map(cloneOperation);
  }
}

export class MemoryPaymentRequestReceiveAttemptRepository implements PaymentRequestReceiveAttemptRepository {
  private readonly attempts = new Map<string, PaymentRequestReceiveAttempt>();

  async create(attempt: PaymentRequestReceiveAttempt): Promise<void> {
    if (this.attempts.has(attempt.id)) {
      throw new Error(`PaymentRequestReceiveAttempt with id ${attempt.id} already exists`);
    }
    if (
      attempt.transportMessageId &&
      (await this.getByTransportMessageId(attempt.transportMessageId))
    ) {
      throw new Error(
        `PaymentRequestReceiveAttempt with transport message id ${attempt.transportMessageId} already exists`,
      );
    }
    if (await this.getByPayloadHash(attempt.requestOperationId, attempt.payloadHash)) {
      throw new Error(
        `PaymentRequestReceiveAttempt with payload hash ${attempt.payloadHash} already exists`,
      );
    }
    this.attempts.set(attempt.id, cloneAttempt(attempt));
  }

  async update(attempt: PaymentRequestReceiveAttempt): Promise<void> {
    if (!this.attempts.has(attempt.id)) {
      throw new Error(`PaymentRequestReceiveAttempt with id ${attempt.id} not found`);
    }
    this.attempts.set(attempt.id, cloneAttempt({ ...attempt, updatedAt: Date.now() }));
  }

  async getById(id: string): Promise<PaymentRequestReceiveAttempt | null> {
    const attempt = this.attempts.get(id);
    return attempt ? cloneAttempt(attempt) : null;
  }

  async getByRequestOperationId(
    requestOperationId: string,
  ): Promise<PaymentRequestReceiveAttempt[]> {
    return Array.from(this.attempts.values())
      .filter((attempt) => attempt.requestOperationId === requestOperationId)
      .map(cloneAttempt);
  }

  async getByReceiveOperationId(
    receiveOperationId: string,
  ): Promise<PaymentRequestReceiveAttempt | null> {
    const attempt = Array.from(this.attempts.values()).find(
      (candidate) => candidate.receiveOperationId === receiveOperationId,
    );
    return attempt ? cloneAttempt(attempt) : null;
  }

  async getByTransportMessageId(
    transportMessageId: string,
  ): Promise<PaymentRequestReceiveAttempt | null> {
    const attempt = Array.from(this.attempts.values()).find(
      (candidate) => candidate.transportMessageId === transportMessageId,
    );
    return attempt ? cloneAttempt(attempt) : null;
  }

  async getByPayloadHash(
    requestOperationId: string,
    payloadHash: string,
  ): Promise<PaymentRequestReceiveAttempt | null> {
    const attempt = Array.from(this.attempts.values()).find(
      (candidate) =>
        candidate.requestOperationId === requestOperationId &&
        candidate.payloadHash === payloadHash,
    );
    return attempt ? cloneAttempt(attempt) : null;
  }

  async getByRequestIdAndPayloadHash(
    requestId: string,
    payloadHash: string,
  ): Promise<PaymentRequestReceiveAttempt | null> {
    const attempt = Array.from(this.attempts.values()).find(
      (candidate) => candidate.requestId === requestId && candidate.payloadHash === payloadHash,
    );
    return attempt ? cloneAttempt(attempt) : null;
  }

  async getByState(
    state: PaymentRequestReceiveAttemptState,
  ): Promise<PaymentRequestReceiveAttempt[]> {
    return Array.from(this.attempts.values())
      .filter((attempt) => attempt.state === state)
      .map(cloneAttempt);
  }

  async delete(id: string): Promise<void> {
    this.attempts.delete(id);
  }
}
