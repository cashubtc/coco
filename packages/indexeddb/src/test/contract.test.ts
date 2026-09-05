import { describe, it, expect } from 'vitest';
import { Amount } from '@cashu/cashu-ts';
import Dexie from 'dexie';
import {
  runRepositoryTransactionContract,
  createDummyMint,
  runKeypairAllocationContract,
  allocateKeypairForTest,
  runAuthSessionRepositoryContract,
  runProofRepositoryContract,
  runMintOperationRepositoryContract,
  runMintQuoteRepositoryContract,
  runPaymentRequestReceiveRepositoryContract,
  runReceiveOperationRepositoryContract,
  runSendOperationRepositoryContract,
  runMeltOperationRepositoryContract,
  runMeltQuoteRepositoryContract,
} from '@cashu/coco-adapter-tests';
import { IndexedDbRepositories } from '../index.ts';

let dbCounter = 0;

async function createRepositories() {
  const dbName = `coco_cashu_contract_${Date.now()}_${dbCounter++}`;
  const repositories = new IndexedDbRepositories({ name: dbName });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      repositories.db.close();
    },
  };
}

async function createSharedRepositories() {
  const dbName = `coco_cashu_shared_allocation_${Date.now()}_${dbCounter++}`;
  const first = new IndexedDbRepositories({ name: dbName });
  const second = new IndexedDbRepositories({ name: dbName });
  await first.init();
  await second.init();

  return {
    first,
    second,
    dispose: async () => {
      first.db.close();
      second.db.close();
    },
  };
}

async function expectRejects(fn: () => Promise<void>) {
  let didThrow = false;
  try {
    await fn();
  } catch {
    didThrow = true;
  }
  expect(didThrow).toBe(true);
}

runRepositoryTransactionContract(
  {
    createRepositories,
    createSharedRepositories,
    createIsolationRepositories: createSharedRepositories,
    holdTransactionOpen: (release) => Dexie.waitFor(release),
    testConcurrentRootOperationIsolation: true,
  },
  { describe, it, expect },
);

runKeypairAllocationContract(
  { createRepositories, createSharedRepositories },
  { describe, it, expect },
);

runAuthSessionRepositoryContract({ createRepositories }, { describe, it, expect });

runProofRepositoryContract({ createRepositories }, { describe, it, expect });

runMintOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMintQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runReceiveOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runSendOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runPaymentRequestReceiveRepositoryContract({ createRepositories }, { describe, it, expect });

describe('indexeddb Wallet transaction boundaries', () => {
  it('does not report a nested strong scope as committed before its ambient parent', async () => {
    const { repositories, dispose } = await createRepositories();
    let nestedScopeResolved = false;
    try {
      await expect(
        repositories.db.transaction('rw', repositories.db.tables, async () => {
          await repositories.withTransaction(async () => {});
          nestedScopeResolved = true;
          throw new Error('abort ambient transaction');
        }),
      ).rejects.toThrow();

      expect(nestedScopeResolved).toBe(false);
    } finally {
      await dispose();
    }
  });

  it('treats another connection to the same Wallet database as ambient', async () => {
    const { first, second, dispose } = await createSharedRepositories();
    try {
      await first.db.transaction('rw', first.db.tables, () => {
        expect(second.db.hasAmbientTransaction).toBe(true);
      });
    } finally {
      await dispose();
    }
  });

  it('allows a Wallet transaction inside an unrelated Dexie database transaction', async () => {
    const { repositories, dispose } = await createRepositories();
    const unrelatedName = `unrelated_${Date.now()}_${dbCounter++}`;
    const unrelated = new Dexie(unrelatedName);
    unrelated.version(1).stores({ items: '++id' });
    await unrelated.open();
    const walletMint = {
      ...createDummyMint(),
      mintUrl: 'https://unrelated-ambient.test',
    };

    try {
      await unrelated.transaction('rw', unrelated.table('items'), async () => {
        await Dexie.waitFor(
          repositories.withTransaction(async ({ mintRepository }) => {
            await mintRepository.addOrUpdateMint(walletMint);
          }),
        );
      });

      expect(await repositories.mintRepository.getAllMints()).toContainEqual(walletMint);
    } finally {
      unrelated.close();
      await Dexie.delete(unrelatedName);
      await dispose();
    }
  }, 2_000);

  it('keeps closed-over root repository calls in the current Wallet transaction', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await expect(
        repositories.withTransaction(async () => {
          await repositories.mintRepository.addOrUpdateMint({
            ...createDummyMint(),
            mintUrl: 'https://closed-over-root.test',
          });
          throw new Error('abort Wallet transaction');
        }),
      ).rejects.toThrow('abort Wallet transaction');

      expect(await repositories.mintRepository.getAllMints()).toEqual([]);
    } finally {
      await dispose();
    }
  }, 2_000);
});

describe('indexeddb quote storage constraints', () => {
  it('rolls back the keypair and high-water mark when persistence aborts', async () => {
    const { repositories, dispose } = await createRepositories();
    const allocationTable = repositories.db.table('coco_cashu_keypair_derivation_allocations');
    const failAllocationWrite = () => {
      throw new Error('forced high-water failure');
    };
    allocationTable.hook('creating').subscribe(failAllocationWrite);
    try {
      await expectRejects(async () => {
        await allocateKeypairForTest(repositories, 'p2pk');
      });

      expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
      expect(await allocationTable.get('p2pk')).toBeUndefined();
      allocationTable.hook('creating').unsubscribe(failAllocationWrite);
      await expect(allocateKeypairForTest(repositories, 'p2pk')).resolves.toMatchObject({
        derivationIndex: 0,
      });
    } finally {
      allocationTable.hook('creating').unsubscribe(failAllocationWrite);
      await dispose();
    }
  });

  it('migrates version-32 keypairs into purpose-scoped allocation state', async () => {
    const dbName = `coco_cashu_keyring_migration_${Date.now()}_${dbCounter++}`;
    const legacy = new Dexie(dbName);
    legacy.version(32).stores({
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    });
    await legacy.open();
    await legacy.table('coco_cashu_keypairs').bulkAdd([
      {
        publicKey: 'legacy-p2pk',
        secretKey: '01'.repeat(32),
        createdAt: 1,
        derivationIndex: 4,
      },
      {
        publicKey: 'current-p2pk',
        secretKey: '02'.repeat(32),
        createdAt: 2,
        derivationIndex: 6,
        purpose: 'p2pk',
      },
      {
        publicKey: 'quote-lock',
        secretKey: '03'.repeat(32),
        createdAt: 3,
        derivationIndex: 3,
        purpose: 'nut20_mint_quote',
      },
      {
        publicKey: 'imported',
        secretKey: '04'.repeat(32),
        createdAt: 4,
      },
    ]);
    legacy.close();

    const repositories = new IndexedDbRepositories({ name: dbName });
    await repositories.init();
    try {
      const keypairRows = await repositories.db.table('coco_cashu_keypairs').toArray();
      expect(keypairRows.find((row) => row.publicKey === 'legacy-p2pk')?.purpose).toBe('p2pk');
      expect(keypairRows.find((row) => row.publicKey === 'imported')?.purpose).toBe('p2pk');
      expect(
        await repositories.db.table('coco_cashu_keypair_derivation_allocations').toArray(),
      ).toEqual(
        expect.arrayContaining([
          { purpose: 'p2pk', lastAllocatedIndex: 6 },
          { purpose: 'nut20_mint_quote', lastAllocatedIndex: 3 },
        ]),
      );
      expect(
        repositories.db
          .table('coco_cashu_keypairs')
          .schema.indexes.some((index) => index.name === '[purpose+derivationIndex]'),
      ).toBe(true);
      await expect(allocateKeypairForTest(repositories, 'p2pk')).resolves.toMatchObject({
        derivationIndex: 7,
      });
      await expect(allocateKeypairForTest(repositories, 'nut20_mint_quote')).resolves.toMatchObject(
        { derivationIndex: 4 },
      );
    } finally {
      repositories.db.close();
    }

    const reopened = new IndexedDbRepositories({ name: dbName });
    await reopened.init();
    try {
      await expect(allocateKeypairForTest(reopened, 'p2pk')).resolves.toMatchObject({
        derivationIndex: 8,
      });
    } finally {
      reopened.db.close();
      await Dexie.delete(dbName);
    }
  });

  it('migrates canonical Mint Quote Accounting without inventing remote time', async () => {
    const dbName = `coco_cashu_migration_${Date.now()}_${dbCounter++}`;
    const legacy = new Dexie(dbName);
    legacy.version(31).stores({
      coco_cashu_canonical_mint_quotes:
        '&[mintUrl+method+quoteId], &[mintUrl+quoteId], state, mintUrl, method',
    });
    await legacy.open();
    await legacy.table('coco_cashu_canonical_mint_quotes').bulkAdd([
      {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'legacy-paid',
        state: 'PAID',
        request: 'lnbc1paid',
        amount: '10',
        unit: 'sat',
        expiry: null,
        pubkey: null,
        quoteDataJson: '{"amount":"10"}',
        lastObservedRemoteState: 'PAID',
        lastObservedRemoteStateAt: 123_000,
        reusable: 0,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        mintUrl: 'https://mint.test',
        method: 'onchain',
        quoteId: 'legacy-reusable',
        state: null,
        request: 'bc1qdeposit',
        amount: null,
        unit: 'sat',
        expiry: null,
        pubkey: '02',
        quoteDataJson: '{"pubkey":"02","amountPaid":"21","amountIssued":"8"}',
        lastObservedRemoteState: null,
        lastObservedRemoteStateAt: 123_000,
        reusable: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        mintUrl: 'https://mint.test',
        method: 'onchain',
        quoteId: 'legacy-malformed',
        state: null,
        request: 'bc1qmalformed',
        amount: null,
        unit: 'sat',
        expiry: null,
        pubkey: '02',
        quoteDataJson: '{not-json',
        lastObservedRemoteState: null,
        lastObservedRemoteStateAt: 123_000,
        reusable: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'legacy-bolt11-malformed',
        state: 'PAID',
        request: 'lnbc1malformed',
        amount: '13',
        unit: 'sat',
        expiry: null,
        pubkey: null,
        quoteDataJson: '{not-json',
        lastObservedRemoteState: 'PAID',
        lastObservedRemoteStateAt: 123_000,
        reusable: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    legacy.close();

    const repositories = new IndexedDbRepositories({ name: dbName });
    await repositories.init();
    try {
      const paid = await repositories.mintQuoteRepository.getMintQuote(
        'https://mint.test',
        'bolt11',
        'legacy-paid',
      );
      const reusable = await repositories.mintQuoteRepository.getMintQuote(
        'https://mint.test',
        'onchain',
        'legacy-reusable',
      );
      const malformed = await repositories.mintQuoteRepository.getMintQuote(
        'https://mint.test',
        'onchain',
        'legacy-malformed',
      );
      const malformedBolt11 = await repositories.mintQuoteRepository.getMintQuote(
        'https://mint.test',
        'bolt11',
        'legacy-bolt11-malformed',
      );

      expect(paid?.amountPaid.toString()).toBe('10');
      expect(paid?.amountIssued.toString()).toBe('0');
      expect(paid?.remoteUpdatedAt).toBe(null);
      expect(reusable?.amountPaid.toString()).toBe('21');
      expect(reusable?.amountIssued.toString()).toBe('8');
      expect(reusable?.remoteUpdatedAt).toBe(null);
      expect(malformed?.amountPaid.toString()).toBe('0');
      expect(malformed?.amountIssued.toString()).toBe('0');
      expect(malformed?.remoteUpdatedAt).toBe(null);
      expect(malformedBolt11?.amountPaid.toString()).toBe('13');
      expect(malformedBolt11?.amountIssued.toString()).toBe('0');
      expect(malformedBolt11?.remoteUpdatedAt).toBe(null);
    } finally {
      repositories.db.close();
      await Dexie.delete(dbName);
    }
  });

  it('rejects persisted mint quote method siblings for one identity', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.table('coco_cashu_canonical_mint_quotes').add({
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'duplicate-mint-quote',
        state: 'UNPAID',
        request: 'bolt11-request',
        amount: '1',
        unit: 'sat',
        expiry: null,
        pubkey: null,
        quoteDataJson: '{"amount":"1"}',
        lastObservedRemoteState: 'UNPAID',
        lastObservedRemoteStateAt: 0,
        reusable: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      await expectRejects(async () => {
        await repositories.db.table('coco_cashu_canonical_mint_quotes').add({
          mintUrl: 'https://mint.test',
          method: 'bolt12',
          quoteId: 'duplicate-mint-quote',
          state: null,
          request: 'bolt12-request',
          amount: null,
          unit: 'sat',
          expiry: null,
          pubkey: '02',
          quoteDataJson: '{"pubkey":"02","amountPaid":"0","amountIssued":"0"}',
          lastObservedRemoteState: null,
          lastObservedRemoteStateAt: 0,
          reusable: 1,
          createdAt: 0,
          updatedAt: 0,
        });
      });
    } finally {
      await dispose();
    }
  });

  it('rejects persisted melt quote method siblings for one identity', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.table('coco_cashu_melt_quotes').add({
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'duplicate-melt-quote',
        quote: 'duplicate-melt-quote',
        state: 'UNPAID',
        request: 'bolt11-request',
        amount: '1',
        unit: 'sat',
        fee_reserve: '1',
        expiry: 0,
        payment_preimage: null,
        change: undefined,
        lastObservedRemoteState: 'UNPAID',
        lastObservedRemoteStateAt: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      await expectRejects(async () => {
        await repositories.db.table('coco_cashu_melt_quotes').add({
          mintUrl: 'https://mint.test',
          method: 'bolt12',
          quoteId: 'duplicate-melt-quote',
          quote: 'duplicate-melt-quote',
          state: 'UNPAID',
          request: 'bolt12-request',
          amount: '1',
          unit: 'sat',
          fee_reserve: '1',
          expiry: 0,
          payment_preimage: null,
          change: undefined,
          lastObservedRemoteState: 'UNPAID',
          lastObservedRemoteStateAt: 0,
          createdAt: 0,
          updatedAt: 0,
        });
      });
    } finally {
      await dispose();
    }
  });
});

describe('hydration corruption guard', () => {
  it('rehydrates legacy melt change amounts that lost their prototype', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.table('coco_cashu_melt_quotes').put({
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'legacy-change-amount',
        quote: 'legacy-change-amount',
        state: 'PAID',
        request: 'bolt11-request',
        amount: '10',
        unit: 'sat',
        fee_reserve: '1',
        expiry: 0,
        payment_preimage: 'preimage',
        change: [
          {
            id: 'keyset-1',
            amount: { value: 2n },
            C_: '02'.padEnd(66, '1'),
          },
        ],
        lastObservedRemoteState: 'PAID',
        lastObservedRemoteStateAt: 0,
        createdAt: 0,
        updatedAt: 0,
      });

      const stored = await repositories.meltQuoteRepository.getMeltQuote(
        'https://mint.test',
        'bolt11',
        'legacy-change-amount',
      );

      expect(stored?.change?.[0]?.amount.equals(Amount.from(2))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('throws when send operation has prepared state but null financial fields', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.runTransaction('rw', ['coco_cashu_send_operations'], async (tx) => {
        await tx.table('coco_cashu_send_operations').put({
          id: 'corrupt-send',
          mintUrl: 'https://mint.test',
          amount: 100,
          unit: 'sat',
          state: 'prepared',
          createdAt: 0,
          updatedAt: 0,
          method: 'default',
          methodDataJson: '{}',
          needsSwap: 0,
          fee: null,
          inputAmount: null,
        });
      });

      let threw = false;
      try {
        await repositories.sendOperationRepository.getById('corrupt-send');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('throws when receive operation has prepared state but null fee', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.runTransaction('rw', ['coco_cashu_receive_operations'], async (tx) => {
        await tx.table('coco_cashu_receive_operations').put({
          id: 'corrupt-receive',
          mintUrl: 'https://mint.test',
          amount: 100,
          unit: 'sat',
          state: 'prepared',
          createdAt: 0,
          updatedAt: 0,
          fee: null,
          inputProofsJson: '[]',
        });
      });

      let threw = false;
      try {
        await repositories.receiveOperationRepository.getById('corrupt-receive');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('throws when melt operation has prepared state but null financial fields', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.runTransaction('rw', ['coco_cashu_melt_operations'], async (tx) => {
        await tx.table('coco_cashu_melt_operations').put({
          id: 'corrupt-melt',
          mintUrl: 'https://mint.test',
          state: 'prepared',
          createdAt: 0,
          updatedAt: 0,
          method: 'bolt11',
          methodDataJson: '{"invoice":"lnbc1test"}',
          quoteId: 'q1',
          amount: null,
          fee_reserve: null,
          swap_fee: null,
          needsSwap: 0,
          inputAmount: null,
        });
      });

      let threw = false;
      try {
        await repositories.meltOperationRepository.getById('corrupt-melt');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });
});
