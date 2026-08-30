import { ensureSchema, IdbDb } from '../index.ts';
import { createTransactionalIdbDurableEventOutboxRepository } from './durableEventOutbox.ts';

interface WorkerMessage {
  dbName: string;
  action: 'claim' | 'enqueue';
  token?: string;
  workerId?: string;
}

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: { result: string | null; error?: string }): void;
};

worker.onmessage = async ({ data }) => {
  const database = new IdbDb({ name: data.dbName });
  try {
    await ensureSchema(database);
    const repository = createTransactionalIdbDurableEventOutboxRepository(database);
    if (data.action === 'enqueue') {
      const result = await repository.enqueueRevision(
        {
          streamId: 'operation-1',
          expectedPreviousRevision: 0,
          streamRevision: 1,
          events: [
            {
              id: 'operation-1-event-1',
              eventKey: 'project-history',
              consumerId: 'wallet.history.projector',
              eventType: 'wallet.operation.finalized',
              envelopeVersion: 1,
              payloadVersion: 1,
              streamId: 'operation-1',
              streamRevision: 1,
              payload: { operationId: 'operation-1' },
              occurredAt: 100,
            },
          ],
        },
        100,
      );
      worker.postMessage({ result: result.outcome });
      return;
    }
    const claim = await repository.claimNext({
      workerId: data.workerId!,
      leaseToken: data.token!,
      leaseDurationMs: 100,
      now: 100,
      contracts: [
        {
          consumerId: 'wallet.history.projector',
          eventType: 'wallet.operation.finalized',
          envelopeVersion: 1,
          payloadVersion: 1,
        },
      ],
    });
    worker.postMessage({ result: claim?.id ?? null });
  } catch (error) {
    worker.postMessage({
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    database.close();
  }
};
