import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { SendOperationService } from '../../operations/send/SendOperationService';
import { DefaultSendHandler } from '../../infra/handlers/send/DefaultSendHandler';
import { P2pkSendHandler } from '../../infra/handlers/send/P2pkSendHandler';
import { SendHandlerProvider } from '../../infra/handlers/send/SendHandlerProvider';
import { MemorySendOperationRepository } from '../../repositories/memory/MemorySendOperationRepository';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { ProofService } from '../../services/ProofService';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { Logger } from '../../logging/Logger';
import type { CoreProof } from '../../types';
import type {
  PreparedSendOperation,
  PendingSendOperation,
  RolledBackSendOperation,
} from '../../operations/send/SendOperation';
import type { SendMethodHandler } from '../../operations/send/SendMethodHandler';

describe('SendOperationService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';

  let sendOpRepo: MemorySendOperationRepository;
  let proofRepo: MemoryProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let handlerProvider: SendHandlerProvider;
  let service: SendOperationService;

  const makeProof = (secret: string, amount: number): CoreProof =>
    ({
      amount,
      C: `C_${secret}`,
      id: keysetId,
      secret,
      mintUrl,
      state: 'ready',
    }) as CoreProof;

  beforeEach(() => {
    sendOpRepo = new MemorySendOperationRepository();
    proofRepo = new MemoryProofRepository();
    eventBus = new EventBus<CoreEvents>();

    mintService = {
      isTrustedMint: mock(async () => true),
    } as unknown as MintService;

    const wallet = {
      unit: 'sat',
      selectProofsToSend(proofs: any[], amount: number, includeFees: boolean) {
        if (!includeFees) {
          const exact = proofs.find((p) => p.amount === amount);
          if (exact) {
            return { send: [exact], keep: proofs.filter((p) => p.secret !== exact.secret) };
          }
        }

        const send: any[] = [];
        let total = 0;
        for (const proof of proofs) {
          if (total >= amount) break;
          send.push(proof);
          total += proof.amount;
        }

        return {
          send,
          keep: proofs.filter((p) => !send.some((selected) => selected.secret === p.secret)),
        };
      },
      getFeesForProofs() {
        return 0;
      },
    };

    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({
        wallet,
        keysetId,
        keyset: { id: keysetId },
        keys: { keys: { 1: 'pubkey' }, id: keysetId },
      })),
      getWallet: mock(async () => wallet),
    } as unknown as WalletService;

    proofService = {
      selectProofsToSend: mock(
        async (selectedMintUrl: string, amount: number, includeFees: boolean = true) => {
          const proofs = await proofRepo.getAvailableProofs(selectedMintUrl);
          return wallet.selectProofsToSend(proofs, amount, includeFees).send;
        },
      ),
      reserveProofs: mock((selectedMintUrl: string, secrets: string[], operationId: string) =>
        proofRepo.reserveProofs(selectedMintUrl, secrets, operationId).then(() => ({ amount: 0 })),
      ),
      releaseProofs: mock((selectedMintUrl: string, secrets: string[]) =>
        proofRepo.releaseProofs(selectedMintUrl, secrets),
      ),
      createOutputsAndIncrementCounters: mock(async () => ({
        keep: [],
        send: [],
        sendAmount: 0,
        keepAmount: 0,
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

    service = new SendOperationService(
      sendOpRepo,
      proofRepo,
      proofService,
      mintService,
      walletService,
      eventBus,
      handlerProvider,
      logger,
    );
  });

  it('serializes prepare calls for the same mint', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 10), makeProof('proof-2', 10)]);

    const firstInit = await service.init(mintUrl, 10);
    const secondInit = await service.init(mintUrl, 10);

    let releaseFirstReservation: () => void;
    const firstReservationBlocked = new Promise<void>((resolve) => {
      releaseFirstReservation = resolve;
    });
    (proofService.reserveProofs as Mock<any>).mockImplementation(
      async (selectedMintUrl: string, secrets: string[], operationId: string) => {
        if (operationId === firstInit.id) {
          await firstReservationBlocked;
        }
        await proofRepo.reserveProofs(selectedMintUrl, secrets, operationId);
        return { amount: 0 };
      },
    );

    const first = service.prepare(firstInit);
    await Promise.resolve();

    let secondResolved = false;
    const second = service.prepare(secondInit).then((operation) => {
      secondResolved = true;
      return operation;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    releaseFirstReservation!();

    const [firstPrepared, secondPrepared] = await Promise.all([first, second]);
    expect(firstPrepared.state).toBe('prepared');
    expect(secondPrepared.state).toBe('prepared');
    expect(secondResolved).toBe(true);
  });

  it('emits send:prepared after the prepared state is persisted', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);

    const initOp = await service.init(mintUrl, 100);
    let persistedState: string | undefined;
    let lockedDuringEvent = false;

    eventBus.on('send:prepared', async ({ operationId }) => {
      persistedState = (await sendOpRepo.getById(operationId))?.state;
      lockedDuringEvent = service.isOperationLocked(operationId);
    });

    const preparedOp = await service.prepare(initOp);

    expect(preparedOp.state).toBe('prepared');
    expect(persistedState).toBe('prepared');
    expect(lockedDuringEvent).toBe(true);
  });

  it('emits send:pending after the pending state is persisted', async () => {
    await proofRepo.saveProofs(mintUrl, [makeProof('proof-1', 100)]);

    const initOp = await service.init(mintUrl, 100);
    const preparedOp = await service.prepare(initOp);
    let persistedState: string | undefined;
    let lockedDuringEvent = false;

    eventBus.on('send:pending', async ({ operationId }) => {
      persistedState = (await sendOpRepo.getById(operationId))?.state;
      lockedDuringEvent = service.isOperationLocked(operationId);
    });

    const result = await service.execute(preparedOp);

    expect(result.operation.state).toBe('pending');
    expect(persistedState).toBe('pending');
    expect(lockedDuringEvent).toBe(true);
  });

  it('persists explicit handler failures without running executing recovery', async () => {
    const preparedOp: PreparedSendOperation = {
      id: 'send-op-failed',
      state: 'prepared',
      mintUrl,
      amount: 100,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsSwap: false,
      fee: 0,
      inputAmount: 100,
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
      prepare: mock(async (ctx) => ({
        ...ctx.operation,
        state: 'prepared',
        updatedAt: Date.now(),
        needsSwap: false,
        fee: 0,
        inputAmount: ctx.operation.amount,
        inputProofSecrets: [],
      })),
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
    service = new SendOperationService(
      sendOpRepo,
      proofRepo,
      proofService,
      mintService,
      walletService,
      eventBus,
      handlerProvider,
      logger,
    );

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
      amount: 100,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      needsSwap: true,
      fee: 0,
      inputAmount: 100,
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
});
