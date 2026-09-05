import { Amount, OutputData, type Wallet } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import { MintBolt12Handler } from '../../infra/handlers/mint/MintBolt12Handler';
import { MintOnchainHandler } from '../../infra/handlers/mint/MintOnchainHandler';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { Logger } from '../../logging/Logger';
import {
  MintOperationError,
  MintQuoteKeyError,
  MintQuoteValidationError,
} from '../../models/Error';
import type {
  ExecuteContext,
  MintMethodHandler,
  MintMethodQuoteSnapshot,
  PendingContext,
  PrepareContext,
  RecoverExecutingContext,
} from '../../operations/mint';
import type {
  ExecutingMintOperation,
  InitMintOperation,
  PendingMintOperation,
} from '../../operations/mint/MintOperation';
import type { ProofRepository } from '../../repositories';
import type { KeyRingService, MintService, ProofService, WalletService } from '../../services';
import { deserializeOutputData, serializeOutputData } from '../../utils';

type ReusableMethod = 'bolt12' | 'onchain';

describe.each(['bolt12', 'onchain'] as const)('%s Mint lifecycle', (method) => {
  const quoteLabel = method === 'bolt12' ? 'BOLT12' : 'Onchain';
  const recoveryLabel = method === 'bolt12' ? 'BOLT12' : 'onchain';
  const mintProofsEndpoint = method === 'bolt12' ? 'mintProofsBolt12' : 'mintProofsOnchain';
  const mintUrl = 'https://mint.test';
  const quoteId = `${method}-quote-1`;
  const pubkey = '02'.padEnd(66, '1');

  let handler: MintMethodHandler<ReusableMethod>;
  let keyRingService: KeyRingService;
  let wallet: Wallet;
  let mintAdapter: MintAdapter;
  let proofService: ProofService;
  let proofRepository: ProofRepository;
  let walletService: WalletService;
  let mintService: MintService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;

  const remoteQuote: MintMethodQuoteSnapshot<ReusableMethod> = {
    quote: quoteId,
    request: method === 'bolt12' ? 'lno1offer' : 'bc1qtestaddress',
    method,
    unit: 'sat',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    pubkey,
    amount_paid: Amount.from(21),
    amount_issued: Amount.from(8),
    updated_at: null,
  };

  const output = new OutputData(
    {
      amount: Amount.from(10),
      id: 'keyset-1',
      B_: 'B_out_1',
    },
    BigInt(1),
    new TextEncoder().encode('out-1'),
  );

  const buildPrepareContext = (): PrepareContext<ReusableMethod> => ({
    operation: {
      id: 'op-1',
      state: 'init',
      mintUrl,
      amount: Amount.from(10),
      unit: 'sat',
      method,
      methodData: {},
      quoteId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies InitMintOperation<ReusableMethod>,
    wallet,
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildExecutingOperation = (): ExecutingMintOperation<ReusableMethod> => ({
    ...buildPrepareContext().operation,
    state: 'executing',
    quoteId,
    request: remoteQuote.request,
    expiry: remoteQuote.expiry,
    pubkey,
    outputData: serializeOutputData({ keep: [output], send: [] }),
  });

  const buildRecoverContext = (
    localClaimabilityFacts = {
      finalizedAmount: Amount.zero(),
      reservedAmount: Amount.zero(),
    },
  ): RecoverExecutingContext<ReusableMethod> => ({
    ...buildPrepareContext(),
    operation: buildExecutingOperation(),
    localClaimabilityFacts,
  });

  const buildPendingContext = (): PendingContext<ReusableMethod> => ({
    operation: {
      ...buildExecutingOperation(),
      state: 'pending',
    } satisfies PendingMintOperation<ReusableMethod>,
    mintAdapter,
    logger,
  });

  beforeEach(() => {
    keyRingService = {
      generateMintQuoteKeyPair: mock(async () => ({
        publicKeyHex: pubkey,
        secretKey: new Uint8Array(32).fill(7),
        derivationIndex: 0,
        purpose: 'nut20_mint_quote' as const,
      })),
      getMintQuoteKeyPair: mock(async () => ({
        publicKeyHex: pubkey,
        secretKey: new Uint8Array(32).fill(7),
        derivationIndex: 0,
        purpose: 'nut20_mint_quote' as const,
      })),
    } as unknown as KeyRingService;

    handler =
      method === 'bolt12'
        ? new MintBolt12Handler(keyRingService)
        : new MintOnchainHandler(keyRingService);

    wallet = {
      [mintProofsEndpoint]: mock(async () => [
        {
          id: 'keyset-1',
          amount: Amount.from(10),
          secret: 'out-1',
          C: 'C_out_1',
        },
      ]),
    } as unknown as Wallet;

    mintAdapter = {
      checkMintQuote: mock(async () => remoteQuote),
    } as unknown as MintAdapter;

    proofService = {
      createOutputsAndIncrementCounters: mock(async () => ({ keep: [output], send: [] })),
      saveProofs: mock(async () => {}),
      recoverProofsFromOutputData: mock(async () => []),
    } as unknown as ProofService;
    proofRepository = {} as ProofRepository;
    walletService = {} as WalletService;
    mintService = {} as MintService;
    eventBus = new EventBus<CoreEvents>();
    logger = { info: mock(() => {}), warn: mock(() => {}) } as unknown as Logger;
  });

  it('prepares deterministic outputs without requiring available quote balance', async () => {
    const result = await handler.prepare({
      ...buildPrepareContext(),
      importedQuote: { ...remoteQuote, amount_paid: Amount.zero(), amount_issued: Amount.zero() },
    });

    expect(keyRingService.getMintQuoteKeyPair).toHaveBeenCalledWith(pubkey);
    expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(
      mintUrl,
      {
        keep: { amount: Amount.from(10), unit: 'sat' },
        send: { amount: Amount.zero(), unit: 'sat' },
      },
      {},
    );
    expect(result.state).toBe('pending');
    expect(result.quoteId).toBe(quoteId);
    expect(result.pubkey).toBe(pubkey);
    expect(result.amount).toEqual(Amount.from(10));
    expect(result.outputData).toEqual(serializeOutputData({ keep: [output], send: [] }));
  });

  it('fails preparation when the quote key is missing', async () => {
    (
      keyRingService.getMintQuoteKeyPair as Mock<typeof keyRingService.getMintQuoteKeyPair>
    ).mockResolvedValueOnce(null);

    const error = await handler
      .prepare({ ...buildPrepareContext(), importedQuote: remoteQuote })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(MintQuoteKeyError);
    expect(error.message).toContain('Missing NUT-20 mint quote key');
  });

  it('executes mint proofs with the persisted quote key', async () => {
    const pending = await handler.prepare({
      ...buildPrepareContext(),
      importedQuote: remoteQuote,
    });
    const context: ExecuteContext<ReusableMethod> = {
      ...buildPrepareContext(),
      operation: {
        ...pending,
        state: 'executing',
      },
    };

    const result = await handler.execute(context);

    expect(result.status).toBe('ISSUED');
    expect(mintAdapter.checkMintQuote).toHaveBeenCalledWith(mintUrl, method, quoteId);
    expect(wallet[mintProofsEndpoint]).toHaveBeenCalledWith(
      Amount.from(10),
      remoteQuote,
      '07'.repeat(32),
      undefined,
      { type: 'custom', data: deserializeOutputData(pending.outputData).keep },
    );
  });

  it('rejects contradictory fresh accounting before mint submission', async () => {
    const pending = await handler.prepare({
      ...buildPrepareContext(),
      importedQuote: remoteQuote,
    });
    (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockResolvedValueOnce({
      ...remoteQuote,
      amount_paid: Amount.from(9),
      amount_issued: Amount.from(10),
    });

    await expect(
      handler.execute({
        ...buildPrepareContext(),
        operation: { ...pending, state: 'executing' },
      }),
    ).rejects.toThrow(`${quoteLabel} mint quote ${quoteId} is not claimable: invalid`);

    expect(wallet[mintProofsEndpoint]).not.toHaveBeenCalled();
  });

  it('does not let a stale valid fresh balance veto service-authorized execution', async () => {
    const pending = await handler.prepare({
      ...buildPrepareContext(),
      importedQuote: remoteQuote,
    });
    (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockResolvedValueOnce({
      ...remoteQuote,
      amount_paid: Amount.from(1),
      amount_issued: Amount.zero(),
    });

    const result = await handler.execute({
      ...buildPrepareContext(),
      operation: { ...pending, state: 'executing' },
    });

    expect(result.status).toBe('ISSUED');
    expect(wallet[mintProofsEndpoint]).toHaveBeenCalledTimes(1);
  });

  it('recovers signed outputs before retrying the mint', async () => {
    (
      proofService.recoverProofsFromOutputData as Mock<
        typeof proofService.recoverProofsFromOutputData
      >
    ).mockResolvedValueOnce([
      {
        id: 'keyset-1',
        amount: Amount.from(10),
        secret: 'out-1',
        C: 'C_out_1',
      },
    ]);

    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result).toEqual({ status: 'FINALIZED' });
    expect(proofService.recoverProofsFromOutputData).toHaveBeenCalledWith(
      mintUrl,
      buildExecutingOperation().outputData,
      { unit: 'sat', createdByOperationId: 'op-1' },
    );
    expect(mintAdapter.checkMintQuote).not.toHaveBeenCalled();
    expect(wallet[mintProofsEndpoint]).not.toHaveBeenCalled();
  });

  it('retries minting from persisted output data when the quote is still available', async () => {
    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result).toEqual({ status: 'FINALIZED' });
    expect(proofService.recoverProofsFromOutputData).toHaveBeenCalled();
    expect(wallet[mintProofsEndpoint]).toHaveBeenCalledWith(
      Amount.from(10),
      remoteQuote,
      '07'.repeat(32),
      undefined,
      { type: 'custom', data: [output] },
    );
    expect(proofService.saveProofs).toHaveBeenCalledWith(mintUrl, [
      expect.objectContaining({
        unit: 'sat',
        createdByOperationId: 'op-1',
        state: 'ready',
        secret: 'out-1',
      }),
    ]);
  });

  it('returns pending during recovery when output restore is empty and balance is unavailable', async () => {
    (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockResolvedValueOnce({
      ...remoteQuote,
      amount_paid: Amount.from(8),
      amount_issued: Amount.from(8),
    });

    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result.status).toBe('PENDING');
    expect(wallet[mintProofsEndpoint]).not.toHaveBeenCalled();
  });

  it('subtracts other in-flight reservations before retrying recovery', async () => {
    const result = await handler.recoverExecuting(
      buildRecoverContext({
        finalizedAmount: Amount.zero(),
        reservedAmount: Amount.from(10),
      }),
    );

    expect(result.status).toBe('PENDING');
    expect(wallet[mintProofsEndpoint]).not.toHaveBeenCalled();
  });

  it('attempts restore again after an already-issued retry result', async () => {
    (
      wallet[mintProofsEndpoint] as Mock<(typeof wallet)[typeof mintProofsEndpoint]>
    ).mockImplementationOnce(async () => {
      throw new MintOperationError(20002, 'already issued');
    });
    (
      proofService.recoverProofsFromOutputData as Mock<
        typeof proofService.recoverProofsFromOutputData
      >
    )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'keyset-1',
          amount: Amount.from(10),
          secret: 'out-1',
          C: 'C_out_1',
        },
      ]);

    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result).toEqual({ status: 'FINALIZED' });
    expect(proofService.recoverProofsFromOutputData).toHaveBeenCalledTimes(2);
  });

  it('retries funded execution recovery after expiry', async () => {
    (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockResolvedValueOnce({
      ...remoteQuote,
      expiry: Math.floor(Date.now() / 1000) - 1,
    });

    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result).toEqual({ status: 'FINALIZED' });
    expect(wallet[mintProofsEndpoint]).toHaveBeenCalled();
    expect(proofService.saveProofs).toHaveBeenCalled();
  });

  it('fails recovery when the mint rejects issuance with quote expired', async () => {
    (
      wallet[mintProofsEndpoint] as Mock<(typeof wallet)[typeof mintProofsEndpoint]>
    ).mockRejectedValueOnce(new MintOperationError(20007, 'Quote expired'));

    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result).toEqual({
      status: 'TERMINAL',
      error: `Recovered: ${recoveryLabel} quote ${quoteId} expired while executing mint`,
    });
    expect(wallet[mintProofsEndpoint]).toHaveBeenCalledTimes(1);
    expect(proofService.saveProofs).not.toHaveBeenCalled();
  });

  it('keeps non-protocol expiry errors pending during recovery', async () => {
    (
      wallet[mintProofsEndpoint] as Mock<(typeof wallet)[typeof mintProofsEndpoint]>
    ).mockRejectedValueOnce(new Error('Authentication session expired'));

    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result).toEqual({
      status: 'PENDING',
      error: 'Authentication session expired',
    });
    expect(proofService.saveProofs).not.toHaveBeenCalled();
  });

  it('reports the validated remote snapshot for a pending operation', async () => {
    const result = await handler.checkPending(buildPendingContext());

    expect(result.quoteSnapshot).toBe(remoteQuote);
    expect(result.observedAt).toEqual(expect.any(Number));
  });

  it('reports an unattributable pending response as a validation failure', async () => {
    (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockResolvedValueOnce({
      ...remoteQuote,
      request: 'bc1qotheraddress',
    });

    const result = await handler.checkPending(buildPendingContext());

    expect(result.quoteSnapshot).toBeUndefined();
    expect(result.validationFailure).toMatchObject({
      code: 'invalid_quote',
      retryable: false,
    });
    expect(result.validationFailure?.reason).toContain('conflicts with pending operation identity');
  });

  it('does not attribute a mismatched response when the operation pubkey is missing', async () => {
    (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockResolvedValueOnce({
      ...remoteQuote,
      quote: 'other-quote',
    });
    const baseContext = buildPendingContext();

    const result = await handler.checkPending({
      ...baseContext,
      operation: { ...baseContext.operation, pubkey: undefined },
    });

    expect(result.quoteSnapshot).toBeUndefined();
    expect(result.validationFailure?.code).toBe('invalid_quote');
  });

  it('preserves the missing-pubkey terminal code for an attributable response', async () => {
    const baseContext = buildPendingContext();

    const result = await handler.checkPending({
      ...baseContext,
      operation: { ...baseContext.operation, pubkey: undefined },
    });

    expect(result.quoteSnapshot).toBe(remoteQuote);
    expect(result.validationFailure?.code).toBe('missing_quote_pubkey');
  });

  it('preserves remote accounting in the pending observation', async () => {
    (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockResolvedValueOnce({
      ...remoteQuote,
      amount_paid: Amount.from(8),
      amount_issued: Amount.from(0),
    });

    const result = await handler.checkPending(buildPendingContext());

    expect(result.quoteSnapshot?.amount_paid?.equals(Amount.from(8))).toBe(true);
  });
  it('rejects preparation with a different quote identity before allocating outputs', async () => {
    await expect(
      handler.prepare({
        ...buildPrepareContext(),
        importedQuote: { ...remoteQuote, quote: 'other-quote' },
      }),
    ).rejects.toBeInstanceOf(MintQuoteValidationError);
    expect(proofService.createOutputsAndIncrementCounters).not.toHaveBeenCalled();
  });

  it('rejects preparation without a quote or deterministic outputs', async () => {
    await expect(handler.prepare(buildPrepareContext())).rejects.toThrow('was not provided');
    (
      proofService.createOutputsAndIncrementCounters as Mock<
        typeof proofService.createOutputsAndIncrementCounters
      >
    ).mockResolvedValueOnce({
      keep: [],
      send: [],
      keepAmount: Amount.zero(),
      sendAmount: Amount.zero(),
    });
    await expect(
      handler.prepare({ ...buildPrepareContext(), importedQuote: remoteQuote }),
    ).rejects.toThrow('Failed to create deterministic outputs');
  });

  it.each(['unit', 'pubkey'] as const)(
    'rejects changed remote %s before issuance or replay',
    async (field) => {
      (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockResolvedValue({
        ...remoteQuote,
        [field]: 'changed',
      });
      await expect(handler.execute(buildRecoverContext())).rejects.toThrow();
      expect((await handler.recoverExecuting(buildRecoverContext())).status).toBe('TERMINAL');
      expect(wallet[mintProofsEndpoint]).not.toHaveBeenCalled();
    },
  );

  it('requires an owned quote key for execution and recovery', async () => {
    (
      keyRingService.getMintQuoteKeyPair as Mock<typeof keyRingService.getMintQuoteKeyPair>
    ).mockResolvedValue(null);
    await expect(handler.execute(buildRecoverContext())).rejects.toBeInstanceOf(MintQuoteKeyError);
    expect(await handler.recoverExecuting(buildRecoverContext())).toEqual({
      status: 'TERMINAL',
      error: `Missing NUT-20 mint quote key for pubkey ${pubkey}`,
    });
    expect(wallet[mintProofsEndpoint]).not.toHaveBeenCalled();
  });

  it('reports a missing operation pubkey after empty Restore', async () => {
    const ctx = buildRecoverContext();
    ctx.operation.pubkey = undefined;
    expect(await handler.recoverExecuting(ctx)).toEqual({
      status: 'TERMINAL',
      error: `Recovered: ${recoveryLabel} mint operation op-1 is missing NUT-20 quote pubkey`,
    });
    expect(mintAdapter.checkMintQuote).not.toHaveBeenCalled();
  });

  it('leaves recovery pending when Restore fails without checking or replaying the quote', async () => {
    (
      proofService.recoverProofsFromOutputData as Mock<
        typeof proofService.recoverProofsFromOutputData
      >
    ).mockRejectedValueOnce(new Error('Restore unavailable'));
    expect(await handler.recoverExecuting(buildRecoverContext())).toEqual({
      status: 'PENDING',
      error: 'Restore unavailable',
    });
    expect(mintAdapter.checkMintQuote).not.toHaveBeenCalled();
    expect(wallet[mintProofsEndpoint]).not.toHaveBeenCalled();
  });

  it('keeps remote observation failures pending after empty Restore', async () => {
    (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockRejectedValueOnce(
      new Error('Mint unavailable'),
    );
    expect(await handler.recoverExecuting(buildRecoverContext())).toEqual({
      status: 'PENDING',
      error: 'Mint unavailable',
    });
    expect(wallet[mintProofsEndpoint]).not.toHaveBeenCalled();
  });

  it('rejects contradictory recovery accounting without replay', async () => {
    (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockResolvedValueOnce({
      ...remoteQuote,
      amount_paid: Amount.from(7),
    });
    expect(await handler.recoverExecuting(buildRecoverContext())).toEqual({
      status: 'TERMINAL',
      error: `Recovered: ${recoveryLabel} quote ${quoteId} has invalid claimability accounting`,
    });
    expect(wallet[mintProofsEndpoint]).not.toHaveBeenCalled();
  });

  it('does not replay balance already consumed by finalized local operations', async () => {
    expect(
      (
        await handler.recoverExecuting(
          buildRecoverContext({
            finalizedAmount: Amount.from(21),
            reservedAmount: Amount.zero(),
          }),
        )
      ).status,
    ).toBe('PENDING');
    expect(wallet[mintProofsEndpoint]).not.toHaveBeenCalled();
  });

  // MintOperationService consumes these outcomes differently; this refactor must retain both.
  it.each([
    new MintOperationError(20002, 'issued'),
    new MintOperationError(11003, 'signed'),
    new Error('outputs already signed'),
  ])('preserves the method-specific initial already-issued outcome: %s', async (error) => {
    (
      wallet[mintProofsEndpoint] as Mock<(typeof wallet)[typeof mintProofsEndpoint]>
    ).mockRejectedValueOnce(error);
    const execution = handler.execute(buildRecoverContext());
    if (method === 'bolt12') {
      expect(await execution).toEqual({ status: 'ALREADY_ISSUED' });
    } else {
      await expect(execution).rejects.toBe(error);
    }
  });

  it('propagates other issuance errors with their original cause', async () => {
    const error = new Error('Mint unavailable', { cause: new Error('Connection closed') });
    (
      wallet[mintProofsEndpoint] as Mock<(typeof wallet)[typeof mintProofsEndpoint]>
    ).mockRejectedValueOnce(error);
    await expect(handler.execute(buildRecoverContext())).rejects.toBe(error);
  });

  it.each(['empty', 'failed'] as const)(
    'keeps an already-issued replay pending when the second Restore is %s',
    async (outcome) => {
      (
        wallet[mintProofsEndpoint] as Mock<(typeof wallet)[typeof mintProofsEndpoint]>
      ).mockRejectedValueOnce(new MintOperationError(11003, 'already signed'));
      const restore = proofService.recoverProofsFromOutputData as Mock<
        typeof proofService.recoverProofsFromOutputData
      >;
      restore.mockResolvedValueOnce([]);
      if (outcome === 'failed') restore.mockRejectedValueOnce(new Error('Restore unavailable'));
      const result = await handler.recoverExecuting(buildRecoverContext());
      expect(result).toEqual({
        status: 'PENDING',
        error:
          outcome === 'failed'
            ? 'Restore unavailable'
            : `Recovered: ${recoveryLabel} quote ${quoteId} was already issued but proofs were not recoverable`,
      });
      expect(restore).toHaveBeenCalledTimes(2);
      expect(proofService.saveProofs).not.toHaveBeenCalled();
    },
  );

  it.each(['quote', 'request', 'unit', 'pubkey'] as const)(
    'does not attribute pending responses with a changed %s',
    async (field) => {
      (mintAdapter.checkMintQuote as Mock<typeof mintAdapter.checkMintQuote>).mockResolvedValueOnce(
        { ...remoteQuote, [field]: 'changed' },
      );
      const result = await handler.checkPending(buildPendingContext());
      expect(result.quoteSnapshot).toBeUndefined();
      expect(result.validationFailure).toMatchObject({ code: 'invalid_quote', retryable: false });
    },
  );
});
