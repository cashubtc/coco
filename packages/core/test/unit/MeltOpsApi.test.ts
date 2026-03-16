import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  FinalizedMeltOperation,
  MeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
} from '../../operations/melt/MeltOperation.ts';
import type { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import { MeltOpsApi } from '../../api/MeltOpsApi.ts';

const mintUrl = 'https://mint.test';

type Assert<T extends true> = T;
type PrepareMeltInput = Parameters<MeltOpsApi['prepare']>[0];
type PrepareMeltMethod = PrepareMeltInput['method'];
type _AssertOnlyBolt11 = Assert<Exclude<PrepareMeltMethod, 'bolt11'> extends never ? true : false>;
type CustomPrepareMeltInput = Parameters<MeltOpsApi<'bolt11' | 'bolt12'>['prepare']>[0];
type _AssertAllowsBolt12 = Assert<'bolt12' extends CustomPrepareMeltInput['method'] ? true : false>;

const supportedPrepareInput: PrepareMeltInput = {
  mintUrl,
  method: 'bolt11',
  methodData: { invoice: 'lnbc1test' },
};
void supportedPrepareInput;

const makePreparedOperation = (): PreparedMeltOperation => ({
  id: 'op-1',
  state: 'prepared',
  mintUrl,
  method: 'bolt11',
  methodData: { invoice: 'lnbc1test' },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  quoteId: 'quote-1',
  amount: 100,
  fee_reserve: 0,
  swap_fee: 0,
  needsSwap: false,
  inputAmount: 100,
  inputProofSecrets: [],
  changeOutputData: { keep: [], send: [] },
});

describe('MeltOpsApi', () => {
  let api: MeltOpsApi;
  let meltOperationService: MeltOperationService;
  let preparedOperation: PreparedMeltOperation;
  let pendingOperation: PendingMeltOperation;

  beforeEach(() => {
    preparedOperation = makePreparedOperation();
    pendingOperation = {
      ...preparedOperation,
      state: 'pending',
    };

    meltOperationService = {
      init: mock(async () => ({ id: 'op-1' })),
      prepare: mock(async () => preparedOperation),
      execute: mock(async () => pendingOperation),
      getOperation: mock(async () => preparedOperation),
      getOperationByQuote: mock(async () => preparedOperation),
      getPreparedOperations: mock(async () => [preparedOperation]),
      getPendingOperations: mock(async () => [pendingOperation]),
      rollback: mock(async () => {}),
      finalize: mock(async () => {}),
      recoverPendingOperations: mock(async () => {}),
      checkPendingOperation: mock(async () => 'finalize'),
      isOperationLocked: mock(() => false),
      isRecoveryInProgress: mock(() => false),
    } as unknown as MeltOperationService;

    api = new MeltOpsApi(meltOperationService);
  });

  it('prepare creates and prepares a melt operation', async () => {
    const result = await api.prepare(supportedPrepareInput);

    expect(meltOperationService.init).toHaveBeenCalledWith(mintUrl, 'bolt11', {
      invoice: 'lnbc1test',
    });
    expect(meltOperationService.prepare).toHaveBeenCalledWith('op-1');
    expect(result).toBe(preparedOperation);
  });

  it('execute resolves ids before executing', async () => {
    const result = await api.execute(preparedOperation.id);

    expect(meltOperationService.getOperation).toHaveBeenCalledWith(preparedOperation.id);
    expect(meltOperationService.execute).toHaveBeenCalledWith(preparedOperation.id);
    expect(result).toBe(pendingOperation);
  });

  it('getByQuote forwards to the service', async () => {
    const result = await api.getByQuote(mintUrl, preparedOperation.quoteId);

    expect(meltOperationService.getOperationByQuote).toHaveBeenCalledWith(
      mintUrl,
      preparedOperation.quoteId,
    );
    expect(result).toBe(preparedOperation);
  });

  it('listPrepared and listInFlight delegate to separate service methods', async () => {
    const prepared = await api.listPrepared();
    const inFlight = await api.listInFlight();

    expect(meltOperationService.getPreparedOperations).toHaveBeenCalledWith();
    expect(meltOperationService.getPendingOperations).toHaveBeenCalledWith();
    expect(prepared).toEqual([preparedOperation]);
    expect(inFlight).toEqual([pendingOperation]);
  });

  it('refresh checks pending operations and re-reads the latest state', async () => {
    const finalizedOperation: FinalizedMeltOperation = {
      ...pendingOperation,
      state: 'finalized',
      updatedAt: Date.now(),
    };
    (meltOperationService.getOperation as unknown as ReturnType<typeof mock>)
      .mockResolvedValueOnce(pendingOperation as MeltOperation)
      .mockResolvedValueOnce(finalizedOperation as MeltOperation);

    const result = await api.refresh(pendingOperation.id);

    expect(meltOperationService.checkPendingOperation).toHaveBeenCalledWith(pendingOperation.id);
    expect(result).toBe(finalizedOperation);
  });

  it('cancel and reclaim validate operation state', async () => {
    await api.cancel(preparedOperation.id);
    expect(meltOperationService.rollback).toHaveBeenCalledWith(preparedOperation.id, undefined);

    (meltOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
      pendingOperation as MeltOperation,
    );
    await api.reclaim(pendingOperation.id, 'user requested');

    expect(meltOperationService.rollback).toHaveBeenCalledWith(
      pendingOperation.id,
      'user requested',
    );
  });
});
