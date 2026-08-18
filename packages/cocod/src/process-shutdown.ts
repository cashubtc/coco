import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from './utils/config.js';
import type { AppLogger } from './utils/logger.js';

export type ProcessShutdownReason = 'http_stop' | 'sigint' | 'sigterm';

interface ProcessShutdownDependencies {
  closeListener(): Promise<void>;
  disposeRuntime(): Promise<void>;
  cleanupProcessState(): Promise<void>;
  flushLogs(): Promise<void>;
  reportFailure(event: string, fields: Record<string, unknown>): void;
  exit(code: number): void;
  logger: AppLogger;
  timeoutMs?: number;
}

/** Coordinates the single Cocod Process shutdown shared by HTTP requests and process signals. */
export class ProcessShutdownCoordinator {
  private acceptingWork = true;
  private completion: Promise<number> | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly dependencies: ProcessShutdownDependencies) {
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive finite number');
    }
  }

  isAcceptingWork(): boolean {
    return this.acceptingWork;
  }

  request(reason: ProcessShutdownReason): Promise<number> {
    if (this.completion) {
      return this.completion;
    }

    this.acceptingWork = false;
    this.completion = this.shutdown(reason);
    return this.completion;
  }

  private async shutdown(reason: ProcessShutdownReason): Promise<number> {
    const { exit, logger, reportFailure } = this.dependencies;
    logger.info('daemon.shutdown.requested', { reason });

    const completion = this.finish(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProcessShutdownDeadlineError()), this.timeoutMs);
    });
    let exitCode: number;
    try {
      exitCode = await Promise.race([completion, deadline]);
    } catch (error) {
      if (!(error instanceof ProcessShutdownDeadlineError)) {
        throw error;
      }
      exitCode = 1;
      logger.error('daemon.shutdown_cleanup_failed', {
        stage: 'deadline',
        timeoutMs: this.timeoutMs,
      });
      reportFailure('daemon.shutdown_cleanup_failed', {
        stage: 'deadline',
        timeoutMs: this.timeoutMs,
        exitCode,
      });
    } finally {
      clearTimeout(timer);
    }
    exit(exitCode);
    return exitCode;
  }

  private async finish(reason: ProcessShutdownReason): Promise<number> {
    const { flushLogs, logger, reportFailure } = this.dependencies;
    const exitCode = await this.cleanup();
    logger.info('daemon.shutdown.completed', { reason, exitCode });
    try {
      await flushLogs();
    } catch (error) {
      reportFailure('daemon.shutdown_log_flush_failed', {
        error: safeError(error),
        exitCode,
      });
    }
    return exitCode;
  }

  private async cleanup(): Promise<number> {
    const { closeListener, disposeRuntime, cleanupProcessState, logger } = this.dependencies;
    const [listenerExitCode, sessionExitCode] = await Promise.all([
      runCleanupStage('listener', closeListener, 0, logger),
      runCleanupStage('coco_session', disposeRuntime, 0, logger),
    ]);
    const exitCode = listenerExitCode === 0 && sessionExitCode === 0 ? 0 : 1;
    return runCleanupStage('process_state', cleanupProcessState, exitCode, logger);
  }
}

class ProcessShutdownDeadlineError extends Error {}

async function runCleanupStage(
  stage: 'listener' | 'coco_session' | 'process_state',
  cleanup: () => Promise<void>,
  exitCode: number,
  logger: AppLogger,
): Promise<number> {
  try {
    await cleanup();
    return exitCode;
  } catch (error) {
    logger.error('daemon.shutdown_cleanup_failed', {
      stage,
      error: safeError(error),
    });
    return 1;
  }
}

function safeError(error: unknown): { name: string } {
  return { name: error instanceof Error ? error.name : 'UnknownError' };
}
