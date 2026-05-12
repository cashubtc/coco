import type {
  PaymentRequestReceiveAttempt,
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveAttemptState,
  PaymentRequestReceiveOperation,
  PaymentRequestReceiveOperationRepository,
  PaymentRequestReceiveState,
} from '@cashu/coco-core';
import { deserializeAmount, serializeAmount } from '@cashu/coco-core';
import type {
  IdbDb,
  PaymentRequestReceiveAttemptRow,
  PaymentRequestReceiveOperationRow,
} from '../lib/db.ts';
import { getUnixTimeSeconds } from '../lib/db.ts';

function operationToRow(
  operation: PaymentRequestReceiveOperation,
): PaymentRequestReceiveOperationRow {
  return {
    id: operation.id,
    requestId: operation.requestId ?? null,
    encodedRequest: operation.encodedRequest,
    state: operation.state,
    transport: operation.transport,
    amount: serializeAmount(operation.amount),
    unit: operation.unit,
    mintsJson: JSON.stringify(operation.mints),
    singleUse: operation.singleUse ? 1 : 0,
    description: operation.description ?? null,
    createdAt: Math.floor(operation.createdAt / 1000),
    updatedAt: Math.floor(operation.updatedAt / 1000),
    error: operation.error ?? null,
    completedAt: operation.completedAt ? Math.floor(operation.completedAt / 1000) : null,
  };
}

function rowToOperation(row: PaymentRequestReceiveOperationRow): PaymentRequestReceiveOperation {
  return {
    id: row.id,
    requestId: row.requestId ?? undefined,
    encodedRequest: row.encodedRequest,
    state: row.state,
    transport: row.transport,
    amount: deserializeAmount(row.amount),
    unit: row.unit,
    mints: JSON.parse(row.mintsJson) as string[],
    singleUse: row.singleUse === 1,
    description: row.description ?? undefined,
    createdAt: row.createdAt * 1000,
    updatedAt: row.updatedAt * 1000,
    error: row.error ?? undefined,
    completedAt: row.completedAt ? row.completedAt * 1000 : undefined,
  };
}

function attemptToRow(attempt: PaymentRequestReceiveAttempt): PaymentRequestReceiveAttemptRow {
  return {
    id: attempt.id,
    requestOperationId: attempt.requestOperationId,
    requestId: attempt.requestId ?? null,
    transport: attempt.transport,
    transportMessageId: attempt.transportMessageId ?? null,
    payloadHash: attempt.payloadHash,
    senderPubkey: attempt.senderPubkey ?? null,
    memo: attempt.memo ?? null,
    mintUrl: attempt.mintUrl,
    unit: attempt.unit,
    grossAmount: serializeAmount(attempt.grossAmount),
    fee: attempt.fee ? serializeAmount(attempt.fee) : null,
    netAmount: attempt.netAmount ? serializeAmount(attempt.netAmount) : null,
    receiveOperationId: attempt.receiveOperationId ?? null,
    state: attempt.state,
    error: attempt.error ?? null,
    payloadJson: attempt.payload ? JSON.stringify(attempt.payload) : null,
    createdAt: Math.floor(attempt.createdAt / 1000),
    updatedAt: Math.floor(attempt.updatedAt / 1000),
  };
}

function rowToAttempt(row: PaymentRequestReceiveAttemptRow): PaymentRequestReceiveAttempt {
  const payload = row.payloadJson
    ? (JSON.parse(row.payloadJson) as PaymentRequestReceiveAttempt['payload'])
    : undefined;
  return {
    id: row.id,
    requestOperationId: row.requestOperationId,
    requestId: row.requestId ?? undefined,
    transport: row.transport,
    transportMessageId: row.transportMessageId ?? undefined,
    payloadHash: row.payloadHash,
    senderPubkey: row.senderPubkey ?? undefined,
    memo: row.memo ?? undefined,
    mintUrl: row.mintUrl,
    unit: row.unit,
    grossAmount: deserializeAmount(row.grossAmount),
    fee: row.fee == null ? undefined : deserializeAmount(row.fee),
    netAmount: row.netAmount == null ? undefined : deserializeAmount(row.netAmount),
    receiveOperationId: row.receiveOperationId ?? undefined,
    state: row.state,
    error: row.error ?? undefined,
    payload,
    createdAt: row.createdAt * 1000,
    updatedAt: row.updatedAt * 1000,
  };
}

export class IdbPaymentRequestReceiveOperationRepository implements PaymentRequestReceiveOperationRepository {
  constructor(private readonly db: IdbDb) {}

  async create(operation: PaymentRequestReceiveOperation): Promise<void> {
    await this.db.runTransaction(
      'rw',
      ['coco_cashu_payment_request_receive_operations'],
      async (tx) => {
        await tx
          .table('coco_cashu_payment_request_receive_operations')
          .add(operationToRow(operation));
      },
    );
  }

  async update(operation: PaymentRequestReceiveOperation): Promise<void> {
    await this.db.runTransaction(
      'rw',
      ['coco_cashu_payment_request_receive_operations'],
      async (tx) => {
        const row = operationToRow(operation);
        row.updatedAt = getUnixTimeSeconds();
        await tx.table('coco_cashu_payment_request_receive_operations').put(row);
      },
    );
  }

  async getById(id: string): Promise<PaymentRequestReceiveOperation | null> {
    const row = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_operations')
      .get(id)) as PaymentRequestReceiveOperationRow | undefined;
    return row ? rowToOperation(row) : null;
  }

  async getByState(state: PaymentRequestReceiveState): Promise<PaymentRequestReceiveOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_operations')
      .where('state')
      .equals(state)
      .toArray()) as PaymentRequestReceiveOperationRow[];
    return rows.map(rowToOperation);
  }

  async getActiveByRequestId(requestId: string): Promise<PaymentRequestReceiveOperation[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_operations')
      .where('requestId')
      .equals(requestId)
      .filter((row: PaymentRequestReceiveOperationRow) => row.state === 'active')
      .toArray()) as PaymentRequestReceiveOperationRow[];
    return rows.map(rowToOperation);
  }

  async list(filter?: {
    state?: PaymentRequestReceiveState;
  }): Promise<PaymentRequestReceiveOperation[]> {
    if (filter?.state) {
      return this.getByState(filter.state);
    }
    const rows = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_operations')
      .toArray()) as PaymentRequestReceiveOperationRow[];
    return rows.map(rowToOperation);
  }

  async delete(id: string): Promise<void> {
    await this.db.runTransaction(
      'rw',
      ['coco_cashu_payment_request_receive_operations'],
      async (tx) => {
        await tx.table('coco_cashu_payment_request_receive_operations').delete(id);
      },
    );
  }
}

export class IdbPaymentRequestReceiveAttemptRepository implements PaymentRequestReceiveAttemptRepository {
  constructor(private readonly db: IdbDb) {}

  async create(attempt: PaymentRequestReceiveAttempt): Promise<void> {
    await this.db.runTransaction(
      'rw',
      ['coco_cashu_payment_request_receive_attempts'],
      async (tx) => {
        const table = tx.table('coco_cashu_payment_request_receive_attempts');
        if (attempt.transportMessageId) {
          const existingByMessage = await table
            .where('transportMessageId')
            .equals(attempt.transportMessageId)
            .first();
          if (existingByMessage) {
            throw new Error(
              `PaymentRequestReceiveAttempt with transport message id ${attempt.transportMessageId} already exists`,
            );
          }
        }
        if (attempt.receiveOperationId) {
          const existingByReceive = await table
            .where('receiveOperationId')
            .equals(attempt.receiveOperationId)
            .first();
          if (existingByReceive) {
            throw new Error(
              `PaymentRequestReceiveAttempt with receive operation id ${attempt.receiveOperationId} already exists`,
            );
          }
        }
        await table.add(attemptToRow(attempt));
      },
    );
  }

  async update(attempt: PaymentRequestReceiveAttempt): Promise<void> {
    await this.db.runTransaction(
      'rw',
      ['coco_cashu_payment_request_receive_attempts'],
      async (tx) => {
        const row = attemptToRow(attempt);
        row.updatedAt = getUnixTimeSeconds();
        await tx.table('coco_cashu_payment_request_receive_attempts').put(row);
      },
    );
  }

  async getById(id: string): Promise<PaymentRequestReceiveAttempt | null> {
    const row = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_attempts')
      .get(id)) as PaymentRequestReceiveAttemptRow | undefined;
    return row ? rowToAttempt(row) : null;
  }

  async getByRequestOperationId(
    requestOperationId: string,
  ): Promise<PaymentRequestReceiveAttempt[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_attempts')
      .where('requestOperationId')
      .equals(requestOperationId)
      .toArray()) as PaymentRequestReceiveAttemptRow[];
    return rows.map(rowToAttempt);
  }

  async getByReceiveOperationId(
    receiveOperationId: string,
  ): Promise<PaymentRequestReceiveAttempt | null> {
    const rows = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_attempts')
      .where('receiveOperationId')
      .equals(receiveOperationId)
      .toArray()) as PaymentRequestReceiveAttemptRow[];
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async getByTransportMessageId(
    transportMessageId: string,
  ): Promise<PaymentRequestReceiveAttempt | null> {
    const rows = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_attempts')
      .where('transportMessageId')
      .equals(transportMessageId)
      .toArray()) as PaymentRequestReceiveAttemptRow[];
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async getByPayloadHash(
    requestOperationId: string,
    payloadHash: string,
  ): Promise<PaymentRequestReceiveAttempt | null> {
    const row = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_attempts')
      .where('[requestOperationId+payloadHash]')
      .equals([requestOperationId, payloadHash])
      .first()) as PaymentRequestReceiveAttemptRow | undefined;
    return row ? rowToAttempt(row) : null;
  }

  async getByRequestIdAndPayloadHash(
    requestId: string,
    payloadHash: string,
  ): Promise<PaymentRequestReceiveAttempt | null> {
    const row = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_attempts')
      .where('requestId')
      .equals(requestId)
      .filter((candidate: PaymentRequestReceiveAttemptRow) => candidate.payloadHash === payloadHash)
      .first()) as PaymentRequestReceiveAttemptRow | undefined;
    return row ? rowToAttempt(row) : null;
  }

  async getByState(
    state: PaymentRequestReceiveAttemptState,
  ): Promise<PaymentRequestReceiveAttempt[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_payment_request_receive_attempts')
      .where('state')
      .equals(state)
      .toArray()) as PaymentRequestReceiveAttemptRow[];
    return rows.map(rowToAttempt);
  }

  async delete(id: string): Promise<void> {
    await this.db.runTransaction(
      'rw',
      ['coco_cashu_payment_request_receive_attempts'],
      async (tx) => {
        await tx.table('coco_cashu_payment_request_receive_attempts').delete(id);
      },
    );
  }
}
