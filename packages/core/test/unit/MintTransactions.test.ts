import { createMintServiceForMetadata } from '../fixtures/MintMetadataRefresh.ts';
import { testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import { StoredMintQueries } from '../../mints/MintMetadata.ts';
import { createCoreTransactionModuleFactory } from '../../transactions/CoreTransaction.ts';
import { MintWalletFactory } from '../../infra/mint/MintWallet.ts';
import {
  Amount,
  Mint,
  OutputData,
  Wallet,
  type Proof,
  type OutputDataCreator,
} from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { describe, expect, it, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { MintBolt11Handler } from '../../infra/handlers/mint/MintBolt11Handler.ts';
import { MintHandlerProvider } from '../../infra/handlers/mint/MintHandlerProvider.ts';
import { HandlerMintRemote } from '../../infra/mint/HandlerMintRemote.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';
import {
  mintQuoteFromBolt11Response,
  mintQuoteFromOnchainResponse,
} from '../../models/MintQuote.ts';
import type { PrepareMintInput } from '../../operations/mint/MintCommands.ts';
import { MintOperationService } from '../../operations/mint/MintOperationService.ts';
import type { MintRemote } from '../../operations/mint/MintRemote.ts';
import type { Repositories, RepositoryTransactionScope } from '../../repositories/index.ts';
import { RepositoryTransactionConflictError } from '../../repositories/RepositoryTransactionError.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import {
  RepositoryCoreTransactionRunner,
  type CoreTransaction,
} from '../../transactions/CoreTransaction.ts';
import { CoreMintTransactions } from '../../transactions/mint/MintTransactions.ts';
import { deserializeOutputData, serializeOutputData } from '../../utils.ts';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';

const mintUrl = 'https://mint.test';
const keysetId = testMintKeysetId();
const timestamp = 1_700_000_000_123;

async function fixture(repositories: Repositories, method: 'bolt11' | 'onchain' = 'bolt11') {
  await repositories.init();
  await repositories.mintRepository.addOrUpdateMint({
    mintUrl,
    name: 'Mint transaction fixture',
    trusted: true,
    mintInfo: {
      name: 'Fixture',
      pubkey: '',
      version: 'test/1',
      contact: [],
      nuts: {
        '4': {
          methods: [
            {
              method: 'bolt11',
              unit: 'sat',
              method_name: null,
              min_amount: null,
              max_amount: null,
            },
          ],
          disabled: false,
        },
        '5': { methods: [], disabled: false },
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await repositories.keysetRepository.addKeyset({
    mintUrl,
    id: keysetId,
    unit: 'sat',
    active: true,
    feePpk: 0,
    keypairs: testMintKeypairs,
  });
  const creator = makeOutputDataCreator({
    createDeterministicData: (_amount, _seed, counter) =>
      [8, 2].map(
        (amount, index) =>
          new OutputData(
            { id: keysetId, amount: Amount.from(amount), B_: `B_${counter + index}` },
            1n,
            new TextEncoder().encode(`secret_${counter + index}`),
          ),
      ),
  });
  const common = {
    quote: 'quote',
    request: 'request',
    unit: 'sat',
    expiry: 1,
    amount_paid: Amount.from(10),
    amount_issued: Amount.zero(),
    updated_at: null,
  };
  const quote =
    method === 'bolt11'
      ? mintQuoteFromBolt11Response(mintUrl, {
          ...common,
          method,
          amount: Amount.from(10),
          state: 'PAID',
        })
      : mintQuoteFromOnchainResponse(mintUrl, { ...common, method, pubkey: 'owned-key' });
  await repositories.mintQuoteRepository.upsertMintQuote(quote);
  const input = (id = 'mint'): PrepareMintInput => ({
    operation: {
      id,
      mintUrl,
      method,
      methodData: {},
      state: 'pending',
      quoteId: quote.quoteId,
      request: quote.request,
      amount: Amount.from(10),
      unit: 'sat',
      pubkey: quote.pubkey,
      expiry: quote.expiry,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    activeKeys: { id: keysetId, unit: 'sat', keys: { ...testMintKeypairs } },
    seed: new Uint8Array(64),
  });
  const runner = new RepositoryCoreTransactionRunner(
    repositories,
    createCoreTransactionModuleFactory(creator),
  );
  const transactions = new CoreMintTransactions(runner);
  async function authorize(id = 'mint') {
    await transactions.prepare(input(id));
    const committed = await transactions.authorize({ operationId: id, timestamp });
    if (committed.operation.state !== 'executing') throw new Error('Fixture was not authorized');
    return committed.operation;
  }
  function proofs(operation: Awaited<ReturnType<typeof authorize>>): Proof[] {
    return deserializeOutputData(operation.outputData).keep.map((output) => ({
      id: output.blindedMessage.id,
      amount: output.blindedMessage.amount,
      secret: new TextDecoder().decode(output.secret),
      C: `C_${output.blindedMessage.B_}`,
    }));
  }
  return { repositories, quote, input, runner, transactions, authorize, proofs, creator };
}

const adapters = [
  { name: 'memory', create: () => ({ repositories: new MemoryRepositories(), close() {} }) },
  {
    name: 'sqlite',
    create: () => {
      const database = new Database(':memory:');
      return {
        repositories: new SqlStorageRepositories({ database: new SqliteDb({ database }) }),
        close: () => database.close(),
      };
    },
  },
];

for (const adapter of adapters)
  describe(`Mint transaction migration (${adapter.name})`, () => {
    it('commits output allocation and pending state with a composed keypair allocation', async () => {
      const db = adapter.create();
      try {
        const f = await fixture(db.repositories);
        const keyInput = await new KeypairDerivation(async () => new Uint8Array(64)).prepare(
          'nut20_mint_quote',
        );
        const pending = await f.runner.run(async (scope) => {
          await scope.keypairs.allocate(keyInput);
          return scope.mints.prepare(f.input());
        });
        expect(pending.counter.counter).toBe(2);
        expect(await f.repositories.counterRepository.getCounter(mintUrl, keysetId)).toMatchObject({
          counter: 2,
        });
        expect(await f.repositories.mintOperationRepository.getById('mint')).toEqual(
          pending.operation,
        );
        expect(
          await f.repositories.keyRingRepository.getAllPersistedKeyPairs('nut20_mint_quote'),
        ).toHaveLength(1);
      } finally {
        db.close();
      }
    });

    it('rolls back every allocation even when a caller catches a scoped Mint failure', async () => {
      const db = adapter.create();
      try {
        const f = await fixture(db.repositories);
        const keyInput = await new KeypairDerivation(async () => new Uint8Array(64)).prepare(
          'nut20_mint_quote',
        );
        await expect(
          f.runner.run(async (scope) => {
            await scope.keypairs.allocate(keyInput);
            await scope.mints.prepare(f.input());
            await scope.mints.prepare(f.input('duplicate')).catch(() => {});
          }),
        ).rejects.toThrow('already tracked');
        expect(await f.repositories.mintOperationRepository.getByMintUrl(mintUrl)).toEqual([]);
        expect(await f.repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
        expect(
          await f.repositories.keyRingRepository.getAllPersistedKeyPairs('nut20_mint_quote'),
        ).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('rejects Mint commands captured from a closed scope', async () => {
      const db = adapter.create();
      try {
        const f = await fixture(db.repositories);
        let captured!: CoreTransaction['mints'];
        await f.runner.run(async (scope) => {
          captured = scope.mints;
        });
        await expect(captured.prepare(f.input())).rejects.toThrow();
        expect(await f.repositories.mintOperationRepository.getByMintUrl(mintUrl)).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('serializes sibling authorization against the current quote reservation', async () => {
      const db = adapter.create();
      try {
        const f = await fixture(db.repositories, 'onchain');
        await Promise.all([
          f.transactions.prepare(f.input('first')),
          f.transactions.prepare(f.input('second')),
        ]);
        const commits = await Promise.all([
          f.transactions.authorize({ operationId: 'first', timestamp }),
          f.transactions.authorize({ operationId: 'second', timestamp }),
        ]);
        expect(commits.filter((commit) => commit.changed)).toHaveLength(1);
        expect(await f.repositories.mintOperationRepository.getByState('executing')).toHaveLength(
          1,
        );
        expect(await f.repositories.counterRepository.getCounter(mintUrl, keysetId)).toMatchObject({
          counter: 4,
        });
      } finally {
        db.close();
      }
    });

    it('rechecks trust before authorizing an already prepared operation', async () => {
      const db = adapter.create();
      try {
        const f = await fixture(db.repositories);
        await f.transactions.prepare(f.input());
        const mint = (await f.repositories.mintRepository.getMintByUrl(mintUrl))!;
        await f.repositories.mintRepository.addOrUpdateMint({ ...mint, trusted: false });
        await expect(f.transactions.authorize({ operationId: 'mint', timestamp })).rejects.toThrow(
          'not trusted',
        );
        expect(await f.repositories.mintOperationRepository.getById('mint')).toMatchObject({
          state: 'pending',
        });
      } finally {
        db.close();
      }
    });

    it.each(['deactivated', 'unit changed', 'keys replaced'] as const)(
      'rejects allocation when the selected keyset is %s before commit',
      async (change) => {
        const db = adapter.create();
        try {
          const f = await fixture(db.repositories);
          const input = f.input();
          await f.repositories.keysetRepository.deleteKeyset(mintUrl, keysetId);
          await f.repositories.keysetRepository.addKeyset({
            mintUrl,
            id: keysetId,
            unit: change === 'unit changed' ? 'usd' : 'sat',
            active: change !== 'deactivated',
            feePpk: 0,
            keypairs:
              change === 'keys replaced'
                ? { ...testMintKeypairs, '1': testMintKeypairs['2'] }
                : testMintKeypairs,
          });
          await expect(f.transactions.prepare(input)).rejects.toThrow('changed after preflight');
          expect(await f.repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
          expect(
            await f.repositories.mintOperationRepository.getById(input.operation.id),
          ).toBeNull();
        } finally {
          db.close();
        }
      },
    );

    it('atomically settles proofs, legacy BOLT11 accounting, and finalized operation state', async () => {
      const db = adapter.create();
      try {
        const f = await fixture(db.repositories);
        const operation = await f.authorize();
        const settled = await f.transactions.settle({
          operation,
          proofs: f.proofs(operation),
          outcome: 'issued',
          timestamp,
        });
        expect(settled.operation.state).toBe('finalized');
        expect(await f.repositories.proofRepository.getReadyProofs(mintUrl)).toHaveLength(2);
        expect(
          (
            await f.repositories.mintQuoteRepository.getMintQuote(mintUrl, 'bolt11', 'quote')
          )?.amountIssued.toString(),
        ).toBe('10');
        expect(await f.repositories.mintOperationRepository.getById('mint')).toEqual(
          settled.operation,
        );
        // Milliseconds are persisted losslessly, so same-millisecond transitions remain distinguishable.
        expect(settled.operation.updatedAt).toBe(operation.updatedAt + 1);
      } finally {
        db.close();
      }
    });

    it('rolls proofs and quote accounting back when final operation persistence fails', async () => {
      const db = adapter.create();
      try {
        const f = await fixture(db.repositories);
        const operation = await f.authorize();
        const controlled = overrideTransactions(f.repositories, (work) =>
          f.repositories.withTransaction((scope) => {
            const operations = scope.mintOperationRepository;
            const rejecting = new Proxy(operations, {
              get(target, property) {
                if (property === 'update')
                  return async () => {
                    throw new Error('finalization failed');
                  };
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
            return work({ ...scope, mintOperationRepository: rejecting });
          }),
        );
        const transactions = new CoreMintTransactions(
          new RepositoryCoreTransactionRunner(controlled),
        );
        await expect(
          transactions.settle({
            operation,
            proofs: f.proofs(operation),
            outcome: 'issued',
            timestamp,
          }),
        ).rejects.toThrow('finalization failed');
        expect(await f.repositories.proofRepository.getReadyProofs(mintUrl)).toEqual([]);
        expect(
          (
            await f.repositories.mintQuoteRepository.getMintQuote(mintUrl, 'bolt11', 'quote')
          )?.amountIssued.isZero(),
        ).toBe(true);
        expect(await f.repositories.mintOperationRepository.getById('mint')).toEqual(operation);
      } finally {
        db.close();
      }
    });

    it('ignores stale negative results after the operation is authorized again', async () => {
      const db = adapter.create();
      try {
        const f = await fixture(db.repositories);
        const first = await f.authorize();
        await f.transactions.returnToPending({ operation: first, timestamp });
        const second = await f.transactions.authorize({ operationId: first.id, timestamp });
        const stale = await f.transactions.fail({
          operation: first,
          failure: { reason: 'late rejection', observedAt: timestamp },
          timestamp,
        });
        expect(stale.changed).toBe(false);
        expect(stale.operation).toEqual(second.operation);
        expect(await f.repositories.mintOperationRepository.getById(first.id)).toEqual(
          second.operation,
        );
      } finally {
        db.close();
      }
    });

    it('retains late issuance proofs after recovery returns the operation to pending', async () => {
      const db = adapter.create();
      try {
        const f = await fixture(db.repositories);
        const operation = await f.authorize();
        const pending = await f.transactions.returnToPending({ operation, timestamp });
        const settled = await f.transactions.settle({
          operation,
          proofs: f.proofs(operation),
          outcome: 'issued',
          timestamp,
        });
        expect(settled.operation).toEqual(pending.operation);
        expect(settled.changed).toBe(false);
        expect(settled.proofs).toHaveLength(2);
        expect(await f.repositories.proofRepository.getReadyProofs(mintUrl)).toHaveLength(2);
        const duplicate = await f.transactions.settle({
          operation,
          proofs: f.proofs(operation),
          outcome: 'issued',
          timestamp,
        });
        expect(duplicate.proofs).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('retains legacy already-issued completion without recovered proofs', async () => {
      const db = adapter.create();
      try {
        const f = await fixture(db.repositories);
        const operation = await f.authorize();
        const settled = await f.transactions.settle({
          operation,
          proofs: [],
          outcome: 'already-issued',
          timestamp,
        });
        expect(settled.operation).toMatchObject({
          state: 'finalized',
          error: expect.stringContaining('no proofs could be restored'),
        });
        expect(await f.repositories.proofRepository.getReadyProofs(mintUrl)).toEqual([]);
      } finally {
        db.close();
      }
    });
  });

describe('Mint transaction orchestration', () => {
  it('performs method preflight before allocating from the transaction-current counter', async () => {
    const f = await fixture(new MemoryRepositories());
    let inTransaction = false;
    const seed = new Uint8Array(64);
    const getSeed = mock(async () => {
      expect(inTransaction).toBe(false);
      return seed;
    });
    const derive = mock<OutputDataCreator['createDeterministicData']>(
      (amount, providedSeed, counter) => {
        expect(inTransaction).toBe(true);
        expect(Amount.from(amount).equals(Amount.from(10))).toBe(true);
        expect(providedSeed).toBe(seed);
        return f.creator.createDeterministicData(
          amount,
          providedSeed,
          counter,
          f.input().activeKeys,
        );
      },
    );
    const handler = new MintBolt11Handler({
      getMintQuoteKeyPair: async () => null,
      generateMintQuoteKeyPair: async () => {
        throw new Error('Unexpected key allocation');
      },
    });
    const remote = new HandlerMintRemote(
      new MintHandlerProvider({ bolt11: handler }),
      new MintWalletFactory(
        { getAuthProvider: () => undefined },
        {
          getRequestFn: () => async () => {
            throw new Error('Unexpected mint request');
          },
        },
      ),
      {} as MintAdapter,
    );
    const metadata = (await new StoredMintQueries(
      f.repositories.mintRepository,
      f.repositories.keysetRepository,
    ).getMetadata(mintUrl))!;
    const prepared = await remote.prepare(
      { ...f.input().operation, state: 'init' },
      f.quote,
      metadata,
      await getSeed(),
    );
    expect(derive).not.toHaveBeenCalled();
    expect(await f.repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    await f.repositories.counterRepository.setCounter(mintUrl, keysetId, 7);
    const controlled = overrideTransactions(f.repositories, async (work) => {
      inTransaction = true;
      try {
        return await f.repositories.withTransaction(work);
      } finally {
        inTransaction = false;
      }
    });
    const result = await new CoreMintTransactions(
      new RepositoryCoreTransactionRunner(
        controlled,
        createCoreTransactionModuleFactory(
          makeOutputDataCreator({ createDeterministicData: derive }),
        ),
      ),
    ).prepare(prepared);
    expect(result.counter.counter).toBe(9);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(getSeed).toHaveBeenCalledTimes(1);
  });

  it('retains the independently committed metadata refresh when Mint preparation rolls back', async () => {
    const f = await fixture(new MemoryRepositories());
    const mint = await f.repositories.mintRepository.getMintByUrl(mintUrl);
    await f.repositories.mintRepository.updateMint({ ...mint, updatedAt: 0 });
    let inTransaction = false;
    const controlled = overrideTransactions(f.repositories, (work) =>
      f.repositories.withTransaction(async (scope) => {
        inTransaction = true;
        const operations = new Proxy(scope.mintOperationRepository, {
          get(target, property) {
            if (property === 'create')
              return async () => {
                throw new Error('operation write failed');
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        try {
          return await work({ ...scope, mintOperationRepository: operations });
        } finally {
          inTransaction = false;
        }
      }),
    );
    const events = new EventBus<CoreEvents>();
    const refreshed = mock(async () => {
      expect(inTransaction).toBe(false);
      expect((await f.repositories.mintRepository.getMintByUrl(mintUrl)).mintInfo.name).toBe(
        'Refreshed',
      );
    });
    events.on('mint:updated', refreshed);
    const pending = mock(() => {});
    events.on('mint-op:pending', pending);
    const fetchMintMetadata = mock(async () => {
      expect(inTransaction).toBe(false);
      return {
        mintUrl,
        mintInfo: { ...mint.mintInfo, name: 'Refreshed' },
        keysets: [
          {
            mintUrl,
            id: keysetId,
            unit: 'sat',
            active: true,
            keypairs: testMintKeypairs,
            feePpk: 0,
          },
        ],
        observedAt: Math.floor(Date.now() / 1000),
      };
    });
    const refresh = createMintServiceForMetadata(controlled, { fetchMintMetadata }, events);
    const handler = new MintBolt11Handler({
      getMintQuoteKeyPair: async () => null,
      generateMintQuoteKeyPair: async () => {
        throw new Error('Unexpected key allocation');
      },
    });
    const remote = new HandlerMintRemote(
      new MintHandlerProvider({ bolt11: handler }),
      new MintWalletFactory(
        { getAuthProvider: () => undefined },
        {
          getRequestFn: () => async () => {
            throw new Error('Unexpected mint request');
          },
        },
      ),
      {} as MintAdapter,
    );
    const service = new MintOperationService({
      mintQueries: new StoredMintQueries(
        f.repositories.mintRepository,
        f.repositories.keysetRepository,
      ),
      mintMetadataRefresh: refresh,
      loadSeed: async () => {
        expect(inTransaction).toBe(false);
        return new Uint8Array(64);
      },
      operations: f.repositories.mintOperationRepository,
      proofs: f.repositories.proofRepository,
      quotes: {
        requireMintQuoteRefForPrepare: async () => f.quote,
        getMintQuote: async () => f.quote,
        getPendingMintQuotes: async () => [],
      },
      remote,
      events,
      transactions: new CoreMintTransactions(
        new RepositoryCoreTransactionRunner(
          controlled,
          createCoreTransactionModuleFactory(f.creator),
        ),
      ),
    });
    await expect(
      service.prepare({ mintUrl, method: 'bolt11', quoteId: f.quote.quoteId }, Amount.from(10)),
    ).rejects.toThrow('operation write failed');
    expect(fetchMintMetadata).toHaveBeenCalledTimes(1);
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(pending).not.toHaveBeenCalled();
    expect((await f.repositories.mintRepository.getMintByUrl(mintUrl)).mintInfo.name).toBe(
      'Refreshed',
    );
    expect(await f.repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(await f.repositories.mintOperationRepository.getByMintUrl(mintUrl)).toEqual([]);
  });

  it('keeps derivation inputs stable across rollback and bounded conflict retries', async () => {
    const f = await fixture(new MemoryRepositories());
    const derive = mock(f.creator.createDeterministicData);
    let conflict = true;
    const controlled = overrideTransactions(f.repositories, (work) =>
      f.repositories.withTransaction(async (scope) => {
        const result = await work(scope);
        if (conflict) {
          conflict = false;
          throw new RepositoryTransactionConflictError('retry allocation');
        }
        return result;
      }),
    );
    const transactions = new CoreMintTransactions(
      new RepositoryCoreTransactionRunner(
        controlled,
        createCoreTransactionModuleFactory(
          makeOutputDataCreator({ createDeterministicData: derive }),
        ),
      ),
    );
    const input = f.input();
    const committed = await transactions.prepare(input);
    expect(derive.mock.calls).toEqual([
      [input.operation.amount, input.seed, 0, input.activeKeys],
      [input.operation.amount, input.seed, 0, input.activeKeys],
    ]);
    expect(committed.operation.createdAt).toBe(timestamp);
    expect(committed.operation.updatedAt).toBe(timestamp);
    expect(await f.repositories.counterRepository.getCounter(mintUrl, keysetId)).toMatchObject({
      counter: 2,
    });
  });

  it('runs remote effects and live listeners outside transactions and cannot replay on listener failure', async () => {
    const f = await fixture(new MemoryRepositories());
    let inTransaction = false;
    const controlled = overrideTransactions(f.repositories, async (work) => {
      inTransaction = true;
      try {
        return await f.repositories.withTransaction(work);
      } finally {
        inTransaction = false;
      }
    });
    const events = new EventBus<CoreEvents>({ throwOnError: true });
    const listener = mock(async () => {
      expect(inTransaction).toBe(false);
      expect(await f.repositories.proofRepository.getReadyProofs(mintUrl)).toHaveLength(2);
      throw new Error('listener failed');
    });
    events.on('proofs:saved', listener);
    const execute = mock(async (operation: Parameters<MintRemote['execute']>[0]) => {
      expect(inTransaction).toBe(false);
      expect(await f.repositories.mintOperationRepository.getById(operation.id)).toMatchObject({
        state: 'executing',
      });
      return { status: 'ISSUED' as const, proofs: f.proofs(operation) };
    });
    const remote: MintRemote = {
      prepare: async () => {
        throw new Error('unexpected preparation');
      },
      execute,
      recoverExecuting: async () => {
        throw new Error('unexpected replay');
      },
      observePending: async () => {
        throw new Error('unexpected observation');
      },
      restoreOutputs: async () => {
        throw new Error('unexpected Restore');
      },
    };
    const service = new MintOperationService({
      mintQueries: { isTrustedMint: async () => true },
      mintMetadataRefresh: {
        refreshAndCommitIfStale: async () =>
          (await new StoredMintQueries(
            f.repositories.mintRepository,
            f.repositories.keysetRepository,
          ).getMetadata(mintUrl))!,
      },
      loadSeed: async () => new Uint8Array(64),
      operations: f.repositories.mintOperationRepository,
      proofs: f.repositories.proofRepository,
      remote,
      events,
      transactions: new CoreMintTransactions(new RepositoryCoreTransactionRunner(controlled)),
      quotes: {
        getMintQuote: () =>
          f.repositories.mintQuoteRepository.getMintQuote(mintUrl, 'bolt11', 'quote'),
        requireMintQuoteRefForPrepare: async () => f.quote,
        getPendingMintQuotes: async () => [],
      },
    });
    const pending = await f.transactions.prepare(f.input());
    expect((await service.execute(pending.operation.id)).state).toBe('finalized');
    expect((await service.execute(pending.operation.id)).state).toBe('finalized');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
