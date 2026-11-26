import { OIDCAuth } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { initializeCoco } from '../../Manager.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

const mintUrl = 'https://auth-mint.test';
const discoveryUrl = 'https://auth.test/.well-known/openid-configuration';
const tokenEndpoint = 'https://auth.test/token';
const deviceEndpoint = 'https://auth.test/device';

/**
 * A clear-auth session through `Manager.auth`, against a faked `fetch` for the mint's info and the
 * OIDC provider. Every token the provider issues expires in a second, so each `ensureCAT` refreshes.
 */
describe('Clear auth session refresh', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('keeps refreshing a device-flow session and keeps its refresh token', async () => {
    const refreshGrants: string[] = [];
    let issued = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url === `${mintUrl}/v1/info`)
        return json({
          name: 'Auth Mint',
          pubkey: '02'.padEnd(66, 'a'),
          version: 'fake/1.0.0',
          nuts: {
            '4': { methods: [], disabled: false },
            '5': { methods: [], disabled: false },
            '21': {
              openid_discovery: discoveryUrl,
              client_id: 'cashu-client',
              protected_endpoints: [],
            },
          },
        });
      if (url === discoveryUrl)
        return json({
          issuer: 'https://auth.test',
          token_endpoint: tokenEndpoint,
          device_authorization_endpoint: deviceEndpoint,
        });
      if (url === deviceEndpoint)
        return json({
          device_code: 'device-code',
          user_code: 'USER-CODE',
          verification_uri: 'https://auth.test/verify',
          expires_in: 600,
          interval: 1,
        });
      if (url === tokenEndpoint) {
        const form = new URLSearchParams(String(init?.body));
        if (form.get('grant_type') === 'refresh_token')
          refreshGrants.push(form.get('refresh_token')!);
        issued += 1;
        return json({
          access_token: `cat-${issued}`,
          refresh_token: `refresh-${issued}`,
          token_type: 'Bearer',
          expires_in: 1,
        });
      }
      return json({ error: `unhandled ${url}` }, 404);
    }) as typeof fetch;
    // The device flow waits out the provider's polling interval between token requests.
    const sleep = spyOn(
      OIDCAuth.prototype as unknown as { sleep(): Promise<void> },
      'sleep',
    ).mockResolvedValue(undefined);
    const repo = new MemoryRepositories();
    const coco = await initializeCoco({
      repo,
      seedGetter: async () => new Uint8Array(64).fill(1),
      watchers: {
        mintOperationWatcher: { disabled: true },
        proofStateWatcher: { disabled: true },
        meltQuoteWatcher: { disabled: true },
      },
      processors: {
        mintOperationProcessor: { disabled: true },
        meltSettlementProcessor: { disabled: true },
        mintSwapOperationProcessor: { disabled: true },
      },
    });
    try {
      const device = await coco.auth.startDeviceAuth(mintUrl);
      await device.poll();
      const provider = coco.auth.getAuthProvider(mintUrl)!;

      expect(await provider.ensureCAT!()).toBe('cat-2');
      expect(await provider.ensureCAT!()).toBe('cat-3');
      expect(refreshGrants).toEqual(['refresh-1', 'refresh-2']);

      // The session is persisted after each refresh without blocking the request.
      let persisted = await repo.authSessionRepository.getSession(mintUrl);
      for (let attempt = 0; persisted?.accessToken !== 'cat-3' && attempt < 50; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        persisted = await repo.authSessionRepository.getSession(mintUrl);
      }
      expect(persisted).toMatchObject({ accessToken: 'cat-3', refreshToken: 'refresh-3' });
    } finally {
      sleep.mockRestore();
      await coco.dispose();
    }
  });
});
