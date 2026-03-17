import { describe, it, expect, beforeEach, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { ProofStateWatcherService } from '../../services/watchers/ProofStateWatcherService.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { ProofRepository } from '../../repositories/index.ts';
import type { CoreProof } from '../../types.ts';
import type { SendOperationService } from '../../operations/send/SendOperationService.ts';
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

  it('bootstraps inflight proofs on start by default', async () => {
    const checkInflightProofs = mock(async () => {});
    const inflightProofs = [
      makeProof({ mintUrl: mintUrlA, secret: 'a1' }),
      makeProof({ mintUrl: mintUrlA, secret: 'a2' }),
      makeProof({ mintUrl: mintUrlB, secret: 'b1' }),
      makeProof({ mintUrl: '', secret: 'invalid' }),
      makeProof({ mintUrl: mintUrlA, secret: '' }),
    ];
    const getInflightProofs = mock(async () => inflightProofs);
    const watchProof: Mock<ProofStateWatcherService['watchProof']> = mock(
      async (_mintUrl: string, _secrets: string[]) => {},
    );

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
    );
    watcher.watchProof = watchProof;

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
    const watchProof: Mock<ProofStateWatcherService['watchProof']> = mock(
      async (_mintUrl: string, _secrets: string[]) => {},
    );

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
    watcher.watchProof = watchProof;

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(checkInflightProofs).not.toHaveBeenCalled();
    expect(getInflightProofs).not.toHaveBeenCalled();
    expect(watchProof).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('finalizes a pending send operation when the batched send proofs are all spent', async () => {
    const getProofBySecret = mock(async () =>
      makeProof({ secret: 'spent-1', state: 'spent', usedByOperationId: 'send-op-1' }),
    );
    const getProofsBySecrets = mock(async () => [
      makeProof({ secret: 'spent-1', state: 'spent' }),
      makeProof({ secret: 'spent-2', state: 'spent' }),
    ]);
    const finalize = mock(async () => {});
    const getOperation = mock(async () => ({
      id: 'send-op-1',
      state: 'pending',
      mintUrl: mintUrlA,
      amount: 2,
      method: 'default',
      methodData: {},
      needsSwap: false,
      fee: 0,
      inputAmount: 2,
      inputProofSecrets: ['spent-1', 'spent-2'],
      createdAt: 0,
      updatedAt: 0,
    }));

    const watcher = new ProofStateWatcherService(
      {} as SubscriptionManager,
      {} as MintService,
      {} as ProofService,
      {
        getProofBySecret,
        getProofsBySecrets,
      } as unknown as ProofRepository,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: false },
    );
    watcher.setSendOperationService({ getOperation, finalize } as unknown as SendOperationService);

    await watcher.start();
    await bus.emit('proofs:state-changed', {
      mintUrl: mintUrlA,
      secrets: ['spent-1'],
      state: 'spent',
    });

    expect(getProofBySecret).toHaveBeenCalledTimes(1);
    expect(getProofBySecret).toHaveBeenCalledWith(mintUrlA, 'spent-1');
    expect(getProofsBySecrets).toHaveBeenCalledTimes(1);
    expect(getProofsBySecrets).toHaveBeenCalledWith(mintUrlA, ['spent-1', 'spent-2']);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith('send-op-1');

    await watcher.stop();
  });

  it('does not finalize a pending send operation when the batched lookup is missing a proof', async () => {
    const getProofBySecret = mock(async () =>
      makeProof({ secret: 'spent-1', state: 'spent', usedByOperationId: 'send-op-1' }),
    );
    const getProofsBySecrets = mock(async () => [makeProof({ secret: 'spent-1', state: 'spent' })]);
    const finalize = mock(async () => {});
    const getOperation = mock(async () => ({
      id: 'send-op-1',
      state: 'pending',
      mintUrl: mintUrlA,
      amount: 2,
      method: 'default',
      methodData: {},
      needsSwap: false,
      fee: 0,
      inputAmount: 2,
      inputProofSecrets: ['spent-1', 'spent-2'],
      createdAt: 0,
      updatedAt: 0,
    }));

    const watcher = new ProofStateWatcherService(
      {} as SubscriptionManager,
      {} as MintService,
      {} as ProofService,
      {
        getProofBySecret,
        getProofsBySecrets,
      } as unknown as ProofRepository,
      bus,
      new NullLogger(),
      { watchExistingInflightOnStart: false },
    );
    watcher.setSendOperationService({ getOperation, finalize } as unknown as SendOperationService);

    await watcher.start();
    await bus.emit('proofs:state-changed', {
      mintUrl: mintUrlA,
      secrets: ['spent-1'],
      state: 'spent',
    });

    expect(getProofsBySecrets).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();

    await watcher.stop();
  });
});
