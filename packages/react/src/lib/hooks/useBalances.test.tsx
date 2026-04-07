import type { Manager } from '@cashu/coco-core';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHookWrapper } from '../../test/testUtils';
import useBalances from './useBalances';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }

    await act(async () => {
      await Promise.resolve();
    });
  }

  throw lastError;
}

function createManagerMock() {
  const byMint = vi.fn().mockResolvedValue({});
  const manager = {
    wallet: {
      balances: {
        byMint,
      },
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Manager;

  return { manager, byMint };
}

describe('useBalances', () => {
  it('preserves an explicit empty mintUrls scope', async () => {
    const { manager, byMint } = createManagerMock();

    const { result } = renderHook(() => useBalances({ mintUrls: [] }), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(byMint).toHaveBeenCalledWith({
        mintUrls: [],
        trustedOnly: undefined,
      });
      expect(result.current.balances).toEqual({
        byMint: {},
        total: {
          spendable: 0,
          reserved: 0,
          total: 0,
        },
      });
    });
  });
});
