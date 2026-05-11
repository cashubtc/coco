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

beforeEach(() => {
  installLocalStorageMock();
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

  it('uses a custom storage key', async () => {
    const seed = makeSeed(3);
    mockRandomValues(seed);
    const seedGetter = localStorageSeedGetter({ storageKey: 'MY_COCO_SEED' });

    await expect(seedGetter()).resolves.toEqual(seed);
    expect(window.localStorage.getItem('MY_COCO_SEED')).toBe(encodeSeed(seed));
    expect(window.localStorage.getItem('COCO_REACT_SEED')).toBeNull();
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
