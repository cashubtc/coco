import {
  createMintServiceForMetadata,
  createMintMetadataRemoteDouble,
} from '../fixtures/MintMetadataRefresh.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import { StoredMintQueries } from '../../mints/MintMetadata.ts';
import { deserializeOutputData } from '../../utils.ts';
import { createSendRemoteDouble } from '../fixtures/SendRemote.ts';
import {
  Amount,
  type OutputDataCreator,
  type OutputDataLike,
  type Token,
  type Wallet,
} from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { SendOperationService } from '../../operations/send/SendOperationService';
import { DefaultSendHandler } from '../../infra/handlers/send/DefaultSendHandler';
import { P2pkSendHandler } from '../../infra/handlers/send/P2pkSendHandler';
import { SendHandlerProvider } from '../../infra/handlers/send/SendHandlerProvider';
import { MemorySendOperationRepository } from '../../repositories/memory/MemorySendOperationRepository';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import type { CoreProof } from '../../types';
import type {
  PreparedSendOperation,
  PendingSendOperation,
} from '../../operations/send/SendOperation';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreSendTransactions } from '../../transactions/send/SendTransactions.ts';
import type { SendTransactions } from '../../transactions/send/SendTransactions.ts';
import type { RepositoryTransactionScope } from '../../repositories';
import { MintOperationError, NetworkError } from '../../models/Error.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';

class CountingMemoryRepositories extends MemoryRepositories {
  transactionCount = 0;
  transactionOpen = false;

  override withTransaction<T>(
    fn: (repositories: RepositoryTransactionScope) => Promise<T>,
  ): Promise<T> {
    this.transactionCount++;
    return super.withTransaction(async (scope) => {
      this.transactionOpen = true;
      try {
        return await fn(scope);
      } finally {
        this.transactionOpen = false;
      }
    });
  }
}

describe('SendOperationService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = testMintKeysetId();
  const usdKeysetId = testMintKeysetId('usd');

  let sendOpRepo: MemorySendOperationRepository;
  let proofRepo: MemoryProofRepository;
  let mintQueries: StoredMintQueries;
  let metadataRemote: ReturnType<typeof createMintMetadataRemoteDouble>;
  let remote: ReturnType<typeof createSendRemoteDouble>;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let handlerProvider: SendHandlerProvider;
  let service: SendOperationService;
  let loadSeed: Mock<() => Promise<Uint8Array>>;
  let sendTransactions: SendTransactions;
  let repositories: CountingMemoryRepositories;

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
    new SendOperationService({
      operationQueries: sendOpRepo,
      proofQueries: proofRepo,
      transactions: sendTransactions,
      mintQueries,
      mintMetadataRefresh: createMintServiceForMetadata(repositories, metadataRemote, eventBus),
      remote,
      loadSeed,
      eventBus,
      handlerProvider,
      outputDataCreator,
      logger,
    });

  const makeSwapPrepared = async (id: string): Promise<PreparedSendOperation> => {
    const input = makeProof(`${id}-input`, 100);
    await proofRepo.saveProofs(mintUrl, [input]);
    await proofRepo.reserveProofs(mintUrl, [input.secret], id);
    const prepared: PreparedSendOperation = {
      id,
      state: 'prepared',
      mintUrl,
      amount: Amount.from(100),
      unit: 'sat',
      createdAt: 100,
      updatedAt: 200,
      revision: 0,
      needsSwap: true,
      fee: Amount.zero(),
      inputAmount: Amount.from(100),
      inputProofSecrets: [input.secret],
      outputData: {
        keep: [],
        send: [
          {
            blindedMessage: { amount: 100, id: keysetId, B_: `B-${id}` },
            blindingFactor: '01',
            secret: Buffer.from(`${id}-send`).toString('hex'),
          },
        ],
      },
      method: 'default',
      methodData: { forceSwap: true },
    };
    await sendOpRepo.create(prepared);
    return prepared;
  };

  const useSwapWallet = (send: Wallet['send']): void => {
    remote.swap.mockImplementation((request) => {
      const data = deserializeOutputData(request.outputData);
      return send(request.amount, request.inputProofs, undefined, {
        send: { type: 'custom', data: data.send },
        keep: { type: 'custom', data: data.keep },
      });
    });
  };

  beforeEach(async () => {
    repositories = new CountingMemoryRepositories();
    sendOpRepo = repositories.sendOperationRepository as MemorySendOperationRepository;
    proofRepo = repositories.proofRepository as MemoryProofRepository;
    sendTransactions = new CoreSendTransactions(new RepositoryCoreTransactionRunner(repositories));
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: keysetId,
      unit: 'sat',
      keypairs: testMintKeypairs,
      active: true,
      feePpk: 0,
    });
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: usdKeysetId,
      unit: 'usd',
      keypairs: testMintKeypairs,
      active: true,
      feePpk: 0,
    });
    eventBus = new EventBus<CoreEvents>();

    await repositories.mintRepository.addNewMint({
      mintUrl,
      name: 'Test',
      trusted: true,
      mintInfo: testMintInfo,
      createdAt: 1,
      updatedAt: Math.floor(Date.now() / 1000),
    });
    mintQueries = new StoredMintQueries(repositories.mintRepository, repositories.keysetRepository);
    remote = createSendRemoteDouble();
    metadataRemote = createMintMetadataRemoteDouble();
    loadSeed = mock(async () => new Uint8Array(32).fill(1));

    logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    } as Logger;

    handlerProvider = new SendHandlerProvider({
      default: new DefaultSendHandler(),
      p2pk: new P2pkSendHandler(),
    });

    service = buildService();
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
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);

    const initOp = await service.init(mintUrl, unitAmount(100));
    const preparedOp = await service.prepare(initOp);
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

  it('executes an exact match without opening a remote session', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);
    const initOp = await service.init(mintUrl, unitAmount(100));
    const preparedOp = await service.prepare(initOp);

    const result = await service.execute(preparedOp);

    expect(result.operation.state).toBe('pending');
    expect(result.operation.revision).toBe(1);
    expect(result.token.proofs.map((proof) => proof.secret)).toEqual(['proof-1']);
    expect(remote.open).not.toHaveBeenCalled();
    expect(remote.swap).not.toHaveBeenCalled();
  });

  it('uses only the caller operation id and reloads authoritative exact-send data', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);
    const initOp = await service.init(mintUrl, unitAmount(100));
    const preparedOp = await service.prepare(initOp);

    const result = await service.execute({
      ...preparedOp,
      inputProofSecrets: ['stale-caller-secret'],
      revision: 999,
    });

    expect(result.token.proofs.map((proof) => proof.secret)).toEqual(['proof-1']);
    expect(result.operation.inputProofSecrets).toEqual(['proof-1']);
  });

  it('logs a post-commit listener failure without misreporting the exact Send', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);
    const initOp = await service.init(mintUrl, unitAmount(100));
    const preparedOp = await service.prepare(initOp);
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
    const send = mock(async (_amount, inputs, _includeFees, outputConfig) => {
      const stored = await sendOpRepo.getById(prepared.id);
      stateDuringTransport = stored?.state;
      revisionDuringTransport = stored?.revision;
      memoDuringTransport = stored?.executionMemo;
      expect(inputs.map((proof: CoreProof) => proof.secret)).toEqual(prepared.inputProofSecrets);
      expect(outputConfig.send.data[0]?.secret).toEqual(
        new TextEncoder().encode(`${prepared.id}-send`),
      );
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
    useSwapWallet(send);
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
    useSwapWallet(
      mock(async () => {
        throw new NetworkError('connection lost');
      }),
    );

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
      useSwapWallet(
        mock(async () => {
          throw new MintOperationError(code, 'uncertain swap outcome');
        }),
      );

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
    useSwapWallet(
      mock(async () => {
        throw new MintOperationError(12001, 'Keyset is not known');
      }),
    );
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
    useSwapWallet(
      mock(async () => ({
        keep: [],
        send: [
          {
            id: keysetId,
            secret: `${prepared.id}-send`,
            amount: Amount.from(100),
            C: 'C-swap-send',
          },
        ],
      })),
    );
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
    const pendingOp: PendingSendOperation = {
      id: 'send-op-pending',
      state: 'pending',
      mintUrl,
      amount: Amount.from(100),
      unit: 'sat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsSwap: false,
      fee: Amount.from(0),
      inputAmount: Amount.from(100),
      inputProofSecrets: ['proof-1'],
      token: { mint: mintUrl, unit: 'sat', proofs: [makeProof('proof-1', 100)] },
      method: 'default',
      methodData: {},
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
    const pendingOp: PendingSendOperation = {
      id: 'send-op-custom-finalize',
      state: 'pending',
      mintUrl,
      amount: Amount.from(100),
      unit: 'sat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsSwap: false,
      fee: Amount.from(0),
      inputAmount: Amount.from(100),
      inputProofSecrets: ['proof-1'],
      token: { mint: mintUrl, unit: 'sat', proofs: [makeProof('proof-1', 100)] },
      method: 'default',
      methodData: {},
    };
    await sendOpRepo.create(pendingOp);
    await proofRepo.saveProofs(mintUrl, [
      { ...makeProof('proof-1', 100), state: 'spent', usedByOperationId: pendingOp.id },
    ]);

    await service.finalize(pendingOp.id);

    expect(repositories.transactionCount).toBe(1);
    expect((await sendOpRepo.getById(pendingOp.id))?.state).toBe('finalized');
  });

  it('preserves empty pending default-token reclaim through its transaction gateway', async () => {
    const pendingOp: PendingSendOperation = {
      id: 'send-op-legacy-reclaim',
      state: 'pending',
      mintUrl,
      amount: Amount.from(100),
      unit: 'sat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      needsSwap: false,
      fee: Amount.zero(),
      inputAmount: Amount.from(100),
      inputProofSecrets: ['proof-1'],
      token: { mint: mintUrl, unit: 'sat', proofs: [makeProof('proof-1', 100)] },
      method: 'default',
      methodData: {},
    };
    await sendOpRepo.create(pendingOp);

    await service.rollback(pendingOp.id, 'Reclaimed by user');

    expect(repositories.transactionCount).toBe(2);
    const stored = await sendOpRepo.getById(pendingOp.id);
    expect(stored?.state).toBe('rolled_back');
    expect(stored?.revision).toBe(3);
    expect(stored?.error).toBe('Reclaimed by user');
  });

  it('persists memo on the token when execute is called with a memo option', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);

    const initOp = await service.init(mintUrl, unitAmount(100));
    const preparedOp = await service.prepare(initOp);
    const result = await service.execute(preparedOp, { memo: 'hello' });

    expect(result.token.memo).toBe('hello');
    const persisted = await sendOpRepo.getById(preparedOp.id);
    expect((persisted as PendingSendOperation).token?.memo).toBe('hello');
  });

  it('omits memo from token when memo is whitespace-only', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);

    const initOp = await service.init(mintUrl, unitAmount(100));
    const preparedOp = await service.prepare(initOp);
    const result = await service.execute(preparedOp, { memo: '   ' });

    expect(result.token.memo).toBeUndefined();
    const persisted = await sendOpRepo.getById(preparedOp.id);
    expect((persisted as PendingSendOperation).token?.memo).toBeUndefined();
  });

  it('emits send:pending event with memo-bearing token', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);

    const initOp = await service.init(mintUrl, unitAmount(100));
    const preparedOp = await service.prepare(initOp);

    let eventToken: Token | undefined;
    eventBus.on('send:pending', ({ token }) => {
      eventToken = token;
    });

    await service.execute(preparedOp, { memo: 'event-memo' });

    expect(eventToken?.memo).toBe('event-memo');
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
});
