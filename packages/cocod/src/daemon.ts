import { mnemonicToSeedSync } from "@scure/bip39";
import { CONFIG_FILE, SOCKET_PATH, PID_FILE } from "./utils/config.js";
import { createDaemonLogger, serializeError } from "./utils/logger.js";
import { DaemonStateManager } from "./utils/state.js";
import { initializeWallet } from "./utils/wallet.js";
import { createRouteHandlers, buildRoutes } from "./routes.js";
import type { WalletConfig } from "./utils/config.js";

export async function startDaemon() {
  const stateManager = new DaemonStateManager();
  const logger = createDaemonLogger();

  logger.info("daemon.start.requested", {
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
    logger.warn("daemon.start.skipped", {
      reason: "already_running",
      socketPath: SOCKET_PATH,
    });
    await logger.flush();
    console.error(`Error: Daemon is already running on ${SOCKET_PATH}`);
    process.exit(1);
  } catch {
    // Not running, safe to proceed
  }

  try {
    await Bun.write(PID_FILE, "");
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

  try {
    const configExists = await Bun.file(CONFIG_FILE).exists();
    if (configExists) {
      const configText = await Bun.file(CONFIG_FILE).text();
      const config: WalletConfig = JSON.parse(configText);

      if (config.encrypted) {
        stateManager.setLocked(config.mnemonic, config.mintUrl);
        logger.info("wallet.config_loaded", {
          encrypted: true,
          mintUrl: config.mintUrl,
          state: "LOCKED",
        });
      } else {
        const manager = await initializeWallet(
          config,
          undefined,
          logger.child({ component: "wallet" }),
        );
        const seed = mnemonicToSeedSync(config.mnemonic);
        stateManager.setUnlocked(manager, config.mintUrl, seed);
        logger.info("wallet.config_loaded", {
          encrypted: false,
          mintUrl: config.mintUrl,
          state: "UNLOCKED",
        });
      }
    } else {
      logger.info("wallet.config_missing");
    }
  } catch (error) {
    logger.warn("wallet.config_load_failed", { error: serializeError(error) });
    stateManager.setError(String(error));
  }

  const routeHandlers = createRouteHandlers(stateManager, logger.child({ component: "wallet" }));
  const routes = buildRoutes(
    routeHandlers,
    () => stateManager.getState(),
    logger.child({
      component: "http",
    }),
  );

  let server: ReturnType<typeof Bun.serve> | undefined;
  let isShuttingDown = false;

  const cleanup = async (reason: string) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    logger.info("daemon.shutdown.requested", { reason });

    server?.stop();

    try {
      await Bun.file(PID_FILE).delete();
    } catch {
      // File might not exist
    }

    logger.info("daemon.shutdown.completed", { reason });
    await logger.flush();
    process.exit(0);
  };

  server = Bun.serve({
    unix: SOCKET_PATH,
    routes: {
      ...routes,
      "/stop": {
        POST: async () => {
          logger.info("daemon.stop_requested", { reason: "http_stop" });
          setTimeout(() => {
            void cleanup("http_stop");
          }, 100);
          return Response.json({ output: "Daemon stopping" });
        },
      },
    },
    async fetch(req) {
      logger.warn("request.unknown_endpoint", {
        method: req.method,
        url: req.url,
      });
      return Response.json({ error: `Unknown endpoint: ${req.url}` }, { status: 404 });
    },
  });

  logger.info("daemon.started", { socketPath: SOCKET_PATH });
  if (stateManager.isUninitialized()) {
    logger.info("wallet.uninitialized");
  }

  process.on("unhandledRejection", (error) => {
    logger.error("daemon.unhandled_rejection", { error: serializeError(error) });
  });

  process.on("uncaughtException", (error) => {
    logger.error("daemon.uncaught_exception", { error: serializeError(error) });
    void logger.flush().finally(() => {
      process.exit(1);
    });
  });

  process.on("SIGINT", () => {
    void cleanup("sigint");
  });
  process.on("SIGTERM", () => {
    void cleanup("sigterm");
  });
}
