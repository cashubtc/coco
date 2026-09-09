export interface CreateV1RouteDefinitionsOptions {
  eventAuthorizationRevalidationIntervalMs?: number;
}
import { normalizeMintUrl, type CoreEvents } from '@cashu/coco-core';
import type { AppLogger } from '../../utils/logger.js';
import {
  defineV1Route,
  V1HttpStreamResponse,
  type V1Runtime,
  type V1RouteDefinition,
  type V1RouteMetadata,
} from '../contract.js';
import {
  noBodySchema,
  resourceInvalidationEventSchema,
  type ResourceInvalidationEventDocument,
} from '../schema.js';
import { requireRunningSession } from './session.js';
import { parseQuery } from './parameters.js';
import { toHistoryDocument } from './history-projection.js';

const EVENTS_ROUTE = {
  method: 'GET',
  path: '/v1/events',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: resourceInvalidationEventSchema,
  responseCacheControl: 'no-store',
  responseMediaType: 'text/event-stream',
} as const satisfies V1RouteMetadata<null, ResourceInvalidationEventDocument>;

type CocoPublicEventSource = {
  on<E extends keyof CoreEvents>(
    event: E,
    handler: (payload: CoreEvents[E]) => void | Promise<void>,
  ): () => void;
};

const EVENT_KEEP_ALIVE_INTERVAL_MS = 5_000;

function createResourceInvalidationStream(
  manager: CocoPublicEventSource,
  request: Request,
  reauthorize: () => Promise<boolean>,
  authorizationRevalidationIntervalMs: number,
  logger: AppLogger | undefined,
  isCurrentSession: () => boolean,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup = (_closeController: boolean) => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const unsubscribes: Array<() => void> = [];
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      let authorizationCheckInFlight = false;

      const enqueueChunk = (chunk: string): boolean => {
        if (closed || controller.desiredSize === null || controller.desiredSize <= 0) return false;
        controller.enqueue(encoder.encode(chunk));
        return true;
      };

      const enqueue = (document: ResourceInvalidationEventDocument): void => {
        if (closed) return;
        if (!isCurrentSession() || controller.desiredSize === null || controller.desiredSize <= 0) {
          // A disconnected consumer will refetch canonical resources. Keeping the connection
          // alive after silently dropping an invalidation could leave it permanently stale.
          cleanup(true);
          return;
        }
        try {
          const event = resourceInvalidationEventSchema.parse(document);
          enqueueChunk(`data: ${JSON.stringify(event)}\n\n`);
        } catch (error) {
          logger?.error('event.projection_failed', {
            eventType: document.type,
            error: { name: error instanceof Error ? error.name : 'UnknownError' },
          });
        }
      };
      const invalidate = <E extends keyof CoreEvents>(
        event: E,
        project: (payload: CoreEvents[E]) => ResourceInvalidationEventDocument,
      ): void => {
        unsubscribes.push(
          manager.on(event, (payload) => {
            try {
              enqueue(project(payload));
            } catch (error) {
              logger?.error('event.projection_failed', {
                coreEvent: event,
                error: { name: error instanceof Error ? error.name : 'UnknownError' },
              });
            }
          }),
        );
      };
      const timestamp = (): string => new Date().toISOString();
      const mintUpdated = (mintUrl: string): ResourceInvalidationEventDocument => ({
        type: 'mint.updated',
        timestamp: timestamp(),
        data: { mintUrl: normalizeMintUrl(mintUrl) },
      });
      const balanceUpdated = (mintUrl: string): ResourceInvalidationEventDocument => ({
        type: 'balance.updated',
        timestamp: timestamp(),
        data: { mintUrl: normalizeMintUrl(mintUrl) },
      });
      const operationUpdated = (
        operationType: 'mint' | 'melt' | 'send' | 'receive',
        payload: { mintUrl: string; operationId: string },
      ): ResourceInvalidationEventDocument => ({
        type: 'operation.updated',
        timestamp: timestamp(),
        data: {
          operationType,
          operationId: payload.operationId,
          mintUrl: normalizeMintUrl(payload.mintUrl),
        },
      });

      invalidate('history:updated', ({ entry }) => ({
        type: 'history.updated',
        timestamp: timestamp(),
        data: toHistoryDocument(entry),
      }));

      invalidate('mint:added', ({ mint }) => mintUpdated(mint.mintUrl));
      invalidate('mint:updated', ({ mint }) => mintUpdated(mint.mintUrl));
      invalidate('mint:metadata-refreshed', ({ mintUrl }) => mintUpdated(mintUrl));
      invalidate('mint:trusted', ({ mintUrl }) => mintUpdated(mintUrl));
      invalidate('mint:untrusted', ({ mintUrl }) => mintUpdated(mintUrl));

      invalidate('mint-quote:updated', ({ mintUrl, method, quoteId }) => ({
        type: 'quote.updated',
        timestamp: timestamp(),
        data: { quoteType: 'mint', mintUrl: normalizeMintUrl(mintUrl), method, quoteId },
      }));
      invalidate('melt-quote:updated', ({ mintUrl, method, quoteId }) => ({
        type: 'quote.updated',
        timestamp: timestamp(),
        data: { quoteType: 'melt', mintUrl: normalizeMintUrl(mintUrl), method, quoteId },
      }));

      invalidate('send:prepared', (payload) => operationUpdated('send', payload));
      invalidate('send:pending', (payload) => operationUpdated('send', payload));
      invalidate('send:finalized', (payload) => operationUpdated('send', payload));
      invalidate('send:rolled-back', (payload) => operationUpdated('send', payload));
      invalidate('receive-op:prepared', (payload) => operationUpdated('receive', payload));
      invalidate('receive-op:finalized', (payload) => operationUpdated('receive', payload));
      invalidate('receive-op:rolled-back', (payload) => operationUpdated('receive', payload));
      invalidate('melt-op:prepared', (payload) => operationUpdated('melt', payload));
      invalidate('melt-op:pending', (payload) => operationUpdated('melt', payload));
      invalidate('melt-op:finalized', (payload) => operationUpdated('melt', payload));
      invalidate('melt-op:rolled-back', (payload) => operationUpdated('melt', payload));
      invalidate('mint-op:pending', (payload) => operationUpdated('mint', payload));
      invalidate('mint-op:requeue', (payload) => operationUpdated('mint', payload));
      invalidate('mint-op:executing', (payload) => operationUpdated('mint', payload));
      invalidate('mint-op:finalized', (payload) => operationUpdated('mint', payload));
      invalidate('mint-op:failed', (payload) => operationUpdated('mint', payload));

      invalidate('proofs:saved', ({ mintUrl }) => balanceUpdated(mintUrl));
      invalidate('proofs:state-changed', ({ mintUrl }) => balanceUpdated(mintUrl));
      invalidate('proofs:deleted', ({ mintUrl }) => balanceUpdated(mintUrl));
      invalidate('proofs:wiped', ({ mintUrl }) => balanceUpdated(mintUrl));
      invalidate('proofs:reserved', ({ mintUrl }) => balanceUpdated(mintUrl));
      invalidate('proofs:released', ({ mintUrl }) => balanceUpdated(mintUrl));

      const onAbort = () => cleanup(true);
      cleanup = (closeController: boolean): void => {
        if (closed) return;
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        request.signal.removeEventListener('abort', onAbort);
        for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
        if (closeController) {
          try {
            controller.close();
          } catch {
            // The consumer may have cancelled the body at the same time as the request aborted.
          }
        }
      };

      const revalidateAuthorization = (): void => {
        if (closed) return;
        if (!isCurrentSession()) {
          cleanup(true);
          return;
        }
        if (authorizationCheckInFlight) return;
        authorizationCheckInFlight = true;
        void reauthorize()
          .then(
            (authorized) => {
              if (closed) return;
              if (!authorized || !isCurrentSession()) {
                cleanup(true);
                return;
              }
              enqueueChunk(': ping\n\n');
            },
            (error) => {
              logger?.error('event.authorization_revalidation_failed', {
                error: { name: error instanceof Error ? error.name : 'UnknownError' },
              });
              cleanup(true);
            },
          )
          .finally(() => {
            authorizationCheckInFlight = false;
          });
      };

      enqueueChunk(': connected\n\n');
      keepAlive = setInterval(() => {
        revalidateAuthorization();
      }, authorizationRevalidationIntervalMs);
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) cleanup(true);
    },
    cancel() {
      cleanup(false);
    },
  });
}

export const eventsMetadata = [EVENTS_ROUTE];

export function createEventsRoutes(
  runtime: V1Runtime,
  logger?: AppLogger,
  options: CreateV1RouteDefinitionsOptions = {},
): V1RouteDefinition[] {
  const events = defineV1Route({
    ...EVENTS_ROUTE,
    handler: (_input, request, { reauthorize }) => {
      parseQuery(request, [], 'The Event stream query is invalid');
      const manager = requireRunningSession(runtime).manager;
      return new V1HttpStreamResponse(
        createResourceInvalidationStream(
          manager,
          request,
          reauthorize,
          options.eventAuthorizationRevalidationIntervalMs ?? EVENT_KEEP_ALIVE_INTERVAL_MS,
          logger,
          () =>
            runtime.getStatus().cocoSession.state === 'running' &&
            runtime.getRunningSession()?.manager === manager,
        ),
        200,
        { Connection: 'keep-alive' },
      );
    },
  });
  return [events];
}
