import { Amount, MintOperationError, StaleKeysetError, type Proof } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { describe, expect, it, mock } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { WalletService } from '../../services/WalletService.ts';
import { SeedService } from '../../services/SeedService.ts';
import { MintRequestProvider } from '../../infra/MintRequestProvider.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreMintMetadataTransactions } from '../../transactions/mints/MintMetadataTransactions.ts';
import { CoreSendTransactions } from '../../transactions/send/SendTransactions.ts';
import {
  createMintMetadataRemoteDouble,
  createMintServiceForMetadata,
} from '../fixtures/MintMetadataRefresh.ts';
import { createSendEnvironment } from '../fixtures/SendEnvironment.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import { preparedSend } from '../fixtures/SendOperation.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import type { CoreProof } from '../../types.ts';

const mintUrl = 'https://mint.test';
const keyset = {
  mintUrl,
  id: testMintKeysetId(),
  unit: 'sat',
  keypairs: testMintKeypairs,
  active: true,
  feePpk: 0,
};
const mint = {
  mintUrl,
  name: 'Mint',
  trusted: true,
  mintInfo: testMintInfo,
  createdAt: 1,
  updatedAt: 100,
};
const observation = {
  mintUrl,
  mintInfo: testMintInfo,
  keysets: [keyset],
  observedAt: 200,
  expectedRevision: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function proof(secret: string): CoreProof {
  return {
    id: keyset.id,
    amount: Amount.from(10),
    secret,
    C: `C-${secret}`,
    mintUrl,
    unit: 'sat',
    state: 'ready',
  };
}

async function prepared() {
  const env = await createSendEnvironment();
  const input = proof('input');
  const operation = preparedSend('send-rotation', [input], [proof('output')]);
  await env.repositories.proofRepository.saveProofs(mintUrl, [input]);
  await env.repositories.proofRepository.reserveProofs(mintUrl, [input.secret], operation.id);
  await env.repositories.sendOperationRepository.create(operation);
  return { ...env, input, operation };
}

describe.each(['memory', 'sqlite'] as const)('keyset invalidation (%s)', (adapter) => {
  it.each(['addNewMint', 'addOrUpdateMint', 'updateMint'] as const)(
    'keeps delayed responses invalid after an update through %s omits the revision',
    async (method) => {
      const database = adapter === 'sqlite' ? new Database(':memory:') : undefined;
      const repositories = database
        ? new SqlStorageRepositories({ database: new SqliteDb({ database }) })
        : new MemoryRepositories();
      try {
        await repositories.init();
        await repositories.mintRepository.addNewMint(mint);
        await repositories.keysetRepository.addKeyset(keyset);
        const transactions = new CoreMintMetadataTransactions(
          new RepositoryCoreTransactionRunner(repositories),
        );
        await transactions.invalidate(mintUrl);
        await repositories.mintRepository[method]({ ...mint, name: 'Local name', updatedAt: 0 });

        expect((await repositories.mintRepository.getMintByUrl(mintUrl)).metadataRevision).toBe(1);
        expect((await transactions.applyObservation(observation)).applied).toBe(false);
        expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBe(0);
      } finally {
        database?.close();
      }
    },
  );

  it('preserves trust, rejects delayed responses, and permits a fresh same-second observation', async () => {
    const database = adapter === 'sqlite' ? new Database(':memory:') : undefined;
    const repositories = database
      ? new SqlStorageRepositories({ database: new SqliteDb({ database }) })
      : new MemoryRepositories();
    try {
      await repositories.init();
      await repositories.mintRepository.addNewMint(mint);
      await repositories.keysetRepository.addKeyset(keyset);
      const transactions = new CoreMintMetadataTransactions(
        new RepositoryCoreTransactionRunner(repositories),
      );
      await repositories.mintRepository.setMintTrusted(mintUrl, false);
      await transactions.invalidate(mintUrl);
      expect(await repositories.mintRepository.getMintByUrl(mintUrl)).toMatchObject({
        trusted: false,
        updatedAt: 0,
        metadataRevision: 1,
      });
      expect((await transactions.applyObservation(observation)).applied).toBe(false);
      const fresh = await transactions.applyObservation({ ...observation, expectedRevision: 1 });
      expect(fresh.applied).toBe(true);
      expect(fresh.metadata.mint.trusted).toBe(false);
      await transactions.invalidate(mintUrl);
      const next = await transactions.applyObservation({ ...observation, expectedRevision: 3 });
      expect(next.applied).toBe(true);
      expect(next.metadata.mint.metadataRevision).toBe(4);
    } finally {
      database?.close();
    }
  });

  it('retains historical keys while deactivating keysets omitted by a refresh', async () => {
    const database = adapter === 'sqlite' ? new Database(':memory:') : undefined;
    const repositories = database
      ? new SqlStorageRepositories({ database: new SqliteDb({ database }) })
      : new MemoryRepositories();
    try {
      await repositories.init();
      await repositories.mintRepository.addNewMint(mint);
      await repositories.keysetRepository.addKeyset(keyset);
      const transactions = new CoreMintMetadataTransactions(
        new RepositoryCoreTransactionRunner(repositories),
      );
      await transactions.applyObservation({ ...observation, keysets: [] });
      expect(await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id)).toMatchObject({
        active: false,
        keypairs: testMintKeypairs,
      });
    } finally {
      database?.close();
    }
  });
});

it('discards a refresh started before invalidation and fetches again before returning', async () => {
  const repositories = new MemoryRepositories();
  await repositories.mintRepository.addNewMint({ ...mint, updatedAt: 0 });
  await repositories.keysetRepository.addKeyset(keyset);
  const remote = createMintMetadataRemoteDouble();
  const started = deferred<void>();
  const finish = deferred<void>();
  remote.fetchMintMetadata.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
    return { ...observation, observedAt: Math.floor(Date.now() / 1000) };
  });
  remote.fetchMintMetadata.mockImplementation(async () => ({
    ...observation,
    mintInfo: { ...testMintInfo, name: 'After rotation' },
    observedAt: Math.floor(Date.now() / 1000),
  }));
  const service = createMintServiceForMetadata(repositories, remote);
  const refresh = service.updateMintData(mintUrl);
  await started.promise;
  await service.invalidateAndCommitKeysets(mintUrl);
  finish.resolve();
  expect((await refresh).mint.mintInfo.name).toBe('After rotation');
  expect(remote.fetchMintMetadata).toHaveBeenCalledTimes(2);
});

it('rebuilds cached Wallet Instances from committed invalidation in another session', async () => {
  const repositories = new MemoryRepositories();
  await repositories.mintRepository.addNewMint({
    ...mint,
    updatedAt: Math.floor(Date.now() / 1000),
  });
  await repositories.keysetRepository.addKeyset(keyset);
  const remote = createMintMetadataRemoteDouble();
  remote.fetchMintMetadata.mockResolvedValue({
    ...observation,
    observedAt: Math.floor(Date.now() / 1000),
  });
  const metadataService = createMintServiceForMetadata(repositories, remote);
  const walletService = new WalletService(
    metadataService,
    new SeedService(async () => new Uint8Array(64).fill(1)),
    new MintRequestProvider(),
  );
  const first = await walletService.getWallet(mintUrl, 'sat');
  const secondSession = createMintServiceForMetadata(repositories, remote);
  await secondSession.invalidateAndCommitKeysets(mintUrl);
  const second = await walletService.getWallet(mintUrl, 'sat');
  expect(second).not.toBe(first);
  expect(await walletService.getWallet(mintUrl, 'sat')).toBe(second);
  expect(remote.fetchMintMetadata).toHaveBeenCalledTimes(1);
  const freshSession = new WalletService(
    secondSession,
    new SeedService(async () => new Uint8Array(64).fill(1)),
    new MintRequestProvider(),
  );
  expect((await freshSession.getWallet(mintUrl, 'sat')).keyChain.cache).toEqual(
    second.keyChain.cache,
  );
});

it('atomically invalidates metadata and releases inputs after a first stale send rejection', async () => {
  const { repositories, service, remote, operation } = await prepared();
  const error = new StaleKeysetError(false, { cause: new MintOperationError(12002, 'Inactive') });
  remote.swap.mockRejectedValue(error);
  await expect(service.execute(operation)).rejects.toBe(error);
  expect(remote.swap).toHaveBeenCalledTimes(1);
  expect(await repositories.sendOperationRepository.getById(operation.id)).toMatchObject({
    state: 'rolled_back',
    outputData: operation.outputData,
  });
  expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toHaveLength(1);
  expect(await repositories.mintRepository.getMintByUrl(mintUrl)).toMatchObject({
    updatedAt: 0,
    metadataRevision: 1,
  });
});

it('keeps a stale rejected replay executing with its exact outputs and input reservation', async () => {
  const { repositories, service, remote, operation } = await prepared();
  const executing = { ...operation, state: 'executing' as const, revision: 1 };
  await repositories.sendOperationRepository.update(executing);
  remote.checkProofStates.mockImplementation(async (proofs) =>
    proofs.map(() => ({ state: 'UNSPENT', Y: 'unused', witness: null })),
  );
  const error = new StaleKeysetError(false);
  remote.swap.mockRejectedValue(error);
  await service.recoverPendingOperations();
  expect(remote.swap).toHaveBeenCalledTimes(1);
  expect(await repositories.sendOperationRepository.getById(operation.id)).toMatchObject({
    state: 'executing',
    outputData: operation.outputData,
  });
  expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
  expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBe(0);
});

it('rolls back metadata invalidation and proof release when recording a stale send rejection fails', async () => {
  const { repositories, transactions, operation } = await prepared();
  const begun = await transactions.beginExecution({
    operationId: operation.id,
    updatedAt: Date.now(),
  });
  const controlled = overrideTransactions(repositories, (work) =>
    repositories.withTransaction((scope) => {
      scope.sendOperationRepository.transition = async () => false;
      return work(scope);
    }),
  );
  const rejecting = new CoreSendTransactions(new RepositoryCoreTransactionRunner(controlled));
  await expect(
    rejecting.failExecution({
      operationId: operation.id,
      expectedRevision: begun.operation.revision!,
      updatedAt: Date.now(),
      error: 'stale',
      invalidateKeysets: true,
    }),
  ).rejects.toThrow();
  expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBeGreaterThan(0);
  expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
    'executing',
  );
  expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
});

it('returns a rejected first reclaim to pending without releasing the token or reusing counters', async () => {
  const env = await createSendEnvironment();
  await env.repositories.proofRepository.saveProofs(mintUrl, [proof('input')]);
  const op = await env.service.prepare(
    await env.service.init(mintUrl, { amount: Amount.from(10), unit: 'sat' }),
  );
  const pending = await env.service.execute(op);
  const error = new StaleKeysetError(false);
  env.remote.reclaim.mockRejectedValue(error);
  await expect(env.service.rollback(op.id)).rejects.toBe(error);
  expect(await env.repositories.sendOperationRepository.getById(op.id)).toMatchObject({
    state: 'pending',
    token: pending.token,
    reclaimData: undefined,
  });
  expect((await env.repositories.proofRepository.getProofBySecret(mintUrl, 'input'))?.state).toBe(
    'inflight',
  );
  expect(
    (await env.repositories.counterRepository.getCounter(mintUrl, keyset.id))!.counter,
  ).toBeGreaterThan(0);
  expect((await env.repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBe(0);
});
