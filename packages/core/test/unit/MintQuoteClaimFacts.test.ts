import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { Amount, OutputData, type Proof } from '@cashu/cashu-ts';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintHandlerProvider } from '../../infra/handlers/mint';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { MintQuoteRef } from '../../models/QuoteIdentity';
import type { BatchMintOperation } from '../../operations/batchMint/BatchMintOperation.ts';
import type {
  ExecutingMintOperation,
  PendingMintOperation,
} from '../../operations/mint/MintOperation';
import type {
  MintMethodHandler,
  RecoverExecutingContext,
} from '../../operations/mint/MintMethodHandler';
import { MintOperationService } from '../../operations/mint/MintOperationService';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { deserializeOutputData } from '../../utils';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import {
  mintQuoteFromBolt11Fixture,
  mintQuoteFromOnchainFixture,
} from '../normalizedMintQuoteFixtures.ts';

/**
 * Standalone Mint claimability must count Batch Mint Members through the shared claim facts:
 * finalized members as local issuance and executing members as Mint Quote Reservations.
 */
describe('Mint Quote claim facts with Batch Mint Operations', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = testMintKeysetId();
  const pubkey = '02'.padEnd(66, '1');

  let repositories: MemoryRepositories;
  let service: MintOperationService;
  let recoveredFacts: RecoverExecutingContext['localClaimabilityFacts'][];

  const outputProofs = (operation: ExecutingMintOperation): Proof[] =>
    deserializeOutputData(operation.outputData).keep.map((output) => ({
      id: output.blindedMessage.id,
      amount: output.blindedMessage.amount,
      secret: new TextDecoder().decode(output.secret),
      C: `C_${new TextDecoder().decode(output.secret)}`,
    }));

  const batch = (
    id: string,
    state: BatchMintOperation['state'],
    method: BatchMintOperation['method'],
    members: Array<{ quoteId: string; amount: number }>,
  ): BatchMintOperation => {
    const base = {
      id,
      mintUrl,
      method,
      unit: 'sat',
      members: members.map((member, ordinal) => ({
        ordinal,
        quoteId: member.quoteId,
        amount: Amount.from(member.amount),
        request: `request-${member.quoteId}`,
        signature: null,
      })),
      outputData: { keep: [], send: [] },
      createdAt: 1,
      updatedAt: 1,
    };
    return state === 'failed'
      ? { ...base, state, terminalFailure: { reason: 'rejected', observedAt: 2 } }
      : { ...base, state };
  };

  const persistBolt11Quote = (quoteId: string) =>
    repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Fixture(mintUrl, {
        quote: quoteId,
        request: `lnbc-${quoteId}`,
        amount: Amount.from(10),
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
      }),
    );

  const persistOnchainQuote = (quoteId: string, paid: number) =>
    repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromOnchainFixture(mintUrl, {
        quote: quoteId,
        request: `bc1q-${quoteId}`,
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        pubkey,
        amount_paid: Amount.from(paid),
        amount_issued: Amount.zero(),
        updated_at: null,
      }),
    );

  beforeEach(async () => {
    repositories = new MemoryRepositories();
    recoveredFacts = [];
    await repositories.mintRepository.addNewMint({
      mintUrl,
      name: 'Test',
      trusted: true,
      mintInfo: {
        ...testMintInfo,
        nuts: {
          ...testMintInfo.nuts,
          '4': {
            disabled: false,
            methods: ['bolt11', 'onchain'].map((method) => ({
              method,
              unit: 'sat',
              method_name: method,
              min_amount: 1,
              max_amount: 1000,
            })),
          },
        },
      },
      createdAt: 1000,
      updatedAt: 1000,
    });
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: keysetId,
      unit: 'sat',
      keypairs: testMintKeypairs,
      active: true,
      feePpk: 0,
    });
    await repositories.keyRingRepository.setPersistedKeyPair({
      publicKeyHex: pubkey,
      secretKey: new Uint8Array(32),
      purpose: 'nut20_mint_quote',
    });

    const quotes = repositories.mintQuoteRepository;
    const getMintQuote = (url: string, method: MintQuoteRef['method'], quoteId: string) =>
      quotes.getMintQuote(url, method, quoteId);
    const handler = {
      execute: mock(async ({ operation }: { operation: ExecutingMintOperation }) => ({
        status: 'ISSUED' as const,
        proofs: outputProofs(operation),
      })),
      recoverExecuting: mock(async (context: RecoverExecutingContext) => {
        recoveredFacts.push(context.localClaimabilityFacts);
        return { status: 'UNRESOLVED' as const };
      }),
    } as unknown as MintMethodHandler;

    service = new MintOperationService({
      handlerProvider: { get: () => handler } as unknown as MintHandlerProvider,
      mintOperationQueries: repositories.mintOperationRepository,
      proofQueries: repositories.proofRepository,
      transactionRunner: new RepositoryCoreTransactionRunner(repositories, {
        ...OutputData,
        createDeterministicData: (amount, _seed, counter, keys) =>
          OutputData.createRandomData(amount, keys).map(
            (output, index) =>
              new OutputData(
                output.blindedMessage,
                output.blindingFactor,
                new TextEncoder().encode(`out-${counter + index}`),
              ),
          ),
      } as typeof OutputData),
      loadSeed: async () => new Uint8Array(32),
      quoteLifecycle: {
        requireMintQuoteRefForPrepare: async (ref: MintQuoteRef) => {
          const quote = await getMintQuote(ref.mintUrl, ref.method, ref.quoteId);
          if (!quote) throw new Error(`Mint quote ${ref.quoteId} was not found`);
          return quote;
        },
        getMintQuote,
        getPendingMintQuotes: async () => [],
        recordMintQuoteSnapshot: mock(async () => {
          throw new Error('unexpected quote observation');
        }),
      },
      mintService: {
        isTrustedMint: async () => true,
        assertMethodUnitSupported: async () => {},
        refreshAndCommitIfStale: async () => ({
          mint: await repositories.mintRepository.findMintByUrl(mintUrl),
          keysets: await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl),
        }),
      } as unknown as MintService,
      walletService: {
        getWalletWithActiveKeysetId: async () => ({ wallet: {} }),
      } as unknown as WalletService,
      mintAdapter: {} as MintAdapter,
      eventBus: new EventBus<CoreEvents>(),
    });
  });

  describe('BOLT11 fixed-amount quotes', () => {
    it('treats a finalized Batch Mint Member as completed local issuance', async () => {
      await persistBolt11Quote('bolt11-finalized');
      await repositories.batchMint.operationRepository.create(
        batch('batch-finalized', 'finalized', 'bolt11', [
          { quoteId: 'other-quote', amount: 10 },
          { quoteId: 'bolt11-finalized', amount: 10 },
        ]),
      );

      const assessment = await service.getMintQuoteClaimability(
        mintUrl,
        'bolt11',
        'bolt11-finalized',
      );

      expect(assessment?.status).toBe('complete');
    });

    for (const state of ['executing', 'finalized'] as const) {
      it(`rejects standalone preparation while a ${state} Batch Mint Member claims the quote`, async () => {
        await persistBolt11Quote(`bolt11-${state}`);
        await repositories.batchMint.operationRepository.create(
          batch(`batch-${state}`, state, 'bolt11', [
            { quoteId: `bolt11-${state}`, amount: 10 },
            { quoteId: 'other-quote', amount: 10 },
          ]),
        );

        await expect(
          service.prepare(
            { mintUrl, method: 'bolt11', quoteId: `bolt11-${state}` },
            Amount.from(10),
          ),
        ).rejects.toThrow(`already claimed by Batch Mint Operation batch-${state}`);
        expect(await repositories.mintOperationRepository.getByMintUrl(mintUrl)).toHaveLength(0);
      });
    }

    it('lets a failed Batch Mint Operation release the quote to standalone claiming', async () => {
      await persistBolt11Quote('bolt11-failed');
      await repositories.batchMint.operationRepository.create(
        batch('batch-failed', 'failed', 'bolt11', [
          { quoteId: 'bolt11-failed', amount: 10 },
          { quoteId: 'other-quote', amount: 10 },
        ]),
      );

      const operation = await service.prepare(
        { mintUrl, method: 'bolt11', quoteId: 'bolt11-failed' },
        Amount.from(10),
      );
      expect((await service.execute(operation.id)).state).toBe('finalized');
    });

    it('does not reserve the quote for execution while a batch reserves it', async () => {
      await persistBolt11Quote('bolt11-reserved');
      const pending = await service.prepare(
        { mintUrl, method: 'bolt11', quoteId: 'bolt11-reserved' },
        Amount.from(10),
      );
      await repositories.batchMint.operationRepository.create(
        batch('batch-reserved', 'executing', 'bolt11', [
          { quoteId: 'other-quote', amount: 10 },
          { quoteId: 'bolt11-reserved', amount: 10 },
        ]),
      );

      expect((await service.execute(pending.id)).state).toBe('pending');
      expect((await repositories.mintOperationRepository.getById(pending.id))?.state).toBe(
        'pending',
      );
    });
  });

  describe('reusable quotes', () => {
    const quoteId = 'onchain-reusable';

    beforeEach(async () => {
      await persistOnchainQuote(quoteId, 30);
      await repositories.batchMint.operationRepository.create(
        batch('batch-finalized', 'finalized', 'onchain', [
          { quoteId: 'other-quote', amount: 4 },
          { quoteId, amount: 5 },
        ]),
      );
      await repositories.batchMint.operationRepository.create(
        batch('batch-executing', 'executing', 'onchain', [
          { quoteId, amount: 10 },
          { quoteId: 'other-quote', amount: 6 },
        ]),
      );
      await repositories.batchMint.operationRepository.create(
        batch('batch-failed', 'failed', 'onchain', [
          { quoteId, amount: 7 },
          { quoteId: 'other-quote', amount: 1 },
        ]),
      );
    });

    it('subtracts finalized and executing Batch Mint Members from the claimable amount', async () => {
      const assessment = await service.getMintQuoteClaimability(mintUrl, 'onchain', quoteId);

      expect(assessment?.status).toBe('claimable');
      expect(assessment?.claimAmount?.toString()).toBe('15');
    });

    it('claims only the remainder left by Batch Mint Members', async () => {
      const claimed = await service.claimMintQuote(mintUrl, 'onchain', quoteId);

      expect(claimed.map((operation) => [operation.state, operation.amount.toString()])).toEqual([
        ['finalized', '15'],
      ]);
    });

    it('keeps a standalone operation pending when batches leave too little', async () => {
      const pending = await service.prepare(
        { mintUrl, method: 'onchain', quoteId },
        Amount.from(16),
      );

      expect((await service.execute(pending.id)).state).toBe('pending');
    });

    it('hands batch reservations and issuance to the method handler during recovery', async () => {
      const pending = await service.prepare(
        { mintUrl, method: 'onchain', quoteId },
        Amount.from(8),
      );
      const executing: ExecutingMintOperation = {
        ...(pending as PendingMintOperation),
        state: 'executing',
      };
      await repositories.mintOperationRepository.update(executing);

      await service.recoverExecutingOperation(executing);

      expect(
        recoveredFacts.map((facts) => [
          facts.finalizedAmount.toString(),
          facts.reservedAmount.toString(),
        ]),
      ).toEqual([['5', '10']]);
    });
  });
});
