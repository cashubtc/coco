import { nip19 } from 'nostr-tools';

import { type AdministrativeCredential, type ClientCapability } from './credentials.js';
import { type CocodRuntime, type RunningCocoSession } from './runtime.js';
import { serializeError } from './utils/logger.js';
import type { AppLogger } from './utils/logger.js';

export type RouteHandler = (req: Request) => Promise<Response>;

export interface RouteDefinition {
  capability: ClientCapability | null;
  GET?: RouteHandler;
  POST?: RouteHandler;
}

export function createRouteHandlers(runtime: CocodRuntime): Record<string, RouteDefinition> {
  const routes: Record<string, RouteDefinition> = {
    '/npc/address': {
      capability: 'wallet:read',
      GET: requireRunning(runtime, async (_req, state: RunningCocoSession) => {
        try {
          const info = await state.npcAccount.getInfo();
          if (info.name) {
            return Response.json({ output: `${info.name}@npubx.cash` });
          }
          const npub = nip19.npubEncode(info.pubkey);
          return Response.json({ output: `${npub}@npubx.cash` });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Failed to get address: ${message}` }, { status: 500 });
        }
      }),
    },
    '/npc/username': {
      capability: 'wallet:admin',
      POST: requireRunning(runtime, async (req, state: RunningCocoSession) => {
        try {
          const { username, confirm } = (await req.json()) as {
            username: string;
            confirm?: boolean;
          };
          if (!username) {
            return Response.json({ error: 'Username is required' }, { status: 400 });
          }
          if (confirm) {
            const res = await state.npcAccount.setUsername(username, confirm);
            if (res.success) {
              return Response.json({ output: res });
            } else {
              return Response.json({
                error: `Failed to set username. Required amount: ${res.pr.amount}. Required mints: ${res.pr.mints?.join(',')}`,
              });
            }
          } else {
            const res = await state.npcAccount.setUsername(username);
            if (res.success) {
              return Response.json({ output: res });
            } else if (res.success === false) {
              return Response.json(
                {
                  error: `Payment required to set username: ${res.pr.amount || 0} SATS. Use 'cocod npc username ${username} --confirm' to proceed`,
                },
                { status: 402 },
              );
            } else {
              return Response.json({ error: 'Invalid response' });
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: `Username operation failed: ${message}` }, { status: 500 });
        }
      }),
    },

    '/events': {
      capability: 'wallet:read',
      GET: requireRunning(runtime, async (req, state: RunningCocoSession) => {
        const KEEP_ALIVE_INTERVAL = 5000; // 5 seconds (prevent 8-10s idle timeout)

        const stream = new ReadableStream({
          start(controller) {
            // Subscribe to history updates
            const unsubscribe = state.manager.on('history:updated', (payload) => {
              const eventData = JSON.stringify({
                type: 'history:updated',
                timestamp: new Date().toISOString(),
                data: payload,
              });
              const sseData = `data: ${eventData}\n\n`;
              controller.enqueue(new TextEncoder().encode(sseData));
            });

            // Send periodic keep-alive pings to prevent connection timeout
            const keepAliveInterval = setInterval(() => {
              controller.enqueue(new TextEncoder().encode(': ping\n\n'));
            }, KEEP_ALIVE_INTERVAL);

            // Cleanup on client disconnect
            req.signal.addEventListener('abort', () => {
              clearInterval(keepAliveInterval);
              unsubscribe();
              controller.close();
            });
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          },
        });
      }),
    },
  };

  return routes;
}

function requireRunning(
  runtime: CocodRuntime,
  handler: (req: Request, session: RunningCocoSession) => Promise<Response>,
): RouteHandler {
  return async (req: Request) => {
    const session = runtime.getRunningSession();
    if (session) {
      return handler(req, session);
    }

    const status = runtime.getStatus();
    if (!status.wallet) {
      return walletNotInitializedResponse();
    }
    if (status.seedAccess?.state === 'locked') {
      return Response.json(
        {
          error:
            "Wallet Seed Access is locked. Run 'cocod session start --passphrase <passphrase>'.",
        },
        { status: 403 },
      );
    }
    if (status.cocoSession.state === 'failed') {
      return Response.json({ error: 'Wallet error' }, { status: 500 });
    }
    return Response.json(
      { error: `Wallet session is ${status.cocoSession.state}` },
      { status: 503 },
    );
  };
}

function walletNotInitializedResponse(): Response {
  return Response.json(
    { error: "Wallet not initialized. Run 'cocod wallet initialize' first." },
    { status: 503 },
  );
}

export function buildRoutes(
  routeHandlers: Record<string, RouteDefinition>,
  runtime: CocodRuntime,
  credentials: AdministrativeCredential,
  logger?: AppLogger,
  options: { isAcceptingWork?: () => boolean } = {},
): Record<
  string,
  {
    GET?: (req: Request) => Promise<Response>;
    POST?: (req: Request) => Promise<Response>;
  }
> {
  const routes: Record<
    string,
    {
      GET?: (req: Request) => Promise<Response>;
      POST?: (req: Request) => Promise<Response>;
    }
  > = {};

  for (const [path, handlers] of Object.entries(routeHandlers)) {
    routes[path] = {};

    if (handlers.GET) {
      const handler = handlers.GET;
      routes[path]!.GET = async (req: Request) =>
        runRoute(
          path,
          req,
          runtime,
          credentials,
          handlers.capability,
          handler,
          logger,
          options.isAcceptingWork,
        );
    }

    if (handlers.POST) {
      const handler = handlers.POST;
      routes[path]!.POST = async (req: Request) =>
        runRoute(
          path,
          req,
          runtime,
          credentials,
          handlers.capability,
          handler,
          logger,
          options.isAcceptingWork,
        );
    }
  }

  return routes;
}

export function buildFallbackHandler(
  runtime: CocodRuntime,
  credentials: AdministrativeCredential,
  logger?: AppLogger,
  options: { isAcceptingWork?: () => boolean } = {},
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const path = new URL(req.url).pathname;
    return runRoute(
      path,
      req,
      runtime,
      credentials,
      'wallet:read',
      async () => {
        logger?.warn('request.unknown_endpoint', { method: req.method, path });
        return Response.json({ error: `Unknown endpoint: ${req.url}` }, { status: 404 });
      },
      logger,
      options.isAcceptingWork,
    );
  };
}

async function runRoute(
  path: string,
  req: Request,
  runtime: CocodRuntime,
  credentials: AdministrativeCredential,
  capability: ClientCapability | null,
  handler: RouteHandler,
  logger?: AppLogger,
  isAcceptingWork?: () => boolean,
): Promise<Response> {
  const startedAt = performance.now();
  const reqId = crypto.randomUUID();
  const requestLogger = logger?.child?.({ method: req.method, path, reqId }) ?? logger;

  try {
    if (capability) {
      const authorization = await credentials.authorize(
        req.headers.get('authorization'),
        capability,
      );
      if (authorization !== 'authorized') {
        const status = authorization === 'unauthenticated' ? 401 : 403;
        requestLogger?.warn('request.rejected', {
          durationMs: Math.round(performance.now() - startedAt),
          state: runtime.getStatus().cocoSession.state,
          status,
        });
        return Response.json(
          { error: status === 401 ? 'Unauthorized' : 'Forbidden' },
          {
            status,
            headers: status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined,
          },
        );
      }
    }

    if (isAcceptingWork?.() === false) {
      const response = Response.json({ error: 'Daemon is shutting down' }, { status: 503 });
      requestLogger?.warn('request.rejected', {
        durationMs: Math.round(performance.now() - startedAt),
        state: runtime.getStatus().cocoSession.state,
        status: response.status,
      });
      return response;
    }

    const response = await handler(req);
    const durationMs = Math.round(performance.now() - startedAt);
    const level = response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info';

    requestLogger?.log?.(level, 'request.completed', {
      durationMs,
      state: runtime.getStatus().cocoSession.state,
      status: response.status,
    });

    return response;
  } catch (error) {
    requestLogger?.error('request.failed', {
      durationMs: Math.round(performance.now() - startedAt),
      error: serializeError(error),
      state: runtime.getStatus().cocoSession.state,
    });

    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
