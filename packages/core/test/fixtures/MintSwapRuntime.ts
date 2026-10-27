import { spyOn } from 'bun:test';
import { mintSwapFixture } from '../../../adapter-tests/src/internal/mintSwap/fixture.ts';
import { MintService } from '../../services/MintService.ts';
import { WalletService } from '../../services/WalletService.ts';
import { KeyRingService } from '../../services/KeyRingService.ts';
import { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import { MintBolt11Handler } from '../../infra/handlers/mint/MintBolt11Handler.ts';
import { MeltBolt11Handler } from '../../infra/handlers/melt/MeltBolt11Handler.ts';
import type { CocoConfig } from '../../Manager.ts';

/** Deterministic protocol/metadata boundary; Manager, locks, coordinator and stores remain real. */
export function installMintSwapProtocol(fixture: Awaited<ReturnType<typeof mintSwapFixture>>) {
  const deps = fixture.dependencies;
  fixture.preparation.seed = new Uint8Array(64).fill(2);
  deps.loadSeed = async () => new Uint8Array(fixture.preparation.seed);
  spyOn(MintService.prototype, 'refreshAndCommitIfStale').mockImplementation(
    deps.mintService.refreshAndCommitIfStale,
  );
  spyOn(WalletService.prototype, 'getWalletWithActiveKeysetId').mockImplementation(
    deps.walletService.getWalletWithActiveKeysetId,
  );
  spyOn(KeyRingService.prototype, 'allocateAndCommitMintQuoteKeyPair').mockImplementation(
    deps.keyRingService.allocateAndCommitMintQuoteKeyPair,
  );
  for (const key of [
    'createMintQuote',
    'createMeltQuote',
    'refreshMeltQuote',
    'refreshMintQuote',
    'recordMeltQuoteObservation',
    'recordMintQuoteSnapshot',
  ] as const) {
    // Each fixture workflow persists its deterministic observation in the real canonical store.
    spyOn(QuoteLifecycle.prototype, key).mockImplementation(deps.quoteLifecycle[key]);
  }
  const mint = deps.mintHandlerProvider.get('bolt11');
  const melt = deps.meltHandlerProvider.get('bolt11');
  spyOn(MintBolt11Handler.prototype, 'execute').mockImplementation(mint.execute.bind(mint));
  spyOn(MintBolt11Handler.prototype, 'recoverExecuting').mockImplementation(
    mint.recoverExecuting.bind(mint),
  );
  spyOn(MeltBolt11Handler.prototype, 'melt').mockImplementation(melt.melt.bind(melt));
  spyOn(MeltBolt11Handler.prototype, 'swap').mockImplementation(melt.swap!.bind(melt));
}

/** Disable unrelated automatic resources; ordinary child startup recovery is still exercised. */
export const mintSwapRuntimeConfig = {
  watchers: {
    mintOperationWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
  },
} satisfies Pick<CocoConfig, 'watchers' | 'processors'>;

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
