import { Amount, type Proof } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MeltHandlerProvider } from '../../infra/handlers/melt/MeltHandlerProvider.ts';
import type { MeltMethodHandler } from '../../operations/melt/MeltMethodHandler.ts';
import type {
  PendingMeltOperation,
  PreparedMeltOperation,
} from '../../operations/melt/MeltOperation.ts';
import { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import {
  applyMeltPaidResult,
  applyMeltPending,
  applyMeltSwapResult,
  beginMeltExecution,
  deferMeltRecovery,
  releaseMeltAfterNonPayment,
} from '../../operations/melt/MeltTransitions.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';
const inputProof: Proof = { amount: Amount.from(12), C: 'C', id: 'ks', secret: 'input' };

function prepared(): PreparedMeltOperation {
  return {
    id: 'op-1',
    state: 'prepared',
    mintUrl,
    method: 'bolt11',
    methodData: { invoice: 'invoice' },
    quoteId,
    unit: 'sat',
    amount: Amount.from(10),
    fee_reserve: Amount.from(2),
    swap_fee: Amount.zero(),
    needsSwap: false,
    inputAmount: Amount.from(12),
    inputProofSecrets: [inputProof.secret],
    changeOutputData: { keep: [], send: [] },
    createdAt: 1,
    updatedAt: 2,
  };
}

const pending = (): PendingMeltOperation => ({ ...prepared(), state: 'pending', updatedAt: 4 });
const quote = (state: 'UNPAID' | 'PENDING' | 'PAID') => ({
  mintUrl,
  method: 'bolt11' as const,
  quoteId,
  quote: quoteId,
  request: 'invoice',
  amount: Amount.from(10),
  fee_reserve: Amount.from(2),
  unit: 'sat',
  expiry: 9999999999,
  state,
  change: [],
  payment_preimage: state === 'PAID' ? 'preimage' : null,
  lastObservedRemoteState: state,
  lastObservedRemoteStateAt: 100,
  createdAt: 1,
  updatedAt: 100,
});

describe('MeltOperationService coordinator', () => {
  let current: any;
  let handler: MeltMethodHandler<'bolt11'>;
  let dependencies: any;
  let performed: unknown[];
  let observations: string[];

  beforeEach(() => {
    current = prepared();
    performed = [];
    observations = [];
    handler = {
      createQuote: mock(async () => quote('UNPAID')),
      fetchRemoteQuote: mock(async () => quote('UNPAID')),
      swap: mock(async () => ({ keep: [], send: [] })),
      melt: mock(async () => ({ status: 'PENDING' as const, change: [] })),
    };
    dependencies = {
      handlerProvider: new MeltHandlerProvider({ bolt11: handler }),
      meltOperationQueries: {
        getById: mock(async () => current),
        getByQuoteId: mock(async () => [current]),
        getByMintUrl: mock(async () => [current]),
        getByState: mock(async () => []),
        getPending: mock(async () => [current]),
      },
      proofQueries: {
        getProofsBySecrets: mock(async () => []),
        getProofsByOperationId: mock(async () => []),
      },
      transactionRunner: {
        run: mock(async (work: any) =>
          work({
            perform: async (transition: unknown, input: any) => {
              performed.push(transition);
              if (transition === beginMeltExecution) {
                current = { ...current, state: 'executing', updatedAt: 3 };
                return { operation: current, inputProofs: [inputProof], changed: true };
              }
              if (transition === applyMeltSwapResult) {
                return {
                  operation: current,
                  savedProofs: [inputProof],
                  sendProofs: [inputProof],
                  spentInputSecrets: [inputProof.secret],
                  changed: true,
                };
              }
              if (transition === applyMeltPending) {
                current = pending();
                return { operation: current, changed: true };
              }
              if (transition === applyMeltPaidResult) {
                current = {
                  ...pending(),
                  state: 'finalized',
                  changeAmount: Amount.zero(),
                  effectiveFee: Amount.from(2),
                  finalizedData: { preimage: 'preimage' },
                };
                return {
                  operation: current,
                  changeProofs: [],
                  spentInputSecrets: [inputProof.secret],
                  changed: true,
                };
              }
              if (transition === releaseMeltAfterNonPayment) {
                current = { ...pending(), state: 'rolled_back', error: input.reason };
                return {
                  operation: current,
                  restoredSecrets: [inputProof.secret],
                  releasedSecrets: [inputProof.secret],
                  changed: true,
                };
              }
              if (transition === deferMeltRecovery) return undefined;
              throw new Error('unexpected transition');
            },
          }),
        ),
      },
      loadSeed: mock(async () => new Uint8Array(32)),
      quoteLifecycle: {
        getMeltQuote: mock(async () => quote('UNPAID')),
        getMeltQuoteById: mock(async () => quote('UNPAID')),
        requireMeltQuoteRefForPrepare: mock(async () => quote('UNPAID')),
        refreshMeltQuote: mock(async () => quote('UNPAID')),
        refreshMeltQuoteById: mock(async () => quote('UNPAID')),
        recordMeltQuoteObservation: mock(async (value: any) => {
          observations.push(value.state);
          return value;
        }),
      },
      mintService: { refreshAndCommitIfStale: mock(async () => ({ keysets: [] })) },
      walletService: { getWalletWithActiveKeysetId: mock(async () => ({ wallet: {} })) },
      mintAdapter: {},
      eventBus: { emit: mock(async () => undefined) },
    };
  });

  it('authorizes, performs the remote Melt, records its quote, then advances', async () => {
    const result = await new MeltOperationService(dependencies).execute('op-1');
    expect(result.state).toBe('pending');
    expect(performed).toEqual([beginMeltExecution, applyMeltPending]);
    expect(observations).toEqual(['PENDING']);
    expect(dependencies.eventBus.emit).toHaveBeenCalledWith(
      'proofs:state-changed',
      { mintUrl, secrets: [inputProof.secret], state: 'inflight' },
      { throwOnError: true },
    );
  });

  it('retains resources after an ambiguous remote error', async () => {
    (handler.melt as any).mockRejectedValueOnce(new Error('connection lost'));
    await expect(new MeltOperationService(dependencies).execute('op-1')).rejects.toThrow(
      'connection lost',
    );
    expect(performed).toEqual([beginMeltExecution, deferMeltRecovery]);
    expect(performed).not.toContain(releaseMeltAfterNonPayment);
  });

  it('commits the pre-swap result before submitting the Melt request', async () => {
    current = {
      ...prepared(),
      needsSwap: true,
      swapOutputData: {
        keep: [],
        send: [
          {
            blindedMessage: { amount: 12, id: 'ks', B_: 'B' },
            blindingFactor: '01',
            secret: Buffer.from('input').toString('hex'),
          },
        ],
      },
    };
    const order: string[] = [];
    (handler.swap as any).mockImplementationOnce(async () => {
      order.push('remote-swap');
      return { keep: [], send: [inputProof] };
    });
    (handler.melt as any).mockImplementationOnce(async () => {
      order.push('remote-melt');
      expect(performed).toContain(applyMeltSwapResult);
      return { status: 'PENDING', change: [] };
    });
    await new MeltOperationService(dependencies).execute('op-1');
    expect(order).toEqual(['remote-swap', 'remote-melt']);
    expect(performed).toEqual([beginMeltExecution, applyMeltSwapResult, applyMeltPending]);
    expect(dependencies.eventBus.emit).toHaveBeenCalledWith(
      'proofs:state-changed',
      { mintUrl, secrets: [inputProof.secret], state: 'spent' },
      { throwOnError: true },
    );
    expect(dependencies.eventBus.emit).toHaveBeenCalledWith(
      'proofs:saved',
      { mintUrl, keysetId: inputProof.id, proofs: [inputProof] },
      { throwOnError: true },
    );
  });

  it('does not replay a committed remote Melt when a post-commit listener fails', async () => {
    dependencies.eventBus.emit = mock(async () => {
      throw new Error('listener failed');
    });
    const result = await new MeltOperationService(dependencies).execute('op-1');
    expect(result.state).toBe('pending');
    expect(handler.melt).toHaveBeenCalledTimes(1);
  });

  it('releases pending proofs only after a fresh UNPAID observation', async () => {
    current = pending();
    const decision = await new MeltOperationService(dependencies).checkPendingOperation('op-1');
    expect(decision).toBe('rollback');
    expect(dependencies.quoteLifecycle.refreshMeltQuoteById).toHaveBeenCalledTimes(1);
    expect(performed).toContain(releaseMeltAfterNonPayment);
    expect(dependencies.eventBus.emit).toHaveBeenCalledWith(
      'proofs:state-changed',
      { mintUrl, secrets: [inputProof.secret], state: 'ready' },
      { throwOnError: true },
    );
    expect(dependencies.eventBus.emit).toHaveBeenCalledWith(
      'proofs:released',
      { mintUrl, secrets: [inputProof.secret] },
      { throwOnError: true },
    );
  });

  it('finalizes from a canonical PAID observation', async () => {
    current = pending();
    dependencies.quoteLifecycle.refreshMeltQuoteById = mock(async () => quote('PAID'));
    const decision = await new MeltOperationService(dependencies).checkPendingOperation('op-1');
    expect(decision).toBe('finalize');
    expect(performed).toContain(applyMeltPaidResult);
    expect(performed).not.toContain(releaseMeltAfterNonPayment);
    expect(dependencies.eventBus.emit).toHaveBeenCalledWith(
      'proofs:state-changed',
      { mintUrl, secrets: [inputProof.secret], state: 'spent' },
      { throwOnError: true },
    );
  });
});
