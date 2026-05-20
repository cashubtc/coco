import { Amount, OutputData, type MintQuoteBolt12Response, type Wallet } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra';
import { MintBolt12Handler } from '../../infra/handlers/mint/MintBolt12Handler';
import type { Logger } from '../../logging/Logger';
import type { ProofRepository } from '../../repositories';
import type { KeyRingService } from '../../services/KeyRingService';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { ExecuteContext, PendingContext, PrepareContext } from '../../operations/mint';
import { serializeOutputData } from '../../utils';

describe('MintBolt12Handler', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-12';
  const pubkey = '02' + '11'.repeat(32);
  const secretKey = new Uint8Array(32).fill(7);

  let handler: MintBolt12Handler;
  let wallet: Wallet;
  let mintAdapter: MintAdapter;
  let proofService: ProofService;
  let proofRepository: ProofRepository;
  let walletService: WalletService;
  let mintService: MintService;
  let keyRingService: KeyRingService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;

  const outputData = serializeOutputData({
    keep: [
      new OutputData(
        {
          amount: Amount.from(10),
          id: 'keyset-1',
          B_: 'B_out_1',
        },
        BigInt(1),
        new TextEncoder().encode('out-1'),
      ),
    ],
    send: [],
  });

  const operation = {
    id: 'op-12',
    state: 'init' as const,
    mintUrl,
    amount: Amount.from(10),
    unit: 'sat',
    method: 'bolt12' as const,
    methodData: { description: 'mint me' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const quote = (overrides: Partial<MintQuoteBolt12Response> = {}): MintQuoteBolt12Response => ({
    quote: quoteId,
    request: 'lno1offer',
    amount: Amount.from(10),
    unit: 'sat',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    pubkey,
    amount_paid: Amount.zero(),
    amount_issued: Amount.zero(),
    ...overrides,
  });

  const buildPrepareContext = (
    overrides: Partial<PrepareContext<'bolt12'>> = {},
  ): PrepareContext<'bolt12'> => ({
    operation,
    wallet,
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    keyRingService,
    eventBus,
    logger,
    ...overrides,
  });

  const buildPendingContext = (remoteQuote: MintQuoteBolt12Response): PendingContext<'bolt12'> => {
    (mintAdapter.checkMintQuoteBolt12 as Mock<any>).mockImplementation(async () => remoteQuote);
    return {
      ...buildPrepareContext(),
      operation: {
        ...operation,
        state: 'pending',
        quoteId,
        request: remoteQuote.request,
        expiry: remoteQuote.expiry,
        pubkey,
        lastObservedRemoteState: 'UNPAID',
        lastObservedRemoteStateAt: Date.now(),
        outputData,
      },
    };
  };

  const buildExecuteContext = (remoteQuote: MintQuoteBolt12Response): ExecuteContext<'bolt12'> => {
    (mintAdapter.checkMintQuoteBolt12 as Mock<any>).mockImplementation(async () => remoteQuote);
    return {
      ...buildPrepareContext(),
      operation: {
        ...operation,
        state: 'executing',
        quoteId,
        request: remoteQuote.request,
        expiry: remoteQuote.expiry,
        pubkey,
        lastObservedRemoteState: 'PAID',
        lastObservedRemoteStateAt: Date.now(),
        outputData,
      },
    };
  };

  beforeEach(() => {
    handler = new MintBolt12Handler();
    wallet = {
      createMintQuoteBolt12: mock(async () => quote()),
      mintProofsBolt12: mock(async () => []),
    } as unknown as Wallet;
    mintAdapter = {
      checkMintQuoteBolt12: mock(async () => quote()),
    } as unknown as MintAdapter;
    proofService = {
      createOutputsAndIncrementCounters: mock(async () => ({ keep: outputData.keep, send: [] })),
      saveProofs: mock(async () => {}),
      recoverProofsFromOutputData: mock(async () => []),
    } as unknown as ProofService;
    keyRingService = {
      generateNewKeyPair: mock(async () => ({ publicKeyHex: pubkey })),
      getKeyPair: mock(async () => ({ publicKeyHex: pubkey, secretKey })),
    } as unknown as KeyRingService;
    proofRepository = {} as ProofRepository;
    walletService = {} as WalletService;
    mintService = {} as MintService;
    eventBus = new EventBus<CoreEvents>();
    logger = { info: mock(() => {}), warn: mock(() => {}) } as unknown as Logger;
  });

  it('creates a fixed-amount quote with a fresh keypair', async () => {
    const result = await handler.prepare(buildPrepareContext());

    expect(keyRingService.generateNewKeyPair).toHaveBeenCalled();
    expect(wallet.createMintQuoteBolt12).toHaveBeenCalledWith(pubkey, {
      amount: Amount.from(10),
      description: 'mint me',
    });
    expect(result.quoteId).toBe(quoteId);
    expect(result.pubkey).toBe(pubkey);
    expect(result.lastObservedRemoteState).toBe('UNPAID');
  });

  it('omits the remote amount for amountless offers while preserving operation amount', async () => {
    const amountlessQuote = quote({ amount: undefined });
    (wallet.createMintQuoteBolt12 as Mock<any>).mockImplementation(async () => amountlessQuote);

    const result = await handler.prepare(
      buildPrepareContext({
        operation: {
          ...operation,
          methodData: { amountless: true, description: 'pay any amount' },
        },
      }),
    );

    expect(wallet.createMintQuoteBolt12).toHaveBeenCalledWith(pubkey, {
      amount: undefined,
      description: 'pay any amount',
    });
    expect(result.amount).toEqual(Amount.from(10));
  });

  it('requires the imported quote pubkey to exist in the keyring', async () => {
    (keyRingService.getKeyPair as Mock<any>).mockImplementation(async () => null);

    await expect(handler.prepare(buildPrepareContext({ importedQuote: quote() }))).rejects.toThrow(
      'is not available in keyring',
    );
  });

  it('marks amountless quotes ready when paid amount covers the operation amount', async () => {
    const result = await handler.checkPending(
      buildPendingContext(
        quote({
          amount: undefined,
          amount_paid: Amount.from(15),
          amount_issued: Amount.from(4),
        }),
      ),
    );

    expect(result.observedRemoteState).toBe('PAID');
    expect(result.category).toBe('ready');
  });

  it('mints with the keyring private key and custom outputs', async () => {
    await handler.execute(
      buildExecuteContext(
        quote({
          amount_paid: Amount.from(10),
        }),
      ),
    );

    const call = (wallet.mintProofsBolt12 as Mock<any>).mock.calls[0]! as any[];
    expect(call[0]).toEqual(Amount.from(10));
    expect(call[1].quote).toBe(quoteId);
    expect(call[2]).toBe(bytesToHex(secretKey));
    expect(call[3]).toBeUndefined();
    expect(call[4].type).toBe('custom');
    expect(call[4].data).toHaveLength(1);
    expect(call[4].data[0].blindedMessage.B_).toBe('B_out_1');
  });
});
