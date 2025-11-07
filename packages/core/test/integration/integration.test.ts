import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { runIntegrationTests } from 'coco-cashu-adapter-tests';
import { MemoryRepositories } from '../../repositories/memory';
import { ConsoleLogger } from '../../logging';
import type { Logger, LogLevel } from '../../logging';

const mintUrl = process.env.MINT_URL;

if (!mintUrl) {
  throw new Error('MINT_URL is not set');
}

function getTestLogger(): Logger | undefined {
  const logLevel = process.env.TEST_LOG_LEVEL;
  if (logLevel && ['error', 'warn', 'info', 'debug'].includes(logLevel)) {
    return new ConsoleLogger('testnut-integration', { level: logLevel as LogLevel });
  }
  return undefined;
}

async function createRepositories() {
  const repositories = new MemoryRepositories();
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      // Memory repositories don't need cleanup
    },
  };
}

runIntegrationTests(
  {
    createRepositories,
    mintUrl,
    logger: getTestLogger(),
    suiteName: 'Testnut Integration Tests',
  },
  { describe, it, beforeEach, afterEach, expect },
);
