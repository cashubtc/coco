import { Amount, type Proof, type Wallet } from '@cashu/cashu-ts';
import type { Repositories } from '../../../../core/repositories/index.ts';
import { RepositoryCoreTransactionRunner } from '../../../../core/transactions/CoreTransaction.ts';
import {
  testMintInfo,
  testMintKeypairs,
  testMintKeysetId,
} from '../../../../core/test/fixtures/MintMetadata.ts';
import { mintQuoteFromBolt11Fixture } from '../../../../core/test/normalizedMintQuoteFixtures.ts';
import { meltQuoteFromBolt11Response, type MeltQuote } from '../../../../core/models/MeltQuote.ts';
import { deserializeOutputData, type SerializedOutputData } from '../../../../core/utils.ts';
import {
  invoiceHash,
  initialMintSwapRetry,
} from '../../../../core/operations/mintSwap/MintSwapValidation.ts';
import type { PreparingMintSwapOperation } from '../../../../core/operations/mintSwap/MintSwapOperation.ts';
import {
  createMintSwap,
  prepareMintSwap,
} from '../../../../core/operations/mintSwap/MintSwapTransitions.ts';
import { EventBus } from '../../../../core/events/EventBus.ts';
import type { CoreEvents } from '../../../../core/events/types.ts';
import { MintHandlerProvider } from '../../../../core/infra/handlers/mint/MintHandlerProvider.ts';
import { MeltHandlerProvider } from '../../../../core/infra/handlers/melt/MeltHandlerProvider.ts';
import {
  MintSwapOperationService,
  type MintSwapOperationServiceDependencies,
} from '../../../../core/operations/mintSwap/MintSwapOperationService.ts';
import { OperationIdLock } from '../../../../core/operations/OperationIdLock.ts';
import { MintScopedLock } from '../../../../core/operations/MintScopedLock.ts';
import type { MintAdapter } from '../../../../core/infra/MintAdapter.ts';

export const sourceUrl = 'https://source.test';
export const destinationUrl = 'https://destination.test';
export const invoice = 'lnbc1mint-swap';
export const keys = { id: testMintKeysetId(), unit: 'sat', keys: testMintKeypairs };
export const pubkey = testMintKeypairs['1'];

export function outputProofs(data: SerializedOutputData, kind: 'keep' | 'send' = 'keep'): Proof[] {
  return deserializeOutputData(data)[kind].map((output) => ({
    id: output.blindedMessage.id,
    amount: Amount.from(output.blindedMessage.amount),
    secret: new TextDecoder().decode(output.secret),
    C: testMintKeypairs['1'],
  }));
}

export async function mintSwapFixture(
  repositories: Repositories,
  options: { input?: number; cap?: number; initialize?: boolean } = {},
) {
  await repositories.init();
  const keypair = {
    publicKeyHex: pubkey,
    secretKey: new Uint8Array(32).fill(1),
    purpose: 'nut20_mint_quote' as const,
  };
  if (options.initialize !== false) {
    for (const mintUrl of [sourceUrl, destinationUrl]) {
      await repositories.mintRepository.addNewMint({
        mintUrl,
        name: mintUrl,
        trusted: true,
        createdAt: 1,
        updatedAt: 1,
        mintInfo: {
          ...testMintInfo,
          nuts: {
            ...testMintInfo.nuts,
            '4': {
              disabled: false,
              methods: [
                {
                  method: 'bolt11',
                  method_name: 'bolt11',
                  unit: 'sat',
                  min_amount: 1,
                  max_amount: 1000,
                },
              ],
            },
            '5': {
              disabled: false,
              methods: [
                {
                  method: 'bolt11',
                  method_name: 'bolt11',
                  unit: 'sat',
                  min_amount: 1,
                  max_amount: 1000,
                },
              ],
            },
            '7': { supported: true },
            '9': { supported: true },
            '20': { supported: true },
          },
        },
      });
      await repositories.keysetRepository.addKeyset({
        mintUrl,
        id: keys.id,
        unit: 'sat',
        keypairs: keys.keys,
        active: true,
        feePpk: 0,
      });
    }
    await repositories.keyRingRepository.setPersistedKeyPair(keypair);
    await repositories.proofRepository.saveProofs(sourceUrl, [
      {
        id: keys.id,
        mintUrl: sourceUrl,
        unit: 'sat',
        state: 'ready',
        amount: Amount.from(options.input ?? 8),
        secret: 'original',
        C: pubkey,
      },
    ]);
  }
  let time = 1_000;
  const saveSource = async (state: 'UNPAID' | 'PENDING' | 'PAID', at = time) => {
    const quote = meltQuoteFromBolt11Response(
      sourceUrl,
      {
        quote: 'source-quote',
        request: invoice,
        amount: Amount.from(8),
        unit: 'sat',
        fee_reserve: Amount.zero(),
        expiry: 100_000,
        state,
        change: [],
        payment_preimage: null,
      },
      { now: at },
    );
    await repositories.meltQuoteRepository.upsertMeltQuote(quote);
    return quote;
  };
  const saveDestination = async (state: 'UNPAID' | 'PAID' | 'ISSUED') => {
    const quote = mintQuoteFromBolt11Fixture(destinationUrl, {
      quote: 'destination-quote',
      request: invoice,
      amount: Amount.from(8),
      unit: 'sat',
      expiry: 100_000,
      state,
      pubkey,
    });
    await repositories.mintQuoteRepository.upsertMintQuote(quote);
    return quote;
  };
  if (options.initialize !== false) {
    await saveSource('UNPAID');
    await saveDestination('UNPAID');
  }
  const runner = new RepositoryCoreTransactionRunner(repositories);
  const parent: PreparingMintSwapOperation = {
    schemaVersion: 1,
    id: 'swap',
    revision: 0,
    state: 'preparing',
    sourceMintUrl: sourceUrl,
    destinationMintUrl: destinationUrl,
    unit: 'sat',
    destinationAmount: Amount.from(8),
    ...(options.cap === undefined ? {} : { sourceDebitCap: Amount.from(options.cap) }),
    sourceQuote: { mintUrl: sourceUrl, method: 'bolt11', quoteId: 'source-quote' },
    destinationQuote: { mintUrl: destinationUrl, method: 'bolt11', quoteId: 'destination-quote' },
    sourceOperationId: 'source-child',
    destinationOperationId: 'destination-child',
    paymentRequestHash: invoiceHash(invoice),
    createdAt: time,
    updatedAt: time,
    stateEnteredAt: time,
    retry: initialMintSwapRetry('preparing', time),
  };
  const preparation = {
    id: parent.id,
    sourceKeys: keys,
    destinationKeys: keys,
    seed: new Uint8Array(32).fill(2),
    now: time,
  };
  const create = () => runner.run((tx) => tx.perform(createMintSwap, parent));
  const prepare = () => runner.run((tx) => tx.perform(prepareMintSwap, preparation));
  const requests: string[] = [];
  let sourceState: 'UNPAID' | 'PENDING' | 'PAID' = 'PAID';
  let destinationState: 'UNPAID' | 'PAID' | 'ISSUED' = 'PAID';
  const events = new EventBus<CoreEvents>();
  let transactionActive = false;
  const assertRemote = () => {
    if (transactionActive) throw new Error('Remote effect inside Wallet transaction');
  };
  const dependencies: MintSwapOperationServiceDependencies = {
    transactionRunner: {
      run: (work) =>
        runner.run(async (tx) => {
          transactionActive = true;
          try {
            return await work(tx);
          } finally {
            transactionActive = false;
          }
        }),
    },
    parentQueries: repositories.mintSwap!.operationRepository,
    sourceQueries: repositories.meltOperationRepository,
    destinationQueries: repositories.mintOperationRepository,
    proofQueries: repositories.proofRepository,
    mintService: {
      isTrustedMint: (url) => repositories.mintRepository.isTrustedMint(url),
      refreshAndCommitIfStale: async (mintUrl) => {
        assertRemote();
        return {
          mint: await repositories.mintRepository.getMintByUrl(mintUrl),
          keysets: await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl),
        };
      },
    },
    keyRingService: {
      allocateAndCommitMintQuoteKeyPair: async () => {
        assertRemote();
        requests.push('allocate-key');
        return keypair;
      },
    },
    quoteLifecycle: {
      // These independent observation workflows use real persistent canonical quote rows.
      createMintQuote: (async () => {
        assertRemote();
        requests.push('destination-quote');
        return saveDestination('UNPAID');
      }) as MintSwapOperationServiceDependencies['quoteLifecycle']['createMintQuote'],
      createMeltQuote: (async () => {
        assertRemote();
        requests.push('source-quote');
        return saveSource('UNPAID');
      }) as MintSwapOperationServiceDependencies['quoteLifecycle']['createMeltQuote'],
      getMeltQuote: (url, method, id) =>
        repositories.meltQuoteRepository.getMeltQuote(url, method, id),
      refreshMeltQuote: async () => {
        assertRemote();
        requests.push('observe-source');
        return saveSource(sourceState);
      },
      refreshMintQuote: async () => {
        assertRemote();
        requests.push('observe-destination');
        return saveDestination(destinationState);
      },
      recordMeltQuoteObservation: async (quote) => {
        assertRemote();
        requests.push('record-source');
        await repositories.meltQuoteRepository.upsertMeltQuote(quote);
        return quote;
      },
      recordMintQuoteSnapshot: (async () => {
        assertRemote();
        return saveDestination(destinationState);
      }) as MintSwapOperationServiceDependencies['quoteLifecycle']['recordMintQuoteSnapshot'],
    },
    mintHandlerProvider: new MintHandlerProvider({
      bolt11: {
        createQuote: async () => {
          throw new Error('Use quote lifecycle');
        },
        fetchRemoteQuote: async () => {
          throw new Error('Use quote lifecycle');
        },
        checkPending: async () => {
          throw new Error('Use quote lifecycle');
        },
        execute: async ({ operation }) => {
          assertRemote();
          requests.push('mint');
          return { status: 'ISSUED', proofs: outputProofs(operation.outputData) };
        },
        recoverExecuting: async ({ operation }) => {
          assertRemote();
          requests.push('recover-mint');
          return { status: 'ISSUED', proofs: outputProofs(operation.outputData) };
        },
      },
    }),
    meltHandlerProvider: new MeltHandlerProvider({
      bolt11: {
        createQuote: async () => {
          throw new Error('Use quote lifecycle');
        },
        fetchRemoteQuote: async () => {
          throw new Error('Use quote lifecycle');
        },
        swap: async ({ operation }) => {
          assertRemote();
          requests.push('swap');
          return {
            keep: outputProofs(operation.swapOutputData!),
            send: outputProofs(operation.swapOutputData!, 'send'),
          };
        },
        melt: async () => {
          assertRemote();
          requests.push('melt');
          return { status: sourceState, change: [] };
        },
      },
    }),
    walletService: {
      getWalletWithActiveKeysetId: async () => {
        assertRemote();
        return {
          wallet: {
            checkProofsStates: async (proofs: Proof[]) => proofs.map(() => ({ state: 'UNSPENT' })),
          } as unknown as Wallet,
          keysetId: keys.id,
          keyset: { ...keys, active: true, input_fee_ppk: 0 },
          keys,
          unit: 'sat',
        };
      },
    },
    mintAdapter: {} as MintAdapter,
    loadSeed: async () => {
      assertRemote();
      return new Uint8Array(32).fill(2);
    },
    sourceOperationLock: new OperationIdLock(),
    destinationOperationLock: new OperationIdLock(),
    mintScopedLock: new MintScopedLock(),
    eventBus: events,
    now: () => {
      assertRemote();
      return ++time;
    },
    random: () => {
      assertRemote();
      return 0.5;
    },
  };
  return {
    repositories,
    runner,
    parent,
    preparation,
    create,
    prepare,
    saveSource,
    saveDestination,
    dependencies,
    requests,
    events,
    service: () => new MintSwapOperationService(dependencies),
    setSourceState: (state: typeof sourceState) => {
      sourceState = state;
    },
    setDestinationState: (state: typeof destinationState) => {
      destinationState = state;
    },
    setTime: (now: number) => {
      time = now;
    },
    get transactionActive() {
      return transactionActive;
    },
  };
}
