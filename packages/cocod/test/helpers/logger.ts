import { mock } from 'bun:test';

import type { AppLogger } from '../../src/utils/logger.js';

type LoggerOverrides = Partial<Pick<AppLogger, 'error' | 'warn' | 'info' | 'debug'>>;

export function createTestLogger(overrides: LoggerOverrides = {}): AppLogger {
  let logger: AppLogger;
  logger = {
    error: overrides.error ?? mock(() => {}),
    warn: overrides.warn ?? mock(() => {}),
    info: overrides.info ?? mock(() => {}),
    debug: overrides.debug ?? mock(() => {}),
    child: mock(() => logger),
    flush: mock(async () => {}),
  } as unknown as AppLogger;
  return logger;
}
