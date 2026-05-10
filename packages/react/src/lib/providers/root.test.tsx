import { initializeCoco, type CocoConfig, type Manager } from '@cashu/coco-core';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CocoCashuProvider } from './root';

vi.mock('@cashu/coco-core', async () => {
  const actual = await vi.importActual<typeof import('@cashu/coco-core')>('@cashu/coco-core');
  return {
    ...actual,
    initializeCoco: vi.fn(),
  };
});

const initializeCocoMock = vi.mocked(initializeCoco);

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

function createManagerMock(): Manager {
  return {
    mint: {
      getAllMints: vi.fn().mockResolvedValue([]),
      addMint: vi.fn(),
      trustMint: vi.fn(),
      untrustMint: vi.fn(),
      isTrustedMint: vi.fn(),
    },
    wallet: {
      balances: {
        byMint: vi.fn().mockResolvedValue({}),
      },
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Manager;
}

function createConfigMock(): CocoConfig {
  return {
    repo: {
      init: vi.fn(),
    },
    seedGetter: vi.fn(),
  } as unknown as CocoConfig;
}

describe('CocoCashuProvider', () => {
  it('initializes a manager from config and renders the fallback until ready', async () => {
    const manager = createManagerMock();
    const config = createConfigMock();
    initializeCocoMock.mockResolvedValue(manager);

    const { getByText, queryByText } = render(
      <CocoCashuProvider config={config} fallback={<div>Loading wallet</div>}>
        <div>Wallet ready</div>
      </CocoCashuProvider>,
    );

    expect(getByText('Loading wallet')).not.toBeNull();
    expect(queryByText('Wallet ready')).toBeNull();

    await waitForAssertion(() => {
      expect(getByText('Wallet ready')).not.toBeNull();
    });

    expect(initializeCocoMock).toHaveBeenCalledTimes(1);
    expect(initializeCocoMock).toHaveBeenCalledWith(config);
  });

  it('renders an initialization error fallback', async () => {
    const config = createConfigMock();
    initializeCocoMock.mockRejectedValue(new Error('seed unavailable'));

    const { getByText, queryByText } = render(
      <CocoCashuProvider
        config={config}
        errorFallback={(error) => <div>Failed: {error.message}</div>}
      >
        <div>Wallet ready</div>
      </CocoCashuProvider>,
    );

    await waitForAssertion(() => {
      expect(getByText('Failed: seed unavailable')).not.toBeNull();
    });

    expect(queryByText('Wallet ready')).toBeNull();
  });

  it('continues to accept an already initialized manager', () => {
    const manager = createManagerMock();

    const { getByText } = render(
      <CocoCashuProvider manager={manager}>
        <div>Wallet ready</div>
      </CocoCashuProvider>,
    );

    expect(getByText('Wallet ready')).not.toBeNull();
    expect(initializeCocoMock).not.toHaveBeenCalled();
  });
});
