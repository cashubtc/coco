import { Amount, OutputData, type Proof, type Token } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import type {
  DeferredReceiveOperation,
  InitReceiveOperation,
} from '../../operations/receive/ReceiveOperation';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import { TokenService } from '../../services/TokenService';
import type { WalletService } from '../../services/WalletService';
import type { CoreProof } from '../../types';
import { KeyPairNotFoundError, MintOperationError, NetworkError } from '../../models/Error';
import { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository';
import { MemoryReceiveOperationRepository } from '../../repositories/memory/MemoryReceiveOperationRepository';

describe('ReceiveOperationService - redeemDeferred', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const decoder = new TextDecoder();

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
  let mockGetFees: Mock<(proofs: Proof[]) => Amount>;
  let mockCheckProofStates: Mock<(mintUrl: string, ys: string[]) => Promise<{ state: string }[]>>;
  let savedProofBatches: { mintUrl: string; proofs: CoreProof[] }[];
  let outputCounter: number;

  const makeProof = (secret: string, amount = 1): Proof =>
    ({
      id: keysetId,
      amount: Amount.from(amount),
      secret,
      C: `C_${secret}`,
    }) as Proof;

  const makeOutput = (secret: string, amount: Amount): OutputData =>
    new OutputData(
      { amount, id: keysetId, B_: `B_${secret}` },
      BigInt(1),
      new TextEncoder().encode(secret),
    );

  const makeDeferredOp = (
    id: string,
    amount: number,
    reason: DeferredReceiveOperation['deferredReason'] = 'dust',
  ): DeferredReceiveOperation => ({
    id,
    state: 'deferred',
    deferredReason: reason,
    mintUrl,
    unit: 'sat',
    amount: Amount.from(amount),
    inputProofs: [makeProof(`${id}-input`, amount)],
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
  });

  beforeEach(() => {
    receiveOpRepo = new MemoryReceiveOperationRepository();
    proofRepo = new MemoryProofRepository();
    eventBus = new EventBus<CoreEvents>();
    savedProofBatches = [];
    outputCounter = 0;

    // Echo the custom output data back as freshly signed proofs so the split
    // by output secret can be asserted.
    mockWalletReceive = mock(
      async (_token: unknown, _config: unknown, outputType: { data: OutputData[] }) =>
        outputType.data.map(
          (output) =>
            ({
              id: keysetId,
              amount: output.blindedMessage.amount,
              secret: decoder.decode(output.secret),
              C: `C_${decoder.decode(output.secret)}`,
            }) as Proof,
        ),
    );
    mockGetFees = mock(() => Amount.from(1));
    mockCheckProofStates = mock(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'UNSPENT' })),
    );

    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({
        wallet: {
          unit: 'sat',
          getFeesForProofs: mockGetFees,
          receive: mockWalletReceive,
        },
      })),
    } as unknown as WalletService;

    proofService = {
      prepareProofsForReceiving: mock(async (proofs: Proof[]) => proofs),
      createOutputsAndIncrementCounters: mock(
        async (_mintUrl: string, intents: { keep: { amount: Amount } }) => ({
          keep: [makeOutput(`out-${outputCounter++}`, intents.keep.amount)],
          send: [],
        }),
      ),
      saveProofs: mock(async (targetMintUrl: string, proofs: CoreProof[]) => {
        savedProofBatches.push({ mintUrl: targetMintUrl, proofs });
        await proofRepo.saveProofs(targetMintUrl, proofs);
      }),
      recoverProofsFromOutputData: mock(async () => []),
    } as unknown as ProofService;

    mintAdapter = { checkProofStates: mockCheckProofStates } as unknown as MintAdapter;

    mintService = {
      isTrustedMint: mock(async () => true),
      ensureUpdatedMint: mock(async () => ({
        mint: { url: mintUrl },
        keysets: [{ id: keysetId }],
      })),
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

  it('settles a queued dust op together with an incoming receive in one swap', async () => {
    // The issue #46 scenario: 1 sat queued dust + incoming 32 sat, fee 1.
    await receiveOpRepo.create(makeDeferredOp('op-dust', 1));
    const finalizedEvents: CoreEvents['receive-op:finalized'][] = [];
    eventBus.on('receive-op:finalized', (payload) => {
      finalizedEvents.push(payload);
    });

    const proofs = [makeProof('incoming-input', 32)];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const initOp = (await service.init(token)) as InitReceiveOperation;
    const result = await service.redeemDeferredGroup(mintUrl, 'sat', initOp);

    expect(result?.state).toBe('finalized');
    if (result?.state !== 'finalized') {
      throw new Error('Expected finalized incoming operation');
    }
    expect(result.amount).toEqual(Amount.from(32));
    expect(mockWalletReceive).toHaveBeenCalledTimes(1);

    const dust = await receiveOpRepo.getById('op-dust');
    expect(dust?.state).toBe('finalized');
    if (dust?.state === 'finalized') {
      // Fee is charged to the largest member; dust keeps its full value.
      expect(dust.fee).toEqual(Amount.from(0));
    }
    expect(result.fee).toEqual(Amount.from(1));
    expect(dust?.batchId).toBeDefined();
    expect(dust?.batchId).toBe(result.batchId!);

    expect(finalizedEvents.length).toBe(2);

    // Each member's new proofs are attributed to its own operation.
    const dustBatch = savedProofBatches.find((batch) =>
      batch.proofs.some((proof) => proof.createdByOperationId === 'op-dust'),
    );
    const incomingBatch = savedProofBatches.find((batch) =>
      batch.proofs.some((proof) => proof.createdByOperationId === result.id),
    );
    expect(dustBatch?.proofs[0]?.amount).toEqual(Amount.from(1));
    expect(incomingBatch?.proofs[0]?.amount).toEqual(Amount.from(31));
  });

  it('defers the incoming receive too when the combined group stays below the fee', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-dust', 1));
    mockGetFees.mockImplementation(() => Amount.from(2));

    const proofs = [makeProof('incoming-input', 1)];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const initOp = (await service.init(token)) as InitReceiveOperation;
    const result = await service.redeemDeferredGroup(mintUrl, 'sat', initOp);

    expect(result?.state).toBe('deferred');
    if (result?.state === 'deferred') {
      expect(result.deferredReason).toBe('dust');
    }
    expect((await receiveOpRepo.getById('op-dust'))?.state).toBe('deferred');
    expect(mockWalletReceive).not.toHaveBeenCalled();
  });

  it('redeems a viable deferred group from the sweep without an incoming receive', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-a', 5));
    await receiveOpRepo.create(makeDeferredOp('op-b', 4));

    await service.redeemDeferred();

    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('finalized');
    expect((await receiveOpRepo.getById('op-b'))?.state).toBe('finalized');
    expect(mockWalletReceive).toHaveBeenCalledTimes(1);
  });

  it('keeps p2pk members with missing keys out of the batch', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-a', 5));
    await receiveOpRepo.create(makeDeferredOp('op-p2pk', 4, 'p2pk-unsigned'));
    (proofService.prepareProofsForReceiving as Mock<any>).mockImplementation(async () => {
      throw new KeyPairNotFoundError('02abc');
    });

    await service.redeemDeferred();

    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('finalized');
    const p2pk = await receiveOpRepo.getById('op-p2pk');
    expect(p2pk?.state).toBe('deferred');
    if (p2pk?.state === 'deferred') {
      expect(p2pk.deferredReason).toBe('p2pk-unsigned');
    }
  });

  it('re-signs p2pk members once the key is available', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-p2pk', 4, 'p2pk-unsigned'));
    const signed = [makeProof('op-p2pk-signed', 4)];
    (proofService.prepareProofsForReceiving as Mock<any>).mockImplementation(async () => signed);

    await service.redeemDeferred();

    const op = await receiveOpRepo.getById('op-p2pk');
    expect(op?.state).toBe('finalized');
    expect(op?.inputProofs).toEqual(signed);
  });

  it('keeps members executing when the batched swap fails transiently', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-a', 5));
    await receiveOpRepo.create(makeDeferredOp('op-b', 4));
    mockWalletReceive.mockImplementation(async () => {
      throw new NetworkError('network timeout');
    });

    await service.redeemDeferred();

    const a = await receiveOpRepo.getById('op-a');
    const b = await receiveOpRepo.getById('op-b');
    expect(a?.state).toBe('executing');
    expect(b?.state).toBe('executing');
    expect(a?.batchId).toBe(b?.batchId!);
  });

  it('returns unspent members to the queue on a terminal mint error', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-healthy', 5, 'mint-unreachable'));
    await receiveOpRepo.create(makeDeferredOp('op-poisoned', 4));
    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(11001, 'Proofs already spent');
    });
    // The poisoned member's inputs are spent at the mint, the healthy one's are not.
    let firstMember = true;
    mockCheckProofStates.mockImplementation(async (_mintUrl: string, ys: string[]) => {
      const state = firstMember ? 'UNSPENT' : 'SPENT';
      firstMember = false;
      return ys.map(() => ({ state }));
    });

    await service.redeemDeferred();

    const healthy = await receiveOpRepo.getById('op-healthy');
    expect(healthy?.state).toBe('deferred');
    if (healthy?.state === 'deferred') {
      expect(healthy.deferredReason).toBe('mint-unreachable');
    }
    // Spent member with no recoverable outputs rolls back.
    expect((await receiveOpRepo.getById('op-poisoned'))?.state).toBe('rolled_back');
  });

  it('finalizes zero-keep members without saving proofs', async () => {
    // Two 1-sat dust ops with a combined fee of 1: one member keeps zero.
    await receiveOpRepo.create(makeDeferredOp('op-a', 1));
    await receiveOpRepo.create(makeDeferredOp('op-b', 1));

    await service.redeemDeferred();

    const a = await receiveOpRepo.getById('op-a');
    const b = await receiveOpRepo.getById('op-b');
    expect(a?.state).toBe('finalized');
    expect(b?.state).toBe('finalized');

    const zeroKeep = [a, b].find(
      (op) => op?.state === 'finalized' && op.fee.equals(Amount.from(1)),
    );
    expect(zeroKeep).toBeDefined();
    const zeroKeepProofs = savedProofBatches.filter((batch) =>
      batch.proofs.some((proof) => proof.createdByOperationId === zeroKeep!.id),
    );
    expect(zeroKeepProofs.length).toBe(0);
  });

  it('receive() drains the queue by batching with the incoming token', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-dust', 1));

    const proofs = [makeProof('incoming-input', 32)];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const result = await service.receive(token);

    expect(result.state).toBe('finalized');
    expect(result.batchId).toBeDefined();
    expect((await receiveOpRepo.getById('op-dust'))?.state).toBe('finalized');
    expect(mockWalletReceive).toHaveBeenCalledTimes(1);
  });

  it('receive() defers the incoming token when the drained group is still dust', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-dust', 1));
    mockGetFees.mockImplementation(() => Amount.from(2));

    const proofs = [makeProof('incoming-input', 1)];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const result = await service.receive(token);

    expect(result.state).toBe('deferred');
    expect((await receiveOpRepo.getById('op-dust'))?.state).toBe('deferred');
  });

  it('receive() takes the solo path when the queue is empty', async () => {
    let preparedEventCount = 0;
    eventBus.on('receive-op:prepared', () => {
      preparedEventCount += 1;
    });
    mockGetFees.mockImplementation(() => Amount.zero());

    const proofs = [makeProof('incoming-input', 32)];
    const token: Token = { mint: mintUrl, proofs } as Token;
    const result = await service.receive(token);

    expect(result.state).toBe('finalized');
    expect(result.batchId).toBeUndefined();
    // The solo saga emits receive-op:prepared; the batch path does not.
    expect(preparedEventCount).toBe(1);
  });

  it('recovery sweep redeems viable queued groups and leaves unreachable ones queued', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-a', 5));
    await receiveOpRepo.create(makeDeferredOp('op-b', 4));

    await service.recoverPendingOperations();

    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('finalized');
    expect((await receiveOpRepo.getById('op-b'))?.state).toBe('finalized');
  });

  it('recovery sweep tolerates an unreachable mint', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-a', 5));
    (walletService.getWalletWithActiveKeysetId as Mock<any>).mockImplementation(async () => {
      throw new NetworkError('offline');
    });

    await service.recoverPendingOperations();

    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('deferred');
  });

  it('skips deferred operations that are currently locked', async () => {
    await receiveOpRepo.create(makeDeferredOp('op-a', 5));
    await receiveOpRepo.create(makeDeferredOp('op-busy', 4));
    const release = await (
      service as unknown as {
        acquireOperationLock: (id: string) => Promise<() => void>;
      }
    ).acquireOperationLock('op-busy');

    try {
      await service.redeemDeferred();
    } finally {
      release();
    }

    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('finalized');
    expect((await receiveOpRepo.getById('op-busy'))?.state).toBe('deferred');
  });
});
