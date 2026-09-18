import { Amount, type OutputDataCreator, type OutputDataLike, type Token } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createSendEnvironment } from '../fixtures/SendEnvironment.ts';
import { preparedSend, pendingSend } from '../fixtures/SendOperation.ts';
import { testMintInfo, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import { deserializeOutputData } from '../../utils.ts';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { CoreProof } from '../../types';
import type {
  PreparedSendOperation,
  PendingSendOperation,
} from '../../operations/send/SendOperation';
import { isSameSendIntent } from '../../operations/send/SendOperation';
import {
  MintOperationError,
  NetworkError,
  SendOperationConflictError,
  SendOperationIntentConflictError,
} from '../../models/Error.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';
import { SendOpsApi } from '../../api/SendOpsApi.ts';
import { ProofStateWatcherService } from '../../services/watchers/ProofStateWatcherService.ts';
import type { SubscriptionManager, SubscriptionCallback } from '../../infra/SubscriptionManager.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';

type Environment = Awaited<ReturnType<typeof createSendEnvironment>>;

describe('SendOperationService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = testMintKeysetId();
  const usdKeysetId = testMintKeysetId('usd');

  let environment: Environment;
  let repositories: Environment['repositories'];
  let sendOpRepo: Environment['repositories']['sendOperationRepository'];
  let proofRepo: Environment['repositories']['proofRepository'];
  let metadataRemote: Environment['metadataRemote'];
  let remote: Environment['remote'];
  let eventBus: Environment['eventBus'];
  let logger: Environment['logger'];
  let service: Environment['service'];
  let loadSeed: Environment['loadSeed'];
  let sendTransactions: Environment['transactions'];

  const makeProof = (secret: string, amount: number, unit = 'sat'): CoreProof =>
    ({
      amount: Amount.from(amount),
      C: `C_${secret}`,
      id: unit === 'sat' ? keysetId : usdKeysetId,
      secret,
      mintUrl,
      unit,
      state: 'ready',
    }) as CoreProof;

  const unitAmount = (amount: number, unit = 'sat') => ({
    amount: Amount.from(amount),
    unit,
  });

  const buildService = (outputDataCreator?: OutputDataCreator) =>
    environment.buildService({ eventBus, outputDataCreator });

  const prepareExact = async (secret = 'proof-1', amount = 100) => {
    await proofRepo.saveProofs(mintUrl, [makeProof(secret, amount)]);
    return service.prepare(await service.init(mintUrl, unitAmount(amount)));
  };

  const makeSwapPrepared = async (id: string): Promise<PreparedSendOperation> => {
    const input = makeProof(`${id}-input`, 100);
    await proofRepo.saveProofs(mintUrl, [input]);
    await proofRepo.reserveProofs(mintUrl, [input.secret], id);
    const prepared = preparedSend(id, [input], [makeProof(`${id}-send`, 100)]);
    await sendOpRepo.create(prepared);
    return prepared;
  };

  const completionPaths = ['recovery', 'refresh', 'finalize', 'notification'] as const;
  const completeThrough = (
    path: (typeof completionPaths)[number],
    operationId: string,
    secret: string,
  ) => {
    const api = new SendOpsApi(service);
    return {
      recovery: () => api.recovery.run(),
      refresh: () => api.refresh(operationId),
      finalize: () => api.finalize(operationId),
      notification: () => service.recordProofSpent(operationId, secret),
    }[path]();
  };

  beforeEach(async () => {
    environment = await createSendEnvironment(['sat', 'usd']);
    ({
      repositories,
      remote,
      metadataRemote,
      eventBus,
      logger,
      loadSeed,
      service,
      transactions: sendTransactions,
    } = environment);
    sendOpRepo = repositories.sendOperationRepository;
    proofRepo = repositories.proofRepository;
  });

  it('prepares concurrent sends from the same mint without reusing proofs', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 10), makeProof('proof-2', 10)]);

    const firstInit = await service.init(mintUrl, unitAmount(10));
    const secondInit = await service.init(mintUrl, unitAmount(10));

    const [firstPrepared, secondPrepared] = await Promise.all([
      service.prepare(firstInit),
      service.prepare(secondInit),
    ]);
    expect(firstPrepared.state).toBe('prepared');
    expect(secondPrepared.state).toBe('prepared');
    expect(firstPrepared.inputProofSecrets).not.toEqual(secondPrepared.inputProofSecrets);
  });

  it('completes asynchronous preflight before opening a repository transaction', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 10)]);
    const init = await service.init(mintUrl, unitAmount(10));
    loadSeed.mockImplementationOnce(async () => {
      throw new Error('seed unavailable');
    });

    await expect(service.prepare(init)).rejects.toThrow('seed unavailable');

    expect(repositories.transactionCount).toBe(0);
    expect(
      (await proofRepo.getProofBySecret(mintUrl, 'proof-1'))?.usedByOperationId,
    ).toBeUndefined();
    expect(await sendOpRepo.getById(init.id)).toBeNull();
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
  });

  it('normalizes the mint URL before querying trust through the repository', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('normalized-input', 10)]);
    const operation = await service.init(`${mintUrl}/`, unitAmount(10));
    const prepared = await service.prepare(operation);
    expect(prepared.mintUrl).toBe(mintUrl);
    expect(prepared.inputProofSecrets).toEqual(['normalized-input']);
  });

  it('lets the P2PK handler fix randomized outputs before atomic preparation', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('p2pk-input', 10)]);
    const fixedOutput = {
      blindedMessage: { id: keysetId, amount: Amount.from(10), B_: 'p2pk-B' },
      blindingFactor: 1n,
      secret: new Uint8Array([1, 2, 3]),
      toProof: () => {
        throw new Error('not used');
      },
    } satisfies OutputDataLike;
    const createP2PKData = mock(() => [fixedOutput]);
    service = buildService(makeOutputDataCreator({ createP2PKData }));
    const operation = await service.init(mintUrl, unitAmount(10), {
      method: 'p2pk',
      methodData: {
        pubkey: '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
      },
    });

    const prepared = await service.prepare(operation);

    expect(createP2PKData).toHaveBeenCalledTimes(1);
    expect(prepared.needsSwap).toBe(true);
    expect(prepared.outputData?.send[0]?.blindedMessage.B_).toBe('p2pk-B');
    expect((await proofRepo.getProofBySecret(mintUrl, 'p2pk-input'))?.usedByOperationId).toBe(
      prepared.id,
    );
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
  });

  it('emits send:prepared after the prepared state is persisted', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);

    const initOp = await service.init(mintUrl, unitAmount(100));
    let persistedState: string | undefined;
    let lockedDuringEvent = false;

    eventBus.on('send:prepared', async ({ operationId }) => {
      persistedState = (await sendOpRepo.getById(operationId))?.state;
      lockedDuringEvent = service.isOperationLocked(operationId);
    });

    const preparedOp = await service.prepare(initOp);

    expect(preparedOp.state).toBe('prepared');
    expect(persistedState).toBe('prepared');
    expect(lockedDuringEvent).toBe(false);
  });

  it('does not publish a prepared event until the transaction gateway resolves', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('event-boundary-proof', 10)]);
    const operation = await service.init(mintUrl, unitAmount(10));
    const realPrepare = sendTransactions.prepare.bind(sendTransactions);
    let releaseGateway!: () => void;
    let markCommitted!: () => void;
    const holdGateway = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      markCommitted = resolve;
    });
    sendTransactions.prepare = async (input) => {
      const result = await realPrepare(input);
      markCommitted();
      await holdGateway;
      return result;
    };
    let eventCount = 0;
    eventBus.on('send:prepared', () => {
      eventCount++;
    });

    const preparation = service.prepare(operation);
    await committed;
    expect(eventCount).toBe(0);
    releaseGateway();
    await preparation;
    expect(eventCount).toBe(1);
  });

  it('releases the mint lock before publishing committed preparation events', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 10), makeProof('proof-2', 10)]);
    const first = await service.init(mintUrl, unitAmount(10));
    const second = await service.init(mintUrl, unitAmount(10));
    let nested: PreparedSendOperation | undefined;

    eventBus.once('send:prepared', async () => {
      nested = await service.prepare(second);
    });

    const prepared = await service.prepare(first);

    expect(prepared.state).toBe('prepared');
    expect(nested?.state).toBe('prepared');
    expect(prepared.inputProofSecrets).not.toEqual(nested?.inputProofSecrets);
  });

  it('emits send:pending after the pending state is persisted', async () => {
    const preparedOp = await prepareExact();
    let persistedState: string | undefined;
    let lockedDuringEvent = false;
    let proofStateDuringEvent: string | undefined;

    eventBus.on('send:pending', async ({ operationId }) => {
      persistedState = (await sendOpRepo.getById(operationId))?.state;
      lockedDuringEvent = service.isOperationLocked(operationId);
    });
    eventBus.on('proofs:state-changed', async ({ secrets, state }) => {
      if (state !== 'inflight') return;
      proofStateDuringEvent = (await proofRepo.getProofBySecret(mintUrl, secrets[0]!))?.state;
      lockedDuringEvent ||= service.isOperationLocked(preparedOp.id);
    });

    const result = await service.execute(preparedOp);

    expect(result.operation.state).toBe('pending');
    expect(persistedState).toBe('pending');
    expect(proofStateDuringEvent).toBe('inflight');
    expect(lockedDuringEvent).toBe(false);
  });

  it.each(['exact', 'swap'] as const)(
    'publishes pending before an immediate watcher notification finalizes the %s send',
    async (mode) => {
      const prepared =
        mode === 'exact' ? await prepareExact() : await makeSwapPrepared('event-order');
      remote.swap.mockResolvedValue({ keep: [], send: [makeProof('event-order-send', 100)] });

      let notifySpent!: () => Promise<void>;
      const subscriptions = {
        subscribe: async (
          _mintUrl: string,
          _kind: string,
          filters: string[],
          callback: SubscriptionCallback<{ Y: string; state: 'SPENT' }>,
        ) => {
          notifySpent = async () => {
            await callback({ Y: filters[0]!, state: 'SPENT' });
          };
          return { subId: 'event-order-sub', unsubscribe: async () => {} };
        },
      };
      const setProofState = mock(async () => {});
      const watcher = new ProofStateWatcherService(
        subscriptions as unknown as SubscriptionManager,
        { isTrustedMint: async () => true } as unknown as MintService,
        { setProofState } as unknown as ProofService,
        proofRepo,
        eventBus,
        logger,
        { watchExistingInflightOnStart: false },
      );
      watcher.setSendOperationService(service);
      await watcher.start();

      const events: string[] = [];
      eventBus.on('send:pending', () => {
        events.push('pending');
      });
      eventBus.on('send:finalized', () => {
        events.push('finalized');
      });
      // Deliver the mint notification after the watcher subscribes, while the
      // proof event that enabled watching is still being dispatched.
      eventBus.on('proofs:state-changed', async ({ state }) => {
        if (mode === 'exact' && state === 'inflight') await notifySpent();
      });
      eventBus.on('proofs:saved', async ({ proofs }) => {
        if (mode === 'swap' && proofs.some((proof) => proof.state === 'inflight')) {
          await notifySpent();
        }
      });

      try {
        await service.execute(prepared);

        expect((await sendOpRepo.getById(prepared.id))?.state).toBe('finalized');
        expect(events).toEqual(['pending', 'finalized']);
        expect(setProofState).not.toHaveBeenCalled();
      } finally {
        await watcher.stop();
      }
    },
  );

  it('executes an exact match without opening a remote session', async () => {
    const preparedOp = await prepareExact();

    const result = await service.execute(preparedOp);

    expect(result.operation.state).toBe('pending');
    expect(result.operation.revision).toBe(1);
    expect(result.token.proofs.map((proof) => proof.secret)).toEqual(['proof-1']);
    expect(remote.open).not.toHaveBeenCalled();
    expect(remote.swap).not.toHaveBeenCalled();
  });

  it('uses only the caller operation id and reloads authoritative exact-send data', async () => {
    const preparedOp = await prepareExact();

    const result = await service.execute({
      ...preparedOp,
      inputProofSecrets: ['stale-caller-secret'],
      revision: 999,
    });

    expect(result.token.proofs.map((proof) => proof.secret)).toEqual(['proof-1']);
    expect(result.operation.inputProofSecrets).toEqual(['proof-1']);
  });

  it('logs a post-commit listener failure without misreporting the exact Send', async () => {
    const preparedOp = await prepareExact();
    eventBus.on('send:pending', () => {
      throw new Error('listener failed');
    });

    const result = await service.execute(preparedOp);

    expect(result.operation.state).toBe('pending');
    expect((await sendOpRepo.getById(preparedOp.id))?.state).toBe('pending');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to publish committed Send event',
      expect.objectContaining({ event: 'send:pending' }),
    );
  });

  it('commits swap execution before transport and applies the response after transport', async () => {
    const prepared = await makeSwapPrepared('swap-boundary');
    let stateDuringTransport: string | undefined;
    let revisionDuringTransport: number | undefined;
    let memoDuringTransport: string | undefined;
    let pendingEventLocked = true;
    remote.swap.mockImplementation(async (request) => {
      const stored = await sendOpRepo.getById(prepared.id);
      stateDuringTransport = stored?.state;
      revisionDuringTransport = stored?.revision;
      memoDuringTransport = stored?.executionMemo;
      expect(request.inputProofs.map((proof) => proof.secret)).toEqual(prepared.inputProofSecrets);
      expect(request.outputData).toEqual(prepared.outputData!);
      return {
        keep: [],
        send: [
          {
            id: keysetId,
            secret: `${prepared.id}-send`,
            amount: Amount.from(100),
            C: 'C-swap-send',
          },
        ],
      };
    });
    eventBus.on('send:pending', () => {
      pendingEventLocked = service.isOperationLocked(prepared.id);
    });

    const result = await service.execute(prepared, { memo: '  durable memo  ' });

    expect(stateDuringTransport).toBe('executing');
    expect(revisionDuringTransport).toBe(1);
    expect(memoDuringTransport).toBe('durable memo');
    expect(pendingEventLocked).toBe(false);
    expect(result.operation.state).toBe('pending');
    expect(result.operation.revision).toBe(2);
    expect(result.token.memo).toBe('durable memo');
    expect((await proofRepo.getProofBySecret(mintUrl, prepared.inputProofSecrets[0]!))?.state).toBe(
      'spent',
    );
    expect((await proofRepo.getProofBySecret(mintUrl, `${prepared.id}-send`))?.state).toBe(
      'inflight',
    );
  });

  it('leaves an ambiguous swap failure executing for recovery', async () => {
    const prepared = await makeSwapPrepared('swap-ambiguous');
    remote.swap.mockRejectedValue(new NetworkError('connection lost'));

    await expect(service.execute(prepared)).rejects.toThrow('connection lost');

    const stored = await sendOpRepo.getById(prepared.id);
    expect(stored?.state).toBe('executing');
    expect(stored?.revision).toBe(1);
    expect(
      (await proofRepo.getProofBySecret(mintUrl, prepared.inputProofSecrets[0]!))
        ?.usedByOperationId,
    ).toBe(prepared.id);
  });

  it.each([11001, 11002, 11003, 11004, 99999])(
    'retains the exact request and reservation after ambiguous mint error %i',
    async (code) => {
      const prepared = await makeSwapPrepared(`swap-error-${code}`);
      const rolledBack = mock(() => {});
      eventBus.on('send:rolled-back', rolledBack);
      remote.swap.mockRejectedValue(new MintOperationError(code, 'uncertain swap outcome'));

      await expect(service.execute(prepared)).rejects.toThrow('uncertain swap outcome');

      const stored = await sendOpRepo.getById(prepared.id);
      expect(stored?.state).toBe('executing');
      if (stored?.state !== 'executing') throw new Error('Expected executing Send');
      expect(stored.inputProofSecrets).toEqual(prepared.inputProofSecrets);
      expect(stored.outputData).toEqual(prepared.outputData);
      expect(
        (await proofRepo.getProofBySecret(mintUrl, prepared.inputProofSecrets[0]!))
          ?.usedByOperationId,
      ).toBe(prepared.id);
      expect(rolledBack).not.toHaveBeenCalled();
    },
  );

  it('does not begin or mask a definitive-looking wallet preflight failure', async () => {
    const prepared = await makeSwapPrepared('swap-preflight-failure');
    remote.open.mockImplementationOnce(() => {
      throw new MintOperationError(12001, 'Could not load active keyset');
    });

    await expect(service.execute(prepared)).rejects.toThrow('Could not load active keyset');

    const stored = await sendOpRepo.getById(prepared.id);
    expect(stored?.state).toBe('prepared');
    expect(stored?.revision).toBe(0);
    expect(
      (await proofRepo.getProofBySecret(mintUrl, prepared.inputProofSecrets[0]!))
        ?.usedByOperationId,
    ).toBe(prepared.id);
  });

  it('atomically rolls back a definitive mint rejection after the transport boundary', async () => {
    const prepared = await makeSwapPrepared('swap-rejected');
    remote.swap.mockRejectedValue(new MintOperationError(12001, 'Keyset is not known'));
    let rolledBackEventLocked = true;
    eventBus.on('send:rolled-back', () => {
      rolledBackEventLocked = service.isOperationLocked(prepared.id);
    });

    await expect(service.execute(prepared)).rejects.toThrow('Keyset is not known');

    const stored = await sendOpRepo.getById(prepared.id);
    expect(stored?.state).toBe('rolled_back');
    expect(stored?.error).toBe('Keyset is not known');
    expect(rolledBackEventLocked).toBe(false);
    expect(
      (await proofRepo.getProofBySecret(mintUrl, prepared.inputProofSecrets[0]!))
        ?.usedByOperationId,
    ).toBeUndefined();
  });

  it('returns committed swap state when a live event listener fails', async () => {
    const prepared = await makeSwapPrepared('swap-event-failure');
    remote.swap.mockResolvedValue({
      keep: [],
      send: [
        {
          id: keysetId,
          secret: `${prepared.id}-send`,
          amount: Amount.from(100),
          C: 'C-swap-send',
        },
      ],
    });
    eventBus = new EventBus<CoreEvents>({ throwOnError: true });
    eventBus.on('send:pending', () => {
      throw new Error('listener failed');
    });
    service = buildService();

    const result = await service.execute(prepared);

    expect(result.operation.state).toBe('pending');
    expect(logger.error).toHaveBeenCalledWith('Failed to publish committed Send event', {
      event: 'send:pending',
      error: expect.any(AggregateError),
    });
  });

  it('prepares and executes a custom-unit send without selecting sat proofs', async () => {
    await proofRepo.saveProofs(mintUrl, [
      makeProof('sat-proof', 100, 'sat'),
      makeProof('usd-proof', 100, 'usd'),
    ]);

    const initOp = await service.init(mintUrl, unitAmount(100, 'USD'));
    const preparedOp = await service.prepare(initOp);
    const result = await service.execute(preparedOp);

    expect(preparedOp.unit).toBe('usd');
    expect(preparedOp.inputProofSecrets).toEqual(['usd-proof']);
    expect(result.token.unit).toBe('usd');
    expect(result.operation.unit).toBe('usd');
    expect(result.token.proofs.map((proof) => proof.secret)).toEqual(['usd-proof']);

    const satProof = await proofRepo.getProofBySecret(mintUrl, 'sat-proof');
    expect(satProof?.state).toBe('ready');
    expect(satProof?.usedByOperationId).toBeUndefined();
  });

  it('serializes competing finalization attempts and returns idempotently', async () => {
    const pendingOp = {
      ...pendingSend('send-op-pending', [makeProof('proof-1', 100)]),
      revision: undefined,
    };
    await sendOpRepo.create(pendingOp);
    await proofRepo.saveProofs(mintUrl, [
      { ...makeProof('proof-1', 100), state: 'spent', usedByOperationId: pendingOp.id },
    ]);

    await expect(
      Promise.all([service.finalize(pendingOp.id), service.finalize(pendingOp.id)]),
    ).resolves.toEqual([undefined, undefined]);

    const persisted = await sendOpRepo.getById(pendingOp.id);
    expect(persisted?.state).toBe('finalized');
  });

  it('keeps finalization persistence inside the Send transaction gateway', async () => {
    const pendingOp = {
      ...pendingSend('send-op-custom-finalize', [makeProof('proof-1', 100)]),
      revision: undefined,
    };
    await sendOpRepo.create(pendingOp);
    await proofRepo.saveProofs(mintUrl, [
      { ...makeProof('proof-1', 100), state: 'spent', usedByOperationId: pendingOp.id },
    ]);

    await service.finalize(pendingOp.id);

    expect(repositories.transactionCount).toBe(1);
    expect((await sendOpRepo.getById(pendingOp.id))?.state).toBe('finalized');
  });

  it.each([...completionPaths])(
    'finishes an already released Send through %s and only publishes committed changes',
    async (path) => {
      const proof = makeProof('released-input', 100);
      await proofRepo.saveProofs(mintUrl, [proof]);
      const prepared = await service.prepare(await service.init(mintUrl, unitAmount(100)));
      const { operation } = await service.execute(prepared);
      await sendOpRepo.update({ ...operation, revision: 0 });
      await proofRepo.setProofState(mintUrl, [proof.secret], 'spent');
      await proofRepo.releaseProofs(mintUrl, [proof.secret]);
      remote.checkProofStates.mockResolvedValue([
        { Y: 'released-input-Y', state: 'SPENT', witness: null },
      ]);
      const releases = mock(() => {});
      const finalized = mock(async () => {
        expect(repositories.transactionOpen).toBe(false);
        expect((await sendOpRepo.getById(operation.id))?.state).toBe('finalized');
      });
      eventBus.on('proofs:released', releases);
      eventBus.on('send:finalized', finalized);
      const complete = () => completeThrough(path, operation.id, proof.secret);

      await complete();
      await complete();

      expect((await sendOpRepo.getById(operation.id))?.state).toBe('finalized');
      expect(finalized).toHaveBeenCalledTimes(1);
      expect(releases).not.toHaveBeenCalled();
    },
  );

  describe('legacy tokenless P2PK completion', () => {
    async function persistTokenlessPending(): Promise<PendingSendOperation> {
      const prepared = await makeSwapPrepared('legacy-tokenless');
      const output = prepared.outputData!.send[0]!;
      const operation: PendingSendOperation = {
        ...prepared,
        method: 'p2pk',
        methodData: {
          pubkey: '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
        },
        state: 'pending',
        revision: 0,
        token: undefined,
        outputData: {
          keep: [],
          send: [
            { ...output, blindedMessage: { ...output.blindedMessage, amount: 50 } },
            {
              ...output,
              blindedMessage: { ...output.blindedMessage, amount: 50, B_: 'second-output' },
              secret: Buffer.from('legacy-tokenless-send-2').toString('hex'),
            },
          ],
        },
      };
      await sendOpRepo.update(operation);
      await proofRepo.setProofState(mintUrl, operation.inputProofSecrets, 'spent');
      remote.checkProofStates.mockImplementation(async (proofs) => {
        expect(repositories.transactionOpen).toBe(false);
        return proofs.map((proof) => ({ Y: `Y-${proof.secret}`, state: 'SPENT', witness: null }));
      });
      return (await sendOpRepo.getById(operation.id)) as PendingSendOperation;
    }

    it.each([...completionPaths])(
      'verifies the persisted allocation through %s without fabricating a token or proofs',
      async (path) => {
        const operation = await persistTokenlessPending();
        const finalized = mock(async () => {
          expect(repositories.transactionOpen).toBe(false);
          expect((await sendOpRepo.getById(operation.id))?.state).toBe('finalized');
        });
        const saved = mock(() => {});
        const released = mock(() => {});
        eventBus.on('send:finalized', finalized);
        eventBus.on('proofs:saved', saved);
        eventBus.on('proofs:released', released);
        const complete = () => completeThrough(path, operation.id, 'legacy-tokenless-send');

        await complete();
        await complete();

        expect(remote.checkProofStates).toHaveBeenCalledTimes(1);
        expect(remote.checkProofStates).toHaveBeenCalledWith([
          { id: keysetId, secret: 'legacy-tokenless-send' },
          { id: keysetId, secret: 'legacy-tokenless-send-2' },
        ]);
        const stored = await sendOpRepo.getById(operation.id);
        expect(stored).toMatchObject({ state: 'finalized', revision: 1, token: undefined });
        expect(stored && 'outputData' in stored ? stored.outputData : undefined).toEqual(
          operation.outputData,
        );
        expect(
          await proofRepo.getProofsBySecrets(mintUrl, [
            'legacy-tokenless-send',
            'legacy-tokenless-send-2',
          ]),
        ).toEqual([]);
        expect(
          (await proofRepo.getProofBySecret(mintUrl, operation.inputProofSecrets[0]!))
            ?.usedByOperationId,
        ).toBeUndefined();
        expect(finalized).toHaveBeenCalledTimes(1);
        expect(released).toHaveBeenCalledTimes(1);
        expect(saved).not.toHaveBeenCalled();
        expect(remote.swap).not.toHaveBeenCalled();
        expect(remote.restoreOutputs).not.toHaveBeenCalled();
      },
    );

    it.each(['UNSPENT', 'PENDING', 'incomplete', 'offline'] as const)(
      'preserves the pending operation and reservations after %s observations',
      async (outcome) => {
        const operation = await persistTokenlessPending();
        remote.checkProofStates.mockImplementation(async () => {
          if (outcome === 'offline') throw new Error('mint unavailable');
          const spent = { Y: 'Y-first', state: 'SPENT' as const, witness: null };
          return outcome === 'incomplete'
            ? [spent]
            : [spent, { Y: 'Y-second', state: outcome, witness: null }];
        });

        await expect(service.finalize(operation.id)).rejects.toThrow();
        await new SendOpsApi(service).refresh(operation.id);

        expect(await sendOpRepo.getById(operation.id)).toEqual(operation);
        expect(
          (await proofRepo.getProofBySecret(mintUrl, operation.inputProofSecrets[0]!))
            ?.usedByOperationId,
        ).toBe(operation.id);
      },
    );

    it('rejects a stale observation when the operation changes during the mint check', async () => {
      const operation = await persistTokenlessPending();
      remote.checkProofStates.mockImplementation(async (proofs) => {
        await sendOpRepo.update({ ...operation, revision: 1 });
        return proofs.map((proof) => ({ Y: `Y-${proof.secret}`, state: 'SPENT', witness: null }));
      });

      await expect(service.finalize(operation.id)).rejects.toThrow('legacy P2PK');

      expect((await sendOpRepo.getById(operation.id))?.state).toBe('pending');
      expect(
        (await proofRepo.getProofBySecret(mintUrl, operation.inputProofSecrets[0]!))
          ?.usedByOperationId,
      ).toBe(operation.id);
    });

    it('updates existing owned output proofs while leaving absent outputs unmaterialized', async () => {
      const operation = await persistTokenlessPending();
      await proofRepo.saveProofs(mintUrl, [
        {
          ...makeProof('legacy-tokenless-send', 50),
          state: 'inflight',
          createdByOperationId: operation.id,
        },
      ]);
      const spent = mock(() => {});
      eventBus.on('proofs:state-changed', spent);

      await service.finalize(operation.id);

      expect((await proofRepo.getProofBySecret(mintUrl, 'legacy-tokenless-send'))?.state).toBe(
        'spent',
      );
      expect(await proofRepo.getProofBySecret(mintUrl, 'legacy-tokenless-send-2')).toBeNull();
      expect(spent).toHaveBeenCalledWith({
        mintUrl,
        secrets: ['legacy-tokenless-send'],
        state: 'spent',
      });
    });
  });

  it('preserves empty pending default-token reclaim through its transaction gateway', async () => {
    const pendingOp = pendingSend('send-op-legacy-reclaim', [makeProof('proof-1', 100)]);
    await sendOpRepo.create(pendingOp);

    await service.rollback(pendingOp.id, 'Reclaimed by user');

    expect(repositories.transactionCount).toBe(2);
    const stored = await sendOpRepo.getById(pendingOp.id);
    expect(stored?.state).toBe('rolled_back');
    expect(stored?.revision).toBe(3);
    expect(stored?.error).toBe('Reclaimed by user');
  });

  it.each([
    { memo: 'hello', expected: 'hello' },
    { memo: '  padded memo  ', expected: 'padded memo' },
    { memo: '   ', expected: undefined },
  ])('returns, persists, and emits the normalized memo "$memo"', async ({ memo, expected }) => {
    const prepared = await prepareExact();
    let eventToken: Token | undefined;
    eventBus.on('send:pending', ({ token }) => {
      eventToken = token;
    });

    const result = await service.execute(prepared, { memo });

    expect(result.token.memo).toBe(expected);
    expect(eventToken).toEqual(result.token);
    const stored = await sendOpRepo.getById(prepared.id);
    expect(stored && 'token' in stored ? stored.token : undefined).toEqual(result.token);
  });

  it('rechecks mint trust inside preparation after asynchronous preflight', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('trust-input', 10)]);
    const intent = await service.init(mintUrl, unitAmount(10));
    loadSeed.mockImplementationOnce(async () => {
      await repositories.mintRepository.setMintTrusted(mintUrl, false);
      return new Uint8Array(32).fill(1);
    });
    await expect(service.prepare(intent)).rejects.toThrow('not trusted');
    expect(await sendOpRepo.getById(intent.id)).toBeNull();
    expect(
      (await proofRepo.getProofBySecret(mintUrl, 'trust-input'))?.usedByOperationId,
    ).toBeUndefined();
  });

  it('fetches stale metadata outside transactions and publishes only the committed snapshot', async () => {
    const mint = await repositories.mintRepository.getMintByUrl(mintUrl);
    await repositories.mintRepository.updateMint({ ...mint, updatedAt: 0 });
    await proofRepo.saveProofs(mintUrl, [makeProof('metadata-input', 10)]);
    metadataRemote.fetchMintMetadata.mockImplementation(async () => {
      expect(repositories.transactionOpen).toBe(false);
      return {
        mintUrl,
        mintInfo: testMintInfo,
        keysets: await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl),
        observedAt: Math.floor(Date.now() / 1000),
      };
    });
    let observedCommitted = false;
    eventBus.on('mint:metadata-refreshed', async () => {
      expect(repositories.transactionOpen).toBe(false);
      expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBeGreaterThan(
        0,
      );
      observedCommitted = true;
    });
    const prepared = await service.prepare(await service.init(mintUrl, unitAmount(10)));
    expect(prepared.state).toBe('prepared');
    expect(observedCommitted).toBe(true);
    expect(repositories.transactionCount).toBe(2);
    expect(metadataRemote.fetchMintMetadata).toHaveBeenCalledTimes(1);
  });

  it('retains an independently committed metadata refresh when Send preparation fails', async () => {
    const mint = await repositories.mintRepository.getMintByUrl(mintUrl);
    await repositories.mintRepository.updateMint({ ...mint, updatedAt: 0 });
    await proofRepo.saveProofs(mintUrl, [makeProof('refresh-before-failure', 10)]);
    metadataRemote.fetchMintMetadata.mockImplementation(async () => ({
      mintUrl,
      mintInfo: { ...testMintInfo, name: 'Independent refresh' },
      keysets: await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl),
      observedAt: Math.floor(Date.now() / 1000),
    }));
    loadSeed.mockImplementationOnce(async () => {
      await repositories.mintRepository.setMintTrusted(mintUrl, false);
      return new Uint8Array(32).fill(1);
    });
    const intent = await service.init(mintUrl, unitAmount(10));
    await expect(service.prepare(intent)).rejects.toThrow('not trusted');
    expect((await repositories.mintRepository.getMintByUrl(mintUrl)).mintInfo.name).toBe(
      'Independent refresh',
    );
    expect(await sendOpRepo.getById(intent.id)).toBeNull();
    expect(
      (await proofRepo.getProofBySecret(mintUrl, 'refresh-before-failure'))?.usedByOperationId,
    ).toBeUndefined();
    expect(repositories.transactionCount).toBe(2);
  });

  it('commits the reclaim plan before mint I/O and publishes the complete terminal result', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('reclaim-input', 10)]);
    const prepared = await service.prepare(await service.init(mintUrl, unitAmount(10)));
    const pending = await service.execute(prepared);
    remote.reclaim.mockImplementation(async (inputs, outputData) => {
      expect(repositories.transactionOpen).toBe(false);
      const stored = await sendOpRepo.getById(prepared.id);
      expect(stored?.state).toBe('rolling_back');
      expect(stored?.reclaimData?.outputData).toEqual(outputData);
      expect(inputs.map((proof) => proof.secret)).toEqual(['reclaim-input']);
      return deserializeOutputData(outputData).keep.map((output) => ({
        id: output.blindedMessage.id,
        amount: output.blindedMessage.amount,
        secret: new TextDecoder().decode(output.secret),
        C: 'reclaimed-signature',
      }));
    });
    let observed = false;
    eventBus.on('send:rolled-back', async ({ operationId }) => {
      expect(repositories.transactionOpen).toBe(false);
      expect((await sendOpRepo.getById(operationId))?.state).toBe('rolled_back');
      expect(
        (await proofRepo.getProofBySecret(mintUrl, 'reclaim-input'))?.usedByOperationId,
      ).toBeUndefined();
      expect((await proofRepo.getAvailableProofs(mintUrl)).length).toBeGreaterThan(0);
      observed = true;
    });
    await service.rollback(pending.operation.id);
    expect(observed).toBe(true);
    expect(remote.reclaim).toHaveBeenCalledTimes(1);
    expect(repositories.transactionCount).toBe(4);
  });

  it('preserves the existing startup warning after an interrupted reclaim without resubmitting it', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('reclaim-interrupted-input', 10)]);
    const prepared = await service.prepare(await service.init(mintUrl, unitAmount(10)));
    await service.execute(prepared);
    remote.reclaim.mockRejectedValue(new Error('connection lost'));
    await expect(service.rollback(prepared.id)).rejects.toThrow('connection lost');
    const stored = await sendOpRepo.getById(prepared.id);
    expect(stored?.state).toBe('rolling_back');
    expect(stored?.reclaimData?.outputData.keep.length).toBeGreaterThan(0);
    await buildService().recoverPendingOperations();
    expect((await sendOpRepo.getById(prepared.id))?.state).toBe('rolling_back');
    expect(remote.reclaim).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Manual recovery via seed restore may be needed'),
      expect.objectContaining({ operationId: prepared.id }),
    );
  });

  it('joins a re-issued prepare for a caller-supplied operation ID after a restart', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 10), makeProof('proof-2', 10)]);
    const callerId = 'caller-command-1';
    const options = { method: 'default' as const, methodData: {}, operationId: callerId };

    const prepared = await service.prepare(await service.init(mintUrl, unitAmount(10), options));

    expect(prepared.id).toBe(callerId);
    const persisted = await sendOpRepo.getById(callerId);
    expect(persisted?.id).toBe(callerId);
    expect(persisted?.mintUrl).toBe(mintUrl);
    expect(persisted?.unit).toBe('sat');
    expect(persisted?.amount.equals(Amount.from(10))).toBe(true);
    expect(await proofRepo.getAvailableProofs(mintUrl, { unit: 'sat' })).toHaveLength(1);

    let preparedEvents = 0;
    eventBus.on('send:prepared', () => {
      preparedEvents++;
    });
    repositories.transactionCount = 0;

    // The host restarts, rebuilds the service over the same storage, and re-issues the same
    // durable command: the persisted operation is reused instead of being prepared again.
    const restarted = environment.buildService({ eventBus });
    const joined = await restarted.prepare(await restarted.init(mintUrl, unitAmount(10), options));

    expect(joined.id).toBe(callerId);
    expect(joined.state).toBe('prepared');
    expect(joined.inputProofSecrets).toEqual(prepared.inputProofSecrets);
    expect(await sendOpRepo.getByState('prepared')).toHaveLength(1);
    expect(repositories.transactionCount).toBe(0);
    expect(preparedEvents).toBe(0);
    expect(await proofRepo.getAvailableProofs(mintUrl, { unit: 'sat' })).toHaveLength(1);
  });

  it('joins concurrent prepares that reuse the same caller-supplied operation ID', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 10), makeProof('proof-2', 10)]);
    const callerId = 'caller-command-2';
    const options = { method: 'default' as const, methodData: {}, operationId: callerId };

    const [first, second] = await Promise.all([
      service
        .init(mintUrl, unitAmount(10), options)
        .then((operation) => service.prepare(operation)),
      service
        .init(mintUrl, unitAmount(10), options)
        .then((operation) => service.prepare(operation)),
    ]);

    expect(first.id).toBe(callerId);
    expect(second.inputProofSecrets).toEqual(first.inputProofSecrets);
    expect(await sendOpRepo.getByState('prepared')).toHaveLength(1);
    expect(repositories.transactionCount).toBe(1);
    expect(await proofRepo.getAvailableProofs(mintUrl, { unit: 'sat' })).toHaveLength(1);
  });

  it('rejects a duplicate caller-supplied operation ID with a different intent', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 10), makeProof('proof-2', 20)]);
    const callerId = 'caller-command-3';
    const prepared = await service.prepare(
      await service.init(mintUrl, unitAmount(10), {
        method: 'default',
        methodData: {},
        operationId: callerId,
      }),
    );
    repositories.transactionCount = 0;

    const conflict = await service
      .init(mintUrl, unitAmount(20), { method: 'default', methodData: {}, operationId: callerId })
      .then((operation) => service.prepare(operation))
      .catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(SendOperationIntentConflictError);
    expect(conflict).toBeInstanceOf(SendOperationConflictError);
    expect((conflict as SendOperationIntentConflictError).operationId).toBe(callerId);
    expect(repositories.transactionCount).toBe(0);
    const persisted = await sendOpRepo.getById(callerId);
    expect(persisted?.amount.equals(prepared.amount)).toBe(true);
    expect(persisted?.updatedAt).toBe(prepared.updatedAt);
    expect(persisted?.revision).toBe(prepared.revision);
  });

  it('rejects a duplicate caller-supplied operation ID that already progressed past prepare', async () => {
    const callerId = 'caller-command-4';
    await sendOpRepo.create(pendingSend(callerId, [makeProof('caller-command-4-input', 10)]));
    repositories.transactionCount = 0;

    const conflict = await service
      .init(mintUrl, unitAmount(10), { method: 'default', methodData: {}, operationId: callerId })
      .then((operation) => service.prepare(operation))
      .catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(SendOperationConflictError);
    expect(conflict).not.toBeInstanceOf(SendOperationIntentConflictError);
    expect((conflict as Error).message).toContain("state 'pending'");
    expect(repositories.transactionCount).toBe(0);
    expect((await sendOpRepo.getById(callerId))?.state).toBe('pending');
  });

  it('rejects a blank caller-supplied operation ID', async () => {
    await expect(
      service.init(mintUrl, unitAmount(10), {
        method: 'default',
        methodData: {},
        operationId: '   ',
      }),
    ).rejects.toThrow('non-empty');
  });

  it('compares send intent by normalized mint, amount, unit, method, and method data', () => {
    const intent = {
      mintUrl,
      amount: Amount.from(10),
      unit: 'sat',
      method: 'default' as const,
      methodData: {},
    };

    expect(isSameSendIntent(intent, { ...intent })).toBe(true);
    expect(isSameSendIntent(intent, { ...intent, mintUrl: `${mintUrl}/` })).toBe(true);
    expect(isSameSendIntent(intent, { ...intent, unit: 'SAT' })).toBe(true);
    expect(isSameSendIntent(intent, { ...intent, amount: Amount.from(20) })).toBe(false);
    expect(isSameSendIntent(intent, { ...intent, unit: 'usd' })).toBe(false);
    expect(isSameSendIntent(intent, { ...intent, mintUrl: 'https://other.test' })).toBe(false);
    expect(
      isSameSendIntent(intent, { ...intent, method: 'p2pk', methodData: { pubkey: 'pubkey-1' } }),
    ).toBe(false);
    expect(isSameSendIntent(intent, { ...intent, methodData: { forceSwap: true } })).toBe(false);
  });
});
