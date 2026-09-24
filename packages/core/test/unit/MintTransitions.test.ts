import { Amount } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';
import type {
  ExecutingMintOperation,
  PendingMintOperation,
} from '../../operations/mint/MintOperation.ts';
import type { Repositories } from '../../repositories/index.ts';
import { RepositoryTransactionConflictError } from '../../repositories/RepositoryTransactionError.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import {
  RepositoryCoreTransactionRunner,
  type CoreTransaction,
} from '../../transactions/CoreTransaction.ts';
import {
  prepareMint,
  beginMintExecution,
  applyMintResult,
  failMint,
  deferMintRecovery,
} from '../../transactions/transitions/mint/MintTransitions.ts';
import type { PrepareMintInput } from '../../transactions/transitions/mint/MintTransitionTypes.ts';
import { deserializeOutputData } from '../../utils.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import {
  mintQuoteFromBolt11Fixture,
  mintQuoteFromBolt12Fixture,
  mintQuoteFromOnchainFixture,
} from '../normalizedMintQuoteFixtures.ts';

const mintUrl = 'https://mint.test';
const keysetId = testMintKeysetId();
const quoteKey = {
  publicKeyHex: '02'.padEnd(66, '1'),
  secretKey: new Uint8Array(32),
  purpose: 'nut20_mint_quote' as const,
};
const methods = ['bolt11', 'bolt12', 'onchain'] as const;
function input(
  operationId = 'mint-1',
  method: PrepareMintInput['method'] = 'bolt11',
): PrepareMintInput {
  return {
    operationId,
    mintUrl,
    method,
    quoteId: method,
    amount: Amount.from(8),
    unit: 'sat',
    activeKeys: { id: keysetId, unit: 'sat', keys: testMintKeypairs },
    seed: new Uint8Array(32).fill(1),
    now: 1000,
  };
}
function proofs(operation: PendingMintOperation | ExecutingMintOperation) {
  return deserializeOutputData(operation.outputData).keep.map((output) => ({
    id: output.blindedMessage.id,
    amount: output.blindedMessage.amount,
    secret: new TextDecoder().decode(output.secret),
    C: testMintKeypairs['1'],
  }));
}

describe.each(['memory', 'sqlite'] as const)('Mint transitions (%s)', (adapter) => {
  let repositories: Repositories;
  let database: Database | undefined;
  let runner: RepositoryCoreTransactionRunner;
  beforeEach(async () => {
    if (adapter === 'sqlite') {
      database = new Database(':memory:');
      repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    } else repositories = new MemoryRepositories();
    await repositories.init();
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
            methods: methods.map((method) => ({
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
    await repositories.keyRingRepository.setPersistedKeyPair(quoteKey);
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Fixture(mintUrl, {
        quote: 'bolt11',
        request: 'lnbc1test',
        amount: Amount.from(8),
        unit: 'sat',
        state: 'PAID',
        expiry: 1,
      }),
    );
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt12Fixture(mintUrl, {
        quote: 'bolt12',
        request: 'lno1test',
        amount: Amount.from(20),
        unit: 'sat',
        pubkey: quoteKey.publicKeyHex,
        amount_paid: Amount.from(8),
        amount_issued: Amount.zero(),
        expiry: 1,
      }),
    );
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromOnchainFixture(mintUrl, {
        quote: 'onchain',
        request: 'bc1qtest',
        unit: 'sat',
        pubkey: quoteKey.publicKeyHex,
        amount_paid: Amount.from(8),
        amount_issued: Amount.zero(),
        expiry: 1,
      }),
    );
    runner = new RepositoryCoreTransactionRunner(repositories);
  });
  afterEach(() => database?.close());

  async function executing(method: PrepareMintInput['method'] = 'bolt11', id = 'mint-1') {
    await runner.run((tx) => prepareMint(tx, input(id, method)));
    const result = await runner.run((tx) => beginMintExecution(tx, { operationId: id, now: 2000 }));
    if (result.operation.state !== 'executing') throw new Error('Expected executing operation');
    return result.operation;
  }

  it.each([...methods])(
    'prepares and finalizes %s with exact outputs and stable timestamps',
    async (method) => {
      const operation = await executing(method);
      const quoteBefore = await repositories.mintQuoteRepository.getMintQuote(
        mintUrl,
        method,
        method,
      );
      const result = await runner.run((tx) =>
        applyMintResult(tx, { operation, proofs: proofs(operation), now: 3000 }),
      );
      expect(result.operation.state).toBe('finalized');
      expect((await repositories.mintOperationRepository.getById(operation.id))?.updatedAt).toBe(
        3000,
      );
      expect(
        (await repositories.proofRepository.getProofsByOperationId(mintUrl, operation.id)).length,
      ).toBe(1);
      expect(await repositories.mintQuoteRepository.getMintQuote(mintUrl, method, method)).toEqual(
        quoteBefore,
      );
    },
  );

  it('composes two mints and key allocation in one transaction, then rolls all of them back', async () => {
    const otherMint = 'https://other.test';
    const original = (await repositories.mintRepository.findMintByUrl(mintUrl))!;
    await repositories.mintRepository.addNewMint({ ...original, mintUrl: otherMint });
    await repositories.keysetRepository.addKeyset({
      mintUrl: otherMint,
      id: keysetId,
      unit: 'sat',
      keypairs: testMintKeypairs,
      active: true,
      feePpk: 0,
    });
    const quote = (await repositories.mintQuoteRepository.getMintQuote(
      mintUrl,
      'bolt11',
      'bolt11',
    ))!;
    await repositories.mintQuoteRepository.upsertMintQuote({ ...quote, mintUrl: otherMint });
    const keyInput = await new KeypairDerivation(async () => new Uint8Array(64)).prepare('p2pk');
    const work = async (tx: CoreTransaction) => {
      await tx.keypairs.allocate(keyInput);
      await prepareMint(tx, input('destination'));
      await prepareMint(tx, { ...input('other'), mintUrl: otherMint });
    };
    await expect(
      runner.run(async (tx) => {
        await work(tx);
        throw new Error('parent failed');
      }),
    ).rejects.toThrow('parent failed');
    expect(await repositories.mintOperationRepository.getById('destination')).toBeNull();
    expect(await repositories.mintOperationRepository.getById('other')).toBeNull();
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(await repositories.counterRepository.getCounter(otherMint, keysetId)).toBeNull();
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
    await runner.run(work);
    expect((await repositories.mintOperationRepository.getById('destination'))?.state).toBe(
      'pending',
    );
    expect((await repositories.mintOperationRepository.getById('other'))?.state).toBe('pending');
  });

  it('rolls back an allocation when operation persistence fails and publishes no partial state', async () => {
    const failing = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, (work) =>
        repositories.withTransaction((scope) => {
          scope.mintOperationRepository.create = async () => {
            throw new Error('write failed');
          };
          return work(scope);
        }),
      ),
    );
    await expect(failing.run((tx) => prepareMint(tx, input()))).rejects.toThrow('write failed');
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(await repositories.mintOperationRepository.getById('mint-1')).toBeNull();
  });

  it('rolls back proofs with finalization and retains the executing reservation', async () => {
    const operation = await executing('bolt12');
    await expect(
      runner.run(async (tx) => {
        await applyMintResult(tx, { operation, proofs: proofs(operation), now: 3000 });
        throw new Error('parent failed');
      }),
    ).rejects.toThrow('parent failed');
    expect(
      await repositories.proofRepository.getProofsByOperationId(mintUrl, operation.id),
    ).toEqual([]);
    expect((await repositories.mintOperationRepository.getById(operation.id))?.state).toBe(
      'executing',
    );
    await runner.run((tx) => prepareMint(tx, input('sibling', 'bolt12')));
    expect(
      (await runner.run((tx) => beginMintExecution(tx, { operationId: 'sibling', now: 3000 })))
        .operation.state,
    ).toBe('pending');
  });

  it('rejects mismatched output proofs and stale operation results without persisting candidates', async () => {
    const operation = await executing();
    await expect(
      runner.run((tx) =>
        applyMintResult(tx, {
          operation,
          proofs: [{ ...proofs(operation)[0]!, secret: 'unrelated' }],
          now: 3000,
        }),
      ),
    ).rejects.toThrow('allocated outputs');
    await expect(
      runner.run((tx) =>
        applyMintResult(tx, {
          operation: { ...operation, quoteId: 'other' },
          proofs: proofs(operation),
          now: 3000,
        }),
      ),
    ).rejects.toThrow('persisted request');
    expect(
      await repositories.proofRepository.getProofsByOperationId(mintUrl, operation.id),
    ).toEqual([]);
  });

  it('enrolls the whole transition: caught validation poisons the outer transaction', async () => {
    const keyInput = await new KeypairDerivation(async () => new Uint8Array(64)).prepare('p2pk');
    await expect(
      runner.run(async (tx) => {
        await tx.keypairs.allocate(keyInput);
        await prepareMint(tx, { ...input(), amount: Amount.from(7) }).catch(() => undefined);
      }),
    ).rejects.toThrow('does not match requested amount');
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
  });

  it('drains a dropped transition promise and rejects a captured scope after commit', async () => {
    let captured!: CoreTransaction;
    await runner.run(async (tx) => {
      captured = tx;
      void prepareMint(tx, input());
    });
    expect((await repositories.mintOperationRepository.getById('mint-1'))?.state).toBe('pending');
    await expect(prepareMint(captured, input('late'))).rejects.toThrow();
  });

  it('retries the entire allocation with unchanged operation identity and outputs', async () => {
    let attempts = 0;
    const outputs: unknown[] = [];
    const retrying = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, (work) =>
        repositories.withTransaction(async (scope) => {
          const result = await work(scope);
          outputs.push(await scope.mintOperationRepository.getById('mint-1'));
          if (++attempts === 1) throw new RepositoryTransactionConflictError('retry');
          return result;
        }),
      ),
    );
    await retrying.run((tx) => prepareMint(tx, input()));
    expect(attempts).toBe(2);
    expect(outputs[0]).toEqual(outputs[1]);
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(1);
  });

  it('chooses one winner across runners sharing reusable quote balance', async () => {
    await runner.run((tx) => prepareMint(tx, input('first', 'onchain')));
    await runner.run((tx) => prepareMint(tx, input('second', 'onchain')));
    const otherRunner = new RepositoryCoreTransactionRunner(repositories);
    const results = await Promise.all([
      runner.run((tx) => beginMintExecution(tx, { operationId: 'first', now: 2000 })),
      otherRunner.run((tx) => beginMintExecution(tx, { operationId: 'second', now: 2000 })),
    ]);
    expect(results.map((result) => result.operation.state).sort()).toEqual([
      'executing',
      'pending',
    ]);
  });

  it('revalidates trust and quote-key ownership inside preparation', async () => {
    await repositories.mintRepository.setMintTrusted(mintUrl, false);
    await expect(runner.run((tx) => prepareMint(tx, input()))).rejects.toThrow('not trusted');
    await repositories.mintRepository.setMintTrusted(mintUrl, true);
    await repositories.keyRingRepository.deletePersistedKeyPair(
      quoteKey.publicKeyHex,
      'nut20_mint_quote',
    );
    await expect(runner.run((tx) => prepareMint(tx, input('locked', 'bolt12')))).rejects.toThrow(
      'Missing NUT-20',
    );
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
  });

  it('keeps ambiguous recovery reserved and prevents late recovery from replacing finalization', async () => {
    const operation = await executing('bolt12');
    await runner.run((tx) => deferMintRecovery(tx, { operation, error: 'timeout', now: 3000 }));
    expect((await repositories.mintOperationRepository.getById(operation.id))?.state).toBe(
      'executing',
    );
    await runner.run((tx) =>
      applyMintResult(tx, { operation, proofs: proofs(operation), now: 4000 }),
    );
    await runner.run((tx) =>
      deferMintRecovery(tx, { operation, error: 'late timeout', now: 5000 }),
    );
    const failed = await runner.run((tx) =>
      failMint(tx, {
        operationId: operation.id,
        expectedState: 'executing',
        failure: { reason: 'late failure', observedAt: 5000 },
        now: 5000,
      }),
    );
    expect(failed.changed).toBe(false);
    expect((await repositories.mintOperationRepository.getById(operation.id))?.state).toBe(
      'finalized',
    );
  });
  it('reuses a prepared child ID without allocating again and rejects a different intent', async () => {
    const prepared = await runner.run((tx) => prepareMint(tx, input('child')));
    const repeated = await runner.run((tx) => prepareMint(tx, { ...input('child'), now: 2000 }));
    expect(repeated.changed).toBe(false);
    expect(repeated.operation.outputData).toEqual(prepared.operation.outputData);
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(1);
    await expect(runner.run((tx) => prepareMint(tx, input('child', 'bolt12')))).rejects.toThrow(
      'different intent',
    );
  });

  it('preserves already-spent output proofs when settling a legacy executing operation', async () => {
    const operation = await executing();
    const saved = proofs(operation).map((proof) => ({
      ...proof,
      mintUrl,
      unit: 'sat',
      state: 'spent' as const,
      createdByOperationId: operation.id,
      usedByOperationId: 'later-send',
    }));
    await repositories.proofRepository.saveProofs(mintUrl, saved);
    await runner.run((tx) => applyMintResult(tx, { operation, proofs: [], now: 3000 }));
    expect(
      await repositories.proofRepository.getProofsByOperationId(mintUrl, operation.id),
    ).toEqual(saved);
  });

  it('rejects duplicate remote candidates without recording local issuance', async () => {
    const operation = await executing();
    const candidate = proofs(operation)[0]!;
    await expect(
      runner.run((tx) =>
        applyMintResult(tx, { operation, proofs: [candidate, candidate], now: 3000 }),
      ),
    ).rejects.toThrow('duplicate');
    expect((await repositories.mintOperationRepository.getById(operation.id))?.state).toBe(
      'executing',
    );
  });
});
