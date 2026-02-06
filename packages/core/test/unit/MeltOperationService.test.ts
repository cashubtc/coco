import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import { MemoryMeltOperationRepository } from '../../repositories/memory/MemoryMeltOperationRepository.ts';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { MintService } from '../../services/MintService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { MeltHandlerProvider } from '../../infra/handlers/index.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { CoreProof } from '../../types.ts';
import type {
  InitMeltOperation,
  PreparedMeltOperation,
  ExecutingMeltOperation,
  PendingMeltOperation,
  FinalizedMeltOperation,
} from '../../operations/melt/MeltOperation.ts';
import type {
  MeltMethodHandler,
  PendingCheckResult,
} from '../../operations/melt/MeltMethodHandler.ts';
import {
  UnknownMintError,
  ProofValidationError,
  OperationInProgressError,
} from '../../models/Error.ts';

describe('MeltOperationService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const invoice = 'lnbc1000n1...';

  let meltOperationRepository: MemoryMeltOperationRepository;
  let proofRepository: MemoryProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let mintAdapter: MintAdapter;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let handlerProvider: MeltHandlerProvider;
  let handler: MeltMethodHandler;
  let service: MeltOperationService;

  const makeProof = (secret: string, overrides?: Partial<CoreProof>): CoreProof =>
    ({
      amount: 10,
      C: `C_${secret}` as unknown as any,
      id: keysetId,
      secret,
      mintUrl,
      state: 'ready',
      ...overrides,
    } as CoreProof);

  const makeInitOp = (id: string, overrides?: Partial<InitMeltOperation>): InitMeltOperation => ({
    id,
    state: 'init',
    mintUrl,
    unit: 'sat',
    method: 'bolt11',
    methodData: { invoice },
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    ...overrides,
  });

  const makePreparedOp = (
    id: string,
    overrides?: Partial<PreparedMeltOperation>,
  ): PreparedMeltOperation => ({
    ...makeInitOp(id),
    state: 'prepared',
    quoteId: 'quote-1',
    amount: 100,
    fee_reserve: 1,
    swap_fee: 0,
    needsSwap: false,
    inputAmount: 101,
    inputProofSecrets: ['proof-1'],
    changeOutputData: { keep: [], send: [] },
    ...overrides,
  });

  const makeExecutingOp = (
    id: string,
    overrides?: Partial<ExecutingMeltOperation>,
  ): ExecutingMeltOperation => ({
    ...makePreparedOp(id),
    state: 'executing',
    ...overrides,
  });

  const makePendingOp = (
    id: string,
    overrides?: Partial<PendingMeltOperation>,
  ): PendingMeltOperation => ({
    ...makePreparedOp(id),
    state: 'pending',
    ...overrides,
  });

  beforeEach(() => {
    meltOperationRepository = new MemoryMeltOperationRepository();
    proofRepository = new MemoryProofRepository();
    eventBus = new EventBus<CoreEvents>();

    handler = {
      prepare: mock(async ({ operation }) =>
        makePreparedOp(operation.id, {
          mintUrl: operation.mintUrl,
          method: operation.method,
          methodData: operation.methodData,
        }),
      ),
      execute: mock(async ({ operation }) => ({
        status: 'PAID',
        finalized: {
          ...operation,
          state: 'finalized',
        } as FinalizedMeltOperation,
      })),
      finalize: mock(async () => {}),
      rollback: mock(async () => {}),
      checkPending: mock(async () => 'stay_pending' as PendingCheckResult),
      recoverExecuting: mock(async ({ operation }) => ({
        status: 'PENDING',
        pending: {
          ...operation,
          state: 'pending',
        } as PendingMeltOperation,
      })),
    } as MeltMethodHandler;

    handlerProvider = {
      get: mock(() => handler),
    } as unknown as MeltHandlerProvider;

    proofService = {
      releaseProofs: mock(async () => {}),
    } as unknown as ProofService;

    mintService = {
      isTrustedMint: mock(async () => true),
    } as unknown as MintService;

    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({ wallet: {} })),
    } as unknown as WalletService;

    mintAdapter = {} as MintAdapter;

    logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    } as Logger;

    service = new MeltOperationService(
      handlerProvider,
      meltOperationRepository,
      proofRepository,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
      logger,
    );
  });

  describe('init', () => {
    it('creates an init operation for trusted mint', async () => {
      const operation = await service.init(mintUrl, 'bolt11', { invoice });

      expect(operation.state).toBe('init');
      const stored = await meltOperationRepository.getById(operation.id);
      expect(stored?.mintUrl).toBe(mintUrl);
    });

    it('throws when mint is untrusted', async () => {
      (mintService.isTrustedMint as Mock<any>).mockResolvedValue(false);

      expect(service.init(mintUrl, 'bolt11', { invoice })).rejects.toThrow(UnknownMintError);
    });

    it('throws for invalid amount', async () => {
      expect(service.init(mintUrl, 'bolt11', { invoice, amountSats: -1 })).rejects.toThrow(
        ProofValidationError,
      );
    });
  });

  describe('prepare', () => {
    it('prepares operation and emits event', async () => {
      const initOp = makeInitOp('op-1');
      await meltOperationRepository.create(initOp);

      const events: any[] = [];
      eventBus.on('melt-op:prepared', (payload) => void events.push(payload));

      const prepared = await service.prepare('op-1');

      expect(prepared.state).toBe('prepared');
      expect(events.length).toBe(1);
      const stored = await meltOperationRepository.getById('op-1');
      expect(stored?.state).toBe('prepared');
    });

    it('recovers init operation when handler fails', async () => {
      const initOp = makeInitOp('op-2');
      await meltOperationRepository.create(initOp);
      await proofRepository.saveProofs(mintUrl, [
        makeProof('reserved', { usedByOperationId: 'op-2' }),
      ]);

      (handler.prepare as Mock<any>).mockRejectedValue(new Error('prepare failed'));

      expect(service.prepare('op-2')).rejects.toThrow('prepare failed');
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['reserved']);
      expect(await meltOperationRepository.getById('op-2')).toBeNull();
    });

    it('throws when operation already in progress', async () => {
      const initOp = makeInitOp('op-3');
      await meltOperationRepository.create(initOp);

      let releasePrepare: () => void;
      (handler.prepare as Mock<any>).mockImplementation(
        () => new Promise((resolve) => (releasePrepare = () => resolve(makePreparedOp('op-3')))),
      );

      const first = service.prepare('op-3');
      await Promise.resolve();

      expect(service.prepare('op-3')).rejects.toThrow(OperationInProgressError);

      releasePrepare!();
      await first;
    });
  });

  describe('execute', () => {
    it('finalizes immediately on PAID response', async () => {
      const prepared = makePreparedOp('op-4');
      await meltOperationRepository.create(prepared);
      await proofRepository.saveProofs(mintUrl, [
        makeProof('proof-1', { usedByOperationId: 'op-4' }),
      ]);

      const events: any[] = [];
      eventBus.on('melt-op:finalized', (payload) => void events.push(payload));

      const result = await service.execute('op-4');

      expect(result.state).toBe('finalized');
      expect(events.length).toBe(1);
      const stored = await meltOperationRepository.getById('op-4');
      expect(stored?.state).toBe('finalized');
    });

    it('moves to pending on PENDING response', async () => {
      const prepared = makePreparedOp('op-5');
      await meltOperationRepository.create(prepared);

      (handler.execute as Mock<any>).mockResolvedValue({
        status: 'PENDING',
        pending: makePendingOp('op-5'),
      });

      const events: any[] = [];
      eventBus.on('melt-op:pending', (payload) => void events.push(payload));

      const result = await service.execute('op-5');

      expect(result.state).toBe('pending');
      expect(events.length).toBe(1);
      const stored = await meltOperationRepository.getById('op-5');
      expect(stored?.state).toBe('pending');
    });

    it('recovers executing operation on handler failure', async () => {
      const prepared = makePreparedOp('op-6');
      await meltOperationRepository.create(prepared);

      (handler.execute as Mock<any>).mockResolvedValue({
        status: 'FAILED',
        failed: { error: 'nope' },
      });

      expect(service.execute('op-6')).rejects.toThrow('nope');
      expect(handler.recoverExecuting).toHaveBeenCalled();
    });
  });

  describe('finalize', () => {
    it('finalizes pending operation and emits event', async () => {
      const pending = makePendingOp('op-7');
      await meltOperationRepository.create(pending);

      const events: any[] = [];
      eventBus.on('melt-op:finalized', (payload) => void events.push(payload));

      await service.finalize('op-7');

      expect(handler.finalize).toHaveBeenCalled();
      expect(events.length).toBe(1);
      const stored = await meltOperationRepository.getById('op-7');
      expect(stored?.state).toBe('finalized');
    });

    it('returns early if already finalized', async () => {
      const finalized = {
        ...makePreparedOp('op-8'),
        state: 'finalized' as const,
      };
      await meltOperationRepository.create(finalized);

      await service.finalize('op-8');

      expect(handler.finalize).not.toHaveBeenCalled();
    });
  });

  describe('rollback', () => {
    it('rolls back prepared operation and emits event', async () => {
      const prepared = makePreparedOp('op-9');
      await meltOperationRepository.create(prepared);

      const events: any[] = [];
      eventBus.on('melt-op:rolled-back', (payload) => void events.push(payload));

      await service.rollback('op-9');

      expect(handler.rollback).toHaveBeenCalled();
      expect(events.length).toBe(1);
      const stored = await meltOperationRepository.getById('op-9');
      expect(stored?.state).toBe('rolled_back');
    });

    it('throws when pending quote is not UNPAID', async () => {
      const pending = makePendingOp('op-10');
      await meltOperationRepository.create(pending);

      (handler.checkPending as Mock<any>).mockResolvedValue('stay_pending');

      expect(service.rollback('op-10')).rejects.toThrow(
        'Cannot rollback pending operation: quote state is not UNPAID',
      );
    });
  });

  describe('checkPendingOperation', () => {
    it('delegates to finalize when handler returns finalize', async () => {
      const pending = makePendingOp('op-11');
      await meltOperationRepository.create(pending);

      (handler.checkPending as Mock<any>).mockResolvedValue('finalize');
      (service as any).finalize = mock(async () => {});

      const result = await service.checkPendingOperation('op-11');

      expect(result).toBe('finalize');
      expect((service as any).finalize).toHaveBeenCalledWith('op-11');
    });
  });

  describe('recoverPendingOperations', () => {
    it('cleans up init operations and releases proofs', async () => {
      await meltOperationRepository.create(makeInitOp('init-op'));
      await proofRepository.saveProofs(mintUrl, [
        makeProof('reserved', { usedByOperationId: 'init-op' }),
      ]);

      await service.recoverPendingOperations();

      expect(await meltOperationRepository.getById('init-op')).toBeNull();
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['reserved']);
    });

    it('recovers executing operations via handler', async () => {
      await meltOperationRepository.create(makeExecutingOp('exec-op'));

      const events: any[] = [];
      eventBus.on('melt-op:pending', (payload) => void events.push(payload));

      await service.recoverPendingOperations();

      expect(handler.recoverExecuting).toHaveBeenCalled();
      expect(events.length).toBe(1);
    });
  });

  describe('queries', () => {
    it('returns pending operations', async () => {
      await meltOperationRepository.create(makeExecutingOp('pending-1'));
      await meltOperationRepository.create(makePendingOp('pending-2'));

      const pending = await service.getPendingOperations();

      expect(pending.map((op) => op.id).sort()).toEqual(['pending-1', 'pending-2']);
    });

    it('returns operation by quote id when present', async () => {
      const prepared = makePreparedOp('op-quote', { quoteId: 'quote-123' });
      await meltOperationRepository.create(prepared);

      const operation = await service.getOperationByQuote(mintUrl, 'quote-123');

      expect(operation?.id).toBe('op-quote');
    });

    it('returns null when quote id is not found', async () => {
      await meltOperationRepository.create(makePreparedOp('op-quote', { quoteId: 'quote-456' }));

      const operation = await service.getOperationByQuote(mintUrl, 'missing-quote');

      expect(operation).toBeNull();
    });

    it('throws when multiple operations share a quote id', async () => {
      await meltOperationRepository.create(makePreparedOp('op-quote-1', { quoteId: 'quote-dupe' }));
      await meltOperationRepository.create(makePreparedOp('op-quote-2', { quoteId: 'quote-dupe' }));

      expect(service.getOperationByQuote(mintUrl, 'quote-dupe')).rejects.toThrow(
        'melt operations',
      );
    });
  });
});
