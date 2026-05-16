import { Amount, type Manager } from '@cashu/coco-core';
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
  const byMintAndUnit = vi.fn().mockResolvedValue({});
  const byUnit = vi.fn().mockResolvedValue({});
  const totalByUnit = vi.fn().mockResolvedValue({});
  const manager = {
    wallet: {
      balances: {
        byMint,
        byMintAndUnit,
        byUnit,
        totalByUnit,
      },
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Manager;

  return { manager, byMint, byMintAndUnit, byUnit, totalByUnit };
}

describe('useBalances', () => {
  it('preserves an explicit empty mintUrls scope', async () => {
    const { manager, byMint, byMintAndUnit, byUnit, totalByUnit } = createManagerMock();

    const { result } = renderHook(() => useBalances({ mintUrls: [] }), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(byMint).toHaveBeenCalledWith({
        mintUrls: [],
        units: undefined,
        trustedOnly: undefined,
      });
      expect(byMintAndUnit).toHaveBeenCalledWith({
        mintUrls: [],
        units: undefined,
        trustedOnly: undefined,
      });
      expect(byUnit).toHaveBeenCalledWith({
        mintUrls: [],
        units: undefined,
        trustedOnly: undefined,
      });
      expect(totalByUnit).toHaveBeenCalledWith({
        mintUrls: [],
        units: undefined,
        trustedOnly: undefined,
      });
      expect(result.current.balances).toEqual({
        byMint: {},
        byMintAndUnit: {},
        byUnit: {},
        total: {
          spendable: Amount.zero(),
          reserved: Amount.zero(),
          total: Amount.zero(),
          unit: 'sat',
        },
        totalByUnit: {},
      });
    });
  });

  it('does not expose a mixed-unit legacy total for multi-unit scopes', async () => {
    const { manager, byMint, byMintAndUnit, byUnit, totalByUnit } = createManagerMock();
    byMintAndUnit.mockResolvedValue({
      'https://mint.test': {
        sat: {
          spendable: Amount.from(10),
          reserved: Amount.zero(),
          total: Amount.from(10),
          unit: 'sat',
        },
        usd: {
          spendable: Amount.from(5),
          reserved: Amount.zero(),
          total: Amount.from(5),
          unit: 'usd',
        },
      },
    });
    byUnit.mockResolvedValue({
      sat: {
        spendable: Amount.from(10),
        reserved: Amount.zero(),
        total: Amount.from(10),
        unit: 'sat',
      },
      usd: {
        spendable: Amount.from(5),
        reserved: Amount.zero(),
        total: Amount.from(5),
        unit: 'usd',
      },
    });
    totalByUnit.mockResolvedValue({
      sat: {
        spendable: Amount.from(10),
        reserved: Amount.zero(),
        total: Amount.from(10),
        unit: 'sat',
      },
      usd: {
        spendable: Amount.from(5),
        reserved: Amount.zero(),
        total: Amount.from(5),
        unit: 'usd',
      },
    });

    const { result } = renderHook(() => useBalances({ units: ['sat', 'usd'] }), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(byMint).not.toHaveBeenCalled();
      expect(result.current.balances.byMint).toEqual({});
      expect(result.current.balances.total).toEqual({
        spendable: Amount.zero(),
        reserved: Amount.zero(),
        total: Amount.zero(),
        unit: 'sat',
      });
      expect(Object.keys(result.current.balances.totalByUnit)).toEqual(['sat', 'usd']);
    });
  });
});
