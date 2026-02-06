import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { QuotesApi } from '../../api/QuotesApi.ts';
import type { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import type { PendingCheckResult } from '../../operations/melt/MeltMethodHandler.ts';
import type { PendingMeltOperation } from '../../operations/melt/MeltOperation.ts';
import type { MintQuoteService } from '../../services/MintQuoteService.ts';
import type { MeltQuoteService } from '../../services/MeltQuoteService.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-123';

const makePendingOperation = (): PendingMeltOperation => ({
  id: 'op-1',
  state: 'pending',
  mintUrl,
  unit: 'sat',
  method: 'bolt11',
  methodData: { invoice: 'lnbc1test' },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  quoteId,
  amount: 100,
  fee_reserve: 0,
  swap_fee: 0,
  needsSwap: false,
  inputAmount: 100,
  inputProofSecrets: [],
  changeOutputData: { keep: [], send: [] },
});

const makeMocks = (operation: PendingMeltOperation) => {
  const mintQuoteService = {} as MintQuoteService;
  const meltQuoteService = {} as MeltQuoteService;

  const meltOperationService = {
    execute: mock(async () => operation),
    checkPendingOperation: mock(async () => 'finalize' as PendingCheckResult),
    getOperationByQuote: mock(async () => operation),
  } as unknown as MeltOperationService;

  return { mintQuoteService, meltQuoteService, meltOperationService };
};

describe('QuotesApi', () => {
  let api: QuotesApi;
  let meltOperationService: MeltOperationService;
  let pendingOperation: PendingMeltOperation;

  beforeEach(() => {
    pendingOperation = makePendingOperation();
    const mocks = makeMocks(pendingOperation);
    meltOperationService = mocks.meltOperationService;
    api = new QuotesApi(
      mocks.mintQuoteService,
      mocks.meltQuoteService,
      mocks.meltOperationService,
    );
  });

  describe('executeMeltByQuote', () => {
    it('returns null when no operation exists', async () => {
      (meltOperationService.getOperationByQuote as any).mockResolvedValueOnce(null);

      const result = await api.executeMeltByQuote(mintUrl, quoteId);

      expect(result).toBeNull();
      expect(meltOperationService.execute).not.toHaveBeenCalled();
    });

    it('executes using the resolved operation id', async () => {
      const result = await api.executeMeltByQuote(mintUrl, quoteId);

      expect(meltOperationService.getOperationByQuote).toHaveBeenCalledWith(mintUrl, quoteId);
      expect(meltOperationService.execute).toHaveBeenCalledWith('op-1');
      expect(result).toBe(pendingOperation);
    });
  });

  describe('checkPendingMeltByQuote', () => {
    it('returns null when no operation exists', async () => {
      (meltOperationService.getOperationByQuote as any).mockResolvedValueOnce(null);

      const result = await api.checkPendingMeltByQuote(mintUrl, quoteId);

      expect(result).toBeNull();
      expect(meltOperationService.checkPendingOperation).not.toHaveBeenCalled();
    });

    it('checks pending using the resolved operation id', async () => {
      const result = await api.checkPendingMeltByQuote(mintUrl, quoteId);

      expect(meltOperationService.getOperationByQuote).toHaveBeenCalledWith(mintUrl, quoteId);
      expect(meltOperationService.checkPendingOperation).toHaveBeenCalledWith('op-1');
      expect(result).toBe('finalize');
    });
  });
});
