import type { CoreEvents, Manager } from '@cashu/coco-core';

import type { AppLogger } from '../../utils/logger.js';
import { V1HttpStreamResponse, type V1Runtime } from '../contract.js';
import { noBodySchema } from '../schema.js';
import { resourceEventSchema, type ResourceEventDocument } from '../resource-schemas.js';
import { toHistoryDocument } from './history.js';
import { defineResourceRoute, requireRunningSession } from './shared.js';

/** Default keep-alive interval; each keep-alive also re-checks the Client Credential. */
export const EVENT_KEEP_ALIVE_INTERVAL_MS = 5_000;

/**
 * Most chunks a stream may hold for a client that is not reading. Beyond it the stream closes, and
 * the client reconnects and refetches, as it must after any disconnect.
 */
export const EVENT_BUFFER_LIMIT = 256;

type EventData<T extends ResourceEventDocument['type']> = Extract<
  ResourceEventDocument,
  { type: T }
>['data'];

interface EventStreamOptions {
  manager: Pick<Manager, 'on'>;
  signal: AbortSignal;
  reauthorize(): Promise<boolean>;
  isCurrentSession(): boolean;
  keepAliveIntervalMs: number;
  logger?: AppLogger;
}

/** Projects Coco events into safe resource invalidations for one connected client. */
export function createResourceEventStream(options: EventStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let close = (): void => {};

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let authorizationCheckInFlight = false;
        let keepAlive: ReturnType<typeof setInterval> | undefined;
        const unsubscribes: Array<() => void> = [];

        close = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          options.signal.removeEventListener('abort', close);
          for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
          try {
            controller.close();
          } catch {
            // The consumer already cancelled the stream.
          }
        };

        const enqueue = (chunk: string): void => {
          if (closed) return;
          if (!options.isCurrentSession()) {
            close();
            return;
          }
          if ((controller.desiredSize ?? 0) <= 0) {
            options.logger?.warn('event.stream_overflow', { bufferLimit: EVENT_BUFFER_LIMIT });
            close();
            return;
          }
          controller.enqueue(encoder.encode(chunk));
        };

        const publish = <T extends ResourceEventDocument['type']>(type: T, data: EventData<T>) => {
          const document = { type, timestamp: new Date().toISOString(), data };
          try {
            enqueue(`data: ${JSON.stringify(resourceEventSchema.parse(document))}\n\n`);
          } catch (error) {
            options.logger?.error('event.projection_failed', {
              type,
              error: { name: error instanceof Error ? error.name : 'UnknownError' },
            });
          }
        };

        const on = <E extends keyof CoreEvents>(
          event: E,
          handler: (payload: CoreEvents[E]) => void,
        ): void => {
          unsubscribes.push(options.manager.on(event, handler));
        };

        on('history:updated', ({ entry }) => publish('history.updated', toHistoryDocument(entry)));

        for (const event of ['mint:added', 'mint:updated'] as const) {
          on(event, ({ mint }) => publish('mint.updated', { mintUrl: mint.mintUrl }));
        }
        for (const event of [
          'mint:metadata-refreshed',
          'mint:trusted',
          'mint:untrusted',
        ] as const) {
          on(event, ({ mintUrl }) => publish('mint.updated', { mintUrl }));
        }

        on('mint-quote:updated', ({ mintUrl, method, quoteId }) =>
          publish('quote.updated', { quoteType: 'mint', mintUrl, method, quoteId }),
        );
        on('melt-quote:updated', ({ mintUrl, method, quoteId }) =>
          publish('quote.updated', { quoteType: 'melt', mintUrl, method, quoteId }),
        );

        const operationEvents = {
          send: ['send:prepared', 'send:pending', 'send:finalized', 'send:rolled-back'],
          receive: ['receive-op:prepared', 'receive-op:finalized', 'receive-op:rolled-back'],
          melt: ['melt-op:prepared', 'melt-op:pending', 'melt-op:finalized', 'melt-op:rolled-back'],
          mint: [
            'mint-op:pending',
            'mint-op:requeue',
            'mint-op:executing',
            'mint-op:finalized',
            'mint-op:failed',
          ],
        } as const;
        for (const [operationType, events] of Object.entries(operationEvents) as Array<
          [keyof typeof operationEvents, (typeof operationEvents)[keyof typeof operationEvents]]
        >) {
          for (const event of events) {
            on(event, ({ mintUrl, operationId }) =>
              publish('operation.updated', { operationType, operationId, mintUrl }),
            );
          }
        }

        for (const event of [
          'proofs:saved',
          'proofs:state-changed',
          'proofs:deleted',
          'proofs:wiped',
          'proofs:reserved',
          'proofs:released',
        ] as const) {
          on(event, ({ mintUrl }) => publish('balance.updated', { mintUrl }));
        }

        keepAlive = setInterval(() => {
          if (closed || authorizationCheckInFlight) return;
          if (!options.isCurrentSession()) {
            close();
            return;
          }
          authorizationCheckInFlight = true;
          options
            .reauthorize()
            .then(
              (authorized) => (authorized ? enqueue(': keep-alive\n\n') : close()),
              (error: unknown) => {
                options.logger?.error('event.reauthorization_failed', {
                  error: { name: error instanceof Error ? error.name : 'UnknownError' },
                });
                close();
              },
            )
            .finally(() => {
              authorizationCheckInFlight = false;
            });
        }, options.keepAliveIntervalMs);

        options.signal.addEventListener('abort', close, { once: true });
        enqueue(': connected\n\n');
        if (options.signal.aborted) close();
      },
      cancel() {
        close();
      },
    },
    new CountQueuingStrategy({ highWaterMark: EVENT_BUFFER_LIMIT }),
  );
}

function isCurrentSession(runtime: V1Runtime, manager: Manager): boolean {
  return runtime.getRunningSession()?.manager === manager;
}

export const eventRoutes = [
  defineResourceRoute({
    method: 'GET',
    path: '/v1/events',
    capability: 'wallet:read',
    summary: 'Server-sent resource invalidations for the running Coco Session',
    requestSchema: noBodySchema,
    responseSchema: resourceEventSchema,
    responseCacheControl: 'no-store',
    responseMediaType: 'text/event-stream',
    handler: (_input, { request, reauthorize }, { runtime, logger, eventKeepAliveIntervalMs }) => {
      const { manager } = requireRunningSession(runtime);
      return new V1HttpStreamResponse(
        createResourceEventStream({
          manager,
          signal: request.signal,
          reauthorize,
          isCurrentSession: () => isCurrentSession(runtime, manager),
          keepAliveIntervalMs: eventKeepAliveIntervalMs,
          logger,
        }),
      );
    },
  }),
];
