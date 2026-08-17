import { SOCKET_PATH, PID_FILE } from './utils/config.js';
import { createDaemonLogger, serializeError } from './utils/logger.js';
import { CocodRuntime } from './runtime.js';
import { createRouteHandlers, buildRoutes } from './routes.js';

export async function startDaemon() {
  const logger = createDaemonLogger();

  logger.info('daemon.start.requested', {
    pidFile: PID_FILE,
    socketPath: SOCKET_PATH,
  });

  try {
    const testConn = await Bun.connect({
      unix: SOCKET_PATH,
      socket: {
        data() {},
        open() {},
        close() {},
        drain() {},
      },
    });
    testConn.end();
    logger.warn('daemon.start.skipped', {
      reason: 'already_running',
      socketPath: SOCKET_PATH,
    });
    await logger.flush();
    console.error(`Error: Daemon is already running on ${SOCKET_PATH}`);
    process.exit(1);
  } catch {
    // Not running, safe to proceed
  }

  const runtime = await CocodRuntime.load({
    logger: logger.child({ component: 'wallet' }),
  });

  try {
    await Bun.write(PID_FILE, '');
    await Bun.file(PID_FILE).delete();
  } catch {
    // Directory creation failed or file didn't exist
  }

  try {
    await Bun.file(SOCKET_PATH).delete();
  } catch {
    // File might not exist
  }
  try {
    await Bun.file(PID_FILE).delete();
  } catch {
    // File might not exist
  }

  await Bun.write(PID_FILE, process.pid.toString());

  const routeHandlers = createRouteHandlers(runtime);
  const routes = buildRoutes(
    routeHandlers,
    runtime,
    logger.child({
      component: 'http',
    }),
  );

  let server: ReturnType<typeof Bun.serve> | undefined;
  let isShuttingDown = false;

  const cleanup = async (reason: string) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    logger.info('daemon.shutdown.requested', { reason });

    server?.stop();

    if (runtime.getStatus().cocoSession.state !== 'stopped') {
      // Give watchers, processors, and plugins a graceful stop, but never block shutdown on it.
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        runtime.dispose().catch((error) => {
          logger.warn('daemon.dispose_failed', { error: serializeError(error) });
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, 3000);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        logger.warn('daemon.dispose_timed_out', { timeoutMs: 3000 });
      }
    }

    try {
      await Bun.file(PID_FILE).delete();
    } catch {
      // File might not exist
    }

    logger.info('daemon.shutdown.completed', { reason });
    await logger.flush();
    process.exit(0);
  };

  server = Bun.serve({
    unix: SOCKET_PATH,
    routes: {
      ...routes,
      '/stop': {
        POST: async () => {
          logger.info('daemon.stop_requested', { reason: 'http_stop' });
          setTimeout(() => {
            void cleanup('http_stop');
          }, 100);
          return Response.json({ output: 'Daemon stopping' });
        },
      },
    },
    async fetch(req) {
      logger.warn('request.unknown_endpoint', {
        method: req.method,
        url: req.url,
      });
      return Response.json({ error: `Unknown endpoint: ${req.url}` }, { status: 404 });
    },
  });

  logger.info('daemon.started', { socketPath: SOCKET_PATH });
  const status = runtime.getStatus();
  if (!status.wallet) {
    logger.info('wallet.uninitialized');
  } else if (status.seedAccess?.requiresPassphrase) {
    logger.info('wallet.config_loaded', {
      mintUrl: status.wallet.mintUrl,
      seedAccess: 'locked',
    });
  } else {
    logger.info('wallet.session_start_requested', {
      mintUrl: status.wallet.mintUrl,
      reason: 'unattended_startup',
    });
    const transition = runtime.startSession();
    void transition.completion.then(
      () => {
        logger.info('wallet.session_started', { mintUrl: status.wallet?.mintUrl });
      },
      (error) => {
        logger.error('wallet.session_start_failed', { error: serializeError(error) });
      },
    );
  }

  process.on('unhandledRejection', (error) => {
    logger.error('daemon.unhandled_rejection', { error: serializeError(error) });
  });

  process.on('uncaughtException', (error) => {
    logger.error('daemon.uncaught_exception', { error: serializeError(error) });
    void logger.flush().finally(() => {
      process.exit(1);
    });
  });

  process.on('SIGINT', () => {
    void cleanup('sigint');
  });
  process.on('SIGTERM', () => {
    void cleanup('sigterm');
  });
}
