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
});
