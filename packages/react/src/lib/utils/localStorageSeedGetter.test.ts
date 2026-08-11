import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localStorageSeedGetter } from './localStorageSeedGetter';

const makeSeed = (offset = 0): Uint8Array =>
  Uint8Array.from({ length: 64 }, (_, index) => (index + offset) % 256);

const encodeSeed = (seed: Uint8Array): string => {
  let binary = '';
  for (const byte of seed) {
    binary += String.fromCharCode(byte);
  }

  return window.btoa(binary);
};

const mockRandomValues = (seed: Uint8Array) =>
  vi
    .spyOn(window.crypto, 'getRandomValues')
    .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (!(array instanceof Uint8Array)) {
        throw new Error('expected Uint8Array');
      }

      array.set(seed);
      return array;
    });

const installLocalStorageMock = () => {
  const storage = new Map<string, string>();
  const localStorageMock: Storage = {
    get length() {
      return storage.size;
    },
    clear: vi.fn(() => {
      storage.clear();
    }),
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(storage.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
  };

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: localStorageMock,
  });
};

const installWebLocksMock = () => {
  let lockTail = Promise.resolve();
  const request = vi.fn(
    async <T>(name: string, callback: (lock: Lock) => Promise<T> | T): Promise<T> => {
      const previousLock = lockTail;
      let releaseLock: () => void = () => undefined;
      lockTail = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      await previousLock;

      try {
        return await callback({ name, mode: 'exclusive' } as Lock);
      } finally {
        releaseLock();
      }
    },
  );

  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: { request },
  });

  return request;
};

beforeEach(() => {
  installLocalStorageMock();
  installWebLocksMock();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('localStorageSeedGetter', () => {
  it('creates and stores a seed under the default key', async () => {
    const seed = makeSeed();
    const getRandomValues = mockRandomValues(seed);
    const seedGetter = localStorageSeedGetter();

    await expect(seedGetter()).resolves.toEqual(seed);
    expect(window.localStorage.getItem('COCO_REACT_SEED')).toBe(encodeSeed(seed));
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('converges concurrent initializers on the same persisted seed', async () => {
    const generatedSeeds = [makeSeed(31), makeSeed(37)];
    const getRandomValues = vi
      .spyOn(window.crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (!(array instanceof Uint8Array)) {
          throw new Error('expected Uint8Array');
        }

        const seed = generatedSeeds.shift();
        if (!seed) {
          throw new Error('unexpected random request');
        }

        array.set(seed);
        return array;
      });

    const firstGetter = localStorageSeedGetter();
    const secondGetter = localStorageSeedGetter();
    let secondPromise: Promise<Uint8Array> | null = null;

    vi.mocked(window.localStorage.getItem).mockImplementationOnce(() => {
      secondPromise = secondGetter();
      return null;
    });

    const firstSeed = await firstGetter();
    if (!secondPromise) {
      throw new Error('second initializer did not run');
    }
    const secondSeed = await secondPromise;

    expect(firstSeed).toEqual(secondSeed);
    expect(window.localStorage.getItem('COCO_REACT_SEED')).toBe(encodeSeed(firstSeed));
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('uses a custom storage key', async () => {
    const seed = makeSeed(3);
    mockRandomValues(seed);
    const seedGetter = localStorageSeedGetter({ storageKey: 'MY_COCO_SEED' });

    await expect(seedGetter()).resolves.toEqual(seed);
    expect(window.localStorage.getItem('MY_COCO_SEED')).toBe(encodeSeed(seed));
    expect(window.localStorage.getItem('COCO_REACT_SEED')).toBeNull();
  });

  it('fails before generating a seed when Web Locks are unavailable', async () => {
    const getRandomValues = mockRandomValues(makeSeed(5));
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    const seedGetter = localStorageSeedGetter();

    await expect(seedGetter()).rejects.toThrow(
      'localStorageSeedGetter requires window.navigator.locks.',
    );
    expect(getRandomValues).not.toHaveBeenCalled();
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
  });

  it('reads an existing seed from localStorage', async () => {
    const seed = makeSeed(7);
    const getRandomValues = mockRandomValues(makeSeed(11));
    window.localStorage.setItem('COCO_REACT_SEED', encodeSeed(seed));

    const seedGetter = localStorageSeedGetter();

    await expect(seedGetter()).resolves.toEqual(seed);
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('caches the seed in the returned getter closure', async () => {
    const seed = makeSeed(13);
    mockRandomValues(seed);
    const seedGetter = localStorageSeedGetter();

    const firstSeed = await seedGetter();
    firstSeed[0] = 255;
    window.localStorage.setItem('COCO_REACT_SEED', encodeSeed(makeSeed(17)));

    await expect(seedGetter()).resolves.toEqual(seed);
  });

  it('does not cache a generated seed when localStorage persistence fails', async () => {
    const seed = makeSeed(19);
    const getRandomValues = mockRandomValues(seed);
    vi.mocked(window.localStorage.setItem).mockImplementationOnce(() => {
      throw new Error('quota exceeded');
    });
    const seedGetter = localStorageSeedGetter();

    await expect(seedGetter()).rejects.toThrow('quota exceeded');
    expect(window.localStorage.getItem('COCO_REACT_SEED')).toBeNull();

    await expect(seedGetter()).resolves.toEqual(seed);
    expect(window.localStorage.getItem('COCO_REACT_SEED')).toBe(encodeSeed(seed));
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    expect(window.localStorage.setItem).toHaveBeenCalledTimes(2);
  });
});
