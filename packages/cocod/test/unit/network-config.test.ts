import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_CLIENT_URL,
  resolveClientEndpoint,
  resolveListenerConfig,
} from '../../src/utils/config.js';

describe('cocod network configuration', () => {
  test('uses the fixed loopback listener and ignores generic PORT', () => {
    expect(resolveListenerConfig({ PORT: '9000' })).toEqual({
      hostname: '127.0.0.1',
      port: 62626,
    });
    expect(resolveClientEndpoint(undefined, {})).toEqual({
      url: DEFAULT_CLIENT_URL,
      explicit: false,
    });
  });

  test('accepts an explicitly configured non-loopback listener', () => {
    expect(
      resolveListenerConfig({
        COCOD_LISTEN_HOST: '0.0.0.0',
        COCOD_LISTEN_PORT: '64000',
      }),
    ).toEqual({ hostname: '0.0.0.0', port: 64000 });
  });

  test.each([
    [{ COCOD_LISTEN_HOST: '' }, 'COCOD_LISTEN_HOST'],
    [{ COCOD_LISTEN_HOST: 'http://127.0.0.1' }, 'COCOD_LISTEN_HOST'],
    [{ COCOD_LISTEN_HOST: 'host/name' }, 'COCOD_LISTEN_HOST'],
    [{ COCOD_LISTEN_PORT: '' }, 'COCOD_LISTEN_PORT'],
    [{ COCOD_LISTEN_PORT: '0' }, 'COCOD_LISTEN_PORT'],
    [{ COCOD_LISTEN_PORT: '65536' }, 'COCOD_LISTEN_PORT'],
    [{ COCOD_LISTEN_PORT: '62626.5' }, 'COCOD_LISTEN_PORT'],
  ] as const)('rejects malformed listener input %p', (environment, setting) => {
    expect(() => resolveListenerConfig(environment)).toThrow(setting);
  });

  test('prefers --url over COCOD_URL and marks both choices explicit', () => {
    expect(
      resolveClientEndpoint('https://wallet.example.com/', {
        COCOD_URL: 'http://127.0.0.1:63000',
      }),
    ).toEqual({ url: 'https://wallet.example.com', explicit: true });
    expect(resolveClientEndpoint(undefined, { COCOD_URL: 'http://127.0.0.1:63000/' })).toEqual({
      url: 'http://127.0.0.1:63000',
      explicit: true,
    });
  });

  test.each([
    'wallet.example.com',
    'ftp://wallet.example.com',
    'https://user:secret@wallet.example.com',
    'https://wallet.example.com/base',
    'https://wallet.example.com/?query=true',
    'https://wallet.example.com/#fragment',
  ])('rejects an invalid explicit client endpoint %s', (url) => {
    expect(() => resolveClientEndpoint(url, {})).toThrow('Cocod URL');
  });
});
