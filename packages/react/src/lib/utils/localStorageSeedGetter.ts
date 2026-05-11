const DEFAULT_STORAGE_KEY = 'COCO_REACT_SEED';
const SEED_LENGTH_BYTES = 64;

export type LocalStorageSeedGetterConfig = {
  storageKey?: string;
};

const getBrowserWindow = (): Window & typeof globalThis => {
  if (typeof window === 'undefined') {
    throw new Error('localStorageSeedGetter requires a browser window.');
  }

  if (!window.localStorage) {
    throw new Error('localStorageSeedGetter requires window.localStorage.');
  }

  if (!window.crypto?.getRandomValues) {
    throw new Error('localStorageSeedGetter requires window.crypto.getRandomValues.');
  }

  return window;
};

const encodeSeed = (seed: Uint8Array, browserWindow: Window & typeof globalThis): string => {
  let binary = '';
  for (const byte of seed) {
    binary += String.fromCharCode(byte);
  }

  return browserWindow.btoa(binary);
};

const decodeSeed = (encodedSeed: string, browserWindow: Window & typeof globalThis): Uint8Array => {
  const binary = browserWindow.atob(encodedSeed);
  const seed = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    seed[index] = binary.charCodeAt(index);
  }

  if (seed.length !== SEED_LENGTH_BYTES) {
    throw new Error(
      `localStorageSeedGetter expected a ${SEED_LENGTH_BYTES}-byte seed in localStorage.`,
    );
  }

  return seed;
};

const createSeed = (browserWindow: Window & typeof globalThis): Uint8Array => {
  const seed = new Uint8Array(SEED_LENGTH_BYTES);
  browserWindow.crypto.getRandomValues(seed);
  return seed;
};

/**
 * Creates a Coco seed getter backed by browser localStorage.
 *
 * The returned getter reads or creates the seed once, then serves it from its
 * closure on later calls.
 */
export const localStorageSeedGetter = (config: LocalStorageSeedGetterConfig = {}) => {
  const storageKey = config.storageKey ?? DEFAULT_STORAGE_KEY;
  let cachedSeed: Uint8Array | null = null;

  return async (): Promise<Uint8Array> => {
    if (cachedSeed) {
      return new Uint8Array(cachedSeed);
    }

    const browserWindow = getBrowserWindow();
    const storedSeed = browserWindow.localStorage.getItem(storageKey);

    if (storedSeed) {
      cachedSeed = decodeSeed(storedSeed, browserWindow);
      return new Uint8Array(cachedSeed);
    }

    const generatedSeed = createSeed(browserWindow);
    browserWindow.localStorage.setItem(storageKey, encodeSeed(generatedSeed, browserWindow));
    cachedSeed = generatedSeed;

    return new Uint8Array(generatedSeed);
  };
};
