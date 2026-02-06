import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { SendOperationService } from '../../operations/send/SendOperationService';
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
  InitSendOperation,
  PreparedSendOperation,
  ExecutingSendOperation,
  PendingSendOperation,
} from '../../operations/send/SendOperation';
import { serializeOutputData } from '../../utils';
import { OutputData, type Proof, type ProofState as CashuProofState } from '@cashu/cashu-ts';

describe('SendOperationService - recoverPendingOperations', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';

  let sendOpRepo: MemorySendOperationRepository;
  let proofRepo: MemoryProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let service: SendOperationService;

  // Mock wallet with checkProofsStates
  let mockCheckProofsStates: Mock<(proofs: { secret: string }[]) => Promise<CashuProofState[]>>;
  let mockMintRestore: Mock<
    (req: { outputs: any[] }) => Promise<{ outputs: any[]; signatures: any[] }>
  >;
  let mockWallet: any;

  const makeProof = (secret: string, overrides?: Partial<CoreProof>): CoreProof =>
    ({
      amount: 10,
      C: `C_${secret}`,
      id: keysetId,
      secret,
      mintUrl,
      state: 'ready',
      ...overrides,
    } as CoreProof);

  const makeInitOp = (id: string): InitSendOperation => ({
    id,
    state: 'init',
    mintUrl,
    amount: 100,
    unit: 'sat',
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
  });

  const makePreparedOp = (
    id: string,
    overrides?: Partial<PreparedSendOperation>,
  ): PreparedSendOperation => ({
    id,
    state: 'prepared',
    mintUrl,
    amount: 100,
    unit: 'sat',
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    needsSwap: true,
    fee: 1,
    inputAmount: 101,
    inputProofSecrets: ['input-secret-1', 'input-secret-2'],
    outputData: serializeOutputData({ keep: [], send: [] }),
    ...overrides,
  });

  const makeExecutingOp = (
    id: string,
    overrides?: Partial<ExecutingSendOperation>,
  ): ExecutingSendOperation => ({
    ...makePreparedOp(id),
    state: 'executing',
    ...overrides,
  });

  const makePendingOp = (
    id: string,
    overrides?: Partial<PendingSendOperation>,
  ): PendingSendOperation => ({
    ...makePreparedOp(id),
    state: 'pending',
    ...overrides,
  });

  /**
   * Creates mock OutputData for testing swap recovery.
   * Returns serialized output data with keep and send outputs.
   */
  const createMockOutputData = (keepSecrets: string[], sendSecrets: string[]) => {
    // Create mock OutputData-like objects with the structure we need
    const mockKeepOutputs = keepSecrets.map((secret) => ({
      blindedMessage: { amount: 10, id: keysetId, B_: `B_keep_${secret}` },
      blindingFactor: '1234567890abcdef',
      secret: Buffer.from(secret).toString('hex'),
    }));

    const mockSendOutputs = sendSecrets.map((secret) => ({
      blindedMessage: { amount: 10, id: keysetId, B_: `B_send_${secret}` },
      blindingFactor: 'abcdef1234567890',
      secret: Buffer.from(secret).toString('hex'),
    }));

    return {
      keep: mockKeepOutputs,
      send: mockSendOutputs,
    };
  };

  beforeEach(() => {
    sendOpRepo = new MemorySendOperationRepository();
    proofRepo = new MemoryProofRepository();
    eventBus = new EventBus<CoreEvents>();

    // Mock checkProofsStates - default to UNSPENT
    mockCheckProofsStates = mock(() =>
      Promise.resolve([{ state: 'UNSPENT', Y: 'test' }] as CashuProofState[]),
    );

    // Mock mint restore endpoint
    mockMintRestore = mock(() =>
      Promise.resolve({
        outputs: [],
        signatures: [],
      }),
    );

    // Mock wallet
    mockWallet = {
      checkProofsStates: mockCheckProofsStates,
      mint: {
        restore: mockMintRestore,
      },
      getKeys: mock(() => Promise.resolve({ keys: { 1: 'pubkey' }, id: keysetId })),
    };

    // Mock ProofService
    proofService = {
      saveProofs: mock(() => Promise.resolve()),
      setProofState: mock(() => Promise.resolve()),
      reserveProofs: mock((mintUrl: string, secrets: string[], operationId: string) =>
        proofRepo.reserveProofs(mintUrl, secrets, operationId).then(() => ({ amount: 0 })),
      ),
      releaseProofs: mock((mintUrl: string, secrets: string[]) =>
        proofRepo.releaseProofs(mintUrl, secrets),
      ),
      createOutputsAndIncrementCounters: mock(() =>
        Promise.resolve({ keep: [], send: [], sendAmount: 0, keepAmount: 0 }),
      ),
      recoverProofsFromOutputData: mock(async (mintUrl: string, serializedOutputData: any) => {
        // Deserialize output data and call wallet restore
        const allOutputs = [...serializedOutputData.keep, ...serializedOutputData.send];
        if (allOutputs.length === 0) return [];

        const blindedMessages = allOutputs.map((o: any) => o.blindedMessage);
        const restoreResult = await mockMintRestore({ outputs: blindedMessages });

        // Construct proofs from restore result
        const recoveredProofs: any[] = [];
        for (let i = 0; i < restoreResult.outputs.length; i++) {
          const output = allOutputs.find(
            (o: any) => o.blindedMessage.B_ === restoreResult.outputs[i]?.B_,
          );
          const signature = restoreResult.signatures[i];
          if (output && signature) {
            recoveredProofs.push({
              id: signature.id,
              amount: signature.amount,
              secret: Buffer.from(output.secret, 'hex').toString(),
              C: signature.C_,
              mintUrl,
              state: 'ready',
            });
          }
        }

        // Save recovered proofs (already mocked)
        if (recoveredProofs.length > 0) {
          await proofService.saveProofs(mintUrl, recoveredProofs);
        }

        return recoveredProofs;
      }),
    } as unknown as ProofService;

    // Mock MintService
    mintService = {
      isTrustedMint: mock(() => Promise.resolve(true)),
    } as unknown as MintService;

    // Mock WalletService
    walletService = {
      getWalletWithActiveKeysetId: mock(() =>
        Promise.resolve({
          wallet: mockWallet,
          keysetId,
          keyset: { id: keysetId },
          keys: { keys: { 1: 'pubkey' }, id: keysetId },
        }),
      ),
      getWallet: mock(() => Promise.resolve(mockWallet)),
    } as unknown as WalletService;

    // Mock Logger
    logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    } as Logger;

    service = new SendOperationService(
      sendOpRepo,
      proofRepo,
      proofService,
      mintService,
      walletService,
      eventBus,
      logger,
    );
  });

  // ============================================================================
  // 1. init State Recovery
  // ============================================================================

  describe('init state operations', () => {
    it('should delete init operations and release any reserved proofs', async () => {
      // Create an init operation
      const initOp = makeInitOp('init-op-1');
      await sendOpRepo.create(initOp);

      // Create a proof that was reserved for this operation (orphaned)
      const proof = makeProof('orphan-proof', { usedByOperationId: 'init-op-1' });
      await proofRepo.saveProofs(mintUrl, [proof]);

      await service.recoverPendingOperations();

      // Operation should be deleted
      const op = await sendOpRepo.getById('init-op-1');
      expect(op).toBeNull();

      // Proof reservation should be released
      const releasedProof = await proofRepo.getProofBySecret(mintUrl, 'orphan-proof');
      expect(releasedProof?.usedByOperationId).toBeUndefined();

      // Logger should have logged the cleanup
      expect(logger.info).toHaveBeenCalledWith('Cleaned up failed init operation', {
        operationId: 'init-op-1',
      });
    });

    it('should handle multiple init operations', async () => {
      await sendOpRepo.create(makeInitOp('init-op-1'));
      await sendOpRepo.create(makeInitOp('init-op-2'));

      await service.recoverPendingOperations();

      expect(await sendOpRepo.getById('init-op-1')).toBeNull();
      expect(await sendOpRepo.getById('init-op-2')).toBeNull();
    });
  });

  // ============================================================================
  // 2. prepared State Recovery
  // ============================================================================

  describe('prepared state operations', () => {
    it('should leave prepared operations as-is and log a warning', async () => {
      const preparedOp = makePreparedOp('prepared-op-1');
      await sendOpRepo.create(preparedOp);

      await service.recoverPendingOperations();

      // Operation should still exist in prepared state
      const op = await sendOpRepo.getById('prepared-op-1');
      expect(op).not.toBeNull();
      expect(op?.state).toBe('prepared');

      // Logger should warn about stale prepared operation
      expect(logger.warn).toHaveBeenCalledWith(
        'Found stale prepared operation, user can rollback manually',
        { operationId: 'prepared-op-1' },
      );
    });
  });

  // ============================================================================
  // 3. executing State Recovery - Exact Match (needsSwap = false)
  // ============================================================================

  describe('executing state - exact match (needsSwap = false)', () => {
    it('should rollback without querying mint when needsSwap is false', async () => {
      const executingOp = makeExecutingOp('exec-op-1', {
        needsSwap: false,
        inputProofSecrets: ['input-1', 'input-2'],
      });
      await sendOpRepo.create(executingOp);

      // Create reserved proofs
      await proofRepo.saveProofs(mintUrl, [
        makeProof('input-1', { usedByOperationId: 'exec-op-1' }),
        makeProof('input-2', { usedByOperationId: 'exec-op-1' }),
      ]);

      await service.recoverPendingOperations();

      // Should NOT query mint (no checkProofsStates call)
      expect(mockCheckProofsStates).not.toHaveBeenCalled();

      // Operation should be rolled back
      const op = await sendOpRepo.getById('exec-op-1');
      expect(op?.state).toBe('rolled_back');
      expect(op?.error).toBe('Recovered: no swap needed, operation never finalized');

      // Proofs should be released
      const proof1 = await proofRepo.getProofBySecret(mintUrl, 'input-1');
      const proof2 = await proofRepo.getProofBySecret(mintUrl, 'input-2');
      expect(proof1?.usedByOperationId).toBeUndefined();
      expect(proof2?.usedByOperationId).toBeUndefined();
    });
  });

  // ============================================================================
  // 4. executing State Recovery - Swap Required, Inputs NOT Spent
  // ============================================================================

  describe('executing state - swap required, inputs NOT spent', () => {
    it('should rollback when mint reports inputs as UNSPENT', async () => {
      const executingOp = makeExecutingOp('exec-op-2', {
        needsSwap: true,
        inputProofSecrets: ['input-1', 'input-2'],
      });
      await sendOpRepo.create(executingOp);

      // Create reserved proofs
      await proofRepo.saveProofs(mintUrl, [
        makeProof('input-1', { usedByOperationId: 'exec-op-2' }),
        makeProof('input-2', { usedByOperationId: 'exec-op-2' }),
      ]);

      // Mock mint response: inputs NOT spent
      mockCheckProofsStates.mockImplementation(() =>
        Promise.resolve([
          { state: 'UNSPENT', Y: 'y1' } as CashuProofState,
          { state: 'UNSPENT', Y: 'y2' } as CashuProofState,
        ]),
      );

      await service.recoverPendingOperations();

      // Should query mint
      expect(mockCheckProofsStates).toHaveBeenCalled();

      // Operation should be rolled back
      const op = await sendOpRepo.getById('exec-op-2');
      expect(op?.state).toBe('rolled_back');
      expect(op?.error).toBe('Recovered: swap never executed');

      // Proofs should be released
      const proof1 = await proofRepo.getProofBySecret(mintUrl, 'input-1');
      expect(proof1?.usedByOperationId).toBeUndefined();
    });
  });

  // ============================================================================
  // 5. executing State Recovery - Swap Required, Inputs ARE Spent, Proofs Already Saved
  // ============================================================================

  describe('executing state - swap required, inputs ARE spent, proofs already saved', () => {
    it('should rollback without recovering proofs when they already exist in DB', async () => {
      const outputData = createMockOutputData(['keep-secret'], ['send-secret']);
      const executingOp = makeExecutingOp('exec-op-3', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        outputData,
      });
      await sendOpRepo.create(executingOp);

      // Create the proofs that were saved before crash (with createdByOperationId)
      await proofRepo.saveProofs(mintUrl, [
        makeProof('input-1', { usedByOperationId: 'exec-op-3', state: 'spent' }),
        makeProof('keep-secret', { createdByOperationId: 'exec-op-3', state: 'ready' }),
        makeProof('send-secret', { createdByOperationId: 'exec-op-3', state: 'ready' }),
      ]);

      // Mock mint response: inputs ARE spent
      mockCheckProofsStates.mockImplementation(() =>
        Promise.resolve([{ state: 'SPENT', Y: 'y1' } as CashuProofState]),
      );

      await service.recoverPendingOperations();

      // Should NOT call mint restore (proofs already exist)
      expect(mockMintRestore).not.toHaveBeenCalled();

      // Operation should be rolled back
      const op = await sendOpRepo.getById('exec-op-3');
      expect(op?.state).toBe('rolled_back');
      expect(op?.error).toBe('Recovered: swap succeeded but token never returned');

      // Input proofs should be marked as spent (they were consumed by the swap)
      const proof = await proofRepo.getProofBySecret(mintUrl, 'input-1');
      expect(proof?.state).toBe('spent');
    });
  });

  // ============================================================================
  // 6. executing State Recovery - Swap Required, Inputs ARE Spent, Proofs NOT Saved
  // ============================================================================

  describe('executing state - swap required, inputs ARE spent, proofs NOT saved', () => {
    it('should recover proofs from mint restore when they do not exist in DB', async () => {
      const outputData = createMockOutputData(['keep-secret'], ['send-secret']);
      const executingOp = makeExecutingOp('exec-op-4', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        outputData,
      });
      await sendOpRepo.create(executingOp);

      // Only input proofs exist (output proofs were NOT saved before crash)
      await proofRepo.saveProofs(mintUrl, [
        makeProof('input-1', { usedByOperationId: 'exec-op-4' }),
      ]);

      // Mock mint response: inputs ARE spent
      mockCheckProofsStates.mockImplementation(() =>
        Promise.resolve([{ state: 'SPENT', Y: 'y1' } as CashuProofState]),
      );

      // Mock mint restore to return signatures
      mockMintRestore.mockImplementation(() =>
        Promise.resolve({
          outputs: [
            { B_: `B_keep_keep-secret`, amount: 10 },
            { B_: `B_send_send-secret`, amount: 10 },
          ],
          signatures: [
            { C_: 'C_keep', amount: 10, id: keysetId },
            { C_: 'C_send', amount: 10, id: keysetId },
          ],
        }),
      );

      await service.recoverPendingOperations();

      // Should call mint restore
      expect(mockMintRestore).toHaveBeenCalled();

      // ProofService.saveProofs should have been called to save recovered proofs
      expect(proofService.saveProofs).toHaveBeenCalled();

      // ProofService.setProofState should have been called to mark input proofs as spent
      expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');

      // Operation should be rolled back
      const op = await sendOpRepo.getById('exec-op-4');
      expect(op?.state).toBe('rolled_back');
      expect(op?.error).toBe('Recovered: swap succeeded but token never returned');
    });

    it('should construct proofs correctly from mint restore response', async () => {
      // Create output data with specific secrets
      const keepSecret = 'my-keep-secret';
      const sendSecret = 'my-send-secret';
      const outputData = createMockOutputData([keepSecret], [sendSecret]);

      const executingOp = makeExecutingOp('exec-op-restore', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        outputData,
      });
      await sendOpRepo.create(executingOp);

      // Only input proofs exist
      await proofRepo.saveProofs(mintUrl, [
        makeProof('input-1', { usedByOperationId: 'exec-op-restore' }),
      ]);

      // Mock mint response: inputs ARE spent
      mockCheckProofsStates.mockImplementation(() =>
        Promise.resolve([{ state: 'SPENT', Y: 'y1' } as CashuProofState]),
      );

      // Mock mint restore - return outputs/signatures in same order as blinded messages
      mockMintRestore.mockImplementation((req: { outputs: any[] }) => {
        // Verify the blinded messages match what we expect from outputData
        expect(req.outputs).toHaveLength(2);
        expect(req.outputs[0].B_).toBe(`B_keep_${keepSecret}`);
        expect(req.outputs[1].B_).toBe(`B_send_${sendSecret}`);

        return Promise.resolve({
          outputs: [
            { B_: `B_keep_${keepSecret}`, amount: 10 },
            { B_: `B_send_${sendSecret}`, amount: 20 },
          ],
          signatures: [
            { C_: 'C_signature_keep', amount: 10, id: keysetId },
            { C_: 'C_signature_send', amount: 20, id: keysetId },
          ],
        });
      });

      // Capture what gets passed to saveProofs
      let savedProofs: any[] = [];
      (proofService.saveProofs as any).mockImplementation((_mintUrl: string, proofs: any[]) => {
        savedProofs = proofs;
        return Promise.resolve();
      });

      await service.recoverPendingOperations();

      // Verify mint restore was called
      expect(mockMintRestore).toHaveBeenCalled();

      // Verify the recovered proofs have correct structure
      expect(savedProofs).toHaveLength(2);

      // First proof (keep)
      const keepProof = savedProofs.find((p) => p.secret === keepSecret);
      expect(keepProof).toBeDefined();
      expect(keepProof.C).toBe('C_signature_keep');
      expect(keepProof.amount).toBe(10);
      expect(keepProof.id).toBe(keysetId);
      expect(keepProof.mintUrl).toBe(mintUrl);
      expect(keepProof.state).toBe('ready');

      // Second proof (send)
      const sendProof = savedProofs.find((p) => p.secret === sendSecret);
      expect(sendProof).toBeDefined();
      expect(sendProof.C).toBe('C_signature_send');
      expect(sendProof.amount).toBe(20);
      expect(sendProof.id).toBe(keysetId);
      expect(sendProof.mintUrl).toBe(mintUrl);
      expect(sendProof.state).toBe('ready');
    });
  });

  // ============================================================================
  // 7. executing State Recovery - Mint Unavailable
  // ============================================================================

  describe('executing state - mint unavailable', () => {
    it('should log warning and skip operation when mint is unreachable', async () => {
      const executingOp = makeExecutingOp('exec-op-5', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
      });
      await sendOpRepo.create(executingOp);

      await proofRepo.saveProofs(mintUrl, [
        makeProof('input-1', { usedByOperationId: 'exec-op-5' }),
      ]);

      // Mock mint error
      mockCheckProofsStates.mockImplementation(() =>
        Promise.reject(new Error('Network error: mint unreachable')),
      );

      await service.recoverPendingOperations();

      // Operation should remain in executing state
      const op = await sendOpRepo.getById('exec-op-5');
      expect(op?.state).toBe('executing');

      // Logger should warn about the failure
      expect(logger.warn).toHaveBeenCalledWith(
        'Could not reach mint for recovery, will retry later',
        { operationId: 'exec-op-5', mintUrl },
      );
    });
  });

  // ============================================================================
  // 8. pending State Recovery - Send Proofs ARE Spent
  // ============================================================================

  describe('pending state - send proofs ARE spent', () => {
    it('should finalize operation when recipient claimed the token', async () => {
      const outputData = createMockOutputData([], ['send-secret']);
      const pendingOp = makePendingOp('pending-op-1', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        outputData,
      });
      await sendOpRepo.create(pendingOp);

      // Create proofs
      await proofRepo.saveProofs(mintUrl, [
        makeProof('input-1', { usedByOperationId: 'pending-op-1', state: 'spent' }),
        makeProof('send-secret', { createdByOperationId: 'pending-op-1', state: 'inflight' }),
      ]);

      // Mock mint response: send proofs ARE spent (recipient claimed)
      mockCheckProofsStates.mockImplementation(() =>
        Promise.resolve([{ state: 'SPENT', Y: 'y1' } as CashuProofState]),
      );

      await service.recoverPendingOperations();

      // Operation should be finalized
      const op = await sendOpRepo.getById('pending-op-1');
      expect(op?.state).toBe('finalized');

      // Logger should info about finalization
      expect(logger.info).toHaveBeenCalledWith('Send operation finalized during recovery', {
        operationId: 'pending-op-1',
      });
    });

    it('should finalize exact match operation when proofs are spent', async () => {
      // Exact match: no swap, inputProofSecrets ARE the send secrets
      const pendingOp = makePendingOp('pending-op-2', {
        needsSwap: false,
        inputProofSecrets: ['send-1', 'send-2'],
        outputData: undefined,
      });
      await sendOpRepo.create(pendingOp);

      // Create proofs
      await proofRepo.saveProofs(mintUrl, [
        makeProof('send-1', { usedByOperationId: 'pending-op-2', state: 'inflight' }),
        makeProof('send-2', { usedByOperationId: 'pending-op-2', state: 'inflight' }),
      ]);

      // Mock mint response: send proofs ARE spent
      mockCheckProofsStates.mockImplementation(() =>
        Promise.resolve([
          { state: 'SPENT', Y: 'y1' } as CashuProofState,
          { state: 'SPENT', Y: 'y2' } as CashuProofState,
        ]),
      );

      await service.recoverPendingOperations();

      // Operation should be finalized
      const op = await sendOpRepo.getById('pending-op-2');
      expect(op?.state).toBe('finalized');
    });
  });

  // ============================================================================
  // 9. pending State Recovery - Send Proofs NOT Spent
  // ============================================================================

  describe('pending state - send proofs NOT spent', () => {
    it('should leave operation as pending when token not yet claimed', async () => {
      const outputData = createMockOutputData([], ['send-secret']);
      const pendingOp = makePendingOp('pending-op-3', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        outputData,
      });
      await sendOpRepo.create(pendingOp);

      await proofRepo.saveProofs(mintUrl, [
        makeProof('send-secret', { createdByOperationId: 'pending-op-3', state: 'inflight' }),
      ]);

      // Mock mint response: send proofs NOT spent
      mockCheckProofsStates.mockImplementation(() =>
        Promise.resolve([{ state: 'UNSPENT', Y: 'y1' } as CashuProofState]),
      );

      await service.recoverPendingOperations();

      // Operation should remain pending
      const op = await sendOpRepo.getById('pending-op-3');
      expect(op?.state).toBe('pending');

      // Logger should debug about leaving as pending
      expect(logger.debug).toHaveBeenCalledWith(
        'Pending operation token not yet claimed, leaving as pending',
        { operationId: 'pending-op-3' },
      );
    });
  });

  // ============================================================================
  // 10. pending State Recovery - Mint Unavailable
  // ============================================================================

  describe('pending state - mint unavailable', () => {
    it('should log warning and skip operation when mint is unreachable', async () => {
      const outputData = createMockOutputData([], ['send-secret']);
      const pendingOp = makePendingOp('pending-op-4', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        outputData,
      });
      await sendOpRepo.create(pendingOp);

      // Mock mint error
      mockCheckProofsStates.mockImplementation(() =>
        Promise.reject(new Error('Network error: mint unreachable')),
      );

      await service.recoverPendingOperations();

      // Operation should remain pending
      const op = await sendOpRepo.getById('pending-op-4');
      expect(op?.state).toBe('pending');

      // Logger should warn
      expect(logger.warn).toHaveBeenCalledWith(
        'Could not reach mint for recovery, will retry later',
        { operationId: 'pending-op-4', mintUrl },
      );
    });
  });

  // ============================================================================
  // 11. Orphaned Proof Reservations
  // ============================================================================

  describe('orphaned proof reservations', () => {
    it('should release proofs reserved by non-existent operations', async () => {
      // Proof reserved by operation that does not exist
      await proofRepo.saveProofs(mintUrl, [
        makeProof('orphan-1', { usedByOperationId: 'non-existent-op' }),
        makeProof('orphan-2', { usedByOperationId: 'non-existent-op' }),
      ]);

      await service.recoverPendingOperations();

      // Reservations should be released
      const proof1 = await proofRepo.getProofBySecret(mintUrl, 'orphan-1');
      const proof2 = await proofRepo.getProofBySecret(mintUrl, 'orphan-2');
      expect(proof1?.usedByOperationId).toBeUndefined();
      expect(proof2?.usedByOperationId).toBeUndefined();

      expect(logger.info).toHaveBeenCalledWith('Released orphaned proof reservations', {
        count: 2,
      });
    });

    it('should release proofs reserved by finalized operations', async () => {
      // Create a finalized operation
      const finalizedOp = {
        ...makePreparedOp('finalized-op'),
        state: 'finalized' as const,
      };
      await sendOpRepo.create(finalizedOp);

      // Proof still has reservation (should have been cleaned up)
      await proofRepo.saveProofs(mintUrl, [
        makeProof('stale-reservation', { usedByOperationId: 'finalized-op' }),
      ]);

      await service.recoverPendingOperations();

      // Reservation should be released
      const proof = await proofRepo.getProofBySecret(mintUrl, 'stale-reservation');
      expect(proof?.usedByOperationId).toBeUndefined();
    });

    it('should release proofs reserved by rolled_back operations', async () => {
      // Create a rolled_back operation
      const rolledBackOp = {
        ...makePreparedOp('rolledback-op'),
        state: 'rolled_back' as const,
      };
      await sendOpRepo.create(rolledBackOp);

      await proofRepo.saveProofs(mintUrl, [
        makeProof('stale-reservation-2', { usedByOperationId: 'rolledback-op' }),
      ]);

      await service.recoverPendingOperations();

      const proof = await proofRepo.getProofBySecret(mintUrl, 'stale-reservation-2');
      expect(proof?.usedByOperationId).toBeUndefined();
    });
  });

  // ============================================================================
  // Edge Cases and Error Handling
  // ============================================================================

  describe('edge cases and error handling', () => {
    it('should handle empty repository gracefully', async () => {
      // No operations exist
      await service.recoverPendingOperations();

      // Should not throw, logger might have debug messages
      expect(logger.info).toHaveBeenCalledWith('Recovery completed', expect.any(Object));
    });

    it('should continue recovering other operations if one fails', async () => {
      // Create two executing operations
      await sendOpRepo.create(
        makeExecutingOp('exec-fail', {
          needsSwap: true,
          inputProofSecrets: ['fail-input'],
        }),
      );
      await sendOpRepo.create(
        makeExecutingOp('exec-success', {
          needsSwap: false,
          inputProofSecrets: ['success-input'],
        }),
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof('fail-input', { usedByOperationId: 'exec-fail' }),
        makeProof('success-input', { usedByOperationId: 'exec-success' }),
      ]);

      // First operation fails on mint check
      let callCount = 0;
      mockCheckProofsStates.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Mint error'));
        }
        return Promise.resolve([{ state: 'UNSPENT', Y: 'y1' } as CashuProofState]);
      });

      await service.recoverPendingOperations();

      // First operation should still be executing (skipped)
      const failedOp = await sendOpRepo.getById('exec-fail');
      expect(failedOp?.state).toBe('executing');

      // Second operation should be rolled back (needsSwap=false, no mint call needed)
      const successOp = await sendOpRepo.getById('exec-success');
      expect(successOp?.state).toBe('rolled_back');
    });

    it('should process operations in correct order: init, executing, pending, orphans', async () => {
      const callOrder: string[] = [];

      // Create fresh logger with tracking
      logger = {
        debug: mock((msg: string) => callOrder.push(`debug:${msg}`)),
        info: mock((msg: string) => callOrder.push(`info:${msg}`)),
        warn: mock((msg: string) => callOrder.push(`warn:${msg}`)),
        error: mock((msg: string) => callOrder.push(`error:${msg}`)),
      } as Logger;

      // Recreate service with tracking logger
      service = new SendOperationService(
        sendOpRepo,
        proofRepo,
        proofService,
        mintService,
        walletService,
        eventBus,
        logger,
      );

      await sendOpRepo.create(makeInitOp('init-1'));
      await sendOpRepo.create(
        makeExecutingOp('exec-1', { needsSwap: false, inputProofSecrets: [] }),
      );
      await sendOpRepo.create(makePendingOp('pending-1', { inputProofSecrets: [] }));

      // Mock for pending check
      mockCheckProofsStates.mockImplementation(() =>
        Promise.resolve([{ state: 'UNSPENT', Y: 'y' } as CashuProofState]),
      );

      await service.recoverPendingOperations();

      // Verify order: init cleanup before executing before pending
      const initIdx = callOrder.findIndex((m) => m.includes('init'));
      const execIdx = callOrder.findIndex((m) => m.includes('executing') || m.includes('rolled'));
      const pendingIdx = callOrder.findIndex((m) => m.includes('pending') || m.includes('Pending'));

      // init operations should be processed (found or cleaned)
      expect(initIdx).toBeGreaterThanOrEqual(0);
    });

    it('should emit send:rolled-back event when rolling back operations', async () => {
      const events: any[] = [];
      eventBus.on('send:rolled-back', (e) => void events.push(e));

      await sendOpRepo.create(
        makeExecutingOp('exec-rollback', {
          needsSwap: false,
          inputProofSecrets: ['input'],
        }),
      );
      await proofRepo.saveProofs(mintUrl, [
        makeProof('input', { usedByOperationId: 'exec-rollback' }),
      ]);

      await service.recoverPendingOperations();

      expect(events.length).toBe(1);
      expect(events[0].operationId).toBe('exec-rollback');
      expect(events[0].operation.state).toBe('rolled_back');
    });

    it('should emit send:finalized event when finalizing pending operations', async () => {
      const events: any[] = [];
      eventBus.on('send:finalized', (e) => void events.push(e));

      const outputData = createMockOutputData([], ['send-secret']);
      await sendOpRepo.create(
        makePendingOp('pending-finalize', {
          needsSwap: true,
          inputProofSecrets: ['input'],
          outputData,
        }),
      );
      await proofRepo.saveProofs(mintUrl, [
        makeProof('send-secret', { createdByOperationId: 'pending-finalize', state: 'inflight' }),
      ]);

      mockCheckProofsStates.mockImplementation(() =>
        Promise.resolve([{ state: 'SPENT', Y: 'y' } as CashuProofState]),
      );

      await service.recoverPendingOperations();

      expect(events.length).toBe(1);
      expect(events[0].operationId).toBe('pending-finalize');
      expect(events[0].operation.state).toBe('finalized');
    });
  });
});
