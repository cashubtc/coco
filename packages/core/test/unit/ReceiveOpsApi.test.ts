import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Token } from '@cashu/cashu-ts';
import type {
  FinalizedReceiveOperation,
  InitReceiveOperation,
  PreparedReceiveOperation,
  ReceiveOperation,
} from '../../operations/receive/ReceiveOperation.ts';
import type { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService.ts';
import type { SerializedOutputData } from '../../utils.ts';
import { ReceiveOpsApi } from '../../api/ReceiveOpsApi.ts';

const mintUrl = 'https://mint.test';

const makePreparedOperation = (): PreparedReceiveOperation => ({
  id: 'op-1',
  state: 'prepared',
  mintUrl,
  amount: 20,
  inputProofs: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  fee: 0,
  outputData: { keep: [], send: [] } as SerializedOutputData,
});

describe('ReceiveOpsApi', () => {
  let api: ReceiveOpsApi;
  let receiveOperationService: ReceiveOperationService;
  let initOperation: InitReceiveOperation;
  let preparedOperation: PreparedReceiveOperation;
  let executingOperation: ReceiveOperation;
  let finalizedOperation: FinalizedReceiveOperation;

  beforeEach(() => {
    initOperation = {
      id: 'op-1',
      state: 'init',
      mintUrl,
      amount: 20,
      inputProofs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    preparedOperation = makePreparedOperation();
    executingOperation = {
      ...preparedOperation,
      state: 'executing',
    };
    finalizedOperation = {
      ...preparedOperation,
      state: 'finalized',
      updatedAt: Date.now(),
    };

    receiveOperationService = {
      init: mock(async () => initOperation),
      prepare: mock(async () => preparedOperation),
      execute: mock(async () => finalizedOperation),
      getOperation: mock(async () => preparedOperation),
      getPreparedOperations: mock(async () => [preparedOperation]),
      getPendingOperations: mock(async () => [executingOperation]),
      finalize: mock(async () => {}),
      recoverPendingOperations: mock(async () => {}),
      recoverExecutingOperation: mock(async () => {}),
      rollback: mock(async () => {}),
      isOperationLocked: mock(() => false),
      isRecoveryInProgress: mock(() => false),
    } as unknown as ReceiveOperationService;

    api = new ReceiveOpsApi(receiveOperationService);
  });

  it('prepare calls init then prepare', async () => {
    const token = { mint: mintUrl, proofs: [] } as Token;
    const result = await api.prepare({ token });

    expect(receiveOperationService.init).toHaveBeenCalledWith(token);
    expect(receiveOperationService.prepare).toHaveBeenCalledWith(initOperation);
    expect(result).toBe(preparedOperation);
  });

  it('execute resolves ids before executing', async () => {
    const result = await api.execute(preparedOperation.id);

    expect(receiveOperationService.getOperation).toHaveBeenCalledWith(preparedOperation.id);
    expect(receiveOperationService.execute).toHaveBeenCalledWith(preparedOperation);
    expect(result).toBe(finalizedOperation);
  });

  it('listPrepared and listInFlight delegate to separate service methods', async () => {
    const prepared = await api.listPrepared();
    const inFlight = await api.listInFlight();

    expect(receiveOperationService.getPreparedOperations).toHaveBeenCalledWith();
    expect(receiveOperationService.getPendingOperations).toHaveBeenCalledWith();
    expect(prepared).toEqual([preparedOperation]);
    expect(inFlight).toEqual([executingOperation]);
  });

  it('refresh recovers executing operations and re-reads the latest state', async () => {
    (receiveOperationService.getOperation as unknown as ReturnType<typeof mock>)
      .mockResolvedValueOnce(executingOperation)
      .mockResolvedValueOnce(finalizedOperation);

    const result = await api.refresh(preparedOperation.id);

    expect(receiveOperationService.recoverExecutingOperation).toHaveBeenCalledWith(
      executingOperation,
    );
    expect(result).toBe(finalizedOperation);
  });

  it('cancel allows init and prepared operations', async () => {
    (
      receiveOperationService.getOperation as unknown as ReturnType<typeof mock>
    ).mockResolvedValueOnce(initOperation);

    await api.cancel(initOperation.id, 'user cancelled');

    expect(receiveOperationService.rollback).toHaveBeenCalledWith('op-1', 'user cancelled');
  });

  it('cancel rejects terminal operations', async () => {
    (
      receiveOperationService.getOperation as unknown as ReturnType<typeof mock>
    ).mockResolvedValueOnce(finalizedOperation);

    await expect(api.cancel(finalizedOperation.id)).rejects.toThrow(
      "Expected 'init' or 'prepared'",
    );
  });
});
