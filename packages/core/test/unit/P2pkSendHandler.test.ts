import { Amount, OutputData, type OutputDataLike } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { P2pkSendHandler } from '../../infra/handlers/send/P2pkSendHandler';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { ProofService } from '../../services/ProofService';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { Logger } from '../../logging/Logger';
import type { CoreProof } from '../../types';
import type { ProofRepository } from '../../repositories';
import { ProofValidationError } from '../../models/Error';
import { getSecretsFromSerializedOutputData } from '../../utils';
import type {
  InitSendOperation,
  PreparedSendOperation,
  ExecutingSendOperation,
  PendingSendOperation,
} from '../../operations/send/SendOperation';
import type {
  BasePrepareContext,
  ExecuteContext,
  FinalizeContext,
  P2pkSendOptions,
  RollbackContext,
  RecoverExecutingContext,
} from '../../operations/send/SendMethodHandler';
import type { Wallet, Proof, OutputConfig } from '@cashu/cashu-ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';

describe('P2pkSendHandler', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const testPubkey = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
  const secondPubkey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const refundPubkey = '02c6047f9441ed7d6d3045406e95c07cd85a2a1ac9f278e80f2ea26a1f8f1c287c';
  const secondRefundPubkey = '02e493dbf1c10d80f3581e4904930b1404cc6c139f1a77d71642c9efe2e5a95c8f';

  let handler: P2pkSendHandler;
  let proofRepository: ProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let mockWallet: Wallet;

  // ============================================================================
  // Test Helpers
  // ============================================================================

  const makeProof = (secret: string, amount = 10, overrides?: Partial<Proof>): Proof =>
    ({
      amount: Amount.from(amount),
      C: `C_${secret}`,
      id: keysetId,
      secret,
      ...overrides,
    }) as Proof;

  const makeCoreProof = (secret: string, amount = 10, overrides?: Partial<CoreProof>): CoreProof =>
    ({
      amount: Amount.from(amount),
      C: `C_${secret}`,
      id: keysetId,
      secret,
      mintUrl,
      unit: 'sat',
      state: 'ready',
      ...overrides,
    }) as CoreProof;

  /**
   * Creates mock OutputData for testing swap operations.
   */
  const createMockOutputData = (keepSecrets: string[], sendSecrets: string[]) => ({
    keep: keepSecrets.map((secret) => ({
      blindedMessage: { amount: 10, id: keysetId, B_: `B_keep_${secret}` },
      blindingFactor: '1234567890abcdef',
      secret: Buffer.from(secret).toString('hex'),
    })),
    send: sendSecrets.map((secret) => ({
      blindedMessage: { amount: 10, id: keysetId, B_: `B_send_${secret}` },
      blindingFactor: 'abcdef1234567890',
      secret: Buffer.from(secret).toString('hex'),
    })),
  });

  const getSendSecretPayloads = (operation: PreparedSendOperation): unknown[] => {
    if (!operation.outputData) {
      throw new Error('expected output data');
    }
    return getSecretsFromSerializedOutputData(operation.outputData).sendSecrets.map((secret) =>
      JSON.parse(secret),
    );
  };

  const makeInitOp = (id: string, overrides?: Partial<InitSendOperation>): InitSendOperation => ({
    id,
    state: 'init',
    mintUrl,
    amount: Amount.from(100),
    method: 'p2pk',
    methodData: { pubkey: testPubkey },
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const makePreparedOp = (
    id: string,
    overrides?: Partial<PreparedSendOperation>,
  ): PreparedSendOperation => ({
    id,
    state: 'prepared',
    mintUrl,
    amount: Amount.from(100),
    method: 'p2pk',
    methodData: { pubkey: testPubkey },
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    needsSwap: true, // P2PK always needs swap
    fee: Amount.from(1),
    inputAmount: Amount.from(101),
    inputProofSecrets: ['input-1', 'input-2'],
    outputData: createMockOutputData(['keep-1'], ['send-1']),
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const makeExecutingOp = (
    id: string,
    overrides?: Partial<ExecutingSendOperation>,
  ): ExecutingSendOperation => ({
    ...makePreparedOp(id),
    state: 'executing',
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const makePendingOp = (
    id: string,
    overrides?: Partial<PendingSendOperation>,
  ): PendingSendOperation => ({
    ...makePreparedOp(id),
    state: 'pending',
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  // ============================================================================
  // Setup
  // ============================================================================

  beforeEach(() => {
    handler = new P2pkSendHandler();
    eventBus = new EventBus<CoreEvents>();

    // Mock wallet
    mockWallet = {
      selectProofsToSend: mock(() => ({
        send: [makeProof('input-1', 60), makeProof('input-2', 50)],
        keep: [],
      })),
      getFeesForProofs: mock(() => Amount.from(1)),
      getKeyset: mock(() => ({ id: keysetId, keys: { 1: 'pubkey' } })),
      send: mock(() =>
        Promise.resolve({
          keep: [makeProof('keep-1', 9)],
          send: [makeProof('send-1', 100)],
        }),
      ),
      checkProofsStates: mock(() => Promise.resolve([{ state: 'UNSPENT', Y: 'y1' }])),
      unit: 'sat',
    } as unknown as Wallet;

    // Mock ProofRepository
    proofRepository = {
      getAvailableProofs: mock(() =>
        Promise.resolve([makeCoreProof('input-1', 60), makeCoreProof('input-2', 50)]),
      ),
      getProofsByOperationId: mock(() => Promise.resolve([])),
    } as unknown as ProofRepository;

    // Mock ProofService
    proofService = {
      selectProofsToSend: mock(
        async (
          _mintUrl: string,
          intent: { amount: Amount; unit: string },
          includeFees: boolean = true,
        ) => {
          const proofs = await proofRepository.getAvailableProofs(mintUrl);
          const totalAvailable = Amount.sum(proofs.map((proof) => proof.amount));
          if (totalAvailable.lessThan(intent.amount)) {
            throw new ProofValidationError(
              `Insufficient balance: need ${intent.amount}, have ${totalAvailable}`,
            );
          }
          return mockWallet.selectProofsToSend(proofs, intent.amount, includeFees).send;
        },
      ),
      reserveProofs: mock(() => Promise.resolve({ amount: Amount.from(110) })),
      createOutputsAndIncrementCounters: mock(() =>
        Promise.resolve({
          keep: createMockOutputData(['keep-1'], []).keep,
          send: createMockOutputData([], ['send-1']).send,
          sendAmount: Amount.from(100),
          keepAmount: Amount.from(9),
        }),
      ),
      setProofState: mock(() => Promise.resolve()),
      saveProofs: mock(() => Promise.resolve()),
      releaseProofs: mock(() => Promise.resolve()),
      recoverProofsFromOutputData: mock(() => Promise.resolve([])),
    } as unknown as ProofService;

    // Mock MintService
    mintService = {
      isTrustedMint: mock(() => Promise.resolve(true)),
      assertNutSupported: mock(() => Promise.resolve()),
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
  });

  // ============================================================================
  // Context Builders
  // ============================================================================

  const buildPrepareContext = (operation: InitSendOperation): BasePrepareContext => ({
    operation,
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildExecuteContext = (
    operation: ExecutingSendOperation,
    reservedProofs: Proof[] = [],
  ): ExecuteContext => ({
    operation,
    wallet: mockWallet,
    reservedProofs,
    proofRepository,
    proofService,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildFinalizeContext = (operation: PendingSendOperation): FinalizeContext => ({
    operation,
    proofRepository,
    proofService,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildRollbackContext = (
    operation: PreparedSendOperation | PendingSendOperation,
  ): RollbackContext => ({
    operation,
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildRecoverContext = (operation: ExecutingSendOperation): RecoverExecutingContext => ({
    operation,
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  // ============================================================================
  // Prepare Phase Tests
  // ============================================================================

  describe('prepare', () => {
    it('delegates P2PK output construction and persists the custom output fields', async () => {
      const customOutput = {
        blindedMessage: {
          amount: Amount.from(100),
          id: keysetId,
          B_: 'custom-p2pk-blinded-message',
        },
        blindingFactor: 0x1234n,
        secret: new Uint8Array([1, 2, 3, 4]),
        ephemeralE: 'custom-ephemeral-e',
        toProof: mock(() => {
          throw new Error('not used while preparing');
        }),
      } satisfies OutputDataLike;
      const createP2PKData = mock(() => [customOutput]);
      handler = new P2pkSendHandler(makeOutputDataCreator({ createP2PKData }));
      const originalCreateP2PKData = OutputData.createP2PKData;
      OutputData.createP2PKData = () => {
        throw new Error('built-in P2PK creation must not be used');
      };

      const result = await (async () => {
        try {
          return await handler.prepare(buildPrepareContext(makeInitOp('op-custom-p2pk')));
        } finally {
          OutputData.createP2PKData = originalCreateP2PKData;
        }
      })();

      expect(createP2PKData).toHaveBeenCalledWith({ pubkey: testPubkey }, Amount.from(100), {
        id: keysetId,
        keys: { 1: 'pubkey' },
      });
      expect(result.outputData?.send).toEqual([
        {
          blindedMessage: {
            amount: '100',
            id: keysetId,
            B_: 'custom-p2pk-blinded-message',
          },
          blindingFactor: '1234',
          secret: '01020304',
          ephemeralE: 'custom-ephemeral-e',
        },
      ]);
    });

    it('should throw if P2PK target data is missing from methodData', async () => {
      const operation = makeInitOp('op-1', {
        methodData: {}, // No P2PK target
      });
      const ctx = buildPrepareContext(operation);

      await expect(handler.prepare(ctx)).rejects.toThrow(
        'P2PK send requires P2PK options or a pubkey in methodData',
      );
    });

    it('should assert that the mint advertises NUT-11 before preparing outputs', async () => {
      const operation = makeInitOp('op-nut11');
      const ctx = buildPrepareContext(operation);

      await handler.prepare(ctx);

      expect(mintService.assertNutSupported).toHaveBeenCalledWith(mintUrl, 11, 'P2PK send');
    });

    it('should reject prepare when the mint does not advertise NUT-11', async () => {
      (mintService.assertNutSupported as Mock<any>).mockRejectedValueOnce(
        new ProofValidationError('NUT-11 support is required'),
      );
      const operation = makeInitOp('op-no-nut11');

      await expect(handler.prepare(buildPrepareContext(operation))).rejects.toThrow(
        'NUT-11 support is required',
      );
      expect(proofService.createOutputsAndIncrementCounters).not.toHaveBeenCalled();
      expect(proofService.reserveProofs).not.toHaveBeenCalled();
    });

    it('should throw if balance is insufficient', async () => {
      const operation = makeInitOp('op-1', { amount: Amount.from(1000) }); // More than available
      (proofRepository.getAvailableProofs as Mock<any>).mockImplementation(
        () => Promise.resolve([makeCoreProof('input-1', 50)]), // Only 50 available
      );

      const ctx = buildPrepareContext(operation);

      await expect(handler.prepare(ctx)).rejects.toThrow(
        'Insufficient balance: need 1000, have 50',
      );
    });

    it('should always set needsSwap to true for P2PK', async () => {
      const operation = makeInitOp('op-1');
      const ctx = buildPrepareContext(operation);

      const result = await handler.prepare(ctx);

      expect(result.needsSwap).toBe(true);
    });

    it('should prepare operation with correct structure', async () => {
      const operation = makeInitOp('op-1');
      const ctx = buildPrepareContext(operation);

      const result = await handler.prepare(ctx);

      expect(result.state).toBe('prepared');
      expect(result.method).toBe('p2pk');
      expect(result.methodData).toEqual({ pubkey: testPubkey });
      expect(result.inputProofSecrets).toEqual(['input-1', 'input-2']);
      expect(result.outputData).toBeDefined();
    });

    it('should create P2PK outputs from legacy pubkey method data', async () => {
      const operation = makeInitOp('op-legacy', {
        methodData: { pubkey: testPubkey },
      });

      const result = await handler.prepare(buildPrepareContext(operation));
      const [secret] = getSendSecretPayloads(result);

      expect(secret).toEqual([
        'P2PK',
        expect.objectContaining({
          data: testPubkey,
        }),
      ]);
    });

    it('should create P2PK outputs from structured NUT-11 options', async () => {
      const options: P2pkSendOptions = {
        pubkey: [testPubkey, secondPubkey],
        requiredSignatures: 2,
        locktime: 1_735_689_600,
        refundKeys: [refundPubkey, secondRefundPubkey],
        requiredRefundSignatures: 2,
        sigFlag: 'SIG_ALL',
        additionalTags: [['memo', 'preserve-me']],
      };
      const operation = makeInitOp('op-structured', {
        methodData: { options },
      });

      const result = await handler.prepare(buildPrepareContext(operation));
      const [secret] = getSendSecretPayloads(result);

      expect(Array.isArray(secret)).toBe(true);
      const [kind, payload] = secret as [string, { nonce: string; data: string; tags: string[][] }];
      expect(kind).toBe('P2PK');
      expect(payload.nonce).toEqual(expect.any(String));
      expect(payload.data).toBe(testPubkey);
      expect(payload.tags).toEqual(
        expect.arrayContaining([
          ['pubkeys', secondPubkey],
          ['n_sigs', '2'],
          ['locktime', '1735689600'],
          ['refund', refundPubkey, secondRefundPubkey],
          ['n_sigs_refund', '2'],
          ['sigflag', 'SIG_ALL'],
          ['memo', 'preserve-me'],
        ]),
      );
    });

    it('should reject structured P2PK options with hashlock data', async () => {
      const operation = makeInitOp('op-hashlock', {
        methodData: {
          options: {
            pubkey: testPubkey,
            hashlock: 'hash',
          } as unknown as P2pkSendOptions,
        },
      });

      await expect(handler.prepare(buildPrepareContext(operation))).rejects.toThrow(
        'P2PK send does not support hashlock/HTLC options',
      );
      expect(mintService.assertNutSupported).not.toHaveBeenCalled();
    });

    it('should reserve proofs for the operation', async () => {
      const operation = makeInitOp('op-1');
      const ctx = buildPrepareContext(operation);

      await handler.prepare(ctx);

      expect(proofService.reserveProofs).toHaveBeenCalledWith(
        mintUrl,
        ['input-1', 'input-2'],
        'op-1',
        { unit: 'sat' },
      );
    });

    it('should create outputs for keep and send amounts', async () => {
      const operation = makeInitOp('op-1', { amount: Amount.from(100) });
      const ctx = buildPrepareContext(operation);

      await handler.prepare(ctx);

      // Selected amount (110) - amount (100) - fee (1) = 9 keep
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(
        mintUrl,
        {
          keep: { amount: Amount.from(9), unit: 'sat' },
          send: { amount: Amount.zero(), unit: 'sat' },
        },
        {},
      );
    });

    it('prepares custom-unit P2PK sends with unit-scoped proof selection and outputs', async () => {
      const operation = makeInitOp('op-usd', { unit: 'usd' });

      const result = await handler.prepare(buildPrepareContext(operation));

      expect(result.unit).toBe('usd');
      expect(proofService.selectProofsToSend).toHaveBeenCalledWith(
        mintUrl,
        { amount: Amount.from(100), unit: 'usd' },
        true,
      );
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(
        mintUrl,
        {
          keep: { amount: Amount.from(9), unit: 'usd' },
          send: { amount: Amount.zero(), unit: 'usd' },
        },
        {},
      );
      expect(proofService.reserveProofs).toHaveBeenCalledWith(
        mintUrl,
        ['input-1', 'input-2'],
        'op-usd',
        { unit: 'usd' },
      );
    });

    it('should throw ProofValidationError when selected proofs do not cover fees', async () => {
      (proofRepository.getAvailableProofs as Mock<any>).mockImplementation(() =>
        Promise.resolve([makeCoreProof('input-1', 60), makeCoreProof('input-2', 40)]),
      );
      (mockWallet.selectProofsToSend as Mock<any>).mockImplementation(() => ({
        send: [makeProof('input-1', 60), makeProof('input-2', 40)],
        keep: [],
      }));

      await expect(
        handler.prepare(buildPrepareContext(makeInitOp('op-underfunded'))),
      ).rejects.toThrow(ProofValidationError);
      await expect(
        handler.prepare(buildPrepareContext(makeInitOp('op-underfunded'))),
      ).rejects.toThrow('Send amount is not sufficient after fees');
      expect(proofService.reserveProofs).not.toHaveBeenCalled();
    });

    it('should log preparation with P2PK pubkey data', async () => {
      const operation = makeInitOp('op-1');
      const ctx = buildPrepareContext(operation);

      await handler.prepare(ctx);

      expect(logger.info).toHaveBeenCalledWith(
        'P2PK send operation prepared',
        expect.objectContaining({
          operationId: 'op-1',
          p2pkPubkey: testPubkey,
        }),
      );
    });
  });

  // ============================================================================
  // Execute Phase Tests - P2PK Locked Proof Creation
  // ============================================================================

  describe('execute', () => {
    describe('P2PK locked proof creation', () => {
      it('should use prepared custom outputs for send outputs', async () => {
        const operation = makeExecutingOp('op-1');
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        // Capture the OutputConfig passed to wallet.send
        let capturedOutputConfig: OutputConfig | undefined;
        (mockWallet.send as Mock<any>).mockImplementation(
          (amount: number, proofs: Proof[], _opts: any, outputConfig: OutputConfig) => {
            capturedOutputConfig = outputConfig;
            return Promise.resolve({
              keep: [makeProof('keep-1', 9)],
              send: [makeProof('send-1', 100)],
            });
          },
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        // Verify the prepared outputs were reused during execution
        expect(capturedOutputConfig).toBeDefined();
        expect(capturedOutputConfig!.send).toEqual({
          type: 'custom',
          data: expect.any(Array),
        });
        expect(capturedOutputConfig!.keep).toEqual({
          type: 'custom',
          data: expect.any(Array),
        });
      });

      it('should pass the correct pubkey from methodData', async () => {
        const customPubkey = '03e5e8d9b1e9e1e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0';
        const operation = makeExecutingOp('op-1', {
          methodData: { pubkey: customPubkey },
          inputProofSecrets: ['input-1', 'input-2'],
        });
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        let capturedOutputConfig: OutputConfig | undefined;
        (mockWallet.send as Mock<any>).mockImplementation(
          (_amount: number, _proofs: Proof[], _opts: any, outputConfig: OutputConfig) => {
            capturedOutputConfig = outputConfig;
            return Promise.resolve({
              keep: [],
              send: [makeProof('send-1', 100)],
            });
          },
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        expect(capturedOutputConfig!.send).toEqual({
          type: 'custom',
          data: expect.any(Array),
        });
      });

      it('should accept structured P2PK method data during execute', async () => {
        const operation = makeExecutingOp('op-structured-execute', {
          methodData: { options: { pubkey: [testPubkey, secondPubkey], requiredSignatures: 2 } },
          inputProofSecrets: ['input-1', 'input-2'],
        });
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        const ctx = buildExecuteContext(operation, inputProofs);

        await expect(handler.execute(ctx)).resolves.toMatchObject({
          status: 'PENDING',
        });
      });

      it('should throw if P2PK target data is missing during execute', async () => {
        const operation = makeExecutingOp('op-1', {
          methodData: {}, // No P2PK target
        });
        const inputProofs = [makeProof('input-1', 110)];

        const ctx = buildExecuteContext(operation, inputProofs);

        await expect(handler.execute(ctx)).rejects.toThrow(
          'P2PK send requires P2PK options or a pubkey in methodData',
        );
      });

      it('should throw if outputData is missing', async () => {
        const operation = makeExecutingOp('op-1', {
          outputData: undefined,
          inputProofSecrets: ['input-1', 'input-2'],
        });
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        const ctx = buildExecuteContext(operation, inputProofs);

        await expect(handler.execute(ctx)).rejects.toThrow(
          'Missing output data for P2PK swap operation',
        );
      });
    });

    describe('proof state management', () => {
      it('should save keep proofs as ready and send proofs as inflight', async () => {
        const operation = makeExecutingOp('op-1');
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        let savedProofs: any[] = [];
        (proofService.saveProofs as Mock<any>).mockImplementation(
          (_mintUrl: string, proofs: any[]) => {
            savedProofs = proofs;
            return Promise.resolve();
          },
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        const keepProofs = savedProofs.filter((p) => p.state === 'ready');
        const sendProofs = savedProofs.filter((p) => p.state === 'inflight');

        expect(keepProofs).toHaveLength(1);
        expect(sendProofs).toHaveLength(1);
        expect(sendProofs[0]?.secret).toBe('send-1');
      });

      it('should mark input proofs as spent after swap', async () => {
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1', 'input-2'],
        });
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        expect(proofService.setProofState).toHaveBeenCalledWith(
          mintUrl,
          ['input-1', 'input-2'],
          'spent',
        );
      });
    });

    describe('token creation', () => {
      it('should return a token with P2PK locked proofs', async () => {
        const operation = makeExecutingOp('op-1');
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        const p2pkLockedProof = makeProof('p2pk-locked-1', 100);
        (mockWallet.send as Mock<any>).mockImplementation(() =>
          Promise.resolve({
            keep: [],
            send: [p2pkLockedProof],
          }),
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        const result = await handler.execute(ctx);

        expect(result.status).toBe('PENDING');
        if (result.status === 'PENDING') {
          const { token } = result;
          expect(token).toBeDefined();
          expect(token?.mint).toBe(mintUrl);
          expect(token?.proofs).toContain(p2pkLockedProof);
          expect(result.pending.token).toEqual(token);
        }
      });
    });

    describe('error handling', () => {
      it('should throw if reserved proofs do not match input secrets', async () => {
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1', 'input-2', 'input-3'], // 3 expected
        });
        // Only 2 proofs provided
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        const ctx = buildExecuteContext(operation, inputProofs);

        await expect(handler.execute(ctx)).rejects.toThrow('Could not find all reserved proofs');
      });
    });
  });

  // ============================================================================
  // Finalize Phase Tests
  // ============================================================================

  describe('finalize', () => {
    it('should release input proof reservations', async () => {
      const operation = makePendingOp('op-1', {
        inputProofSecrets: ['input-1', 'input-2'],
      });

      const ctx = buildFinalizeContext(operation);
      await handler.finalize(ctx);

      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1', 'input-2']);
    });

    it('should release send and keep proof reservations when present', async () => {
      const operation = makePendingOp('op-1');
      const ctx = buildFinalizeContext(operation);

      await handler.finalize(ctx);

      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['send-1']);
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['keep-1']);
    });
  });

  // ============================================================================
  // Rollback Phase Tests
  // ============================================================================

  describe('rollback', () => {
    describe('prepared state rollback', () => {
      it('should release reserved proofs for prepared operation', async () => {
        const operation = makePreparedOp('op-1', {
          inputProofSecrets: ['input-1', 'input-2'],
        });

        const ctx = buildRollbackContext(operation);
        await handler.rollback(ctx);

        expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1', 'input-2']);
      });
    });

    describe('pending state rollback', () => {
      it('should reject pending rollback because P2PK tokens cannot be reclaimed', async () => {
        const operation = makePendingOp('op-1');
        const ctx = buildRollbackContext(operation);

        await expect(handler.rollback(ctx)).rejects.toThrow(
          'P2PK Send Operation in pending state can not be rolled back.',
        );
      });

      it('should not release reservations for pending rollback', async () => {
        const outputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makePendingOp('op-1', {
          inputProofSecrets: ['input-1'],
          outputData,
        });

        const ctx = buildRollbackContext(operation);
        await expect(handler.rollback(ctx)).rejects.toThrow(
          'P2PK Send Operation in pending state can not be rolled back.',
        );
        expect(proofService.releaseProofs).not.toHaveBeenCalled();
      });
    });
  });

  // ============================================================================
  // Recovery Tests
  // ============================================================================

  describe('recoverExecuting', () => {
    describe('swap never executed', () => {
      it('should rollback when input proofs are UNSPENT', async () => {
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1'],
        });

        (mockWallet.checkProofsStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'UNSPENT', Y: 'y1' }]),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('FAILED');
        if (result.status === 'FAILED') {
          expect(result.failed.error).toBe('Recovered: P2PK swap never executed');
        }
        expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1']);
      });
    });

    describe('swap executed', () => {
      it('should recover keep proofs and resurface the token when swap succeeded', async () => {
        const outputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1'],
          outputData,
        });

        (mockWallet.checkProofsStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'SPENT', Y: 'y1' }]),
        );
        let savedProofs: any[] = [];
        (proofService.saveProofs as Mock<any>).mockImplementation(
          (_mintUrl: string, proofs: any[]) => {
            savedProofs = [...savedProofs, ...proofs];
            return Promise.resolve();
          },
        );
        (proofService.recoverProofsFromOutputData as Mock<any>).mockImplementation(
          (_mintUrl: string, serializedOutputData: any, options?: any) => {
            if (serializedOutputData.send.length > 0) {
              expect(options).toEqual({ persistRecoveredProofs: false, unit: 'sat' });
              return Promise.resolve([makeProof('send-1', 100)]);
            }
            return Promise.resolve([]);
          },
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('PENDING');
        expect(proofService.recoverProofsFromOutputData).toHaveBeenCalledWith(
          mintUrl,
          {
            keep: outputData.keep,
            send: [],
          },
          {
            createdByOperationId: 'op-1',
            unit: 'sat',
          },
        );
        expect(proofService.recoverProofsFromOutputData).toHaveBeenCalledWith(
          mintUrl,
          {
            keep: [],
            send: outputData.send,
          },
          {
            persistRecoveredProofs: false,
            unit: 'sat',
          },
        );
        if (result.status === 'PENDING') {
          expect(result.token?.proofs).toEqual([makeProof('send-1', 100)]);
          expect(result.pending.token).toEqual(result.token);
        }
        expect(savedProofs.filter((proof) => proof.secret === 'send-1')).toEqual([
          expect.objectContaining({
            secret: 'send-1',
            state: 'inflight',
            createdByOperationId: 'op-1',
          }),
        ]);
      });

      it('should mark input proofs as spent after recovery', async () => {
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1'],
        });

        (mockWallet.checkProofsStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'SPENT', Y: 'y1' }]),
        );

        const ctx = buildRecoverContext(operation);
        await handler.recoverExecuting(ctx);

        expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');
      });

      it('should return pending without a token when the reconstructed send proofs are already spent', async () => {
        const operation = makeExecutingOp('op-1');

        (mockWallet.checkProofsStates as Mock<any>)
          .mockImplementationOnce(() => Promise.resolve([{ state: 'SPENT', Y: 'y1' }]))
          .mockImplementationOnce(() => Promise.resolve([{ state: 'SPENT', Y: 'y-send' }]));
        (proofService.recoverProofsFromOutputData as Mock<any>).mockImplementation(() =>
          Promise.resolve([]),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('PENDING');
        if (result.status === 'PENDING') {
          expect(result.token).toBeUndefined();
          expect(result.pending.token).toBeUndefined();
        }
      });
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle empty keep outputs gracefully', async () => {
      const operation = makeExecutingOp('op-1');
      const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

      (mockWallet.send as Mock<any>).mockImplementation(() =>
        Promise.resolve({
          keep: [], // No keep proofs
          send: [makeProof('send-1', 100)],
        }),
      );

      const ctx = buildExecuteContext(operation, inputProofs);
      const result = await handler.execute(ctx);

      expect(result.status).toBe('PENDING');
    });

    it('should handle multiple send proofs', async () => {
      const operation = makeExecutingOp('op-1');
      const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

      (mockWallet.send as Mock<any>).mockImplementation(() =>
        Promise.resolve({
          keep: [makeProof('keep-1', 9)],
          send: [makeProof('send-1', 50), makeProof('send-2', 50)],
        }),
      );

      const ctx = buildExecuteContext(operation, inputProofs);
      const result = await handler.execute(ctx);

      expect(result.status).toBe('PENDING');
      if (result.status === 'PENDING') {
        expect(result.token?.proofs).toHaveLength(2);
      }
    });
  });
});
