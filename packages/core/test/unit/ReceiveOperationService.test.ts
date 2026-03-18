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
import type { ProofService } from '../../services/ProofService';
import { TokenService } from '../../services/TokenService';
import type { WalletService } from '../../services/WalletService';
import { OutputData, type Proof, type Token } from '@cashu/cashu-ts';
import { ProofValidationError, UnknownMintError } from '../../models/Error';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { getOutputProofSecrets } from '../../operations/receive/ReceiveOperation';
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
    (mintUrl: string) => Promise<{ mint: { url: string }; keysets: { id: string }[] }>
  >;

  const makeProof = (secret: string): Proof =>
    ({
      id: keysetId,
      amount: 10,
      secret,
      C: `C_${secret}`,
    }) as Proof;

  const makeOutputData = (secrets: string[]): OutputData[] =>
    secrets.map(
      (secret) =>
        new OutputData(
          { amount: 10, id: keysetId, B_: `B_${secret}` },
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
          getFeesForProofs: mock(() => 0),
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

    let eventPayload: CoreEvents['receive:created'] | undefined;
    eventBus.on('receive:created', (payload) => {
      eventPayload = payload;
    });

    await service.receive(token);

    const finalized = await receiveOpRepo.getByState('finalized');
    expect(finalized.length).toBe(1);
    const op = finalized[0] as FinalizedReceiveOperation;

    expect(op?.mintUrl).toBe(mintUrl);
    expect(op?.amount).toBe(20);
    expect(op?.outputData).toBeDefined();
    expect(eventPayload?.mintUrl).toBe(mintUrl);
    expect(eventPayload?.token.proofs.length).toBe(2);
  });

  it('prepare() persists outputData and fee', async () => {
    const proofs = [makeProof('p1')];
    const token: Token = { mint: mintUrl, proofs } as Token;

    const initOp = await service.init(token);
    const prepared = await service.prepare(initOp);

    expect(prepared.state).toBe('prepared');
    expect(prepared.fee).toBe(0);
    expect(prepared.outputData).toBeDefined();
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
    const zeroProof = { ...makeProof('p1'), amount: 0 } as Proof;
    const token: Token = { mint: mintUrl, proofs: [zeroProof] } as Token;

    expect(service.init(token)).rejects.toThrow(ProofValidationError);
  });

  it('prepare throws when operation has no input proofs', async () => {
    const initOp: InitReceiveOperation = {
      id: 'empty-op',
      state: 'init',
      mintUrl,
      amount: 0,
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
      amount: 1,
      secret,
      C: `C_${secret}`,
      mintUrl,
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
      amount: 1,
      secret,
      C: `C_${secret}`,
      mintUrl,
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
