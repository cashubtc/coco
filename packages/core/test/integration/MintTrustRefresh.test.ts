import { afterEach, describe, expect, it } from 'bun:test';
import { initializeCoco, MemoryRepositories, type Manager } from '../../index.ts';
import { testMintInfo } from '../fixtures/MintMetadata.ts';

const mintUrl = process.env.MINT_URL ?? 'http://localhost:3338';
const sessions: Manager[] = [];
const originalFetch = globalThis.fetch;

async function session() {
  const repo = new MemoryRepositories();
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => seed,
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
    requestRateLimit: { disabled: true },
  });
  sessions.push(coco);
  return { coco, repo };
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const coco of sessions.splice(0)) await coco.dispose();
});

// Core-only public trust-change contract coverage: no adapter schema or repository contract changes.
// The case drives the real Manager, services and repositories and replaces only HTTP transport.
describe('Mint trust refresh', () => {
  it('publishes committed trust decisions when stale metadata cannot be refreshed', async () => {
    const { coco, repo } = await session();
    const staleTime = Math.floor(Date.now() / 1000) - 600;
    await repo.mintRepository.addNewMint({
      mintUrl,
      name: 'Offline mint',
      trusted: false,
      mintInfo: testMintInfo,
      createdAt: staleTime,
      updatedAt: staleTime,
    });
    const trustAtRequest: boolean[] = [];
    globalThis.fetch = (async (input, init) => {
      if (!String(input).startsWith(mintUrl)) return originalFetch(input, init);
      trustAtRequest.push(await coco.mint.isTrustedMint(mintUrl));
      throw new Error('mint offline');
    }) as typeof fetch;
    const published: { trusted: boolean; storedTrust: boolean; mintInfo: unknown }[] = [];
    coco.on('mint:updated', async ({ mint }) => {
      published.push({
        trusted: mint.trusted,
        storedTrust: await coco.mint.isTrustedMint(mintUrl),
        mintInfo: mint.mintInfo,
      });
    });

    for (const [trusted, change] of [
      [true, () => coco.mint.trustMint(mintUrl)],
      [false, () => coco.mint.untrustMint(mintUrl)],
      [true, () => coco.mint.addMint(mintUrl, { trusted: true })],
    ] as const) {
      trustAtRequest.length = 0;
      await change();
      expect(await coco.mint.isTrustedMint(mintUrl)).toBe(trusted);
      expect(trustAtRequest.length).toBeGreaterThan(0);
      expect(trustAtRequest.every((observed) => observed === trusted)).toBe(true);
    }
    expect(published).toEqual(
      [true, false, true].map((trusted) => ({
        trusted,
        storedTrust: trusted,
        mintInfo: testMintInfo,
      })),
    );

    // Without stored metadata there is no committed Known Mint to report, so the failure propagates.
    const unknownMintUrl = `${mintUrl}/unknown`;
    await expect(coco.mint.addMint(unknownMintUrl)).rejects.toThrow('Failed to fetch mint');
    await expect(coco.mint.trustMint(unknownMintUrl)).rejects.toThrow('Failed to fetch mint');
    expect(await coco.mint.getAllMints()).toHaveLength(1);
    expect(published).toHaveLength(3);
  });
});
