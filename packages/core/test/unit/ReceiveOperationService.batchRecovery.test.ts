import { Amount, type Proof } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import type { ExecutingReceiveOperation } from '../../operations/receive/ReceiveOperation';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import { TokenService } from '../../services/TokenService';
import type { WalletService } from '../../services/WalletService';
import type { CoreProof } from '../../types';
import { MintOperationError } from '../../models/Error';
import { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository';
import { MemoryReceiveOperationRepository } from '../../repositories/memory/MemoryReceiveOperationRepository';

describe('ReceiveOperationService - batch recovery', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const batchId = 'batch-1';
  const decoder = new TextDecoder();

  let receiveOpRepo: MemoryReceiveOperationRepository;
  let proofRepo: MemoryProofRepository;
  let proofService: ProofService;
  let walletService: WalletService;
  let mintAdapter: MintAdapter;
  let eventBus: EventBus<CoreEvents>;
  let service: ReceiveOperationService;

  let mockWalletReceive: Mock<(...args: any[]) => Promise<Proof[]>>;
  let mockCheckProofStates: Mock<(mintUrl: string, ys: string[]) => Promise<{ state: string }[]>>;

  const makeProof = (secret: string, amount = 1): Proof =>
    ({
      id: keysetId,
      amount: Amount.from(amount),
      secret,
      C: `C_${secret}`,
    }) as Proof;

  const makeSerializedOutputs = (secrets: string[], amount = 1) => ({
    keep: secrets.map((secret) => ({
      blindedMessage: { amount, id: keysetId, B_: `B_${secret}` },
      blindingFactor: '1234567890abcdef',
      secret: Buffer.from(secret).toString('hex'),
    })),
    send: [],
  });

  const makeBatchMember = (
    id: string,
    amount: number,
    fee: number,
    keepSecrets: string[],
  ): ExecutingReceiveOperation =>
    ({
      id,
      state: 'executing',
      mintUrl,
      unit: 'sat',
      amount: Amount.from(amount),
      inputProofs: [makeProof(`${id}-input`, amount)],
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
      fee: Amount.from(fee),
      outputData: makeSerializedOutputs(keepSecrets, amount - fee),
      batchId,
    }) as ExecutingReceiveOperation;

  beforeEach(() => {
    receiveOpRepo = new MemoryReceiveOperationRepository();
    proofRepo = new MemoryProofRepository();
    eventBus = new EventBus<CoreEvents>();

    mockWalletReceive = mock(
      async (_token: unknown, _config: unknown, outputType: { data: { secret: Uint8Array }[] }) =>
        outputType.data.map(
          (output, i) =>
            ({
              id: keysetId,
              amount: Amount.from(1),
              secret: decoder.decode(output.secret),
              C: `C_recovered_${i}`,
            }) as Proof,
        ),
    );

    mockCheckProofStates = mock(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'UNSPENT' })),
    );

    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({
        wallet: {
          unit: 'sat',
          getFeesForProofs: mock(() => Amount.from(1)),
          receive: mockWalletReceive,
        },
      })),
    } as unknown as WalletService;

    let sweepOutputCounter = 0;
    proofService = {
      prepareProofsForReceiving: mock(async (proofs: Proof[]) => proofs),
      createOutputsAndIncrementCounters: mock(async () => ({
        keep: [
          {
            blindedMessage: { amount: Amount.from(1), id: keysetId, B_: 'B_sweep' },
            blindingFactor: BigInt(1),
            secret: new TextEncoder().encode(`sweep-out-${sweepOutputCounter++}`),
          },
        ],
        send: [],
      })),
      saveProofs: mock(async (targetMintUrl: string, proofs: CoreProof[]) => {
        await proofRepo.saveProofs(targetMintUrl, proofs);
      }),
      recoverProofsFromOutputData: mock(async () => []),
    } as unknown as ProofService;

    mintAdapter = { checkProofStates: mockCheckProofStates } as unknown as MintAdapter;

    const mintService = {} as MintService;
    service = new ReceiveOperationService(
      receiveOpRepo,
      proofRepo,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      new TokenService(mintService),
      eventBus,
    );
  });

  it('re-executes the combined swap when all batch inputs are unspent', async () => {
    await receiveOpRepo.create(makeBatchMember('op-a', 5, 1, ['a-out']));
    await receiveOpRepo.create(makeBatchMember('op-b', 4, 0, ['b-out']));

    await service.recoverPendingOperations();

    expect(mockWalletReceive).toHaveBeenCalledTimes(1);
    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('finalized');
    expect((await receiveOpRepo.getById('op-b'))?.state).toBe('finalized');

    const savedA = await proofRepo.getProofsByOperationId(mintUrl, 'op-a');
    const savedB = await proofRepo.getProofsByOperationId(mintUrl, 'op-b');
    expect(savedA.map((proof) => proof.secret)).toEqual(['a-out']);
    expect(savedB.map((proof) => proof.secret)).toEqual(['b-out']);
  });

  it('restores each member from its own outputData when all inputs are spent', async () => {
    await receiveOpRepo.create(makeBatchMember('op-a', 5, 1, ['a-out']));
    await receiveOpRepo.create(makeBatchMember('op-b', 4, 0, ['b-out']));
    mockCheckProofStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'SPENT' })),
    );
    (proofService.recoverProofsFromOutputData as Mock<any>).mockImplementation(
      async (
        targetMintUrl: string,
        outputData: { keep: { secret: string }[] },
        options: { createdByOperationId: string },
      ) => {
        const proofs = outputData.keep.map((output) => ({
          id: keysetId,
          amount: Amount.from(1),
          secret: decoder.decode(Buffer.from(output.secret, 'hex')),
          C: 'C_restored',
          mintUrl: targetMintUrl,
          unit: 'sat',
          state: 'ready',
          createdByOperationId: options.createdByOperationId,
        }));
        await proofRepo.saveProofs(targetMintUrl, proofs as CoreProof[]);
        return proofs;
      },
    );

    await service.recoverPendingOperations();

    expect(mockWalletReceive).not.toHaveBeenCalled();
    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('finalized');
    expect((await receiveOpRepo.getById('op-b'))?.state).toBe('finalized');
  });

  it('rolls back spent members whose outputs cannot be recovered', async () => {
    await receiveOpRepo.create(makeBatchMember('op-a', 5, 1, ['a-out']));
    mockCheckProofStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'SPENT' })),
    );

    await service.recoverPendingOperations();

    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('rolled_back');
  });

  it('finalizes zero-keep members when the batch inputs are spent', async () => {
    await receiveOpRepo.create(makeBatchMember('op-zero', 1, 1, []));
    mockCheckProofStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'SPENT' })),
    );

    await service.recoverPendingOperations();

    expect((await receiveOpRepo.getById('op-zero'))?.state).toBe('finalized');
  });

  it('requeues unspent members when another member was spent externally', async () => {
    await receiveOpRepo.create(makeBatchMember('op-doublespent', 4, 0, ['ds-out']));
    await receiveOpRepo.create(makeBatchMember('op-survivor', 5, 1, ['sv-out']));
    // op-doublespent's inputs are gone (sender reclaimed them); the survivor's
    // inputs are untouched.
    mockCheckProofStates.mockImplementation(async (_mintUrl: string, ys: string[]) => {
      // Member input secrets are 'op-doublespent-input' / 'op-survivor-input';
      // checkProofStatesWithMint hashes them, so track call order instead:
      // members are processed in sorted id order (doublespent first).
      const call = mockCheckProofStates.mock.calls.length;
      const state = call <= 1 ? 'SPENT' : 'UNSPENT';
      return ys.map(() => ({ state }));
    });

    await service.recoverPendingOperations();

    expect((await receiveOpRepo.getById('op-doublespent'))?.state).toBe('rolled_back');
    // The survivor returns to the queue and the sweep at the end of the
    // recovery run re-redeems it in a fresh batch.
    const survivor = await receiveOpRepo.getById('op-survivor');
    expect(survivor?.state).toBe('finalized');
    expect(survivor?.batchId).toBeDefined();
    expect(survivor?.batchId).not.toBe(batchId);
  });

  it('requeues all members when re-execution fails terminally', async () => {
    await receiveOpRepo.create(makeBatchMember('op-a', 5, 1, ['a-out']));
    await receiveOpRepo.create(makeBatchMember('op-b', 4, 0, ['b-out']));
    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(11001, 'Transaction inputs do not balance');
    });

    await service.recoverPendingOperations();

    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('deferred');
    expect((await receiveOpRepo.getById('op-b'))?.state).toBe('deferred');
  });

  it('leaves members executing when the mint is unreachable', async () => {
    await receiveOpRepo.create(makeBatchMember('op-a', 5, 1, ['a-out']));
    mockCheckProofStates.mockImplementation(async () => {
      throw new Error('Network timeout');
    });

    await service.recoverPendingOperations();

    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('executing');
  });

  it('never solo-re-executes a batch member through recoverExecutingOperation', async () => {
    const member = makeBatchMember('op-a', 5, 1, ['a-out']);
    await receiveOpRepo.create(member);

    await service.recoverExecutingOperation(member);

    expect(mockWalletReceive).not.toHaveBeenCalled();
    expect((await receiveOpRepo.getById('op-a'))?.state).toBe('executing');
  });
});
