import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { type Proof, type Wallet, type OutputConfig } from '@cashu/cashu-ts';
import { DefaultSendHandler } from '../../infra/handlers/send/DefaultSendHandler';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import type { ProofRepository } from '../../repositories';
import type { ProofService } from '../../services/ProofService';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { CoreProof } from '../../types';
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
  RollbackContext,
  RecoverExecutingContext,
} from '../../operations/send/SendMethodHandler';
import { ProofValidationError } from '../../models/Error';

describe('DefaultSendHandler', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';

  let handler: DefaultSendHandler;
  let proofRepository: ProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let mockWallet: Wallet;

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

  const useOperationProofs = (proofs: CoreProof[]) => {
    proofRepository = {
      ...proofRepository,
      getProofsByOperationId: mock(() => Promise.resolve(proofs)),
    } as ProofRepository;
  };

  const makeInitOp = (id: string, overrides?: Partial<InitSendOperation>): InitSendOperation => ({
    id,
    state: 'init',
    mintUrl,
    amount: Amount.from(100),
    method: 'default',
    methodData: {},
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
    method: 'default',
    methodData: {},
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    needsSwap: true,
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

  beforeEach(() => {
    handler = new DefaultSendHandler();
    eventBus = new EventBus<CoreEvents>();

    mockWallet = {
      selectProofsToSend: mock((proofs: Proof[], amount: Amount, includeFees: boolean) => {
        if (!includeFees) {
          const exact = proofs.find((proof) => proof.amount.equals(amount));
          if (exact) {
            return { send: [exact], keep: proofs.filter((proof) => proof.secret !== exact.secret) };
          }
        }

        const send: Proof[] = [];
        let total = Amount.zero();
        for (const proof of proofs) {
          if (total.greaterThanOrEqual(amount)) break;
          send.push(proof);
          total = total.add(proof.amount);
        }

        return {
          send,
          keep: proofs.filter(
            (proof) => !send.some((selected) => selected.secret === proof.secret),
          ),
        };
      }),
      getFeesForProofs: mock(() => Amount.from(1)),
      send: mock(() =>
        Promise.resolve({
          keep: [makeProof('keep-1', 9)],
          send: [makeProof('send-1', 100)],
        }),
      ),
      receive: mock(() => Promise.resolve([makeProof('reclaim-1', 99)])),
      checkProofsStates: mock(() => Promise.resolve([{ state: 'UNSPENT', Y: 'y1' }])),
      unit: 'sat',
    } as unknown as Wallet;

    proofRepository = {
      getAvailableProofs: mock(() =>
        Promise.resolve([makeCoreProof('proof-100', 100), makeCoreProof('proof-5', 5)]),
      ),
      getProofsByOperationId: mock(() => Promise.resolve([])),
    } as unknown as ProofRepository;

    proofService = {
      selectProofsToSend: mock(
        async (
          selectedMintUrl: string,
          intent: { amount: Amount; unit: string },
          includeFees: boolean = true,
        ) => {
          const proofs = await proofRepository.getAvailableProofs(selectedMintUrl);
          return mockWallet.selectProofsToSend(proofs, intent.amount, includeFees).send;
        },
      ),
      reserveProofs: mock(() => Promise.resolve({ amount: Amount.from(100) })),
      releaseProofs: mock(() => Promise.resolve()),
      createOutputsAndIncrementCounters: mock(() =>
        Promise.resolve({
          keep: createMockOutputData(['keep-1'], []).keep,
          send: createMockOutputData([], ['send-1']).send,
          sendAmount: Amount.from(100),
          keepAmount: Amount.from(9),
        }),
      ),
      setProofState: mock(() => Promise.resolve()),
      restoreProofsToReady: mock(() => Promise.resolve()),
      saveProofs: mock(() => Promise.resolve()),
      recoverProofsFromOutputData: mock(() => Promise.resolve([])),
    } as unknown as ProofService;

    mintService = {
      isTrustedMint: mock(() => Promise.resolve(true)),
    } as unknown as MintService;

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

    logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    } as Logger;
  });

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

  describe('prepare', () => {
    it('prepares an exact-match send without swap data', async () => {
      const operation = makeInitOp('op-exact');

      const result = await handler.prepare(buildPrepareContext(operation));

      expect(result.state).toBe('prepared');
      expect(result.needsSwap).toBe(false);
      expect(result.fee).toEqual(Amount.zero());
      expect(result.outputData).toBe(undefined);
      expect(result.inputProofSecrets).toEqual(['proof-100']);
      expect(proofService.createOutputsAndIncrementCounters).not.toHaveBeenCalled();
      expect(proofService.reserveProofs).toHaveBeenCalledWith(mintUrl, ['proof-100'], 'op-exact', {
        unit: 'sat',
      });
    });

    it('prepares a swap send when no exact match exists', async () => {
      (proofRepository.getAvailableProofs as Mock<any>).mockImplementation(() =>
        Promise.resolve([makeCoreProof('input-1', 60), makeCoreProof('input-2', 50)]),
      );

      const result = await handler.prepare(buildPrepareContext(makeInitOp('op-swap')));

      expect(result.needsSwap).toBe(true);
      expect(result.fee).toEqual(Amount.from(1));
      expect(result.outputData).toBeDefined();
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(
        mintUrl,
        {
          keep: { amount: Amount.from(9), unit: 'sat' },
          send: { amount: Amount.from(100), unit: 'sat' },
        },
        {},
      );
    });

    it('throws ProofValidationError when selected proofs do not cover fees', async () => {
      (proofService.selectProofsToSend as Mock<any>).mockImplementation(
        (
          _mintUrl: string,
          _intent: { amount: Amount; unit: string },
          includeFees: boolean = true,
        ) => {
          return Promise.resolve(
            includeFees ? [makeProof('input-1', 60), makeProof('input-2', 40)] : [],
          );
        },
      );

      await expect(
        handler.prepare(buildPrepareContext(makeInitOp('op-underfunded'))),
      ).rejects.toThrow(ProofValidationError);
      await expect(
        handler.prepare(buildPrepareContext(makeInitOp('op-underfunded'))),
      ).rejects.toThrow('Send amount is not sufficient after fees');
      expect(proofService.reserveProofs).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('marks exact-match proofs inflight without saving replacement proofs', async () => {
      const operation = makeExecutingOp('op-exact', {
        needsSwap: false,
        fee: Amount.from(0),
        inputAmount: Amount.from(100),
        inputProofSecrets: ['proof-100'],
        outputData: undefined,
      });
      const proof = makeProof('proof-100', 100);

      const result = await handler.execute(buildExecuteContext(operation, [proof]));

      expect(result.status).toBe('PENDING');
      if (result.status === 'PENDING') {
        expect(result.token?.proofs).toEqual([proof]);
        expect(result.pending.token).toEqual(result.token);
      }
      expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['proof-100'], 'inflight');
      expect(proofService.saveProofs).not.toHaveBeenCalled();
    });

    it('executes a swap send using stored outputs and persists proof states', async () => {
      const operation = makeExecutingOp('op-swap');
      const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];
      let capturedOutputConfig: OutputConfig | undefined;

      (mockWallet.send as Mock<any>).mockImplementation(
        (_amount: number, _proofs: Proof[], _opts: unknown, outputConfig: OutputConfig) => {
          capturedOutputConfig = outputConfig;
          return Promise.resolve({
            keep: [makeProof('keep-1', 9)],
            send: [makeProof('send-1', 100)],
          });
        },
      );

      const result = await handler.execute(buildExecuteContext(operation, inputProofs));

      expect(result.status).toBe('PENDING');
      if (result.status === 'PENDING') {
        expect(result.pending.token).toEqual(result.token);
      }
      expect(capturedOutputConfig?.send).toEqual({ type: 'custom', data: expect.any(Array) });
      expect(capturedOutputConfig?.keep).toEqual({ type: 'custom', data: expect.any(Array) });
      expect(proofService.saveProofs).toHaveBeenCalledWith(
        mintUrl,
        expect.arrayContaining([
          expect.objectContaining({ secret: 'keep-1', state: 'ready' }),
          expect.objectContaining({
            secret: 'send-1',
            state: 'inflight',
            createdByOperationId: 'op-swap',
          }),
        ]),
      );
      expect(proofService.setProofState).toHaveBeenCalledWith(
        mintUrl,
        ['input-1', 'input-2'],
        'spent',
      );
    });

    it('encodes custom-unit swap sends and replacement proofs with the operation unit', async () => {
      const operation = makeExecutingOp('op-usd', { unit: 'usd' });
      const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

      const result = await handler.execute(buildExecuteContext(operation, inputProofs));

      expect(result.status).toBe('PENDING');
      if (result.status === 'PENDING') {
        expect(result.token?.unit).toBe('usd');
        expect(result.pending.unit).toBe('usd');
      }
      expect(proofService.saveProofs).toHaveBeenCalledWith(
        mintUrl,
        expect.arrayContaining([
          expect.objectContaining({ secret: 'keep-1', unit: 'usd', state: 'ready' }),
          expect.objectContaining({ secret: 'send-1', unit: 'usd', state: 'inflight' }),
        ]),
      );
    });
  });

  describe('finalize', () => {
    it('releases input, send, and keep reservations', async () => {
      await handler.finalize(buildFinalizeContext(makePendingOp('op-finalize')));

      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1', 'input-2']);
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['send-1']);
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['keep-1']);
    });
  });

  describe('rollback', () => {
    it('releases reserved proofs for a prepared operation', async () => {
      await handler.rollback(buildRollbackContext(makePreparedOp('op-prepared')));

      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1', 'input-2']);
    });

    it('reclaims inflight send proofs for a pending operation', async () => {
      const operation = makePendingOp('op-pending', {
        inputProofSecrets: ['input-1'],
        outputData: createMockOutputData(['keep-1'], ['send-1']),
      });
      const sendProof = makeCoreProof('send-1', 100, {
        state: 'inflight',
        createdByOperationId: 'op-pending',
      });

      useOperationProofs([sendProof]);
      (mockWallet.receive as Mock<any>).mockImplementation(() =>
        Promise.resolve([makeProof('reclaim-1', 99)]),
      );

      await handler.rollback(buildRollbackContext(operation));

      const receiveArgs = (mockWallet.receive as Mock<any>).mock.calls[0];

      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(
        mintUrl,
        {
          keep: { amount: Amount.from(99), unit: 'sat' },
          send: { amount: Amount.zero(), unit: 'sat' },
        },
        {},
      );
      expect(receiveArgs).toBeDefined();
      expect(
        receiveArgs?.some(
          (arg: unknown) =>
            typeof arg === 'object' &&
            arg !== null &&
            'type' in arg &&
            (arg as { type?: string }).type === 'custom',
        ),
      ).toBe(true);
      expect(proofService.saveProofs).toHaveBeenCalledWith(
        mintUrl,
        expect.arrayContaining([expect.objectContaining({ secret: 'reclaim-1', state: 'ready' })]),
      );
      expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['send-1'], 'spent');
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1']);
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['keep-1']);
    });

    it('reclaims exact-match pending proofs through the mint', async () => {
      const operation = makePendingOp('op-exact-pending', {
        needsSwap: false,
        fee: Amount.zero(),
        inputAmount: Amount.from(100),
        inputProofSecrets: ['proof-100'],
        outputData: undefined,
      });
      const sendProof = makeCoreProof('proof-100', 100, {
        state: 'inflight',
        createdByOperationId: 'op-exact-pending',
      });

      useOperationProofs([sendProof]);

      await handler.rollback(buildRollbackContext(operation));

      expect(proofService.restoreProofsToReady).not.toHaveBeenCalled();
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(
        mintUrl,
        {
          keep: { amount: Amount.from(99), unit: 'sat' },
          send: { amount: Amount.zero(), unit: 'sat' },
        },
        {},
      );
      expect(mockWallet.receive).toHaveBeenCalled();
    });
  });

  describe('recoverExecuting', () => {
    it('rolls back an exact-match executing operation without mint recovery', async () => {
      const operation = makeExecutingOp('op-recover-exact', {
        needsSwap: false,
        fee: Amount.from(0),
        inputAmount: Amount.from(100),
        inputProofSecrets: ['proof-100'],
        outputData: undefined,
      });

      const result = await handler.recoverExecuting(buildRecoverContext(operation));

      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') {
        expect(result.failed.error).toBe('Recovered: no swap needed, operation never finalized');
      }
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['proof-100']);
      expect(mockWallet.checkProofsStates).not.toHaveBeenCalled();
    });

    it('recovers swap proofs when the mint already spent the inputs', async () => {
      const operation = makeExecutingOp('op-recover-swap', {
        inputProofSecrets: ['input-1'],
        outputData: createMockOutputData(['keep-1'], ['send-1']),
      });

      (mockWallet.checkProofsStates as Mock<any>).mockImplementation(() =>
        Promise.resolve([{ state: 'SPENT', Y: 'y1' }]),
      );
      (proofService.recoverProofsFromOutputData as Mock<any>).mockImplementation(() =>
        Promise.resolve([makeCoreProof('keep-1', 10), makeCoreProof('send-1', 100)]),
      );

      const result = await handler.recoverExecuting(buildRecoverContext(operation));

      expect(result.status).toBe('FAILED');
      expect(proofService.recoverProofsFromOutputData).toHaveBeenCalledWith(
        mintUrl,
        operation.outputData,
        {
          createdByOperationId: 'op-recover-swap',
          unit: 'sat',
        },
      );
      expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');
      if (result.status === 'FAILED') {
        expect(result.failed.error).toBe('Recovered: swap succeeded but token never returned');
      }
    });
  });
});
