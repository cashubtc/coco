import type {
  InitReceiveOperation,
  PreparedReceiveOperation,
  ExecutingReceiveOperation,
} from '../../operations/receive/ReceiveOperation';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { ProofState as CashuProofState, Proof } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository';
import { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService';
import { MemoryReceiveOperationRepository } from '../../repositories/memory/MemoryReceiveOperationRepository';

describe('ReceiveOperationService - recoverPendingOperations', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';

  let receiveOpRepo: MemoryReceiveOperationRepository;
  let proofRepo: MemoryProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let eventBus: EventBus<CoreEvents>;
  let service: ReceiveOperationService;

  let mockCheckProofsStates: Mock<(proofs: { secret: string }[]) => Promise<CashuProofState[]>>;

  const makeProof = (secret: string): Proof =>
    ({
      id: keysetId,
      amount: 10,
      secret,
      C: `C_${secret}`,
    }) as Proof;

  const makeOutputData = (secrets: string[]) => {
    const mockKeepOutputs = secrets.map((secret) => ({
      blindedMessage: { amount: 10, id: keysetId, B_: `B_${secret}` },
      blindingFactor: '1234567890abcdef',
      secret: Buffer.from(secret, 'hex').toString('hex'),
    }));

    return {
      keep: mockKeepOutputs,
      send: [],
    };
  };

  const makeInitOp = (id: string, proofs: Proof[]): InitReceiveOperation => ({
    id,
    state: 'init',
    mintUrl,
    amount: proofs.reduce((acc, proof) => acc + proof.amount, 0),
    inputProofs: proofs,
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
  });

  const makePreparedOp = (
    id: string,
    proofs: Proof[],
    outputSecret = 'output-secret',
  ): PreparedReceiveOperation => ({
    id,
    state: 'prepared',
    mintUrl,
    amount: proofs.reduce((acc, proof) => acc + proof.amount, 0),
    inputProofs: proofs,
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    fee: 1,
    outputData: makeOutputData([outputSecret]),
  });

  const makeExecutingOp = (
    id: string,
    proofs: Proof[],
    outputSecret = 'output-secret',
  ): ExecutingReceiveOperation => ({
    ...makePreparedOp(id, proofs, outputSecret),
    state: 'executing',
  });

  beforeEach(() => {
    receiveOpRepo = new MemoryReceiveOperationRepository();
    proofRepo = new MemoryProofRepository();
    eventBus = new EventBus<CoreEvents>();

    mockCheckProofsStates = mock(async (proofs: { secret: string }[]) =>
      proofs.map(() => ({ state: 'UNSPENT' }) as CashuProofState),
    );

    const mockWallet = {
      checkProofsStates: mockCheckProofsStates,
    };

    walletService = {
      getWallet: mock(async () => mockWallet),
    } as unknown as WalletService;

    proofService = {
      recoverProofsFromOutputData: mock(async () => []),
    } as unknown as ProofService;

    mintService = {} as MintService;

    service = new ReceiveOperationService(
      receiveOpRepo,
      proofRepo,
      proofService,
      mintService,
      walletService,
      eventBus,
    );
  });

  it('cleans up init operations', async () => {
    const proofs = [makeProof('p1')];
    const op = makeInitOp('init-op', proofs);
    await receiveOpRepo.create(op);

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored).toBe(null);
  });

  it('rolls back prepared operations', async () => {
    const proofs = [makeProof('p1')];
    const op = makePreparedOp('prepared-op', proofs);
    await receiveOpRepo.create(op);

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('rolled_back');
  });

  it('rolls back executing operations when all inputs are unspent', async () => {
    const proofs = [makeProof('p1'), makeProof('p2')];
    const op = makeExecutingOp('exec-op', proofs);
    await receiveOpRepo.create(op);

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('rolled_back');
    expect((proofService.recoverProofsFromOutputData as Mock<any>).mock.calls.length).toBe(0);
    expect(mockCheckProofsStates.mock.calls.length).toBeGreaterThan(0);
  });

  it('finalizes executing operations when all inputs are spent and recovers proofs', async () => {
    const proofs = [makeProof('p1'), makeProof('p2')];
    const op = makeExecutingOp('exec-op-spent', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (items: { secret: string }[]) =>
      items.map(() => ({ state: 'SPENT' }) as CashuProofState),
    );

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('finalized');
    expect((proofService.recoverProofsFromOutputData as Mock<any>).mock.calls.length).toBe(1);
    expect(mockCheckProofsStates.mock.calls.length).toBeGreaterThan(0);
  });

  it('properly propagates errors from checkProofsStates as executing', async () => {
    const proofs = [makeProof('p1')];
    const op = makeExecutingOp('exec-op-error', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async () => {
      throw new Error('Network timeout');
    });

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('executing');
  });

  it('handles recoverProofsFromOutputData error by retaining rolled_back state', async () => {
    const proofs = [makeProof('p1')];
    const op = makeExecutingOp('exec-op-error-proof', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (items: { secret: string }[]) =>
      items.map(() => ({ state: 'UNSPENT' }) as CashuProofState),
    );
    (proofService.recoverProofsFromOutputData as Mock<any>).mockImplementation(async () => {
      throw new Error('Mint restore failed');
    });

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('rolled_back');
  });
});
