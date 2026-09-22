import { Amount, type ProofState as CashuProofState, type Token } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createSendEnvironment } from '../fixtures/SendEnvironment.ts';
import { preparedSend, pendingSend } from '../fixtures/SendOperation.ts';
import type { SwapTransportRequest } from '../../transactions/send/types.ts';
import { testMintKeysetId } from '../fixtures/MintMetadata.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { MintOperationError } from '../../models/Error.ts';
import type {
  ExecutingSendOperation,
  InitSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  RolledBackSendOperation,
} from '../../operations/send/SendOperation.ts';
import type { CoreProof } from '../../types.ts';
import { computeYHexForSecrets } from '../../utils.ts';

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

async function replayResult(request: SwapTransportRequest) {
  return {
    keep: [],
    send: [
      {
        id: keysetId,
        secret: Buffer.from(request.outputData.send[0]!.secret, 'hex').toString(),
        amount: Amount.from(10),
        C: 'C-replayed',
      },
    ],
  };
}

function executingOperation(id: string): ExecutingSendOperation {
  return {
    ...preparedSend(id, [coreProof(`${id}-input`)], [coreProof(`${id}-send`)]),
    state: 'executing',
    revision: 1,
    executionMemo: 'persisted memo',
  };
}

type Environment = Awaited<ReturnType<typeof createSendEnvironment>>;

describe('SendOperationService executing recovery', () => {
  let environment: Environment;
  let repositories: Environment['repositories'];
  let service: Environment['service'];
  let remote: Environment['remote'];
  let logger: Environment['logger'];
  let eventBus: Environment['eventBus'];
  let transactions: Environment['transactions'];

  const buildService = (serviceEvents = eventBus) =>
    environment.buildService({ eventBus: serviceEvents });

  beforeEach(async () => {
    environment = await createSendEnvironment();
    ({ repositories, service, remote, logger, eventBus, transactions } = environment);
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
    const pending = pendingSend(id, [input], needsSwap ? [send] : undefined);
    await repositories.sendOperationRepository.create(pending);
    return pending;
  }

  it('restarts from executing and replays the exact persisted request once when inputs are unspent', async () => {
    const operation = executingOperation('restart-replay');
    await persistExecuting(operation);
    remote.checkProofStates.mockImplementation(async (proofs) =>
      proofs.map(
        (proof) =>
          ({
            state: 'UNSPENT',
            Y: `Y-${proof.secret}`,
          }) as CashuProofState,
      ),
    );
    remote.swap.mockImplementation(async (request) => {
      expect(request.inputProofs.map((proof) => proof.secret)).toEqual(operation.inputProofSecrets);
      expect(request.outputData).toEqual(operation.outputData!);
      return replayResult(request);
    });

    await service.recoverPendingOperations();
    await service.recoverPendingOperations();

    expect(remote.swap).toHaveBeenCalledTimes(1);
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
    remote.checkProofStates.mockImplementation(async (proofs) => {
      checkCount++;
      if (checkCount === 2) releaseChecks();
      await bothChecked;
      return proofs.map(
        (proof) => ({ state: 'UNSPENT', Y: `Y-${proof.secret}` }) as CashuProofState,
      );
    });
    remote.swap.mockImplementation(replayResult);
    const secondSession = buildService(new EventBus<CoreEvents>());

    await Promise.all([
      service.recoverPendingOperations(),
      secondSession.recoverPendingOperations(),
    ]);

    expect(remote.swap).toHaveBeenCalledTimes(1);
    const stored = await repositories.sendOperationRepository.getById(operation.id);
    expect(stored?.state).toBe('pending');
    expect(stored?.revision).toBe(3);
  });

  it('applies fully restored outputs through the normal result transaction', async () => {
    const operation = executingOperation('restart-restore');
    await persistExecuting(operation);
    remote.checkProofStates.mockImplementation(async (proofs) =>
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

    expect(remote.swap).not.toHaveBeenCalled();
    expect(remote.restoreOutputs).toHaveBeenCalledWith(operation.outputData);
    expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
      'pending',
    );
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, `${operation.id}-send`))?.state,
    ).toBe('inflight');
  });

  it.each(['ready', 'inflight'] as const)(
    'recovers a legacy exact Send interrupted with %s inputs',
    async (state) => {
      const operation: ExecutingSendOperation = {
        ...executingOperation(`legacy-exact-${state}`),
        revision: undefined,
        needsSwap: false,
        outputData: undefined,
        methodData: {},
      };
      await persistExecuting(operation);
      await repositories.proofRepository.setProofState(mintUrl, operation.inputProofSecrets, state);
      let rolledBackEvents = 0;
      eventBus.on('send:rolled-back', async () => {
        expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
          'rolled_back',
        );
        expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toHaveLength(1);
        rolledBackEvents++;
        throw new Error('Legacy recovery listener failed');
      });

      await service.recoverPendingOperations();
      await service.recoverPendingOperations();

      const stored = await repositories.sendOperationRepository.getById(operation.id);
      expect(stored?.state).toBe('rolled_back');
      expect(stored?.revision).toBe(1);
      const input = await repositories.proofRepository.getProofBySecret(
        mintUrl,
        operation.inputProofSecrets[0]!,
      );
      expect(input?.state).toBe('ready');
      expect(input?.usedByOperationId).toBeUndefined();
      expect(rolledBackEvents).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to publish committed Send event',
        expect.objectContaining({ event: 'send:rolled-back' }),
      );
      expect(remote.swap).not.toHaveBeenCalled();
      expect(remote.checkProofStates).not.toHaveBeenCalled();
    },
  );

  it('preserves saved change already spent by another operation during legacy swap recovery', async () => {
    const original = executingOperation('legacy-spent-change');
    const keepSecret = `${original.id}-keep`;
    const operation: ExecutingSendOperation = {
      ...original,
      revision: undefined,
      inputAmount: Amount.from(20),
      outputData: {
        send: original.outputData!.send,
        keep: [
          {
            ...original.outputData!.send[0]!,
            secret: Buffer.from(keepSecret).toString('hex'),
            blindedMessage: { amount: 10, id: keysetId, B_: 'B-keep' },
          },
        ],
      },
    };
    await repositories.sendOperationRepository.create(operation);
    const spentChange = coreProof(keepSecret, {
      state: 'spent',
      createdByOperationId: operation.id,
      usedByOperationId: 'later-operation',
    });
    await repositories.proofRepository.saveProofs(mintUrl, [
      coreProof(operation.inputProofSecrets[0]!, {
        amount: Amount.from(20),
        state: 'spent',
        usedByOperationId: operation.id,
      }),
      spentChange,
    ]);
    remote.checkProofStates.mockImplementation(async (proofs) =>
      proofs.map(
        (proof) =>
          ({
            state: proof.secret.endsWith('-input') ? 'SPENT' : 'UNSPENT',
            Y: `Y-${proof.secret}`,
          }) as CashuProofState,
      ),
    );
    // Restore returns only unspent outputs, so the already-spent change must come from storage.
    remote.restoreOutputs.mockResolvedValue([coreProof(`${operation.id}-send`)]);

    await service.recoverPendingOperations();

    expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
      'pending',
    );
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, keepSecret)).toEqual(
      spentChange,
    );
    expect(remote.swap).not.toHaveBeenCalled();
  });

  it('does not republish a legacy output committed to a later exact Send', async () => {
    const legacyId = 'legacy-output-reused';
    const input = coreProof('legacy-spent-input', {
      amount: Amount.from(8),
      state: 'spent',
      usedByOperationId: legacyId,
    });
    const output = coreProof('legacy-ready-output', {
      amount: Amount.from(8),
      createdByOperationId: legacyId,
    });
    const legacy: ExecutingSendOperation = {
      ...preparedSend(legacyId, [input], [output]),
      state: 'executing',
      revision: undefined,
    };
    // Legacy recovery could save available outputs before persisting the operation result.
    await repositories.sendOperationRepository.create(legacy);
    await repositories.proofRepository.saveProofs(mintUrl, [input, output]);

    const prepared = await service.prepare(
      await service.init(mintUrl, { amount: Amount.from(8), unit: 'sat' }),
    );
    expect(prepared.needsSwap).toBe(false);
    const later = await service.execute(prepared);
    expect(later.token.proofs.map((proof) => proof.secret)).toEqual([output.secret]);
    const committedOutput = await repositories.proofRepository.getProofBySecret(
      mintUrl,
      output.secret,
    );
    expect(committedOutput).toMatchObject({
      state: 'inflight',
      createdByOperationId: legacyId,
      usedByOperationId: later.operation.id,
    });

    const republished: Token[] = [];
    eventBus.on('send:pending', (event) => {
      if (event.operationId === legacyId) republished.push(event.token);
    });
    remote.checkProofStates.mockImplementation(async (proofs) =>
      proofs.map((proof) => ({
        Y: computeYHexForSecrets([proof.secret])[0]!,
        state: proof.secret === input.secret ? 'SPENT' : 'UNSPENT',
        witness: null,
      })),
    );

    await service.recoverPendingOperations();

    expect(republished).toEqual([]);
    expect((await service.getOperation(legacyId))?.state).toBe('executing');
    expect(await service.getOperation(later.operation.id)).toEqual(later.operation);
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, output.secret)).toEqual(
      committedOutput,
    );
    expect(remote.swap).not.toHaveBeenCalled();
    expect(remote.restoreOutputs).not.toHaveBeenCalled();
  });

  it('recovers legacy ready send outputs without making the pending token locally spendable', async () => {
    const operation = { ...executingOperation('legacy-ready-output'), revision: undefined };
    await persistExecuting(operation);
    await repositories.proofRepository.setProofState(mintUrl, operation.inputProofSecrets, 'spent');
    const sendProof = coreProof(`${operation.id}-send`, {
      state: 'ready',
      createdByOperationId: operation.id,
    });
    // Old default recovery saved all restored outputs as ready before saving rolled_back.
    await repositories.proofRepository.saveProofs(mintUrl, [sendProof]);
    remote.checkProofStates.mockImplementation(async (proofs) =>
      proofs.map((proof) => ({
        state: proof.secret.endsWith('-input') ? 'SPENT' : 'UNSPENT',
        Y: `Y-${proof.secret}`,
        witness: null,
      })),
    );
    const events: string[] = [];
    eventBus.on('send:pending', async () => {
      expect(repositories.transactionOpen).toBe(false);
      expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
      events.push('pending');
    });
    eventBus.on('proofs:state-changed', ({ secrets, state }) => {
      if (state === 'inflight' && secrets.includes(sendProof.secret)) events.push('inflight');
    });

    await service.recoverPendingOperations();
    await service.recoverPendingOperations();

    expect(await service.getOperation(operation.id)).toMatchObject({
      state: 'pending',
      token: { proofs: [expect.objectContaining({ secret: sendProof.secret })] },
    });
    expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, sendProof.secret)).toEqual({
      ...sendProof,
      state: 'inflight',
    });
    expect(events).toEqual(['pending', 'inflight']);
    expect(remote.swap).not.toHaveBeenCalled();
    expect(remote.restoreOutputs).not.toHaveBeenCalled();

    remote.checkProofStates.mockImplementation(async (proofs) =>
      proofs.map((proof) => ({ state: 'SPENT', Y: `Y-${proof.secret}`, witness: null })),
    );
    await service.finalize(operation.id);

    expect((await service.getOperation(operation.id))?.state).toBe('finalized');
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, sendProof.secret))?.state,
    ).toBe('spent');
  });

  it.each(['ready', 'spent'] as const)(
    'recovers a legacy swap after saving outputs with %s inputs',
    async (state) => {
      const operation = { ...executingOperation(`legacy-swap-${state}`), revision: undefined };
      await persistExecuting(operation);
      const sendProof = coreProof(`${operation.id}-send`, {
        state: 'inflight',
        createdByOperationId: operation.id,
      });
      await repositories.proofRepository.saveProofs(mintUrl, [sendProof]);
      await repositories.proofRepository.setProofState(mintUrl, operation.inputProofSecrets, state);
      remote.checkProofStates.mockImplementation(async (proofs) =>
        proofs.map(
          (proof) =>
            ({
              state: proof.secret.endsWith('-input') ? 'SPENT' : 'UNSPENT',
              Y: `Y-${proof.secret}`,
            }) as CashuProofState,
        ),
      );
      remote.restoreOutputs.mockResolvedValue([sendProof]);

      await service.recoverPendingOperations();
      await service.recoverPendingOperations();

      const stored = await repositories.sendOperationRepository.getById(operation.id);
      expect(stored?.state).toBe('pending');
      if (stored?.state !== 'pending') throw new Error('Expected pending Send');
      expect(stored.token?.proofs[0]?.secret).toBe(sendProof.secret);
      expect(stored.token?.memo).toBe(operation.executionMemo);
      expect(
        await repositories.proofRepository.getProofBySecret(mintUrl, sendProof.secret),
      ).toEqual(sendProof);
      expect(
        (
          await repositories.proofRepository.getProofBySecret(
            mintUrl,
            operation.inputProofSecrets[0]!,
          )
        )?.state,
      ).toBe('spent');
      expect(remote.swap).not.toHaveBeenCalled();
    },
  );

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
    remote.checkProofStates.mockResolvedValue([
      { state: 'SPENT', Y: 'Y-a' },
      { state: 'UNSPENT', Y: 'Y-b' },
    ] as CashuProofState[]);

    await service.recoverPendingOperations();

    const stored = await repositories.sendOperationRepository.getById(operation.id);
    expect(stored?.state).toBe('executing');
    expect(stored && 'outputData' in stored ? stored.outputData : undefined).toEqual(
      operation.outputData,
    );
    expect(remote.swap).not.toHaveBeenCalled();
    expect(remote.restoreOutputs).not.toHaveBeenCalled();
  });

  it('keeps an unreachable recovery attempt executing', async () => {
    const operation = executingOperation('restart-offline');
    await persistExecuting(operation);
    remote.checkProofStates.mockRejectedValue(new Error('mint unavailable'));

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
    remote.checkProofStates.mockImplementation(async (proofs) =>
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
    remote.checkProofStates.mockImplementation(async (proofs) => {
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
    remote.checkProofStates.mockImplementation(async (proofs) => {
      if (proofs[0]?.secret.startsWith(offline.id)) throw new Error('mint offline');
      return proofs.map(
        (proof) => ({ state: 'UNSPENT', Y: `Y-${proof.secret}` }) as CashuProofState,
      );
    });
    remote.swap.mockImplementation(replayResult);

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
    remote.checkProofStates.mockImplementation(async (proofs) => {
      expect(await repositories.sendOperationRepository.getById(init.id)).toBeNull();
      checkedSecrets.push(proofs[0]!.secret);
      return proofs.map(
        (proof) => ({ state: 'UNSPENT', Y: `Y-${proof.secret}` }) as CashuProofState,
      );
    });
    remote.swap.mockImplementation(replayResult);

    await service.recoverPendingOperations();

    expect(checkedSecrets[0]).toBe(executing.inputProofSecrets[0]);
    expect(checkedSecrets.some((secret) => secret.startsWith('ordered-pending'))).toBe(true);
  });

  it('retains an executing request after an unknown mint error during recovery', async () => {
    const operation = executingOperation('unknown-replay-error');
    await persistExecuting(operation);
    remote.checkProofStates.mockResolvedValue([
      { state: 'UNSPENT', Y: 'Y-input' },
    ] as CashuProofState[]);
    remote.swap.mockRejectedValue(new MintOperationError(99999, 'unknown mint failure'));

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
    remote.swap.mockImplementation(async (...args) => {
      if (++submissions === 1) {
        originalStarted();
        await originalResponse;
        return replayResult(...args);
      }
      throw new MintOperationError(12002, 'keyset rotated after original submission');
    });
    remote.checkProofStates.mockResolvedValue([
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
