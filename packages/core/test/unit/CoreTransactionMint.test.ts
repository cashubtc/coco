import { Amount } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import type { CoreTransaction } from '../../transactions/CoreTransaction.ts';
import { mintFixture } from '../helpers/mintReconciliation.ts';
import { overrideTransactions } from '../overrideTransactions.ts';

for (const storage of ['memory', 'sqlite'] as const) {
  describe(`CoreTransaction Mint and Keypair composition (${storage})`, () => {
    async function setup() {
      const fixture = await mintFixture();
      const database = storage === 'sqlite' ? new Database(':memory:') : undefined;
      const repositories = database
        ? new SqlStorageRepositories({ database: new SqliteDb({ database }) })
        : fixture.repositories;
      await repositories.init();
      await repositories.mintRepository.addOrUpdateMint(
        await fixture.repositories.mintRepository.getMintByUrl(fixture.mintUrl),
      );
      for (const keyset of (await fixture.metadata()).keysets)
        await repositories.keysetRepository.addKeyset(keyset);
      const quote = await fixture.quote();
      await repositories.mintQuoteRepository.upsertMintQuote(quote);
      const amount = Amount.from(100);
      const mintInput = {
        ...(await fixture.remote.preflight(
          quote,
          amount,
          await fixture.metadata(),
          await fixture.loadSeed(),
        )),
        id: 'composed-mint',
        quote,
        amount,
      };
      const keyInput = await new KeypairDerivation(async () => new Uint8Array(64)).prepare('p2pk');
      let opens = 0;
      const runner = new RepositoryCoreTransactionRunner(
        overrideTransactions(repositories, (work) => {
          opens++;
          return repositories.withTransaction(work);
        }),
      );
      return { repositories, runner, mintInput, keyInput, database, opens: () => opens };
    }

    it.each(['deactivated', 'unit changed', 'keys replaced'] as const)(
      'rejects Mint allocation when its keyset is %s after preflight',
      async (change) => {
        const f = await setup();
        try {
          const input = f.mintInput;
          const keyset = (await f.repositories.keysetRepository.getKeysetById(
            input.quote.mintUrl,
            input.activeKeys.id,
          ))!;
          await f.repositories.keysetRepository.deleteKeyset(
            input.quote.mintUrl,
            input.activeKeys.id,
          );
          await f.repositories.keysetRepository.addKeyset({
            ...keyset,
            active: change !== 'deactivated',
            unit: change === 'unit changed' ? 'usd' : keyset.unit,
            keypairs: change === 'keys replaced' ? {} : keyset.keypairs,
          });
          await expect(f.runner.run((scope) => scope.mints.prepare(input))).rejects.toThrow(
            'changed after preflight',
          );
          expect(await f.repositories.mintOperationRepository.getById(input.id)).toBeNull();
          expect(await f.repositories.mintRecoveryRepository.get(input.id)).toBeNull();
          expect(
            await f.repositories.counterRepository.getCounter(
              input.quote.mintUrl,
              input.activeKeys.id,
            ),
          ).toBeNull();
        } finally {
          f.database?.close();
        }
      },
    );

    it('commits both domains through one scope and rolls both back on failure', async () => {
      const f = await setup();
      try {
        await expect(
          f.runner.run(async (scope) => {
            await scope.keypairs.allocate(f.keyInput);
            await scope.mints.prepare(f.mintInput);
            throw new Error('composed transition failed');
          }),
        ).rejects.toThrow('composed transition failed');
        expect(f.opens()).toBe(1);
        expect(await f.repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBeNull();
        expect(await f.repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
        expect(await f.repositories.mintOperationRepository.getById(f.mintInput.id)).toBeNull();
        expect(await f.repositories.mintRecoveryRepository.get(f.mintInput.id)).toBeNull();
        expect(
          await f.repositories.counterRepository.getCounter(
            f.mintInput.quote.mintUrl,
            f.mintInput.activeKeys.id,
          ),
        ).toBeNull();

        const committed = await f.runner.run(async (scope) => {
          const keypair = await scope.keypairs.allocate(f.keyInput);
          const mint = await scope.mints.prepare(f.mintInput);
          return { keypair, mint };
        });
        expect(f.opens()).toBe(2);
        expect(committed.keypair.derivationIndex).toBe(0);
        expect(await f.repositories.mintOperationRepository.getById(f.mintInput.id)).toMatchObject({
          id: f.mintInput.id,
          state: 'pending',
          amount: f.mintInput.amount,
          outputData: committed.mint.operation.outputData,
        });
        expect(
          await f.repositories.counterRepository.getCounter(
            f.mintInput.quote.mintUrl,
            f.mintInput.activeKeys.id,
          ),
        ).toEqual(committed.mint.counter);
        expect(await f.repositories.mintRecoveryRepository.get(f.mintInput.id)).toMatchObject({
          provenance: 'prepared',
        });
      } finally {
        f.database?.close();
      }
    });

    it('rolls back both domains even when the caller catches a Mint command failure', async () => {
      const f = await setup();
      try {
        await expect(
          f.runner.run(async (scope) => {
            await scope.keypairs.allocate(f.keyInput);
            await scope.mints.prepare(f.mintInput);
            await scope.mints.prepare(f.mintInput).catch(() => {});
          }),
        ).rejects.toThrow();
        expect(f.opens()).toBe(1);
        expect(await f.repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
        expect(await f.repositories.mintOperationRepository.getById(f.mintInput.id)).toBeNull();
        expect(await f.repositories.mintRecoveryRepository.get(f.mintInput.id)).toBeNull();
        expect(
          await f.repositories.counterRepository.getCounter(
            f.mintInput.quote.mintUrl,
            f.mintInput.activeKeys.id,
          ),
        ).toBeNull();
      } finally {
        f.database?.close();
      }
    });

    it('rejects a captured Mint command after its transaction ends', async () => {
      const f = await setup();
      let prepare!: CoreTransaction['mints']['prepare'];
      try {
        await f.runner.run(async (scope) => {
          prepare = scope.mints.prepare;
          await scope.keypairs.allocate(f.keyInput);
        });
        await expect(prepare(f.mintInput)).rejects.toThrow('Wallet transaction scope is closed');
        expect(await f.repositories.mintOperationRepository.getById(f.mintInput.id)).toBeNull();
        expect(await f.repositories.mintRecoveryRepository.get(f.mintInput.id)).toBeNull();
      } finally {
        f.database?.close();
      }
    });
  });
}
