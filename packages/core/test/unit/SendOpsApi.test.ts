import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SendOperationService } from '../../operations/send/SendOperationService.ts';
import type {
  FinalizedSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  SendOperation,
} from '../../operations/send/SendOperation.ts';
import { SendOpsApi } from '../../api/SendOpsApi.ts';

const mintUrl = 'https://mint.test';

const makePreparedOperation = (): PreparedSendOperation => ({
  id: 'op-1',
  state: 'prepared',
  mintUrl,
  amount: 20,
  method: 'default',
  methodData: {},
  createdAt: Date.now(),
  updatedAt: Date.now(),
  needsSwap: false,
  fee: 0,
  inputAmount: 20,
  inputProofSecrets: [],
});

describe('SendOpsApi', () => {
  let api: SendOpsApi;
  let sendOperationService: SendOperationService;
  let preparedOperation: PreparedSendOperation;
  let pendingOperation: PendingSendOperation;

  beforeEach(() => {
    preparedOperation = makePreparedOperation();
    pendingOperation = {
      ...preparedOperation,
      state: 'pending',
      token: { mint: mintUrl, proofs: [] },
    };

    sendOperationService = {
      init: mock(async () => ({ id: 'op-1' })),
      prepare: mock(async () => preparedOperation),
      execute: mock(async () => ({ operation: pendingOperation, token: pendingOperation.token! })),
      getOperation: mock(async () => preparedOperation),
      getPreparedOperations: mock(async () => [preparedOperation]),
      getPendingOperations: mock(async () => [pendingOperation]),
      rollback: mock(async () => {}),
      finalize: mock(async () => {}),
      recoverPendingOperations: mock(async () => {}),
      checkPendingOperation: mock(async () => {}),
      isOperationLocked: mock(() => false),
      isRecoveryInProgress: mock(() => false),
    } as unknown as SendOperationService;

    api = new SendOpsApi(sendOperationService);
  });

  it('prepare calls init and prepare with default target', async () => {
    const result = await api.prepare({ mintUrl, amount: 20 });

    expect(sendOperationService.init).toHaveBeenCalledWith(mintUrl, 20, {
      method: 'default',
      methodData: {},
    });
    expect(sendOperationService.prepare).toHaveBeenCalled();
    expect(result).toBe(preparedOperation);
  });

  it('prepare maps p2pk target to send method options', async () => {
    await api.prepare({
      mintUrl,
      amount: 20,
      target: { type: 'p2pk', pubkey: 'pubkey-1' },
    });

    expect(sendOperationService.init).toHaveBeenCalledWith(mintUrl, 20, {
      method: 'p2pk',
      methodData: { pubkey: 'pubkey-1' },
    });
  });

  it('execute re-reads operation objects before executing', async () => {
    const staleOperation: SendOperation = {
      ...preparedOperation,
      updatedAt: preparedOperation.updatedAt - 1,
    };

    const result = await api.execute(staleOperation);

    expect(sendOperationService.getOperation).toHaveBeenCalledWith(preparedOperation.id);
    expect(sendOperationService.execute).toHaveBeenCalledWith(preparedOperation);
    expect(result.operation).toBe(pendingOperation);
  });

  it('listPrepared and listInFlight delegate to separate service methods', async () => {
    const prepared = await api.listPrepared();
    const inFlight = await api.listInFlight();

    expect(sendOperationService.getPreparedOperations).toHaveBeenCalledWith();
    expect(sendOperationService.getPendingOperations).toHaveBeenCalledWith();
    expect(prepared).toEqual([preparedOperation]);
    expect(inFlight).toEqual([pendingOperation]);
  });

  it('refresh checks pending operations and re-reads the latest state', async () => {
    const finalizedOperation: FinalizedSendOperation = {
      ...pendingOperation,
      state: 'finalized',
      updatedAt: Date.now(),
    };
    (sendOperationService.getOperation as unknown as ReturnType<typeof mock>)
      .mockResolvedValueOnce(pendingOperation as SendOperation)
      .mockResolvedValueOnce(finalizedOperation as SendOperation);

    const result = await api.refresh(pendingOperation.id);

    expect(sendOperationService.checkPendingOperation).toHaveBeenCalledWith(pendingOperation);
    expect(result).toBe(finalizedOperation);
  });

  it('cancel only allows prepared operations', async () => {
    await api.cancel(preparedOperation.id);
    expect(sendOperationService.rollback).toHaveBeenCalledWith(preparedOperation.id);

    (sendOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
      pendingOperation as SendOperation,
    );

    await expect(api.cancel(pendingOperation.id)).rejects.toThrow("Expected 'prepared'");
  });

  it('reclaim only allows pending operations', async () => {
    (sendOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
      pendingOperation as SendOperation,
    );

    await api.reclaim(pendingOperation.id);
    expect(sendOperationService.rollback).toHaveBeenCalledWith(pendingOperation.id);
  });

  it('finalize delegates directly to the service', async () => {
    await api.finalize(pendingOperation.id);

    expect(sendOperationService.finalize).toHaveBeenCalledWith(pendingOperation.id);
    expect(sendOperationService.getOperation).not.toHaveBeenCalled();
  });

  it('finalize preserves service-owned idempotence for already finalized operations', async () => {
    const finalizedOperation: FinalizedSendOperation = {
      ...pendingOperation,
      state: 'finalized',
      updatedAt: Date.now(),
    };
    (sendOperationService.finalize as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
      undefined,
    );

    await expect(api.finalize(finalizedOperation.id)).resolves.toBeUndefined();
    expect(sendOperationService.finalize).toHaveBeenCalledWith(finalizedOperation.id);
  });
});
