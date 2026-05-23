import { describe, it, expect } from 'vitest';
import {
  runRepositoryTransactionContract,
  runAuthSessionRepositoryContract,
  runProofRepositoryContract,
  runMintOperationRepositoryContract,
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
    dispose: async () => {},
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
  },
  { describe, it, expect },
);

runAuthSessionRepositoryContract({ createRepositories }, { describe, it, expect });

runProofRepositoryContract({ createRepositories }, { describe, it, expect });

runMintOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runReceiveOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runSendOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runPaymentRequestReceiveRepositoryContract({ createRepositories }, { describe, it, expect });

describe('indexeddb quote storage constraints', () => {
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
