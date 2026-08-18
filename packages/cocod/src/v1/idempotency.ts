interface IdempotencyRecord<T> {
  readonly fingerprint: string;
  readonly result: Promise<T>;
  settled: boolean;
}

/** Raised when one Idempotency-Key identifies two different validated commands. */
export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super('The Idempotency-Key was already used for a different request');
    this.name = 'IdempotencyKeyConflictError';
  }
}

/** Raised when all bounded idempotency slots contain commands that are still pending. */
export class IdempotencyCapacityError extends Error {
  constructor() {
    super('The process-local idempotency store is temporarily full');
    this.name = 'IdempotencyCapacityError';
  }
}

/**
 * Replays accepted process-local commands while retaining bounded records with opaque request
 * fingerprints. Failed commands are removed so the same key can be retried.
 */
export class ProcessLocalIdempotency {
  private readonly records = new Map<string, IdempotencyRecord<unknown>>();

  constructor(private readonly maxEntries = 1_024) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive safe integer');
    }
  }

  async execute<T>(
    key: string,
    requestIdentity: unknown,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const fingerprint = await fingerprintRequest(requestIdentity);
    const existing = this.records.get(key) as IdempotencyRecord<T> | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new IdempotencyKeyConflictError();
      }
      this.touch(key, existing);
      return existing.result;
    }

    this.makeRoom();
    const record: IdempotencyRecord<T> = {
      fingerprint,
      result: Promise.resolve().then(operation),
      settled: false,
    };
    this.records.set(key, record as IdempotencyRecord<unknown>);
    void record.result.then(
      () => {
        record.settled = true;
      },
      () => {
        record.settled = true;
        if (this.records.get(key) === record) {
          this.records.delete(key);
        }
      },
    );
    return record.result;
  }

  private touch<T>(key: string, record: IdempotencyRecord<T>): void {
    this.records.delete(key);
    this.records.set(key, record as IdempotencyRecord<unknown>);
  }

  private makeRoom(): void {
    if (this.records.size < this.maxEntries) {
      return;
    }
    for (const [key, record] of this.records) {
      if (record.settled) {
        this.records.delete(key);
        return;
      }
    }
    throw new IdempotencyCapacityError();
  }
}

async function fingerprintRequest(value: unknown): Promise<string> {
  const serialized = stableSerialize(value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return Buffer.from(digest).toString('hex');
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Idempotency request identity contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Idempotency request identity is not JSON-compatible');
}
