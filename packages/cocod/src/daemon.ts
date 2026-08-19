import {
  CONFIG_DIR,
  listenerUrl,
  PID_FILE,
  resolveListenerConfig,
  type ListenerConfig,
} from './utils/config.js';
import { createDaemonLogger, serializeError } from './utils/logger.js';
import { CocodRuntime } from './runtime.js';
import { buildFallbackHandler, createRouteHandlers, buildRoutes } from './routes.js';
import { AdministrativeCredential } from './credentials.js';
import { ProcessShutdownCoordinator } from './process-shutdown.js';
import {
  StateDirectoryLease,
  StateDirectoryLeaseUnavailableError,
} from './state-directory-lease.js';
import { buildV1FallbackHandler, buildV1Routes, createV1RouteDefinitions } from './v1/http.js';
import packageJson from '../package.json' with { type: 'json' };

export async function startDaemon() {
  const logger = createDaemonLogger();
  let listener: ListenerConfig;

  try {
    listener = resolveListenerConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('daemon.configuration_invalid', { message });
    await logger.flush();
    console.error(`Error: ${message}`);
    process.exit(1);
  }
  const endpoint = listenerUrl(listener);

  logger.info('daemon.start.requested', {
    pidFile: PID_FILE,
    endpoint,
  });

  let stateDirectoryLease: StateDirectoryLease;
  try {
    stateDirectoryLease = await StateDirectoryLease.acquire();
  } catch (error) {
    if (error instanceof StateDirectoryLeaseUnavailableError) {
      logger.warn('daemon.start.skipped', {
        reason: 'state_directory_owned',
        stateDirectory: CONFIG_DIR,
      });
      await logger.flush();
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    logger.error('daemon.state_directory_lease_failed', {
      stateDirectory: CONFIG_DIR,
      error: serializeError(error),
    });
    await logger.flush();
    console.error(`Error: Failed to acquire Cocod state directory lease at ${CONFIG_DIR}`);
    process.exit(1);
  }

  let credentials: AdministrativeCredential;
  let runtime: CocodRuntime;
  try {
    credentials = await AdministrativeCredential.loadOrBootstrap();
    runtime = await CocodRuntime.load({
      logger: logger.child({ component: 'wallet' }),
    });
  } catch (error) {
    await stateDirectoryLease.release();
    throw error;
  }

  let server: ReturnType<typeof Bun.serve> | undefined;
  const shutdown = new ProcessShutdownCoordinator({
    closeListener: async () => {
      await server?.stop();
    },
    disposeRuntime: () => runtime.dispose(),
    cleanupProcessState: async () => {
      await cleanupProcessState(stateDirectoryLease);
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

  try {
    server = Bun.serve({
      hostname: listener.hostname,
      port: listener.port,
      routes: { ...legacyRoutes, ...v1Routes },
      fetch: buildV1FallbackHandler(credentials, legacyFallback, httpLogger),
    });
  } catch (error) {
    try {
      await runtime.dispose();
    } finally {
      await stateDirectoryLease.release();
    }
    logger.error('daemon.listener_bind_failed', { endpoint, error: serializeError(error) });
    await logger.flush();
    console.error(`Error: Failed to bind Cocod TCP listener at ${endpoint}`);
    process.exit(1);
  }

  try {
    await Bun.write(PID_FILE, process.pid.toString());
  } catch (error) {
    try {
      await server.stop(true);
    } finally {
      try {
        await runtime.dispose();
      } finally {
        await stateDirectoryLease.release();
      }
    }
    logger.error('daemon.process_state_initialization_failed', {
      error: serializeError(error),
    });
    await logger.flush();
    console.error(`Error: Failed to write Cocod PID file at ${PID_FILE}`);
    process.exit(1);
  }

  logger.info('daemon.started', { endpoint });
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

async function cleanupProcessState(stateDirectoryLease: StateDirectoryLease): Promise<void> {
  let pidCleanupError: unknown;
  try {
    await Bun.file(PID_FILE).delete();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      pidCleanupError = error;
    }
  }

  try {
    await stateDirectoryLease.release();
  } catch (error) {
    if (pidCleanupError !== undefined) {
      throw new AggregateError(
        [pidCleanupError, error],
        'Failed to clean up Cocod PID and state directory lease',
      );
    }
    throw error;
  }

  if (pidCleanupError !== undefined) {
    throw pidCleanupError;
  }
}
