import { SOCKET_PATH, PID_FILE } from './utils/config.js';
import { createDaemonLogger, serializeError } from './utils/logger.js';
import { CocodRuntime } from './runtime.js';
import { buildFallbackHandler, createRouteHandlers, buildRoutes } from './routes.js';
import { AdministrativeCredential } from './credentials.js';
import { ProcessShutdownCoordinator } from './process-shutdown.js';
import { buildV1FallbackHandler, buildV1Routes, createV1RouteDefinitions } from './v1/http.js';
import packageJson from '../package.json' with { type: 'json' };

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

  const credentials = await AdministrativeCredential.loadOrBootstrap();
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

  let server: ReturnType<typeof Bun.serve> | undefined;
  const shutdown = new ProcessShutdownCoordinator({
    closeListener: async () => {
      await server?.stop();
    },
    disposeRuntime: () => runtime.dispose(),
    cleanupProcessState: async () => {
      try {
        await Bun.file(PID_FILE).delete();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    },
    flushLogs: () => logger.flush(),
    reportFailure: (event, fields) => {
      process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
    },
    exit: (code) => process.exit(code),
    logger,
  });
  const routeHandlers = createRouteHandlers(runtime);
  const httpLogger = logger.child({ component: 'http' });
  const availability = { isAcceptingWork: () => shutdown.isAcceptingWork() };
  const legacyRoutes = buildRoutes(routeHandlers, runtime, credentials, httpLogger, availability);
  const v1Routes = buildV1Routes(
    createV1RouteDefinitions(runtime, packageJson.version, shutdown, httpLogger),
    credentials,
    httpLogger,
    availability,
  );
  const legacyFallback = buildFallbackHandler(runtime, credentials, httpLogger, availability);

  server = Bun.serve({
    unix: SOCKET_PATH,
    routes: { ...legacyRoutes, ...v1Routes },
    fetch: buildV1FallbackHandler(credentials, legacyFallback, httpLogger),
  });

  logger.info('daemon.started', { socketPath: SOCKET_PATH });
  const unattendedStart = runtime.startUnattendedSession();
  const status = runtime.getStatus();
  if (!status.wallet) {
    logger.info('wallet.uninitialized');
  } else if (!unattendedStart) {
    logger.info('wallet.config_loaded', {
      mintUrl: status.wallet.mintUrl,
      seedAccess: 'locked',
    });
  } else {
    logger.info('wallet.session_start_requested', {
      mintUrl: status.wallet.mintUrl,
      reason: 'unattended_startup',
    });
    void unattendedStart.completion.then(
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
    void shutdown.request('sigint');
  });
  process.on('SIGTERM', () => {
    void shutdown.request('sigterm');
  });
}
