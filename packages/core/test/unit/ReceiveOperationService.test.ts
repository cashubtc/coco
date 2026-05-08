import { Amount } from '@cashu/cashu-ts';
import type {
  FinalizedReceiveOperation,
  InitReceiveOperation,
  PreparedReceiveOperation,
  ReceiveOperation,
} from '../../operations/receive/ReceiveOperation';
import type { CoreProof } from '../../types';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { MintService } from '../../services/MintService';
import { HistoryService } from '../../services/HistoryService';
import type { ProofService } from '../../services/ProofService';
import { TokenService } from '../../services/TokenService';
import type { WalletService } from '../../services/WalletService';
import { OutputData, type Proof, type Token } from '@cashu/cashu-ts';
import {
  MintOperationError,
  NetworkError,
  ProofValidationError,
  UnknownMintError,
} from '../../models/Error';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { getOutputProofSecrets } from '../../operations/receive/ReceiveOperation';
import { MemoryHistoryRepository } from '../../repositories/memory/MemoryHistoryRepository';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository';
import { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService';
import { MemoryReceiveOperationRepository } from '../../repositories/memory/MemoryReceiveOperationRepository';

describe('ReceiveOperationService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';

  let receiveOpRepo: MemoryReceiveOperationRepository;
  let proofRepo: MemoryProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let mintAdapter: MintAdapter;
  let tokenService: TokenService;
  let eventBus: EventBus<CoreEvents>;
  let service: ReceiveOperationService;

  let mockWalletReceive: Mock<(...args: any[]) => Promise<Proof[]>>;
  let mockIsTrustedMint: Mock<(mintUrl: string) => Promise<boolean>>;
  let mockEnsureUpdatedMint: Mock<
    (
      mintUrl: string,
    ) => Promise<{ mint: { url: string }; keysets: { id: string; unit?: string }[] }>
  >;

  const makeProof = (secret: string): Proof =>
    ({
      id: keysetId,
      amount: Amount.from(10),
      secret,
      C: `C_${secret}`,
    }) as Proof;

  const makeOutputData = (secrets: string[]): OutputData[] =>
    secrets.map(
      (secret) =>
        new OutputData(
          { amount: Amount.from(10), id: keysetId, B_: `B_${secret}` },
          BigInt(1),
          new TextEncoder().encode(secret),
        ),
    );

  const createMockMintAdapter = (): MintAdapter =>
    ({
      checkProofStates: mock(() => Promise.resolve([])),
    }) as unknown as MintAdapter;

  beforeEach(() => {
    receiveOpRepo = new MemoryReceiveOperationRepository();
    proofRepo = new MemoryProofRepository();
    eventBus = new EventBus<CoreEvents>();
    mintAdapter = createMockMintAdapter();

    mockWalletReceive = mock(async () => [makeProof('n1'), makeProof('n2')]);

    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({
        wallet: {
          unit: 'sat',
          getFeesForProofs: mock(() => Amount.zero()),
          receive: mockWalletReceive,
        },
      })),
      getWallet: mock(async () => ({
        checkProofsStates: mock(async () => []),
      })),
    } as unknown as WalletService;

    proofService = {
      prepareProofsForReceiving: mock(async (proofs: Proof[]) => proofs),
      createOutputsAndIncrementCounters: mock(async () => ({
        keep: makeOutputData(['out-1']),
        send: [],
      })),
      setProofState: mock(async () => {}),
      saveProofs: mock(async () => {}),
    } as unknown as ProofService;

    mockIsTrustedMint = mock(async () => true);
    mockEnsureUpdatedMint = mock(async () => ({
      mint: { url: mintUrl },
      keysets: [{ id: keysetId }],
    }));

    mintService = {
      isTrustedMint: mockIsTrustedMint,
      ensureUpdatedMint: mockEnsureUpdatedMint,
    } as unknown as MintService;

    tokenService = new TokenService(mintService);

    service = new ReceiveOperationService(
      receiveOpRepo,
      proofRepo,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      tokenService,
      eventBus,
    );
  });

  it('init -> prepare -> execute via receive() finalizes and emits event', async () => {
    const proofs = [makeProof('p1'), makeProof('p2')];
    const token: Token = { mint: mintUrl, proofs } as Token;

    let eventPayload: CoreEvents['receive-op:finalized'] | undefined;
    eventBus.on('receive-op:finalized', (payload) => {
      eventPayload = payload;
    });

    await service.receive(token);

    const finalized = await receiveOpRepo.getByState('finalized');
    expect(finalized.length).toBe(1);
    const op = finalized[0] as FinalizedReceiveOperation;

    expect(op?.mintUrl).toBe(mintUrl);
    expect(op?.unit).toBe('sat');
    expect(op?.amount).toEqual(Amount.from(20));
    expect(op?.outputData).toBeDefined();
    expect(eventPayload?.mintUrl).toBe(mintUrl);
    expect(eventPayload?.operation.state).toBe('finalized');
    expect(eventPayload?.operation.inputProofs.length).toBe(2);
  });

  it('prepare() persists outputData and fee', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs } as Token;

    const initOp = await service.init(token);
    const prepared = await service.prepare(initOp);

    expect(prepared.state).toBe('prepared');
    expect(prepared.fee).toEqual(Amount.from(0));
    expect(prepared.outputData).toBeDefined();
  });

  it('emits receive-op:prepared after the prepared state is persisted', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const initOp = await service.init(token);
    let persistedState: string | undefined;
    let lockedDuringEvent = false;

    eventBus.on('receive-op:prepared', async ({ operationId }) => {
      persistedState = (await receiveOpRepo.getById(operationId))?.state;
      lockedDuringEvent = service.isOperationLocked(operationId);
    });

    const prepared = await service.prepare(initOp);

    expect(prepared.state).toBe('prepared');
    expect(persistedState).toBe('prepared');
    expect(lockedDuringEvent).toBe(true);
  });

  it('emits receive-op:finalized after the finalized state is persisted', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const initOp = await service.init(token);
    const prepared = await service.prepare(initOp);
    let persistedState: string | undefined;
    let lockedDuringEvent = false;

    eventBus.on('receive-op:finalized', async ({ operationId }) => {
      persistedState = (await receiveOpRepo.getById(operationId))?.state;
      lockedDuringEvent = service.isOperationLocked(operationId);
    });

    const finalized = await service.execute(prepared);

    expect(finalized.state).toBe('finalized');
    expect(persistedState).toBe('finalized');
    expect(lockedDuringEvent).toBe(true);
  });

  it('emits receive-op:rolled-back after the rolled back state is persisted', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const initOp = await service.init(token);
    const prepared = await service.prepare(initOp);
    let persistedState: string | undefined;
    let lockedDuringEvent = false;

    eventBus.on('receive-op:rolled-back', async ({ operationId }) => {
      persistedState = (await receiveOpRepo.getById(operationId))?.state;
      lockedDuringEvent = service.isOperationLocked(operationId);
    });

    await service.rollback(prepared.id);

    expect(persistedState).toBe('rolled_back');
    expect(lockedDuringEvent).toBe(true);
    expect((await receiveOpRepo.getById(prepared.id))?.state).toBe('rolled_back');
  });

  it('rollback emits terminal receive history projection', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const initOp = await service.init(token);
    const prepared = await service.prepare(initOp);
    const historyRepo = new MemoryHistoryRepository({
      receiveOperationRepository: receiveOpRepo,
    });

    new HistoryService(historyRepo, eventBus);

    await service.rollback(prepared.id);

    const historyEntry = await historyRepo.getReceiveHistoryEntry(mintUrl, prepared.id);
    expect(historyEntry?.state).toBe('rolled_back');
  });
  it('init rejects untrusted mints', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs } as Token;

    mockIsTrustedMint.mockImplementation(async () => false);

    expect(service.init(token)).rejects.toThrow(UnknownMintError);
    const initOps = await receiveOpRepo.getByState('init');
    expect(initOps.length).toBe(0);
  });

  it('init rejects invalid token strings before trust check', async () => {
    expect(service.init('not-a-token')).rejects.toThrow(ProofValidationError);
    expect(mockIsTrustedMint.mock.calls.length).toBe(0);
  });

  it('init rejects tokens with no proofs', async () => {
    const proofs: Proof[] = [];
    const token: Token = { mint: mintUrl, proofs } as Token;

    expect(service.init(token)).rejects.toThrow(ProofValidationError);
  });

  it('init rejects tokens with non-positive amount', async () => {
    const zeroProof = { ...makeProof('p1'), amount: Amount.from(0) } as Proof;
    const token: Token = { mint: mintUrl, proofs: [zeroProof] } as Token;

    expect(service.init(token)).rejects.toThrow(ProofValidationError);
  });

  it('init rejects token units that conflict with proof keyset units', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs, unit: 'usd' } as Token;

    expect(service.init(token)).rejects.toThrow('Unit mismatch: expected usd, received sat');
  });

  it('init accepts non-sat tokens when proof keysets match the token unit', async () => {
    mockEnsureUpdatedMint.mockImplementationOnce(async () => ({
      mint: { url: mintUrl },
      keysets: [{ id: keysetId, unit: 'usd' }],
    }));
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs, unit: 'USD' } as Token;

    const operation = await service.init(token);

    expect(operation.unit).toBe('usd');
  });

  it('prepare throws when operation has no input proofs', async () => {
    const initOp: InitReceiveOperation = {
      id: 'empty-op',
      state: 'init',
      mintUrl,
      unit: 'sat',
      amount: Amount.from(0),
      inputProofs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await receiveOpRepo.create(initOp);

    expect(service.prepare(initOp)).rejects.toThrow(ProofValidationError);
  });

  it('prepare throws when fees consume the full amount', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const initOp = await service.init(token);

    (walletService.getWalletWithActiveKeysetId as Mock<any>).mockImplementation(async () => ({
      wallet: {
        unit: 'sat',
        getFeesForProofs: mock(() => initOp.amount),
        receive: mockWalletReceive,
      },
    }));

    expect(service.prepare(initOp)).rejects.toThrow(ProofValidationError);
  });

  it('prepare throws ProofValidationError when fees exceed the amount', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const initOp = await service.init(token);

    (walletService.getWalletWithActiveKeysetId as Mock<any>).mockImplementation(async () => ({
      wallet: {
        unit: 'sat',
        getFeesForProofs: mock(() => initOp.amount.add(Amount.from(1))),
        receive: mockWalletReceive,
      },
    }));

    try {
      await service.prepare(initOp);
      throw new Error('Expected prepare to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ProofValidationError);
      expect((error as Error).message).toBe('Receive amount is not sufficient after fees');
    }
  });

  it('prepare throws when deterministic outputs are empty', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const initOp = await service.init(token);

    (proofService.createOutputsAndIncrementCounters as Mock<any>).mockImplementation(async () => ({
      keep: [],
      send: [],
    }));

    expect(service.prepare(initOp)).rejects.toThrow('Failed to create deterministic outputs');
  });

  it('execute throws when outputData is missing', async () => {
    const proofs = [makeProof('p1')];
    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);
    const brokenPrepared = {
      ...prepared,
      outputData: undefined,
    } as unknown as PreparedReceiveOperation;
    await receiveOpRepo.update(brokenPrepared as unknown as ReceiveOperation);

    expect(service.execute(prepared)).rejects.toThrow('Missing output data');
  });

  it('rolls back executing receive operations on terminal NUT-03 mint errors', async () => {
    const proofs = [makeProof('p1')];
    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);
    let rolledBackEvent: CoreEvents['receive-op:rolled-back'] | undefined;

    eventBus.on('receive-op:rolled-back', (payload) => {
      rolledBackEvent = payload;
    });

    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(11001, 'Proofs already spent');
    });

    await expect(service.execute(prepared)).rejects.toThrow('Proofs already spent');

    const stored = await receiveOpRepo.getById(prepared.id);
    expect(stored?.state).toBe('rolled_back');
    expect(stored?.error).toBe('Proofs already spent');
    expect(rolledBackEvent?.operation.state).toBe('rolled_back');
    expect((proofService.saveProofs as Mock<any>).mock.calls.length).toBe(0);
  });

  it('rolls back executing receive operations on terminal NUT-03 keyset errors', async () => {
    const proofs = [makeProof('p1')];
    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);

    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(12001, 'Keyset is not known');
    });

    await expect(service.execute(prepared)).rejects.toThrow('Keyset is not known');

    const stored = await receiveOpRepo.getById(prepared.id);
    expect(stored?.state).toBe('rolled_back');
    expect(stored?.error).toBe('Keyset is not known');
  });

  it('rolls back executing receive operations on generic mint protocol errors', async () => {
    const proofs = [makeProof('p1')];
    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);

    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(0, 'Keyset unknown');
    });

    await expect(service.execute(prepared)).rejects.toThrow('Keyset unknown');

    const stored = await receiveOpRepo.getById(prepared.id);
    expect(stored?.state).toBe('rolled_back');
    expect(stored?.error).toBe('Keyset unknown');
  });

  it('updates receive history to rolled_back on generic mint protocol errors', async () => {
    const proofs = [makeProof('p1')];
    const historyRepo = new MemoryHistoryRepository({
      receiveOperationRepository: receiveOpRepo,
    });
    new HistoryService(historyRepo, eventBus);

    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);

    expect(await historyRepo.getReceiveHistoryEntry(mintUrl, prepared.id)).toBeNull();

    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(0, 'Keyset unknown');
    });

    await expect(service.execute(prepared)).rejects.toThrow('Keyset unknown');

    const historyEntry = await historyRepo.getReceiveHistoryEntry(mintUrl, prepared.id);
    expect(historyEntry?.state).toBe('rolled_back');
    expect(historyEntry?.amount).toEqual(prepared.amount);
  });

  it('keeps executing when receive fails with recovery-sensitive outputs already signed', async () => {
    const proofs = [makeProof('p1')];
    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);

    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(11003, 'Outputs already signed');
    });

    await expect(service.execute(prepared)).rejects.toThrow('Outputs already signed');

    const stored = await receiveOpRepo.getById(prepared.id);
    expect(stored?.state).toBe('executing');
  });

  for (const { code, message } of [
    { code: 11002, message: 'Proofs are pending' },
    { code: 11004, message: 'Outputs are pending' },
  ]) {
    it(`rolls back when receive fails with non-spendable NUT-03 state ${code}`, async () => {
      const proofs = [makeProof('p1')];
      const initOp = await service.init({ mint: mintUrl, proofs } as Token);
      const prepared = await service.prepare(initOp);

      mockWalletReceive.mockImplementation(async () => {
        throw new MintOperationError(code, message);
      });

      await expect(service.execute(prepared)).rejects.toThrow(message);

      const stored = await receiveOpRepo.getById(prepared.id);
      expect(stored?.state).toBe('rolled_back');
      expect(stored?.error).toBe(message);
    });
  }

  it('keeps executing on local validation failures after the mint call', async () => {
    const proofs = [makeProof('p1')];
    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);

    mockWalletReceive.mockImplementation(async () => {
      throw new ProofValidationError('Invalid signature in receive response');
    });

    await expect(service.execute(prepared)).rejects.toThrow(
      'Invalid signature in receive response',
    );

    const stored = await receiveOpRepo.getById(prepared.id);
    expect(stored?.state).toBe('executing');
  });

  it('keeps executing on transient receive failures', async () => {
    const proofs = [makeProof('p1')];
    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);

    mockWalletReceive.mockImplementation(async () => {
      throw new NetworkError('network timeout');
    });

    await expect(service.execute(prepared)).rejects.toThrow('network timeout');

    const stored = await receiveOpRepo.getById(prepared.id);
    expect(stored?.state).toBe('executing');
  });

  it('finalize is idempotent on an already finalized operation', async () => {
    const proofs = [makeProof('p1')];
    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);
    const executing = {
      ...prepared,
      state: 'executing',
      updatedAt: Date.now(),
    } as ReceiveOperation;
    await receiveOpRepo.update(executing);

    const outputSecrets = getOutputProofSecrets(executing as PreparedReceiveOperation);
    const savedProofs: CoreProof[] = outputSecrets.map((secret) => ({
      id: keysetId,
      amount: Amount.from(1),
      secret,
      C: `C_${secret}`,
      mintUrl,
      unit: 'sat',
      state: 'ready',
      createdByOperationId: executing.id,
    }));
    await proofRepo.saveProofs(mintUrl, savedProofs);

    await service.finalize(executing.id);
    await service.finalize(executing.id);

    const stored = await receiveOpRepo.getById(executing.id);
    expect(stored?.state).toBe('finalized');
  });

  it('uses batched proof lookup when checking whether outputs were already saved', async () => {
    const proofs = [makeProof('p1')];
    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);
    const executing = {
      ...prepared,
      state: 'executing',
      updatedAt: Date.now(),
    } as ReceiveOperation;
    await receiveOpRepo.update(executing);

    const outputSecrets = getOutputProofSecrets(executing as PreparedReceiveOperation);
    const savedProofs: CoreProof[] = outputSecrets.map((secret) => ({
      id: keysetId,
      amount: Amount.from(1),
      secret,
      C: `C_${secret}`,
      mintUrl,
      unit: 'sat',
      state: 'ready',
      createdByOperationId: executing.id,
    }));
    await proofRepo.saveProofs(mintUrl, savedProofs);

    const batchLookup = mock(proofRepo.getProofsBySecrets.bind(proofRepo));
    proofRepo.getProofsBySecrets = batchLookup;
    proofRepo.getProofBySecret = mock(async () => {
      throw new Error('expected batched proof lookup');
    });

    await service.finalize(executing.id);

    expect(batchLookup).toHaveBeenCalledTimes(1);
    expect(batchLookup).toHaveBeenCalledWith(mintUrl, outputSecrets);
    expect((await receiveOpRepo.getById(executing.id))?.state).toBe('finalized');
  });

  it('finalize throws when operation is not executing', async () => {
    const proofs = [makeProof('p1')];
    const initOp = await service.init({ mint: mintUrl, proofs } as Token);
    const prepared = await service.prepare(initOp);

    expect(service.finalize(prepared.id)).rejects.toThrow('Cannot finalize operation');
  });
});
