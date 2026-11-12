import { Amount } from '@cashu/cashu-ts';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initializeCoco, type CocoConfig, type Manager } from '../../Manager.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { expiringKeysetVector, testMintInfo } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://expiring-keyset.test';
// The id commits to the expiry, so it only re-derives when the expiry is kept.
const { id, keypairs: keys, feePpk, finalExpiry } = expiringKeysetVector;
const disabledRuntime = {
  requestRateLimit: { disabled: true },
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
} satisfies Pick<CocoConfig, 'requestRateLimit' | 'watchers' | 'processors'>;

describe('a mint whose only keyset expires', () => {
  const managers: Manager[] = [];
  let originalFetch: typeof fetch;
  let servesKeys: boolean;

  beforeEach(() => {
    servesKeys = true;
    originalFetch = globalThis.fetch;
    // The mint is the system boundary; everything behind it is the real wallet.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const { pathname } = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (pathname === '/v1/info') return Response.json(testMintInfo);
      if (pathname === '/v1/keysets') {
        return Response.json({
          keysets: [
            { id, unit: 'sat', active: true, input_fee_ppk: feePpk, final_expiry: finalExpiry },
          ],
        });
      }
      if (pathname === `/v1/keys/${id}` && servesKeys) {
        return Response.json({ keysets: [{ id, unit: 'sat', keys }] });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    globalThis.fetch = originalFetch;
  });

  async function start(repo: MemoryRepositories) {
    const manager = await initializeCoco({
      repo,
      seedGetter: async () => new Uint8Array(64).fill(1),
      ...disabledRuntime,
    });
    managers.push(manager);
    return manager;
  }

  it('prepares a send in the first session and in one that starts from stored keys', async () => {
    const repo = new MemoryRepositories();
    const first = await start(repo);
    await first.mint.addMint(mintUrl, { trusted: true });
    // A stored proof stands in for earlier issuance; preparing a send never redeems it.
    await repo.proofRepository.saveProofs(mintUrl, [
      {
        mintUrl,
        id,
        unit: 'sat',
        amount: Amount.from(8),
        secret: 'held',
        C: keys['8'],
        state: 'ready',
      },
    ]);

    const prepared = await first.ops.send.prepare({ mintUrl, amount: 8 });
    expect(prepared.needsSwap).toBe(false);
    await first.ops.send.cancel(prepared.id);
    await first.dispose();

    // The stored keys must still derive the advertised id, because they cannot be fetched again.
    servesKeys = false;
    const second = await start(repo);
    const again = await second.ops.send.prepare({ mintUrl, amount: 8 });
    expect(again.needsSwap).toBe(false);
  });
});
