import {
  Amount,
  OutputData,
  createBlindSignature,
  createNewMintKeys,
  pointFromHex,
  serializeMintKeys,
  type MintKeys,
  type Proof,
} from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MeltHandlerProvider } from '../../infra/handlers/melt/MeltHandlerProvider.ts';
import type { MeltMethodHandler } from '../../operations/melt/MeltMethodHandler.ts';
import type {
  ExecutingMeltOperation,
  InitMeltOperation,
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
import { serializeOutputData } from '../../utils.ts';

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
  let transitionInputs: any[];
  let observations: string[];

  beforeEach(() => {
    current = prepared();
    performed = [];
    transitionInputs = [];
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
              transitionInputs.push(input);
              if (transition === beginMeltExecution) {
                current = { ...current, state: 'executing', updatedAt: 3 };
                return { operation: current, inputProofs: [inputProof], changed: true };
              }
              if (transition === applyMeltSwapResult) {
                return {
                  operation: current,
                  savedProofs: [...input.keepProofs, ...input.sendProofs],
                  sendProofs: input.sendProofs,
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

  it('finalizes a complete cached PAID settlement without another remote refresh', async () => {
    current = pending();
    dependencies.quoteLifecycle.getMeltQuote = mock(async () => quote('PAID'));

    const decision = await new MeltOperationService(dependencies).checkPendingOperation('op-1');

    expect(decision).toBe('finalize');
    expect(performed).toContain(applyMeltPaidResult);
    expect(dependencies.quoteLifecycle.refreshMeltQuoteById).not.toHaveBeenCalled();
  });

  it('refreshes a persisted PAID quote that omits change before finalizing', async () => {
    current = pending();
    dependencies.quoteLifecycle.getMeltQuote = mock(async () => ({
      ...quote('PAID'),
      change: undefined,
    }));
    dependencies.quoteLifecycle.refreshMeltQuoteById = mock(async () => ({
      ...quote('PAID'),
      payment_preimage: 'remote-preimage',
      change: [],
    }));

    const decision = await new MeltOperationService(dependencies).checkPendingOperation('op-1');

    expect(decision).toBe('finalize');
    expect(performed).toContain(applyMeltPaidResult);
    expect(dependencies.quoteLifecycle.refreshMeltQuoteById).toHaveBeenCalledTimes(1);
  });

  it('retains a pending operation when a full PAID refresh is still missing change', async () => {
    current = pending();
    dependencies.quoteLifecycle.getMeltQuote = mock(async () => ({
      ...quote('PAID'),
      change: undefined,
    }));
    dependencies.quoteLifecycle.refreshMeltQuoteById = mock(async () => ({
      ...quote('PAID'),
      change: undefined,
    }));

    await expect(
      new MeltOperationService(dependencies).checkPendingOperation('op-1'),
    ).rejects.toThrow('settlement change is incomplete');

    expect(performed).not.toContain(applyMeltPaidResult);
    expect(performed).not.toContain(releaseMeltAfterNonPayment);
  });

  it('refreshes an explicitly supplied incomplete PAID quote before finalizing', async () => {
    current = pending();
    dependencies.quoteLifecycle.refreshMeltQuote = mock(async () => quote('PAID'));

    await new MeltOperationService(dependencies).finalize('op-1', {
      canonicalQuote: { ...quote('PAID'), change: undefined },
    });

    expect(dependencies.quoteLifecycle.refreshMeltQuote).toHaveBeenCalledTimes(1);
    expect(performed).toContain(applyMeltPaidResult);
  });

  it('preserves an absent optional on-chain outpoint as absent finalized data', async () => {
    current = {
      ...pending(),
      method: 'onchain',
      methodData: { address: 'bc1qtest', amountSats: Amount.from(8), feeIndex: 7 },
    } as PendingMeltOperation;
    const canonicalQuote = {
      ...quote('PAID'),
      method: 'onchain',
      request: 'bc1qtest',
      fee_options: [{ fee_index: 7, fee_reserve: Amount.from(2), estimated_blocks: 3 }],
      outpoint: undefined,
      change: [],
    } as any;

    await new MeltOperationService(dependencies).finalize('op-1', { canonicalQuote });

    const paidInput = transitionInputs[performed.indexOf(applyMeltPaidResult)];
    expect(paidInput.finalizedData).toBeUndefined();
  });

  it('returns a quote-bound legacy init operation by canonical identity', async () => {
    const init: InitMeltOperation = {
      id: 'legacy-init',
      state: 'init',
      mintUrl,
      method: 'bolt11',
      methodData: { invoice: 'invoice' },
      quoteId,
      unit: 'sat',
      error: 'prepare failed',
      createdAt: 1,
      updatedAt: 1,
    };
    current = init;
    dependencies.meltOperationQueries.getByQuoteId = mock(async () => [init]);
    dependencies.quoteLifecycle.getMeltQuoteById = mock(async () => quote('UNPAID'));

    await expect(
      new MeltOperationService(dependencies).getOperationByQuoteIdentity({ mintUrl, quoteId }),
    ).resolves.toEqual(init);
  });

  it('defers recovery when only part of a pre-swap output set exists locally', async () => {
    current = swapExecutingOperation(1, 1);
    dependencies.quoteLifecycle.refreshMeltQuoteById = mock(async () => quote('UNPAID'));
    dependencies.proofQueries.getProofsBySecrets = mock(async () => [inputProof]);

    await expect(
      new MeltOperationService(dependencies).recoverExecutingOperation(current),
    ).rejects.toThrow('partial outputs');

    expect(performed).toEqual([deferMeltRecovery]);
    expect(performed).not.toContain(releaseMeltAfterNonPayment);
  });

  it('retains pre-swap resources when unspent originals contradict a PAID quote', async () => {
    current = swapExecutingOperation(1);
    dependencies.quoteLifecycle.refreshMeltQuoteById = mock(async () => quote('PAID'));
    dependencies.proofQueries.getProofsBySecrets = mock(
      async (_mintUrl: string, secrets: string[]) =>
        secrets.includes(inputProof.secret) ? [inputProof] : [],
    );
    dependencies.walletService.getWalletWithActiveKeysetId = mock(async () => ({
      wallet: { checkProofsStates: mock(async () => [{ state: 'UNSPENT' }]) },
    }));

    await expect(
      new MeltOperationService(dependencies).recoverExecutingOperation(current),
    ).rejects.toThrow('quote advanced although pre-swap inputs are unspent');

    expect(performed).toEqual([deferMeltRecovery]);
    expect(performed).not.toContain(releaseMeltAfterNonPayment);
  });

  it('releases original pre-swap inputs only when the quote and proofs prove non-payment', async () => {
    current = swapExecutingOperation(1);
    dependencies.quoteLifecycle.refreshMeltQuoteById = mock(async () => quote('UNPAID'));
    dependencies.proofQueries.getProofsBySecrets = mock(
      async (_mintUrl: string, secrets: string[]) =>
        secrets.includes(inputProof.secret) ? [inputProof] : [],
    );
    dependencies.walletService.getWalletWithActiveKeysetId = mock(async () => ({
      wallet: { checkProofsStates: mock(async () => [{ state: 'UNSPENT' }]) },
    }));

    await new MeltOperationService(dependencies).recoverExecutingOperation(current);

    expect(performed).toEqual([releaseMeltAfterNonPayment]);
    expect(transitionInputs[0].evidence.originalProofsUnspent).toBe(true);
  });

  it('defers recovery when spent originals cannot restore the complete pre-swap output set', async () => {
    current = swapExecutingOperation(1);
    dependencies.quoteLifecycle.refreshMeltQuoteById = mock(async () => quote('PENDING'));
    dependencies.proofQueries.getProofsBySecrets = mock(
      async (_mintUrl: string, secrets: string[]) =>
        secrets.includes(inputProof.secret) ? [inputProof] : [],
    );
    dependencies.walletService.getWalletWithActiveKeysetId = mock(async () => ({
      wallet: {
        mint: { restore: mock(async () => ({ outputs: [], signatures: [] })) },
        checkProofsStates: mock(async () => [{ state: 'SPENT' }]),
      },
    }));

    await expect(
      new MeltOperationService(dependencies).recoverExecutingOperation(current),
    ).rejects.toThrow('restored output set is incomplete');

    expect(performed).toEqual([deferMeltRecovery]);
    expect(performed).not.toContain(applyMeltSwapResult);
    expect(performed).not.toContain(releaseMeltAfterNonPayment);
  });

  it('does not treat an absent original proof set as proof of non-payment', async () => {
    current = swapExecutingOperation(1);
    dependencies.quoteLifecycle.refreshMeltQuoteById = mock(async () => quote('UNPAID'));
    dependencies.proofQueries.getProofsBySecrets = mock(async () => []);
    const checkProofsStates = mock(async () => []);
    dependencies.walletService.getWalletWithActiveKeysetId = mock(async () => ({
      wallet: {
        mint: { restore: mock(async () => ({ outputs: [], signatures: [] })) },
        checkProofsStates,
      },
    }));

    await expect(
      new MeltOperationService(dependencies).recoverExecutingOperation(current),
    ).rejects.toThrow('restored output set is incomplete');

    expect(checkProofsStates).not.toHaveBeenCalled();
    expect(performed).toEqual([deferMeltRecovery]);
    expect(performed).not.toContain(releaseMeltAfterNonPayment);
  });

  it('restores a complete pre-swap output set before applying quote recovery', async () => {
    const keyset = createNewMintKeys(4, new Uint8Array(32).fill(7));
    const keys: MintKeys = {
      id: keyset.keysetId,
      unit: 'sat',
      keys: serializeMintKeys(keyset.pubKeys),
    };
    const seed = new Uint8Array(64).fill(3);
    const keep = OutputData.createDeterministicData(Amount.from(1), seed, 0, keys);
    const send = OutputData.createDeterministicData(Amount.from(2), seed, keep.length, keys);
    current = {
      ...swapExecutingOperation(send.length),
      swapOutputData: serializeOutputData({ keep, send }),
    } as ExecutingMeltOperation;
    dependencies.quoteLifecycle.refreshMeltQuoteById = mock(async () => quote('PENDING'));
    dependencies.proofQueries.getProofsBySecrets = mock(
      async (_mintUrl: string, secrets: string[]) =>
        secrets.includes(inputProof.secret) ? [inputProof] : [],
    );
    dependencies.mintService.refreshAndCommitIfStale = mock(async () => ({
      keysets: [
        {
          mintUrl,
          id: keys.id,
          unit: 'sat',
          keypairs: keys.keys,
          active: true,
          feePpk: 0,
          updatedAt: 1,
        },
      ],
    }));
    const wallet = {
      mint: {
        restore: mock(
          async ({ outputs }: { outputs: Array<{ B_: string; amount: number; id: string }> }) => ({
            outputs,
            signatures: outputs.map((output) => {
              const signature = createBlindSignature(
                pointFromHex(output.B_),
                keyset.privKeys[String(output.amount)]!,
                output.id,
              );
              return { id: output.id, amount: output.amount, C_: signature.C_.toHex(true) };
            }),
          }),
        ),
      },
      checkProofsStates: mock(async (proofs: Proof[]) =>
        proofs.some((proof) => proof.secret === inputProof.secret)
          ? [{ state: 'SPENT' }]
          : proofs.map(() => ({ state: 'UNSPENT' })),
      ),
    };
    dependencies.walletService.getWalletWithActiveKeysetId = mock(async () => ({ wallet }));

    await new MeltOperationService(dependencies).recoverExecutingOperation(current);

    expect(performed).toEqual([applyMeltSwapResult, applyMeltPending]);
    expect(transitionInputs[0].keepProofs).toHaveLength(keep.length);
    expect(transitionInputs[0].sendProofs).toHaveLength(send.length);
  });
});

function swapExecutingOperation(sendCount = 2, keepCount = 0): ExecutingMeltOperation {
  return {
    ...prepared(),
    state: 'executing',
    needsSwap: true,
    swapOutputData: {
      keep: Array.from({ length: keepCount }, (_, index) => ({
        blindedMessage: { amount: 1, id: 'ks', B_: `keep-B-${index}` },
        blindingFactor: `1${index + 1}`,
        secret: Buffer.from(`keep-${index}`).toString('hex'),
      })),
      send: Array.from({ length: sendCount }, (_, index) => ({
        blindedMessage: { amount: 1, id: 'ks', B_: `send-B-${index}` },
        blindingFactor: `0${index + 1}`,
        secret: Buffer.from(`send-${index}`).toString('hex'),
      })),
    },
  } as ExecutingMeltOperation;
}
