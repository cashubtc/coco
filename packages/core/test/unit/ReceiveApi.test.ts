import type {
  ReceiveOperation,
  InitReceiveOperation,
  PreparedReceiveOperation,
  FinalizedReceiveOperation,
} from '../../operations/receive/ReceiveOperation.ts';
import type { Token } from '@cashu/cashu-ts';
import { ReceiveApi } from '../../api/ReceiveApi.ts';
import type { SerializedOutputData } from '../../utils.ts';
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService.ts';

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

describe('ReceiveApi', () => {
  let api: ReceiveApi;
  let receiveOperationService: ReceiveOperationService;
  let initOperation: InitReceiveOperation;
  let preparedOperation: PreparedReceiveOperation;
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
      getPendingOperations: mock(async () => [preparedOperation]),
      finalize: mock(async () => {}),
      recoverPendingOperations: mock(async () => {}),
      rollback: mock(async () => {}),
      isOperationLocked: mock(() => false),
      isRecoveryInProgress: mock(() => false),
    } as unknown as ReceiveOperationService;

    api = new ReceiveApi(receiveOperationService);
  });

  it('prepareReceive calls init then prepare', async () => {
    const token = { mint: mintUrl, proofs: [] } as Token;
    const result = await api.prepareReceive(token);

    expect(receiveOperationService.init).toHaveBeenCalledWith(token);
    expect(receiveOperationService.prepare).toHaveBeenCalledWith(initOperation);
    expect(result).toBe(preparedOperation);
  });

  it('executeReceive throws when operation is missing', async () => {
    (receiveOperationService.getOperation as any).mockResolvedValueOnce(null);

    await expect(api.executeReceive('missing')).rejects.toThrow('not found');
  });

  it('executeReceive throws when operation is not prepared', async () => {
    const op: ReceiveOperation = { ...initOperation };
    (receiveOperationService.getOperation as any).mockResolvedValueOnce(op);

    await expect(api.executeReceive(op.id)).rejects.toThrow("Expected 'prepared'");
  });

  it('executeReceive executes the prepared operation', async () => {
    const result = await api.executeReceive(preparedOperation.id);

    expect(receiveOperationService.getOperation).toHaveBeenCalledWith(preparedOperation.id);
    expect(receiveOperationService.execute).toHaveBeenCalledWith(preparedOperation);
    expect(result).toBe(finalizedOperation);
  });

  it('getOperation forwards to the service', async () => {
    const result = await api.getOperation('op-1');

    expect(receiveOperationService.getOperation).toHaveBeenCalledWith('op-1');
    expect(result).toBe(preparedOperation);
  });

  it('getPendingOperations forwards to the service', async () => {
    const result = await api.getPendingOperations();

    expect(receiveOperationService.getPendingOperations).toHaveBeenCalledWith();
    expect(result).toEqual([preparedOperation]);
  });

  it('finalize forwards to the service', async () => {
    await api.finalize('op-1');

    expect(receiveOperationService.finalize).toHaveBeenCalledWith('op-1');
  });

  it('recoverPendingOperations forwards to the service', async () => {
    await api.recoverPendingOperations();

    expect(receiveOperationService.recoverPendingOperations).toHaveBeenCalledWith();
  });

  it('rollbackReceive forwards to the service', async () => {
    await api.rollbackReceive('op-1', 'user cancelled');

    expect(receiveOperationService.rollback).toHaveBeenCalledWith('op-1', 'user cancelled');
  });

  it('isOperationLocked returns the service result', () => {
    (receiveOperationService.isOperationLocked as any).mockReturnValueOnce(true);

    expect(api.isOperationLocked('op-1')).toBe(true);
    expect(receiveOperationService.isOperationLocked).toHaveBeenCalledWith('op-1');
  });

  it('isRecoveryInProgress returns the service result', () => {
    (receiveOperationService.isRecoveryInProgress as any).mockReturnValueOnce(true);

    expect(api.isRecoveryInProgress()).toBe(true);
    expect(receiveOperationService.isRecoveryInProgress).toHaveBeenCalledWith();
  });
});
