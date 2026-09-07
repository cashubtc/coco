import { createMintServiceForMetadata } from '../fixtures/MintMetadataRefresh.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import { StoredMintQueries } from '../../mints/MintMetadata.ts';
import { deserializeOutputData } from '../../utils.ts';
import { createSendRemoteDouble } from '../fixtures/SendRemote.ts';
import { Amount, type ProofState as CashuProofState } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { DefaultSendHandler } from '../../infra/handlers/send/DefaultSendHandler.ts';
import { P2pkSendHandler } from '../../infra/handlers/send/P2pkSendHandler.ts';
import { SendHandlerProvider } from '../../infra/handlers/send/SendHandlerProvider.ts';
import type { Logger } from '../../logging/Logger.ts';
import { MintOperationError } from '../../models/Error.ts';
import type {
  ExecutingSendOperation,
  InitSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  RolledBackSendOperation,
} from '../../operations/send/SendOperation.ts';
import { SendOperationService } from '../../operations/send/SendOperationService.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreSendTransactions } from '../../transactions/send/SendTransactions.ts';
import type { SendTransactions } from '../../transactions/send/SendTransactions.ts';
import type { CoreProof } from '../../types.ts';

const mintUrl = 'https://mint.test';
const keysetId = testMintKeysetId();

function coreProof(secret: string, overrides: Partial<CoreProof> = {}): CoreProof {
  return {
    id: keysetId,
    secret,
    amount: Amount.from(10),
    C: `C-${secret}`,
    mintUrl,
    unit: 'sat',
    state: 'ready',
    ...overrides,
  };
}

async function replayResult(
  _amount: Amount,
  _inputs: CoreProof[],
  _fees: boolean | undefined,
  config: { send: { data: Array<{ secret: Uint8Array }> } },
) {
  return {
    keep: [],
    send: [
      {
        id: keysetId,
        secret: new TextDecoder().decode(config.send.data[0]!.secret),
        amount: Amount.from(10),
        C: 'C-replayed',
      },
    ],
  };
}

function executingOperation(id: string): ExecutingSendOperation {
  const sendSecret = `${id}-send`;
  return {
    id,
    state: 'executing',
    mintUrl,
    amount: Amount.from(10),
    unit: 'sat',
    method: 'default',
    methodData: { forceSwap: true },
    createdAt: 100,
    updatedAt: 200,
    revision: 1,
    needsSwap: true,
    fee: Amount.zero(),
    inputAmount: Amount.from(10),
    inputProofSecrets: [`${id}-input`],
    outputData: {
      keep: [],
      send: [
        {
          blindedMessage: { amount: 10, id: keysetId, B_: `B-${id}` },
          blindingFactor: '01',
          secret: Buffer.from(sendSecret).toString('hex'),
        },
      ],
    },
    executionMemo: 'persisted memo',
  };
}

describe('SendOperationService executing recovery', () => {
  let repositories: MemoryRepositories;
  let service: SendOperationService;
  let wallet: {
    send: Mock<typeof replayResult>;
    checkProofsStates: Mock<(proofs: CoreProof[]) => Promise<CashuProofState[]>>;
  };
  let remote: ReturnType<typeof createSendRemoteDouble>;
  let logger: Logger;
  let eventBus: EventBus<CoreEvents>;
  let transactions: SendTransactions;

  function buildService(serviceEvents = eventBus): SendOperationService {
    return new SendOperationService({
      operationQueries: repositories.sendOperationRepository,
      proofQueries: repositories.proofRepository,
      transactions,
      mintQueries: new StoredMintQueries(
        repositories.mintRepository,
        repositories.keysetRepository,
      ),
      mintMetadataRefresh: createMintServiceForMetadata(repositories, undefined, serviceEvents),
      remote,
      loadSeed: async () => new Uint8Array(32),
      eventBus: serviceEvents,
      handlerProvider: new SendHandlerProvider({
        default: new DefaultSendHandler(),
        p2pk: new P2pkSendHandler(),
      }),
      logger,
    });
  }

  beforeEach(async () => {
    repositories = new MemoryRepositories();
    wallet = {
      send: mock(async () => ({ send: [], keep: [] })),
      checkProofsStates: mock(async () => []),
    };
    await repositories.mintRepository.addNewMint({
      mintUrl,
      name: 'Test',
      trusted: true,
      mintInfo: testMintInfo,
      createdAt: 1,
      updatedAt: Math.floor(Date.now() / 1000),
    });
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: keysetId,
      unit: 'sat',
      active: true,
      feePpk: 0,
      keypairs: testMintKeypairs,
    });
    remote = createSendRemoteDouble();
    remote.swap.mockImplementation((request) =>
      wallet.send(request.amount, request.inputProofs as CoreProof[], undefined, {
        send: { data: deserializeOutputData(request.outputData).send },
      }),
    );
    remote.checkProofStates.mockImplementation((proofs) =>
      wallet.checkProofsStates(proofs as CoreProof[]),
    );
    logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    };
    eventBus = new EventBus<CoreEvents>();
    transactions = new CoreSendTransactions(new RepositoryCoreTransactionRunner(repositories));
    service = buildService();
  });

  async function persistExecuting(operation: ExecutingSendOperation): Promise<void> {
    await repositories.proofRepository.saveProofs(mintUrl, [
      coreProof(operation.inputProofSecrets[0]!, { usedByOperationId: operation.id }),
    ]);
    await repositories.sendOperationRepository.create(operation);
  }

  async function persistPending(id: string, needsSwap: boolean): Promise<PendingSendOperation> {
    const inputSecret = `${id}-input`;
    const sendSecret = needsSwap ? `${id}-send` : inputSecret;
    const input = coreProof(inputSecret, {
      state: needsSwap ? 'spent' : 'inflight',
      usedByOperationId: id,
    });
    const send = needsSwap
      ? coreProof(sendSecret, { state: 'inflight', createdByOperationId: id })
      : input;
    await repositories.proofRepository.saveProofs(mintUrl, needsSwap ? [input, send] : [input]);
    const pending: PendingSendOperation = {
      id,
      state: 'pending',
      mintUrl,
      amount: Amount.from(10),
      unit: 'sat',
      method: 'default',
      methodData: needsSwap ? { forceSwap: true } : {},
      createdAt: 100,
      updatedAt: 200,
      revision: needsSwap ? 2 : 1,
      needsSwap,
      fee: Amount.zero(),
      inputAmount: Amount.from(10),
      inputProofSecrets: [inputSecret],
      outputData: needsSwap
        ? {
            keep: [],
            send: [
              {
                blindedMessage: { amount: 10, id: keysetId, B_: `B-${id}` },
                blindingFactor: '01',
                secret: Buffer.from(sendSecret).toString('hex'),
              },
            ],
          }
        : undefined,
      token: { mint: mintUrl, unit: 'sat', proofs: [send] },
    };
    await repositories.sendOperationRepository.create(pending);
    return pending;
  }

  it('restarts from executing and replays the exact persisted request once when inputs are unspent', async () => {
    const operation = executingOperation('restart-replay');
    await persistExecuting(operation);
    wallet.checkProofsStates.mockImplementation(async (proofs: CoreProof[]) =>
      proofs.map(
        (proof) =>
          ({
            state: proof.secret.endsWith('-input') ? 'UNSPENT' : 'UNSPENT',
            Y: `Y-${proof.secret}`,
          }) as CashuProofState,
      ),
    );
    wallet.send.mockImplementation(
      async (
        _amount: Amount,
        inputs: CoreProof[],
        _includeFees: boolean | undefined,
        outputConfig: { send: { data: Array<{ secret: Uint8Array }> } },
      ) => {
        expect(inputs.map((proof: CoreProof) => proof.secret)).toEqual(operation.inputProofSecrets);
        expect(outputConfig.send.data[0]?.secret).toEqual(
          new TextEncoder().encode(`${operation.id}-send`),
        );
        return {
          keep: [],
          send: [
            {
              id: keysetId,
              secret: `${operation.id}-send`,
              amount: Amount.from(10),
              C: 'C-replayed',
            },
          ],
        };
      },
    );

    await service.recoverPendingOperations();
    await service.recoverPendingOperations();

    expect(wallet.send).toHaveBeenCalledTimes(1);
    const stored = await repositories.sendOperationRepository.getById(operation.id);
    expect(stored?.state).toBe('pending');
    expect(stored?.revision).toBe(3);
    expect(stored?.executionMemo).toBe('persisted memo');
    expect(stored && 'token' in stored ? stored.token?.memo : undefined).toBe('persisted memo');
  });

  it('allows only one Coco Session to claim and replay an executing revision', async () => {
    const operation = executingOperation('concurrent-replay');
    await persistExecuting(operation);
    let releaseChecks!: () => void;
    const bothChecked = new Promise<void>((resolve) => {
      releaseChecks = resolve;
    });
    let checkCount = 0;
    wallet.checkProofsStates.mockImplementation(async (proofs: CoreProof[]) => {
      checkCount++;
      if (checkCount === 2) releaseChecks();
      await bothChecked;
      return proofs.map(
        (proof) => ({ state: 'UNSPENT', Y: `Y-${proof.secret}` }) as CashuProofState,
      );
    });
    wallet.send.mockImplementation(replayResult);
    const secondSession = buildService(new EventBus<CoreEvents>());

    await Promise.all([
      service.recoverPendingOperations(),
      secondSession.recoverPendingOperations(),
    ]);

    expect(wallet.send).toHaveBeenCalledTimes(1);
    const stored = await repositories.sendOperationRepository.getById(operation.id);
    expect(stored?.state).toBe('pending');
    expect(stored?.revision).toBe(3);
  });

  it('applies fully restored outputs through the normal result transaction', async () => {
    const operation = executingOperation('restart-restore');
    await persistExecuting(operation);
    wallet.checkProofsStates.mockImplementation(async (proofs: CoreProof[]) =>
      proofs.map(
        (proof) =>
          ({
            state: proof.secret.endsWith('-input') ? 'SPENT' : 'UNSPENT',
            Y: `Y-${proof.secret}`,
          }) as CashuProofState,
      ),
    );
    remote.restoreOutputs.mockResolvedValue([
      {
        id: keysetId,
        secret: `${operation.id}-send`,
        amount: Amount.from(10),
        C: 'C-restored',
      },
    ]);

    await service.recoverPendingOperations();

    expect(wallet.send).not.toHaveBeenCalled();
    expect(remote.restoreOutputs).toHaveBeenCalledWith(operation.outputData);
    expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
      'pending',
    );
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, `${operation.id}-send`))?.state,
    ).toBe('inflight');
  });

  it('keeps mixed input outcomes executing with the original request intact', async () => {
    const operation = {
      ...executingOperation('restart-ambiguous'),
      inputProofSecrets: ['restart-ambiguous-input-a', 'restart-ambiguous-input-b'],
    };
    await repositories.proofRepository.saveProofs(mintUrl, [
      coreProof(operation.inputProofSecrets[0]!, { usedByOperationId: operation.id }),
      coreProof(operation.inputProofSecrets[1]!, { usedByOperationId: operation.id }),
    ]);
    await repositories.sendOperationRepository.create(operation);
    wallet.checkProofsStates.mockResolvedValue([
      { state: 'SPENT', Y: 'Y-a' },
      { state: 'UNSPENT', Y: 'Y-b' },
    ] as CashuProofState[]);

    await service.recoverPendingOperations();

    const stored = await repositories.sendOperationRepository.getById(operation.id);
    expect(stored?.state).toBe('executing');
    expect(stored && 'outputData' in stored ? stored.outputData : undefined).toEqual(
      operation.outputData,
    );
    expect(wallet.send).not.toHaveBeenCalled();
    expect(remote.restoreOutputs).not.toHaveBeenCalled();
  });

  it('keeps an unreachable recovery attempt executing', async () => {
    const operation = executingOperation('restart-offline');
    await persistExecuting(operation);
    wallet.checkProofsStates.mockRejectedValue(new Error('mint unavailable'));

    await service.recoverPendingOperations();

    expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
      'executing',
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Error recovering executing operation',
      expect.objectContaining({ operationId: operation.id }),
    );
  });

  it('retains the explicit persisted-init cleanup path', async () => {
    const init: InitSendOperation = {
      id: 'legacy-init',
      state: 'init',
      mintUrl,
      amount: Amount.from(10),
      unit: 'sat',
      method: 'default',
      methodData: {},
      createdAt: 100,
      updatedAt: 100,
      revision: 0,
    };
    await repositories.sendOperationRepository.create(init);
    await repositories.proofRepository.saveProofs(mintUrl, [
      coreProof('legacy-reservation', { usedByOperationId: init.id }),
    ]);

    await service.recoverPendingOperations();

    expect(await repositories.sendOperationRepository.getById(init.id)).toBeNull();
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'legacy-reservation'))
        ?.usedByOperationId,
    ).toBeUndefined();
  });

  it('cleans multiple persisted init rows in one recovery pass', async () => {
    for (const id of ['legacy-init-a', 'legacy-init-b']) {
      await repositories.sendOperationRepository.create({
        id,
        state: 'init',
        mintUrl,
        amount: Amount.from(10),
        unit: 'sat',
        method: 'default',
        methodData: {},
        createdAt: 100,
        updatedAt: 100,
        revision: 0,
      });
    }

    await service.recoverPendingOperations();

    expect(await repositories.sendOperationRepository.getByState('init')).toEqual([]);
  });

  it('leaves prepared operations untouched and reports them for user cancellation', async () => {
    const executing = executingOperation('stale-prepared');
    const prepared: PreparedSendOperation = { ...executing, state: 'prepared', revision: 0 };
    await persistExecuting(executing);
    await repositories.sendOperationRepository.delete(executing.id);
    await repositories.sendOperationRepository.create(prepared);

    await service.recoverPendingOperations();

    expect((await repositories.sendOperationRepository.getById(prepared.id))?.state).toBe(
      'prepared',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Found stale prepared operation, user can rollback manually',
      { operationId: prepared.id },
    );
  });

  it('finalizes exact and swapped pending sends after definitive spent observations', async () => {
    const exact = await persistPending('pending-exact', false);
    const swapped = await persistPending('pending-swap', true);
    wallet.checkProofsStates.mockImplementation(async (proofs: CoreProof[]) =>
      proofs.map((proof) => ({ state: 'SPENT', Y: `Y-${proof.secret}` }) as CashuProofState),
    );
    const finalizedIds: string[] = [];
    eventBus.on('send:finalized', ({ operationId }) => void finalizedIds.push(operationId));

    await service.recoverPendingOperations();

    expect((await repositories.sendOperationRepository.getById(exact.id))?.state).toBe('finalized');
    expect((await repositories.sendOperationRepository.getById(swapped.id))?.state).toBe(
      'finalized',
    );
    expect(new Set(finalizedIds)).toEqual(new Set([exact.id, swapped.id]));
  });

  it('keeps pending sends unchanged when proofs are unspent or the mint is unreachable', async () => {
    const unspent = await persistPending('pending-unspent', false);
    const offline = await persistPending('pending-offline', false);
    wallet.checkProofsStates.mockImplementation(async (proofs: CoreProof[]) => {
      if (proofs[0]?.secret.startsWith(offline.id)) throw new Error('mint offline');
      return proofs.map(
        (proof) => ({ state: 'UNSPENT', Y: `Y-${proof.secret}` }) as CashuProofState,
      );
    });

    await service.recoverPendingOperations();

    expect((await repositories.sendOperationRepository.getById(unspent.id))?.state).toBe('pending');
    expect((await repositories.sendOperationRepository.getById(offline.id))?.state).toBe('pending');
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not reach mint for recovery, will retry later',
      { operationId: offline.id, mintUrl },
    );
  });

  it('releases terminal Send reservations and preserves unidentified owners', async () => {
    const rolledBack: RolledBackSendOperation = {
      ...executingOperation('terminal-operation'),
      state: 'rolled_back',
      revision: 2,
      error: 'done',
    };
    await repositories.sendOperationRepository.create(rolledBack);
    await repositories.proofRepository.saveProofs(mintUrl, [
      coreProof('missing-owner-proof', { usedByOperationId: 'missing-operation' }),
      coreProof('terminal-owner-proof', { usedByOperationId: rolledBack.id }),
    ]);
    let releasedSecrets: string[] = [];
    const listenerError = new Error('listener failed');
    eventBus.on('proofs:released', (payload) => {
      releasedSecrets = payload.secrets;
      throw listenerError;
    });

    await service.recoverPendingOperations();

    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'missing-owner-proof'))
        ?.usedByOperationId,
    ).toBe('missing-operation');
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'terminal-owner-proof'))
        ?.usedByOperationId,
    ).toBeUndefined();
    expect(new Set(releasedSecrets)).toEqual(new Set(['terminal-owner-proof']));
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to publish committed Send event',
      expect.objectContaining({ event: 'proofs:released', error: expect.any(Error) }),
    );
  });

  it('handles an empty repository and continues after one executing recovery fails', async () => {
    await service.recoverPendingOperations();
    const offline = executingOperation('continue-offline');
    const replayed = executingOperation('continue-replayed');
    await persistExecuting(offline);
    await persistExecuting(replayed);
    wallet.checkProofsStates.mockImplementation(async (proofs: CoreProof[]) => {
      if (proofs[0]?.secret.startsWith(offline.id)) throw new Error('mint offline');
      return proofs.map(
        (proof) => ({ state: 'UNSPENT', Y: `Y-${proof.secret}` }) as CashuProofState,
      );
    });
    wallet.send.mockImplementation(replayResult);

    await service.recoverPendingOperations();

    expect((await repositories.sendOperationRepository.getById(offline.id))?.state).toBe(
      'executing',
    );
    expect((await repositories.sendOperationRepository.getById(replayed.id))?.state).toBe(
      'pending',
    );
  });

  it('processes legacy init cleanup before executing and pending remote checks', async () => {
    const init: InitSendOperation = {
      id: 'ordered-init',
      state: 'init',
      mintUrl,
      amount: Amount.from(10),
      unit: 'sat',
      method: 'default',
      methodData: {},
      createdAt: 100,
      updatedAt: 100,
      revision: 0,
    };
    await repositories.sendOperationRepository.create(init);
    const executing = executingOperation('ordered-executing');
    await persistExecuting(executing);
    await persistPending('ordered-pending', false);
    const checkedSecrets: string[] = [];
    wallet.checkProofsStates.mockImplementation(async (proofs: CoreProof[]) => {
      expect(await repositories.sendOperationRepository.getById(init.id)).toBeNull();
      checkedSecrets.push(proofs[0]!.secret);
      return proofs.map(
        (proof) => ({ state: 'UNSPENT', Y: `Y-${proof.secret}` }) as CashuProofState,
      );
    });
    wallet.send.mockImplementation(replayResult);

    await service.recoverPendingOperations();

    expect(checkedSecrets[0]).toBe(executing.inputProofSecrets[0]);
    expect(checkedSecrets.some((secret) => secret.startsWith('ordered-pending'))).toBe(true);
  });

  it('retains an executing request after an unknown mint error during recovery', async () => {
    const operation = executingOperation('unknown-replay-error');
    await persistExecuting(operation);
    wallet.checkProofsStates.mockResolvedValue([
      { state: 'UNSPENT', Y: 'Y-input' },
    ] as CashuProofState[]);
    wallet.send.mockRejectedValue(new MintOperationError(99999, 'unknown mint failure'));

    await service.recoverPendingOperations();

    const stored = await repositories.sendOperationRepository.getById(operation.id);
    expect(stored?.state).toBe('executing');
    if (stored?.state !== 'executing') throw new Error('Expected executing Send');
    expect(stored.inputProofSecrets).toEqual(operation.inputProofSecrets);
    expect(stored.outputData).toEqual(operation.outputData);
    expect(
      (
        await repositories.proofRepository.getProofBySecret(
          mintUrl,
          operation.inputProofSecrets[0]!,
        )
      )?.usedByOperationId,
    ).toBe(operation.id);
  });

  it('keeps a replay validation rejection recoverable while the original request succeeds', async () => {
    const operation = executingOperation('overlapping-submissions');
    await persistExecuting(operation);
    const prepared: PreparedSendOperation = { ...operation, state: 'prepared', revision: 0 };
    await repositories.sendOperationRepository.update(prepared);
    let originalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      originalStarted = resolve;
    });
    let releaseOriginal!: () => void;
    const originalResponse = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    let submissions = 0;
    wallet.send.mockImplementation(async (...args) => {
      if (++submissions === 1) {
        originalStarted();
        await originalResponse;
        return replayResult(...args);
      }
      throw new MintOperationError(12002, 'keyset rotated after original submission');
    });
    wallet.checkProofsStates.mockResolvedValue([
      { state: 'UNSPENT', Y: 'Y-input' },
    ] as CashuProofState[]);
    const original = service.execute(prepared);
    await started;
    try {
      await buildService().recoverPendingOperations();
      const stored = await repositories.sendOperationRepository.getById(operation.id);
      expect(stored?.state).toBe('executing');
      expect(
        (
          await repositories.proofRepository.getProofBySecret(
            mintUrl,
            operation.inputProofSecrets[0]!,
          )
        )?.usedByOperationId,
      ).toBe(operation.id);
    } finally {
      releaseOriginal();
    }
    expect((await original).operation.state).toBe('pending');
    expect(submissions).toBe(2);
  });
});
