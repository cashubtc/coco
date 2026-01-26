import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { ProofStateWatcherService } from '../../services/watchers/ProofStateWatcherService.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { ProofRepository } from '../../repositories/index.ts';
import type { CoreProof } from '../../types.ts';
import { NullLogger } from '../../logging/NullLogger.ts';

describe('ProofStateWatcherService', () => {
  const mintUrlA = 'https://mint-a.test';
  const mintUrlB = 'https://mint-b.test';

  let bus: EventBus<CoreEvents>;

  const makeProof = (overrides: Partial<CoreProof>): CoreProof =>
    ({
      id: 'keyset-1',
      amount: 1,
      secret: 'secret',
      C: 'C' as unknown as CoreProof['C'],
      mintUrl: mintUrlA,
      state: 'inflight',
      ...overrides,
    }) as CoreProof;

  beforeEach(() => {
    bus = new EventBus<CoreEvents>();
  });

  it('bootstraps inflight proofs on start when enabled', async () => {
    const checkInflightProofs = mock(async () => {});
    const inflightProofs = [
      makeProof({ mintUrl: mintUrlA, secret: 'a1' }),
      makeProof({ mintUrl: mintUrlA, secret: 'a2' }),
      makeProof({ mintUrl: mintUrlB, secret: 'b1' }),
      makeProof({ mintUrl: '', secret: 'invalid' }),
      makeProof({ mintUrl: mintUrlA, secret: '' }),
    ];
    const getInflightProofs = mock(async () => inflightProofs);
    const watchProof = mock(async () => {});

    const proofService = {
      checkInflightProofs,
    } as unknown as ProofService;
    const proofRepository = {
      getInflightProofs,
    } as unknown as ProofRepository;
    const subs = {} as SubscriptionManager;
    const mintService = {
      isTrustedMint: mock(async () => true),
    } as unknown as MintService;

    const watcher = new ProofStateWatcherService(
      subs,
      mintService,
      proofService,
      proofRepository,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: true },
    );
    (watcher as { watchProof: typeof watchProof }).watchProof = watchProof;

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(checkInflightProofs).toHaveBeenCalledTimes(1);
    expect(getInflightProofs).toHaveBeenCalledTimes(1);
    expect(watchProof).toHaveBeenCalledTimes(2);
    expect(watchProof.mock.calls[0]).toEqual([mintUrlA, ['a1', 'a2']]);
    expect(watchProof.mock.calls[1]).toEqual([mintUrlB, ['b1']]);

    await watcher.stop();
  });

  it('skips bootstrapping inflight proofs when disabled', async () => {
    const checkInflightProofs = mock(async () => {});
    const getInflightProofs = mock(async () => []);
    const watchProof = mock(async () => {});

    const proofService = {
      checkInflightProofs,
    } as unknown as ProofService;
    const proofRepository = {
      getInflightProofs,
    } as unknown as ProofRepository;
    const subs = {} as SubscriptionManager;
    const mintService = {
      isTrustedMint: mock(async () => true),
    } as unknown as MintService;

    const watcher = new ProofStateWatcherService(
      subs,
      mintService,
      proofService,
      proofRepository,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: false },
    );
    (watcher as { watchProof: typeof watchProof }).watchProof = watchProof;

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(checkInflightProofs).not.toHaveBeenCalled();
    expect(getInflightProofs).not.toHaveBeenCalled();
    expect(watchProof).not.toHaveBeenCalled();

    await watcher.stop();
  });
});
