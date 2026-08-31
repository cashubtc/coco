import { Amount } from '@cashu/cashu-ts';
import type {
  InitReceiveOperation,
  PreparedReceiveOperation,
  ExecutingReceiveOperation,
} from '../../operations/receive/ReceiveOperation';
import { getOutputProofSecrets } from '../../operations/receive/ReceiveOperation';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { MintService } from '../../services/MintService';
import { TokenService } from '../../services/TokenService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { ProofState as CashuProofState, Proof } from '@cashu/cashu-ts';
import { MintOperationError, ProofValidationError } from '../../models/Error';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { ReceiveOpsApi } from '../../api/ReceiveOpsApi.ts';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository';
import { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService';
import { MemoryReceiveOperationRepository } from '../../repositories/memory/MemoryReceiveOperationRepository';
import type { ReceiveTransactions } from '../../transactions/receive/ReceiveTransactions.ts';
import type { SeedService } from '../../services/SeedService.ts';

describe('ReceiveOperationService - recoverPendingOperations', () => {
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
  let api: ReceiveOpsApi;
  let transactions: ReceiveTransactions;

  let mockCheckProofsStates: Mock<(mintUrl: string, ys: string[]) => Promise<CashuProofState[]>>;
  let mockWalletReceive: Mock<(...args: any[]) => Promise<Proof[]>>;

  const makeProof = (secret: string): Proof =>
    ({
      id: keysetId,
      amount: Amount.from(10),
      secret,
      C: `C_${secret}`,
    }) as Proof;

  const makeOutputData = (secrets: string[]) => {
    const mockKeepOutputs = secrets.map((secret) => ({
      blindedMessage: { amount: 10, id: keysetId, B_: `B_${secret}` },
      blindingFactor: '1234567890abcdef',
      secret: Buffer.from(secret).toString('hex'),
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
    unit: 'sat',
    amount: Amount.sum(proofs.map((proof) => proof.amount)),
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
    unit: 'sat',
    amount: Amount.sum(proofs.map((proof) => proof.amount)),
    inputProofs: proofs,
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    fee: Amount.from(1),
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
    mockCheckProofsStates = mock(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'UNSPENT' }) as CashuProofState),
    );
    mintAdapter = { checkProofStates: mockCheckProofsStates } as unknown as MintAdapter;
    mockWalletReceive = mock(async () => [makeProof('r1')]);

    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({
        wallet: {
          unit: 'sat',
          receive: mockWalletReceive,
        },
      })),
    } as unknown as WalletService;

    proofService = {
      observeRestoreProofsFromOutputData: mock(async () => ({
        status: 'none',
        expectedOutputCount: 1,
        restoredProofs: [],
        unspentProofs: [],
      })),
    } as unknown as ProofService;

    mintService = {} as MintService;

    tokenService = new TokenService(mintService);

    transactions = {
      prepare: async () => {
        throw new Error('Unexpected Receive preparation');
      },
      beginExecution: async () => {
        throw new Error('Unexpected normal Receive execution');
      },
      applyResult: async ({ operationId, expectedRevision, updatedAt, proofs }) => {
        const current = await receiveOpRepo.getById(operationId);
        if (!current) throw new Error('Receive operation not found');
        if (current.state === 'finalized') {
          return { operation: current, savedProofs: [], committed: false };
        }
        if (current.state !== 'executing') throw new Error('Receive operation not executing');
        const existing = await proofRepo.getProofsBySecrets(
          current.mintUrl,
          proofs.map((proof) => proof.secret),
        );
        const existingSecrets = new Set(existing.map((proof) => proof.secret));
        const missing = proofs.filter((proof) => !existingSecrets.has(proof.secret));
        if (missing.length > 0) await proofRepo.saveProofs(current.mintUrl, missing);
        const finalized = {
          ...current,
          state: 'finalized' as const,
          revision: expectedRevision + 1,
          updatedAt,
        };
        if (
          !(await receiveOpRepo.transition({
            operationId,
            expectedState: 'executing',
            expectedRevision,
            next: finalized,
          }))
        ) {
          throw new Error('Receive result conflict');
        }
        return { operation: finalized, savedProofs: missing, committed: true };
      },
      failExecution: async ({ operationId, expectedRevision, updatedAt, error }) => {
        const current = await receiveOpRepo.getById(operationId);
        if (!current) throw new Error('Receive operation not found');
        if (current.state === 'rolled_back') {
          return { operation: current, committed: false };
        }
        if (current.state !== 'executing') throw new Error('Receive operation not executing');
        const rolledBack = {
          ...current,
          state: 'rolled_back' as const,
          revision: expectedRevision + 1,
          updatedAt,
          error,
        };
        if (
          !(await receiveOpRepo.transition({
            operationId,
            expectedState: 'executing',
            expectedRevision,
            next: rolledBack,
          }))
        ) {
          throw new Error('Receive failure conflict');
        }
        return { operation: rolledBack, committed: true };
      },
      cancelPrepared: async () => {
        throw new Error('Unexpected Receive cancellation');
      },
      deleteLegacyInit: (operationId) => receiveOpRepo.delete(operationId),
    };
    service = new ReceiveOperationService({
      operationQueries: receiveOpRepo,
      proofQueries: proofRepo,
      transactions,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      tokenService,
      seedService: { getSeed: async () => new Uint8Array(64) } as SeedService,
      eventBus,
    });
    api = new ReceiveOpsApi(service);
  });

  it('cleans up init operations', async () => {
    const proofs = [makeProof('p1')];
    const op = makeInitOp('init-op', proofs);
    await receiveOpRepo.create(op);

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored).toBe(null);
  });

  it('leaves prepared operations unchanged for manual rollback', async () => {
    const proofs = [makeProof('p1')];
    const op = makePreparedOp('prepared-op', proofs);
    await receiveOpRepo.create(op);

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('prepared');
  });

  it('retries executing operations when all inputs are unspent', async () => {
    const proofs = [makeProof('p1'), makeProof('p2')];
    const op = makeExecutingOp('exec-op', proofs);
    await receiveOpRepo.create(op);

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('finalized');
    expect(mockWalletReceive.mock.calls.length).toBe(1);
    expect(await proofRepo.getProofBySecret(mintUrl, 'r1')).not.toBeNull();
    expect((proofService.observeRestoreProofsFromOutputData as Mock<any>).mock.calls.length).toBe(
      0,
    );
    expect(mockWalletReceive.mock.calls[0]?.[0]?.proofs).toEqual(proofs);
    expect(mockWalletReceive.mock.calls[0]?.[2]?.data).toHaveLength(1);
  });

  it('does not replay a finalized Receive during a repeated recovery sweep', async () => {
    const op = makeExecutingOp('exec-op-repeat', [makeProof('p1')]);
    await receiveOpRepo.create(op);

    await service.recoverPendingOperations();
    await service.recoverPendingOperations();

    expect((await receiveOpRepo.getById(op.id))?.state).toBe('finalized');
    expect(mockWalletReceive).toHaveBeenCalledTimes(1);
  });

  it('converges concurrent recovery from independent service instances', async () => {
    const op = makeExecutingOp('exec-op-concurrent', [makeProof('p1')]);
    await receiveOpRepo.create(op);
    const otherService = new ReceiveOperationService({
      operationQueries: receiveOpRepo,
      proofQueries: proofRepo,
      transactions,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      tokenService,
      seedService: { getSeed: async () => new Uint8Array(64) } as SeedService,
      eventBus,
    });

    await Promise.all([
      service.recoverExecutingOperation(op),
      otherService.recoverExecutingOperation(op),
    ]);

    expect((await receiveOpRepo.getById(op.id))?.state).toBe('finalized');
    expect(await proofRepo.getProofsByOperationId(mintUrl, op.id)).toHaveLength(1);
  });

  it('finalizes executing operations when all inputs are spent and recovers proofs', async () => {
    const proofs = [makeProof('p1'), makeProof('p2')];
    const op = makeExecutingOp('exec-op-spent', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) => {
      const count = Math.max(1, ys.length);
      return Array.from({ length: count }, () => ({ state: 'SPENT' }) as CashuProofState);
    });
    (proofService.observeRestoreProofsFromOutputData as Mock<any>).mockImplementation(async () => {
      const outputSecrets = getOutputProofSecrets(op);
      const recovered: Proof[] = outputSecrets.map(
        (secret) =>
          ({
            id: keysetId,
            amount: Amount.from(10),
            secret,
            C: `C_${secret}`,
          }) as Proof,
      );
      return {
        status: 'complete-unspent',
        expectedOutputCount: recovered.length,
        restoredProofs: recovered,
        unspentProofs: recovered,
      };
    });

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('finalized');
    expect((proofService.observeRestoreProofsFromOutputData as Mock<any>).mock.calls.length).toBe(
      1,
    );
    expect(mockCheckProofsStates.mock.calls.length).toBeGreaterThan(0);
    expect(mockWalletReceive.mock.calls.length).toBe(0);
  });

  it('rolls back an executing receive when spent inputs have no recoverable outputs', async () => {
    const proofs = [makeProof('p1')];
    const op = makeExecutingOp('exec-op-spent-unrecoverable', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'SPENT' }) as CashuProofState),
    );

    await api.recovery.run();

    const stored = await api.get(op.id);
    expect(stored?.state).toBe('rolled_back');
    expect(stored?.error).toBe('Recovered: input proofs spent without recoverable outputs');
    expect((await api.listInFlight()).map((operation) => operation.id)).not.toContain(op.id);
  });

  it('finalizes with spent proofs when exact Restore outputs exist but are already spent', async () => {
    const op = makeExecutingOp('exec-op-restored-spent', [makeProof('p1')]);
    await receiveOpRepo.create(op);
    mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'SPENT' }) as CashuProofState),
    );
    const restored = getOutputProofSecrets(op).map(
      (secret) => ({ id: keysetId, amount: Amount.from(10), secret, C: `C_${secret}` }) as Proof,
    );
    (proofService.observeRestoreProofsFromOutputData as Mock<any>).mockResolvedValue({
      status: 'complete-spent',
      expectedOutputCount: restored.length,
      restoredProofs: restored,
      unspentProofs: [],
    });

    await service.recoverPendingOperations();

    expect((await receiveOpRepo.getById(op.id))?.state).toBe('finalized');
    expect((await proofRepo.getProofsByOperationId(mintUrl, op.id))[0]?.state).toBe('spent');
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

  it('keeps executing when inputs are not conclusively spent', async () => {
    const proofs = [makeProof('p1'), makeProof('p2')];
    const op = makeExecutingOp('exec-op-mixed', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) => {
      if (ys.length === 0) return [];
      if (ys.length === 1) return [{ state: 'SPENT' } as CashuProofState];
      return [{ state: 'SPENT' } as CashuProofState, { state: 'UNSPENT' } as CashuProofState];
    });

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('executing');
  });

  it('keeps executing when the mint returns incomplete input-state evidence', async () => {
    const op = makeExecutingOp('exec-op-incomplete-state', [makeProof('p1'), makeProof('p2')]);
    await receiveOpRepo.create(op);
    mockCheckProofsStates.mockResolvedValue([{ state: 'SPENT' } as CashuProofState]);

    await service.recoverPendingOperations();

    expect((await receiveOpRepo.getById(op.id))?.state).toBe('executing');
    expect(proofService.observeRestoreProofsFromOutputData).not.toHaveBeenCalled();
  });

  it('keeps executing when Restore observation fails for spent inputs', async () => {
    const proofs = [makeProof('p1')];
    const op = makeExecutingOp('exec-op-error-proof', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'SPENT' }) as CashuProofState),
    );
    (proofService.observeRestoreProofsFromOutputData as Mock<any>).mockImplementation(async () => {
      throw new Error('Mint restore failed');
    });

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('executing');
  });

  it('rolls back when re-execution fails with a terminal NUT-03 mint error', async () => {
    const proofs = [makeProof('p1')];
    const op = makeExecutingOp('exec-op-terminal-retry', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'UNSPENT' }) as CashuProofState),
    );
    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(11001, 'Proofs already spent');
    });

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('rolled_back');
    expect(stored?.error).toBe('Proofs already spent');
  });

  it('rolls back when re-execution fails with a terminal NUT-03 keyset error', async () => {
    const proofs = [makeProof('p1')];
    const op = makeExecutingOp('exec-op-terminal-keyset-retry', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'UNSPENT' }) as CashuProofState),
    );
    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(12002, 'Keyset is inactive');
    });

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('rolled_back');
    expect(stored?.error).toBe('Keyset is inactive');
  });

  it('rolls back when re-execution fails with a generic mint protocol error', async () => {
    const proofs = [makeProof('p1')];
    const op = makeExecutingOp('exec-op-generic-mint-error', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'UNSPENT' }) as CashuProofState),
    );
    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(0, 'Keyset unknown');
    });

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('rolled_back');
    expect(stored?.error).toBe('Keyset unknown');
  });

  it('keeps executing when re-execution hits recovery-sensitive outputs already signed', async () => {
    const proofs = [makeProof('p1')];
    const op = makeExecutingOp('exec-op-already-signed', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'UNSPENT' }) as CashuProofState),
    );
    mockWalletReceive.mockImplementation(async () => {
      throw new MintOperationError(11003, 'Outputs already signed');
    });

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('executing');
  });

  for (const { code, message } of [
    { code: 11002, message: 'Proofs are pending' },
    { code: 11004, message: 'Outputs are pending' },
  ]) {
    it(`keeps executing when re-execution hits ambiguous NUT-03 state ${code}`, async () => {
      const proofs = [makeProof('p1')];
      const op = makeExecutingOp(`exec-op-pending-${code}`, proofs);
      await receiveOpRepo.create(op);

      mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
        ys.map(() => ({ state: 'UNSPENT' }) as CashuProofState),
      );
      mockWalletReceive.mockImplementation(async () => {
        throw new MintOperationError(code, message);
      });

      await service.recoverPendingOperations();

      const stored = await receiveOpRepo.getById(op.id);
      expect(stored?.state).toBe('executing');
    });
  }

  it('keeps executing when spent-proof recovery fails with a local validation error', async () => {
    const proofs = [makeProof('p1')];
    const op = makeExecutingOp('exec-op-terminal-restore', proofs);
    await receiveOpRepo.create(op);

    mockCheckProofsStates.mockImplementation(async (_mintUrl: string, ys: string[]) =>
      ys.map(() => ({ state: 'SPENT' }) as CashuProofState),
    );
    (proofService.observeRestoreProofsFromOutputData as Mock<any>).mockImplementation(async () => {
      throw new ProofValidationError('Invalid signature in recovered outputs');
    });

    await service.recoverPendingOperations();

    const stored = await receiveOpRepo.getById(op.id);
    expect(stored?.state).toBe('executing');
  });
});
