import { Amount, type Proof, type Wallet } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra';
import { MeltBolt12Handler } from '../../infra/handlers/melt/MeltBolt11Handler';
import type { Logger } from '../../logging/Logger';
import type {
  BasePrepareContext,
  ExecuteContext,
  PendingContext,
} from '../../operations/melt/MeltMethodHandler';
import type {
  ExecutingMeltOperation,
  InitMeltOperation,
  PendingMeltOperation,
} from '../../operations/melt/MeltOperation';
import type { ProofRepository } from '../../repositories';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';

describe('MeltBolt12Handler', () => {
  const mintUrl = 'https://mint.test';
  const offer = 'lno1offer';
  const quoteId = 'melt-quote-12';
  const inputProof: Proof = {
    amount: Amount.from(112),
    C: 'C_input',
    id: 'keyset-1',
    secret: 'input-1',
  };

  let handler: MeltBolt12Handler;
  let wallet: Wallet;
  let proofRepository: ProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let mintAdapter: MintAdapter;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;

  const initOperation = (
    overrides: Partial<
      InitMeltOperation & { method: 'bolt12'; methodData: { offer: string; amountSats?: Amount } }
    > = {},
  ): InitMeltOperation & {
    method: 'bolt12';
    methodData: { offer: string; amountSats?: Amount };
  } => ({
    id: 'op-12',
    state: 'init',
    mintUrl,
    unit: 'sat',
    method: 'bolt12',
    methodData: { offer },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  const executingOperation = (): ExecutingMeltOperation & {
    method: 'bolt12';
    methodData: { offer: string; amountSats?: Amount };
  } => ({
    ...initOperation(),
    state: 'executing',
    quoteId,
    amount: Amount.from(100),
    fee_reserve: Amount.from(12),
    swap_fee: Amount.zero(),
    needsSwap: false,
    inputAmount: Amount.from(112),
    inputProofSecrets: ['input-1'],
    changeOutputData: { keep: [], send: [] },
  });

  const prepareContext = (operation = initOperation()): BasePrepareContext<'bolt12'> => ({
    operation,
    wallet,
    proofRepository,
    proofService,
    mintService,
    walletService,
    mintAdapter,
    eventBus,
    logger,
  });

  beforeEach(() => {
    handler = new MeltBolt12Handler();
    eventBus = new EventBus<CoreEvents>();
    wallet = {
      createMeltQuoteBolt12: mock(async () => ({
        quote: quoteId,
        amount: Amount.from(100),
        fee_reserve: Amount.from(12),
        unit: 'sat',
        state: 'UNPAID',
      })),
      getFeesForProofs: mock(() => Amount.zero()),
    } as unknown as Wallet;
    proofRepository = {
      getProofsByOperationId: mock(async () => [inputProof]),
    } as unknown as ProofRepository;
    proofService = {
      selectProofsToSend: mock(async () => [inputProof]),
      reserveProofs: mock(async () => ({ amount: Amount.from(112) })),
      createBlankOutputs: mock(async () => []),
      setProofState: mock(async () => {}),
      restoreProofsToReady: mock(async () => {}),
      releaseProofs: mock(async () => {}),
      unblindAndSaveChangeProofs: mock(async () => {}),
    } as unknown as ProofService;
    mintService = {} as MintService;
    walletService = {} as WalletService;
    mintAdapter = {
      customMeltBolt12: mock(async () => ({
        state: 'PAID',
        change: [],
        payment_preimage: 'preimage-12',
      })),
      checkMeltQuoteBolt12: mock(async () => ({
        state: 'PAID',
        change: [],
        payment_preimage: 'preimage-12',
      })),
      checkMeltQuoteBolt12State: mock(async () => 'PAID'),
    } as unknown as MintAdapter;
    logger = { debug: mock(() => {}), info: mock(() => {}) } as unknown as Logger;
  });

  it('creates a BOLT12 melt quote using offer and optional amount in millisats', async () => {
    const prepared = await handler.prepare(
      prepareContext(initOperation({ methodData: { offer, amountSats: Amount.from(123) } })),
    );

    expect(wallet.createMeltQuoteBolt12).toHaveBeenCalledWith(offer, Amount.from(123000));
    expect(prepared.method).toBe('bolt12');
    expect(prepared.quoteId).toBe(quoteId);
    expect(prepared.amount).toEqual(Amount.from(100));
  });

  it('uses customMeltBolt12 and records the returned preimage', async () => {
    const operation = executingOperation();
    const result = await handler.execute({
      ...prepareContext(),
      operation,
      reservedProofs: [inputProof],
    } as ExecuteContext<'bolt12'>);

    expect(mintAdapter.customMeltBolt12).toHaveBeenCalledWith(mintUrl, [inputProof], [], quoteId);
    expect(result.status).toBe('PAID');
    if (result.status === 'PAID') {
      expect(result.finalized.finalizedData).toEqual({ preimage: 'preimage-12' });
    }
  });

  it('checks pending BOLT12 melt quotes with the method-specific adapter call', async () => {
    const result = await handler.checkPending?.({
      ...prepareContext(),
      operation: { ...executingOperation(), state: 'pending' } as PendingMeltOperation & {
        method: 'bolt12';
        methodData: { offer: string };
      },
    } as PendingContext<'bolt12'>);

    expect(mintAdapter.checkMeltQuoteBolt12State).toHaveBeenCalledWith(mintUrl, quoteId);
    expect(result).toBe('finalize');
  });
});
