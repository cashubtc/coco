import { Amount, type Token } from '@cashu/cashu-ts';
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
import type { ProofService } from '../../services/ProofService';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { SeedService } from '../../services/SeedService.ts';
import type { Logger } from '../../logging/Logger';
import type { CoreProof } from '../../types';
import type {
  PreparedSendOperation,
  PendingSendOperation,
  RolledBackSendOperation,
} from '../../operations/send/SendOperation';
import type { SendMethodHandler } from '../../operations/send/SendMethodHandler';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreSendTransactions } from '../../transactions/send/SendTransactions.ts';
import type { SendTransactions } from '../../transactions/send/SendTransactions.ts';
import type { RepositoryTransactionScope } from '../../repositories';

class CountingMemoryRepositories extends MemoryRepositories {
  transactionCount = 0;

  override withTransaction<T>(
    fn: (repositories: RepositoryTransactionScope) => Promise<T>,
  ): Promise<T> {
    this.transactionCount++;
    return super.withTransaction(fn);
  }
}

describe('SendOperationService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const usdKeysetId = 'keyset-usd';

  let sendOpRepo: MemorySendOperationRepository;
  let proofRepo: MemoryProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let handlerProvider: SendHandlerProvider;
  let service: SendOperationService;
  let seedService: SeedService;
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

  const buildService = () =>
    new SendOperationService({
      operationQueries: sendOpRepo,
      proofQueries: proofRepo,
      transactions: sendTransactions,
      proofService,
      mintService,
      walletService,
      seedService,
      eventBus,
      handlerProvider,
      logger,
    });

  beforeEach(async () => {
    repositories = new CountingMemoryRepositories();
    sendOpRepo = repositories.sendOperationRepository as MemorySendOperationRepository;
    proofRepo = repositories.proofRepository as MemoryProofRepository;
    sendTransactions = new CoreSendTransactions(new RepositoryCoreTransactionRunner(repositories));
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: keysetId,
      unit: 'sat',
      keypairs: { 1: 'unused' },
      active: true,
      feePpk: 0,
    });
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: usdKeysetId,
      unit: 'usd',
      keypairs: { 1: 'unused' },
      active: true,
      feePpk: 0,
    });
    eventBus = new EventBus<CoreEvents>();

    mintService = {
      isTrustedMint: mock(async () => true),
      assertNutSupported: mock(async () => {}),
      ensureUpdatedMint: mock(async () => ({
        mint: { mintUrl },
        keysets: [
          { id: keysetId, unit: 'sat', feePpk: 0 },
          { id: usdKeysetId, unit: 'usd', feePpk: 0 },
        ],
      })),
    } as unknown as MintService;

    const wallet = {
      unit: 'sat',
      selectProofsToSend(proofs: any[], amount: Amount, includeFees: boolean) {
        if (!includeFees) {
          const exact = proofs.find((p) => p.amount.equals(amount));
          if (exact) {
            return { send: [exact], keep: proofs.filter((p) => p.secret !== exact.secret) };
          }
        }

        const send: any[] = [];
        let total = Amount.zero();
        for (const proof of proofs) {
          if (total.greaterThanOrEqual(amount)) break;
          send.push(proof);
          total = total.add(proof.amount);
        }

        return {
          send,
          keep: proofs.filter((p) => !send.some((selected) => selected.secret === p.secret)),
        };
      },
      getFeesForProofs() {
        return Amount.zero();
      },
    };

    walletService = {
      getWalletWithActiveKeysetId: mock(async (_mintUrl: string, unit: string) => {
        const selectedKeysetId = unit.toLowerCase() === 'sat' ? keysetId : usdKeysetId;
        return {
          wallet,
          keysetId: selectedKeysetId,
          keyset: { id: selectedKeysetId },
          keys: {
            keys: { 1: 'unused' },
            id: selectedKeysetId,
            unit: unit.toLowerCase(),
            active: true,
          },
        };
      }),
      getWallet: mock(async () => wallet),
    } as unknown as WalletService;
    seedService = {
      getSeed: mock(async () => new Uint8Array(32).fill(1)),
    } as unknown as SeedService;

    proofService = {
      selectProofsToSend: mock(
        async (
          selectedMintUrl: string,
          intent: { amount: Amount; unit: string },
          includeFees: boolean = true,
        ) => {
          const proofs = await proofRepo.getAvailableProofs(selectedMintUrl, { unit: intent.unit });
          return wallet.selectProofsToSend(proofs, intent.amount, includeFees).send;
        },
      ),
      reserveProofs: mock((selectedMintUrl: string, secrets: string[], operationId: string) =>
        proofRepo
          .reserveProofs(selectedMintUrl, secrets, operationId)
          .then(() => ({ amount: Amount.from(0) })),
      ),
      releaseProofs: mock((selectedMintUrl: string, secrets: string[]) =>
        proofRepo.releaseProofs(selectedMintUrl, secrets),
      ),
      createOutputsAndIncrementCounters: mock(async () => ({
        keep: [],
        send: [],
        sendAmount: Amount.zero(),
        keepAmount: Amount.zero(),
      })),
      setProofState: mock(async () => {}),
      saveProofs: mock(async () => {}),
    } as unknown as ProofService;

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
    (seedService.getSeed as Mock<any>).mockImplementationOnce(async () => {
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

  it('executes an exact match without a wallet request or handler call', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);
    const initOp = await service.init(mintUrl, unitAmount(100));
    const preparedOp = await service.prepare(initOp);
    const walletCallsAfterPreparation = (walletService.getWalletWithActiveKeysetId as Mock<any>)
      .mock.calls.length;

    const result = await service.execute(preparedOp);

    expect(result.operation.state).toBe('pending');
    expect(result.operation.revision).toBe(1);
    expect(result.token.proofs.map((proof) => proof.secret)).toEqual(['proof-1']);
    expect((walletService.getWalletWithActiveKeysetId as Mock<any>).mock.calls).toHaveLength(
      walletCallsAfterPreparation,
    );
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
    expect(walletService.getWalletWithActiveKeysetId).toHaveBeenCalledWith(mintUrl, 'usd');
    expect(result.token.unit).toBe('usd');
    expect(result.operation.unit).toBe('usd');
    expect(result.token.proofs.map((proof) => proof.secret)).toEqual(['usd-proof']);

    const satProof = await proofRepo.getProofBySecret(mintUrl, 'sat-proof');
    expect(satProof?.state).toBe('ready');
    expect(satProof?.usedByOperationId).toBeUndefined();
  });

  it('persists explicit handler failures without running executing recovery', async () => {
    const preparedOp: PreparedSendOperation = {
      id: 'send-op-failed',
      state: 'prepared',
      mintUrl,
      amount: Amount.from(100),
      unit: 'sat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsSwap: true,
      fee: Amount.from(0),
      inputAmount: Amount.from(100),
      inputProofSecrets: ['proof-1'],
      method: 'default',
      methodData: {},
    };
    await sendOpRepo.create(preparedOp);

    const failedOperation: RolledBackSendOperation = {
      ...preparedOp,
      state: 'rolled_back',
      updatedAt: Date.now(),
      error: 'Explicit handler failure',
    };

    const customHandler: SendMethodHandler<'default'> = {
      execute: mock(async () => ({
        status: 'FAILED' as const,
        failed: failedOperation,
      })),
      recoverExecuting: mock(async () => ({
        status: 'FAILED' as const,
        failed: failedOperation,
      })),
    };

    handlerProvider = new SendHandlerProvider({
      default: customHandler,
      p2pk: new P2pkSendHandler(),
    });
    service = buildService();

    const events: CoreEvents['send:rolled-back'][] = [];
    eventBus.on('send:rolled-back', (event) => void events.push(event));

    await expect(service.execute(preparedOp)).rejects.toThrow('Explicit handler failure');

    expect(customHandler.execute).toHaveBeenCalledTimes(1);
    expect(customHandler.recoverExecuting).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]?.operationId).toBe(preparedOp.id);
    expect(events[0]?.operation.state).toBe('rolled_back');

    const persisted = await sendOpRepo.getById(preparedOp.id);
    expect(persisted?.state).toBe('rolled_back');
    expect(persisted?.error).toBe('Explicit handler failure');
  });

  it('waits for an in-progress finalization to finish before returning', async () => {
    const pendingOp: PendingSendOperation = {
      id: 'send-op-pending',
      state: 'pending',
      mintUrl,
      amount: Amount.from(100),
      unit: 'sat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsSwap: true,
      fee: Amount.from(0),
      inputAmount: Amount.from(100),
      inputProofSecrets: ['proof-1'],
      outputData: {
        keep: [],
        send: [
          {
            blindedMessage: { amount: 100, id: keysetId, B_: 'B_send_1' },
            blindingFactor: 'abc123',
            secret: Buffer.from('send-secret-1').toString('hex'),
          },
        ],
      },
      method: 'default',
      methodData: {},
    };
    await sendOpRepo.create(pendingOp);

    let releaseFirstFinalize: () => void;
    const firstFinalizeBlocked = new Promise<void>((resolve) => {
      releaseFirstFinalize = resolve;
    });

    (proofService.releaseProofs as Mock<any>)
      .mockImplementationOnce(async () => {
        await firstFinalizeBlocked;
      })
      .mockImplementation(async () => {});

    const firstFinalize = service.finalize(pendingOp.id);
    await Promise.resolve();

    const secondFinalize = service.finalize(pendingOp.id);
    await Promise.resolve();

    expect(service.isOperationLocked(pendingOp.id)).toBe(true);

    releaseFirstFinalize!();

    await expect(Promise.all([firstFinalize, secondFinalize])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    const persisted = await sendOpRepo.getById(pendingOp.id);
    expect(persisted?.state).toBe('finalized');
  });

  it('delegates finalization side effects to the send method handler before persisting', async () => {
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
      method: 'default',
      methodData: {},
    };
    await sendOpRepo.create(pendingOp);

    let persistedStateDuringFinalize: string | undefined;
    const customHandler: SendMethodHandler<'default'> = {
      execute: mock(async () => {
        throw new Error('not used');
      }),
      finalize: mock(async ({ operation }) => {
        persistedStateDuringFinalize = (await sendOpRepo.getById(operation.id))?.state;
      }),
      recoverExecuting: mock(async () => {
        throw new Error('not used');
      }),
    };

    handlerProvider = new SendHandlerProvider({
      default: customHandler,
      p2pk: new P2pkSendHandler(),
    });
    service = buildService();

    await service.finalize(pendingOp.id);

    expect(customHandler.finalize).toHaveBeenCalledTimes(1);
    expect(persistedStateDuringFinalize).toBe('pending');
    expect((await sendOpRepo.getById(pendingOp.id))?.state).toBe('finalized');
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
});
