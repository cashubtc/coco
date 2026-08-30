export class DurableEventOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableEventOutboxError';
  }
}

export class DurableEventValidationError extends DurableEventOutboxError {
  constructor(message: string) {
    super(message);
    this.name = 'DurableEventValidationError';
  }
}

export class DurableEventBatchConflictError extends DurableEventOutboxError {
  constructor(message: string) {
    super(message);
    this.name = 'DurableEventBatchConflictError';
  }
}

export class DurableEventCapacityExceededError extends DurableEventOutboxError {
  constructor(message: string) {
    super(message);
    this.name = 'DurableEventCapacityExceededError';
  }
}

export class DurableEventRevisionAlreadyCompactedError extends DurableEventOutboxError {
  readonly streamId: string;
  readonly streamRevision: number;

  constructor(streamId: string, streamRevision: number) {
    super(`Durable event revision ${streamRevision} for stream ${streamId} is already compacted`);
    this.name = 'DurableEventRevisionAlreadyCompactedError';
    this.streamId = streamId;
    this.streamRevision = streamRevision;
  }
}

export class DurableEventInvariantError extends DurableEventOutboxError {
  constructor(message: string) {
    super(message);
    this.name = 'DurableEventInvariantError';
  }
}

export class DurableEventStaleClaimError extends DurableEventOutboxError {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`Durable event ${eventId} does not have the current claim token`);
    this.name = 'DurableEventStaleClaimError';
    this.eventId = eventId;
  }
}

/**
 * The host transaction mechanism could not commit a transaction that it proved rolled back.
 * This is an adapter conflict, not a consumer delivery failure.
 */
export class DurableEventTransactionConflictError extends DurableEventOutboxError {
  constructor(message = 'Durable event transaction conflict') {
    super(message);
    this.name = 'DurableEventTransactionConflictError';
  }
}

/**
 * The host transaction mechanism cannot prove whether the local transaction committed.
 * The caller must reconcile durable state before it tries the operation again.
 */
export class DurableEventCommitUnknownError extends DurableEventOutboxError {
  constructor(message = 'Durable event transaction commit result is unknown') {
    super(message);
    this.name = 'DurableEventCommitUnknownError';
  }
}

export class DurableEventCorruptRecordError extends DurableEventOutboxError {
  readonly eventId: string;

  constructor(eventId: string, message: string) {
    super(message);
    this.name = 'DurableEventCorruptRecordError';
    this.eventId = eventId;
  }
}

export class DurableEventConsumerError extends DurableEventOutboxError {
  readonly code: string;
  readonly retryable: boolean;
  readonly safeMessage?: string;

  constructor(options: {
    code: string;
    retryable: boolean;
    safeMessage?: string;
    cause?: unknown;
  }) {
    super(options.safeMessage ?? options.code);
    this.name = 'DurableEventConsumerError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.safeMessage = options.safeMessage;
    (this as unknown as { cause?: unknown }).cause = options.cause;
  }
}
