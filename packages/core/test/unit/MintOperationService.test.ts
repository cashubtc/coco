import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { OutputData, type MintQuoteBolt11Response, type Proof } from '@cashu/cashu-ts';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import { MintOperationService } from '../../operations/mint/MintOperationService';
import type {
  ExecutingMintOperation,
  InitMintOperation,
  PendingMintOperation,
} from '../../operations/mint/MintOperation';
import type {
  MintExecutionResult,
  MintMethodHandler,
  PendingMintCheckResult,
  RecoverExecutingResult,
} from '../../operations/mint/MintMethodHandler';
import type { MintHandlerProvider } from '../../infra/handlers/mint';
import { MemoryMintOperationRepository } from '../../repositories/memory/MemoryMintOperationRepository';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { MintAdapter } from '../../infra/MintAdapter';
import { serializeOutputData } from '../../utils';
import type { CoreProof } from '../../types';

describe('MintOperationService', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-1';
  const keysetId = 'keyset-1';

  let operationRepo: MemoryMintOperationRepository;
  let proofRepo: MemoryProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let mintAdapter: MintAdapter;
  let eventBus: EventBus<CoreEvents>;
  let handler: MintMethodHandler<'bolt11'>;
  let handlerProvider: MintHandlerProvider;
  let service: MintOperationService;

  const makeProof = (secret: string): Proof =>
    ({
      id: keysetId,
      amount: 10,
      secret,
      C: `C_${secret}`,
    }) as Proof;

  const makeSerializedOutputData = (secret: string) =>
    serializeOutputData({
      keep: [
        new OutputData(
          {
            amount: 10,
            id: keysetId,
            B_: `B_${secret}`,
          },
          BigInt(1),
          new TextEncoder().encode(secret),
        ),
      ],
      send: [],
    });

  const toCoreProof = (secret: string, operationId: string): CoreProof => ({
    id: keysetId,
    amount: 10,
    secret,
    C: `C_${secret}`,
    mintUrl,
    state: 'ready',
    createdByOperationId: operationId,
  });

  const makeInitOp = (id: string): InitMintOperation => ({
    id,
    state: 'init',
    mintUrl,
    method: 'bolt11',
    methodData: {},
    amount: 10,
    unit: 'sat',
    quoteId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const makePendingOp = (id: string, secret = 'out-1'): PendingMintOperation => ({
    ...makeInitOp(id),
    state: 'pending',
    quoteId,
    amount: 10,
    request: 'lnbc1test',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    lastObservedRemoteState: 'PAID',
    lastObservedRemoteStateAt: Date.now(),
    outputData: makeSerializedOutputData(secret),
  });

  const makeExecutingOp = (id: string, secret = 'out-1'): ExecutingMintOperation => ({
    ...makePendingOp(id, secret),
    state: 'executing',
  });

  beforeEach(async () => {
    operationRepo = new MemoryMintOperationRepository();
    proofRepo = new MemoryProofRepository();
    eventBus = new EventBus<CoreEvents>();

    const mockPrepare = mock(async ({ operation }: { operation: InitMintOperation }) => {
      return makePendingOp(operation.id);
    });

    const mockExecute = mock(async (): Promise<MintExecutionResult> => {
      return { status: 'ISSUED', proofs: [makeProof('out-1')] };
    });

    const mockRecoverExecuting = mock(async (): Promise<RecoverExecutingResult> => {
      return { status: 'PENDING' };
    });

    const mockCheckPending = mock(
      async (): Promise<PendingMintCheckResult<'bolt11'>> => ({
        observedRemoteState: 'UNPAID',
        observedRemoteStateAt: Date.now(),
        category: 'waiting',
      }),
    );

    handler = {
      prepare: mockPrepare,
      execute: mockExecute,
      recoverExecuting: mockRecoverExecuting,
      checkPending: mockCheckPending,
    };

    handlerProvider = {
      get: mock(() => handler),
    } as unknown as MintHandlerProvider;

    proofService = {
      saveProofs: mock(async (_mintUrl: string, proofs: CoreProof[]) => {
        await proofRepo.saveProofs(mintUrl, proofs);
      }),
      recoverProofsFromOutputData: mock(async (_mintUrl: string, _outputData, options) => {
        if (!options?.createdByOperationId) {
          return [];
        }
        await proofRepo.saveProofs(mintUrl, [toCoreProof('out-1', options.createdByOperationId)]);
        return [makeProof('out-1')];
      }),
    } as unknown as ProofService;

    mintService = {
      isTrustedMint: mock(async () => true),
    } as unknown as MintService;

    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({ wallet: {} })),
    } as unknown as WalletService;

    mintAdapter = {} as MintAdapter;

    service = new MintOperationService(
      handlerProvider,
      operationRepo,
      proofRepo,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
    );
  });

  it('prepareNewQuote persists a pending operation and emits mint-op:pending', async () => {
    const pendingEvents: Array<CoreEvents['mint-op:pending']> = [];
    eventBus.on('mint-op:pending', (event) => {
      pendingEvents.push(event);
    });

    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({ operation }: { operation: InitMintOperation }) => ({
        ...makePendingOp(operation.id),
        quoteId: 'quote-created',
        request: 'lnbc1created',
        lastObservedRemoteState: 'UNPAID',
      }),
    );

    const pending = await service.prepareNewQuote(mintUrl, 10, 'sat');

    expect(pending.state).toBe('pending');
    expect(pending.quoteId).toBe('quote-created');
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.operationId).toBe(pending.id);
    const createdOperation = pendingEvents[0]?.operation as PendingMintOperation | undefined;
    expect(createdOperation?.quoteId).toBe('quote-created');
    expect(createdOperation?.request).toBe('lnbc1created');
    expect(createdOperation?.lastObservedRemoteState).toBe('UNPAID');
  });

  it('importQuote persists a pending operation and emits mint-op:pending', async () => {
    const pendingEvents: Array<CoreEvents['mint-op:pending']> = [];
    eventBus.on('mint-op:pending', (event) => {
      pendingEvents.push(event);
    });

    const importedQuote: MintQuoteBolt11Response = {
      quote: 'quote-imported',
      request: 'lnbc1imported',
      amount: 12,
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
    };

    (handler.prepare as Mock<any>).mockImplementationOnce(
      async ({ operation }: { operation: InitMintOperation }) => ({
        ...makePendingOp(operation.id),
        quoteId: importedQuote.quote,
        amount: importedQuote.amount,
        request: importedQuote.request,
        expiry: importedQuote.expiry,
        lastObservedRemoteState: importedQuote.state,
      }),
    );

    const pending = await service.importQuote(mintUrl, importedQuote, 'bolt11', {});

    expect(pending.state).toBe('pending');
    expect(pending.quoteId).toBe(importedQuote.quote);
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.operationId).toBe(pending.id);
    const importedOperation = pendingEvents[0]?.operation as PendingMintOperation | undefined;
    expect(importedOperation?.quoteId).toBe(importedQuote.quote);
    expect(importedOperation?.request).toBe(importedQuote.request);
    expect(importedOperation?.lastObservedRemoteState).toBe(importedQuote.state);
  });

  it('importQuote rejects unsupported quote units', async () => {
    const importedQuote: MintQuoteBolt11Response = {
      quote: 'quote-usd',
      request: 'lnbc1imported',
      amount: 12,
      unit: 'usd',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
    };

    await expect(service.importQuote(mintUrl, importedQuote, 'bolt11', {})).rejects.toThrow(
      "Unsupported mint unit 'usd'. Only 'sat' is currently supported.",
    );

    expect(handler.prepare).not.toHaveBeenCalled();
  });

  it('prepare + finalize runs init -> pending -> execute for an existing tracked operation', async () => {
    const quoteStateEvents: Array<CoreEvents['mint-op:quote-state-changed']> = [];
    const finalizedEvents: Array<CoreEvents['mint-op:finalized']> = [];
    eventBus.on('mint-op:quote-state-changed', (event) => {
      quoteStateEvents.push(event);
    });
    eventBus.on('mint-op:finalized', (event) => {
      finalizedEvents.push(event);
    });

    const initOp = makeInitOp('mint-op-redeem');
    await operationRepo.create(initOp);

    const pending = await service.prepare(initOp.id);
    const finalized = await service.finalize(pending.id);

    expect(finalized?.state).toBe('finalized');

    const stored = await operationRepo.getByQuoteId(mintUrl, quoteId);
    expect(stored.length).toBe(1);
    expect(stored[0]?.state).toBe('finalized');

    const saved = await proofRepo.getProofBySecret(mintUrl, 'out-1');
    expect(saved).not.toBeNull();
    expect(saved?.createdByOperationId).toBe(finalized?.id);

    expect(quoteStateEvents.length).toBe(1);
    expect(quoteStateEvents[0]?.quoteId).toBe(quoteId);
    expect(quoteStateEvents[0]?.state).toBe('ISSUED');
    expect(finalizedEvents.length).toBe(1);
    expect(finalizedEvents[0]?.operationId).toBe(finalized?.id);
    expect(finalizedEvents[0]?.operation.state).toBe('finalized');
  });

  it('finalize is idempotent after finalize', async () => {
    const initOp = makeInitOp('mint-op-idempotent');
    await operationRepo.create(initOp);

    const pending = await service.prepare(initOp.id);
    const first = await service.finalize(pending.id);
    const second = await service.finalize(first.id);

    expect(first?.state).toBe('finalized');
    expect(second?.id).toBe(first?.id);

    const ops = await operationRepo.getByQuoteId(mintUrl, quoteId);
    expect(ops.length).toBe(1);
  });

  it('recoverExecutingOperation finalizes when handler marks FINALIZED', async () => {
    const op = makeExecutingOp('exec-1');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({ status: 'FINALIZED' });

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);
    expect(stored?.state).toBe('finalized');
  });

  it('recoverExecutingOperation returns to pending when quote was not issued remotely', async () => {
    const op = makeExecutingOp('exec-2');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({
      status: 'PENDING',
      error: 'Recovered: quote not issued remotely',
    });

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);
    expect(stored?.state).toBe('pending');
    expect(stored?.error).toBe('Recovered: quote not issued remotely');
  });

  it('recoverExecutingOperation returns to pending when proofs are not recoverable', async () => {
    const op = makeExecutingOp('exec-3');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({ status: 'FINALIZED' });
    (proofService.recoverProofsFromOutputData as Mock<any>).mockResolvedValueOnce([]);

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);
    expect(stored?.state).toBe('pending');
  });

  it('recoverExecutingOperation finalizes expired quotes as terminal failures', async () => {
    const op = makeExecutingOp('exec-expired');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({
      status: 'TERMINAL',
      error: `Recovered: quote ${quoteId} expired while executing mint`,
    });

    await service.recoverExecutingOperation(op);

    const stored = await operationRepo.getById(op.id);

    expect(stored?.state).toBe('failed');
    expect(stored?.error).toBe(`Recovered: quote ${quoteId} expired while executing mint`);
  });

  it('finalize returns a failed operation when recovery finds an expired quote', async () => {
    const op = makeExecutingOp('exec-expired-redeem');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({
      status: 'TERMINAL',
      error: `Recovered: quote ${quoteId} expired while executing mint`,
    });

    const result = await service.finalize(op.id);

    expect(result?.state).toBe('failed');
    expect(result?.id).toBe(op.id);
  });

  it('finalize throws when executing operation is recovered back to pending', async () => {
    const op = makeExecutingOp('exec-4');
    await operationRepo.create(op);

    (handler.recoverExecuting as Mock<any>).mockResolvedValueOnce({ status: 'PENDING' });

    await expect(service.finalize(op.id)).rejects.toThrow(
      `Operation ${op.id} remains pending after recovery`,
    );
  });

  it('getOperationByQuote returns null when no tracked operation exists for the quote', async () => {
    await expect(service.getOperationByQuote(mintUrl, quoteId)).resolves.toBeNull();
  });

  it('execute finalizes when already issued proofs cannot be restored', async () => {
    const pendingOp = makePendingOp('pending-2');
    await operationRepo.create(pendingOp);

    (handler.execute as Mock<any>).mockResolvedValueOnce({ status: 'ALREADY_ISSUED' });
    (proofService.recoverProofsFromOutputData as Mock<any>).mockResolvedValueOnce([]);

    const finalized = await service.execute(pendingOp.id);

    const stored = await operationRepo.getById(pendingOp.id);

    expect(finalized.state).toBe('finalized');
    expect(finalized.error).toBe(
      `Recovered issued quote ${pendingOp.quoteId} but no proofs could be restored`,
    );
    expect(stored?.state).toBe('finalized');
    expect(stored?.error).toBe(
      `Recovered issued quote ${pendingOp.quoteId} but no proofs could be restored`,
    );
  });

  it('recoverPendingOperations cleans init operations and reconciles stale pending ones', async () => {
    const initOp = makeInitOp('init-1');
    const pendingOp = makePendingOp('pending-1');

    await operationRepo.create(initOp);
    await operationRepo.create(pendingOp);

    (handler.checkPending as Mock<any>).mockResolvedValueOnce({
      observedRemoteState: 'PAID',
      observedRemoteStateAt: Date.now(),
      category: 'ready',
    });

    await service.recoverPendingOperations();

    const initStored = await operationRepo.getById(initOp.id);
    const pendingStored = await operationRepo.getById(pendingOp.id);

    expect(initStored).toBeNull();
    expect(pendingStored?.state).toBe('finalized');
  });

  it('checkPendingOperation leaves unpaid operations pending', async () => {
    const pendingOp = makePendingOp('pending-3');
    await operationRepo.create(pendingOp);

    const result = await service.checkPendingOperation(pendingOp.id);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(result.category).toBe('waiting');
    expect(result.observedRemoteState).toBe('UNPAID');
    expect(stored?.state).toBe('pending');
    if (!stored || stored.state !== 'pending') {
      throw new Error('Expected pending operation to remain pending after unpaid check');
    }
    expect(stored.lastObservedRemoteState).toBe('UNPAID');
    expect(stored.lastObservedRemoteStateAt).toEqual(expect.any(Number));
  });

  it('recordPendingObservation updates the stored remote state without emitting another event', async () => {
    const pendingOp = makePendingOp('pending-4');
    const quoteStateEvents: Array<CoreEvents['mint-op:quote-state-changed']> = [];
    eventBus.on('mint-op:quote-state-changed', (event) => {
      quoteStateEvents.push(event);
    });
    await operationRepo.create(pendingOp);

    const observedAt = Date.now();
    const result = await service.recordPendingObservation(pendingOp.id, 'PAID', observedAt);
    const stored = await operationRepo.getById(pendingOp.id);

    expect(result.lastObservedRemoteState).toBe('PAID');
    expect(result.lastObservedRemoteStateAt).toBe(observedAt);
    expect(stored?.state).toBe('pending');
    if (!stored || stored.state !== 'pending') {
      throw new Error('Expected pending operation to remain pending after recording observation');
    }
    expect(stored.lastObservedRemoteState).toBe('PAID');
    expect(stored.lastObservedRemoteStateAt).toBe(observedAt);
    expect(handler.checkPending).not.toHaveBeenCalled();
    expect(quoteStateEvents).toHaveLength(0);
  });

  it('persists a pending quote-state-changed event emitted by another service', async () => {
    const pendingOp = makePendingOp('pending-5');
    await operationRepo.create(pendingOp);

    const observedAt = Date.now();
    await eventBus.emit('mint-op:quote-state-changed', {
      mintUrl,
      operationId: pendingOp.id,
      operation: {
        ...pendingOp,
        lastObservedRemoteState: 'PAID',
        lastObservedRemoteStateAt: observedAt,
        updatedAt: observedAt,
      },
      quoteId: pendingOp.quoteId,
      state: 'PAID',
    });

    const stored = await operationRepo.getById(pendingOp.id);

    expect(stored?.state).toBe('pending');
    if (!stored || stored.state !== 'pending') {
      throw new Error('Expected pending operation to remain pending after event persistence');
    }
    expect(stored.lastObservedRemoteState).toBe('PAID');
    expect(stored.lastObservedRemoteStateAt).toBe(observedAt);
    expect(handler.checkPending).not.toHaveBeenCalled();
  });
});
