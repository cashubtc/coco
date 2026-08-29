import { describe, expect, it, mock } from 'bun:test';

import {
  KeysetSyncError,
  OperationRecoveryRequiredError,
  StaleKeysetError,
} from '../../models/Error.ts';
import { KeysetRotationService } from '../../operations/KeysetRotationService.ts';
import { MintScopedLock } from '../../operations/MintScopedLock.ts';
import type { WalletService } from '../../services/WalletService.ts';

const operation = {
  operationId: 'op-1',
  mintUrl: 'https://mint.example',
  unit: 'sat',
  cause: new Error('mint rejected stale outputs'),
};

function createService(options?: {
  requireRefresh?: () => Promise<void>;
  refresh?: () => Promise<void>;
}) {
  const calls: string[] = [];
  const requireMintRefresh = mock(async () => {
    calls.push('require');
    await options?.requireRefresh?.();
  });
  const refreshRequiredMint = mock(async () => {
    calls.push('refresh');
    await options?.refresh?.();
  });
  const clearCache = mock(() => {
    calls.push('invalidate');
  });
  const walletService = {
    requireMintRefresh,
    refreshRequiredMint,
    clearCache,
  } as unknown as WalletService;

  return {
    calls,
    requireMintRefresh,
    refreshRequiredMint,
    service: new KeysetRotationService(walletService, new MintScopedLock()),
  };
}

describe('KeysetRotationService', () => {
  it('persists refresh intent, rolls back, refreshes, then reports a retryable stale error', async () => {
    const { calls, service } = createService();

    const promise = service.handleStaleKeyset({
      ...operation,
      reconcile: async () => {
        calls.push('reconcile');
        return { status: 'rolled_back' };
      },
    });

    await expect(promise).rejects.toBeInstanceOf(StaleKeysetError);
    expect(calls).toEqual(['require', 'reconcile', 'refresh']);
    try {
      await promise;
    } catch (error) {
      expect(error).toMatchObject({
        operationId: 'op-1',
        mintUrl: 'https://mint.example',
        unit: 'sat',
        retryable: true,
      });
    }
  });

  it('returns a recovered operation only after the forced refresh succeeds', async () => {
    const { calls, service } = createService();
    const recovered = { state: 'finalized' };

    const result = await service.handleStaleKeyset({
      ...operation,
      reconcile: async () => {
        calls.push('reconcile');
        return { status: 'resolved', value: recovered };
      },
    });

    expect(result).toBe(recovered);
    expect(calls).toEqual(['require', 'reconcile', 'refresh']);
  });

  it('serializes concurrent stale recovery for the same mint snapshot', async () => {
    const { calls, service } = createService();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = service.handleStaleKeyset({
      ...operation,
      operationId: 'op-1',
      reconcile: async () => {
        calls.push('reconcile-1');
        markFirstStarted();
        await firstMayFinish;
        return { status: 'rolled_back' };
      },
    });
    await firstStarted;

    const second = service.handleStaleKeyset({
      ...operation,
      operationId: 'op-2',
      reconcile: async () => {
        calls.push('reconcile-2');
        return { status: 'rolled_back' };
      },
    });
    await Promise.resolve();
    expect(calls).toEqual(['require', 'reconcile-1']);

    const firstResult = first.catch((error: unknown) => error);
    const secondResult = second.catch((error: unknown) => error);
    releaseFirst();
    expect(await firstResult).toBeInstanceOf(StaleKeysetError);
    expect(await secondResult).toBeInstanceOf(StaleKeysetError);
    expect(calls).toEqual([
      'require',
      'reconcile-1',
      'refresh',
      'require',
      'reconcile-2',
      'refresh',
    ]);
  });

  it('requires recovery when the operation outcome is ambiguous', async () => {
    const { calls, refreshRequiredMint, service } = createService();

    const promise = service.handleStaleKeyset({
      ...operation,
      reconcile: async () => {
        calls.push('reconcile');
        return { status: 'recovery_required', cause: new Error('mixed proof state') };
      },
    });

    await expect(promise).rejects.toBeInstanceOf(OperationRecoveryRequiredError);
    expect(calls).toEqual(['require', 'reconcile', 'invalidate']);
    expect(refreshRequiredMint).not.toHaveBeenCalled();
  });

  it('requires recovery when persisting or refreshing the snapshot boundary fails', async () => {
    const persistFailure = createService({
      requireRefresh: async () => {
        throw new Error('database unavailable');
      },
    });
    await expect(
      persistFailure.service.handleStaleKeyset({
        ...operation,
        reconcile: async () => ({ status: 'rolled_back' }),
      }),
    ).rejects.toBeInstanceOf(OperationRecoveryRequiredError);
    expect(persistFailure.calls).toEqual(['require']);

    const refreshFailure = createService({
      refresh: async () => {
        throw new Error('mint unavailable');
      },
    });
    await expect(
      refreshFailure.service.handleStaleKeyset({
        ...operation,
        reconcile: async () => {
          refreshFailure.calls.push('reconcile');
          return { status: 'rolled_back' };
        },
      }),
    ).rejects.toBeInstanceOf(OperationRecoveryRequiredError);
    expect(refreshFailure.calls).toEqual(['require', 'reconcile', 'refresh']);
  });

  it('force-refreshes an unknown keyset before throwing a stable sync error', async () => {
    const { calls, service } = createService();

    const promise = service.refreshUnknownKeyset({
      ...operation,
      keysetId: '00deadbeef',
    });

    await expect(promise).rejects.toBeInstanceOf(KeysetSyncError);
    expect(calls).toEqual(['require', 'refresh']);
    try {
      await promise;
    } catch (error) {
      expect(error).toMatchObject({
        mintUrl: 'https://mint.example',
        keysetId: '00deadbeef',
      });
    }
  });
});
