import { expect, mock, test } from 'bun:test';

import { ProcessShutdownCoordinator } from '../../src/process-shutdown.js';
import { deferred } from '../helpers/deferred.js';
import { createTestLogger } from '../helpers/logger.js';

test('accepts one shutdown and waits for listener and Session cleanup before process cleanup', async () => {
  const listenerClosed = deferred<void>();
  const closeListener = mock(() => listenerClosed.promise);
  const disposeRuntime = mock(async () => {});
  const cleanupProcessState = mock(async () => {});
  const flushLogs = mock(async () => {});
  const exit = mock((_code: number) => {});
  const coordinator = new ProcessShutdownCoordinator({
    closeListener,
    disposeRuntime,
    cleanupProcessState,
    flushLogs,
    reportFailure: () => {},
    exit,
    logger: createTestLogger(),
  });

  const first = coordinator.request('http_stop');
  const concurrent = coordinator.request('sigterm');

  expect(coordinator.isAcceptingWork()).toBe(false);
  expect(concurrent).toBe(first);
  expect(closeListener).toHaveBeenCalledTimes(1);
  expect(disposeRuntime).toHaveBeenCalledTimes(1);
  expect(cleanupProcessState).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();

  listenerClosed.resolve();
  expect(await first).toBe(0);

  expect(disposeRuntime).toHaveBeenCalledTimes(1);
  expect(cleanupProcessState).toHaveBeenCalledTimes(1);
  expect(flushLogs).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(0);
});

test('reports a non-zero exit when Coco Session cleanup cannot be confirmed', async () => {
  const logError = mock((_event: string, _fields: unknown) => {});
  const cleanupProcessState = mock(async () => {});
  const flushLogs = mock(async () => {});
  const exit = mock((_code: number) => {});
  const coordinator = new ProcessShutdownCoordinator({
    closeListener: async () => {},
    disposeRuntime: async () => {
      throw new Error('sensitive repository connection failed');
    },
    cleanupProcessState,
    flushLogs,
    reportFailure: () => {},
    exit,
    logger: createTestLogger({ error: logError }),
  });

  expect(await coordinator.request('sigint')).toBe(1);

  expect(cleanupProcessState).toHaveBeenCalledTimes(1);
  expect(flushLogs).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(1);
  expect(logError).toHaveBeenCalledWith('daemon.shutdown_cleanup_failed', {
    stage: 'coco_session',
    error: { name: 'Error' },
  });
  expect(JSON.stringify(logError.mock.calls)).not.toContain('sensitive repository connection');
});

test('attempts Coco Session cleanup when listener closure exceeds the shared deadline', async () => {
  const logError = mock((_event: string, _fields: unknown) => {});
  const disposeRuntime = mock(async () => {});
  const cleanupProcessState = mock(async () => {});
  const reportFailure = mock((_event: string, _fields: Record<string, unknown>) => {});
  const exit = mock((_code: number) => {});
  const coordinator = new ProcessShutdownCoordinator({
    closeListener: () => new Promise<void>(() => {}),
    disposeRuntime,
    cleanupProcessState,
    flushLogs: async () => {},
    reportFailure,
    exit,
    logger: createTestLogger({ error: logError }),
    timeoutMs: 5,
  });

  expect(await coordinator.request('sigterm')).toBe(1);

  expect(disposeRuntime).toHaveBeenCalledTimes(1);
  expect(cleanupProcessState).not.toHaveBeenCalled();
  expect(logError).toHaveBeenCalledWith('daemon.shutdown_cleanup_failed', {
    stage: 'deadline',
    timeoutMs: 5,
  });
  expect(reportFailure).toHaveBeenCalledWith('daemon.shutdown_cleanup_failed', {
    stage: 'deadline',
    timeoutMs: 5,
    exitCode: 1,
  });
  expect(exit).toHaveBeenCalledWith(1);
}, 100);

test('bounds stalled log delivery with the process deadline', async () => {
  const reportFailure = mock((_event: string, _fields: Record<string, unknown>) => {});
  const exit = mock((_code: number) => {});
  const coordinator = new ProcessShutdownCoordinator({
    closeListener: async () => {},
    disposeRuntime: async () => {},
    cleanupProcessState: async () => {},
    flushLogs: () => new Promise<void>(() => {}),
    reportFailure,
    exit,
    logger: createTestLogger(),
    timeoutMs: 5,
  });

  expect(await coordinator.request('sigint')).toBe(1);
  expect(reportFailure).toHaveBeenCalledWith('daemon.shutdown_cleanup_failed', {
    stage: 'deadline',
    timeoutMs: 5,
    exitCode: 1,
  });
  expect(exit).toHaveBeenCalledWith(1);
}, 100);
