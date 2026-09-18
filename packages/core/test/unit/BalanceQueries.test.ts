import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { StoredBalanceQueries } from '../../proofs/BalanceQueries.ts';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository.ts';
import { ProofValidationError } from '../../models/Error.ts';
import type { CoreProof } from '../../types.ts';

describe('StoredBalanceQueries', () => {
  const mintUrl = 'https://mint.test';
  const otherMintUrl = 'https://mint.other';
  const keysetId = 'keyset-1';
  const operationId = 'op-123';

  let proofRepo: MemoryProofRepository;
  let mints: { getAllTrustedMints: () => Promise<{ mintUrl: string }[]> };

  const makeProof = (overrides: Partial<CoreProof>): CoreProof =>
    ({
      amount: Amount.from(1),
      C: 'C_' as unknown as any,
      id: keysetId,
      unit: 'sat',
      secret: Math.random().toString(36).slice(2),
      mintUrl,
      state: 'ready',
      ...overrides,
    }) as unknown as CoreProof;

  beforeEach(() => {
    proofRepo = new MemoryProofRepository();
    mints = {
      async getAllTrustedMints() {
        return [{ mintUrl }];
      },
    };
  });

  it('returns canonical single-mint views', async () => {
    const queries = new StoredBalanceQueries(proofRepo, mints as any);

    await proofRepo.saveProofs(mintUrl, [
      makeProof({ secret: 'a1', amount: Amount.from(100) }),
      makeProof({ secret: 'a2', amount: Amount.from(50) }),
    ]);
    await proofRepo.reserveProofs(mintUrl, ['a1'], operationId);

    await expect(queries.getBalancesByMint({ mintUrls: [mintUrl] })).resolves.toEqual({
      [mintUrl]: {
        spendable: Amount.from(50),
        reserved: Amount.from(100),
        total: Amount.from(150),
        unit: 'sat',
      },
    });
    await expect(queries.getBalanceTotal({ mintUrls: [mintUrl] })).resolves.toEqual({
      spendable: Amount.from(50),
      reserved: Amount.from(100),
      total: Amount.from(150),
      unit: 'sat',
    });
  });

  it('uses mint-scoped ready proof reads for scoped balance queries', async () => {
    const originalGetReadyProofs = proofRepo.getReadyProofs.bind(proofRepo);
    const originalGetAllReadyProofs = proofRepo.getAllReadyProofs.bind(proofRepo);

    proofRepo.getReadyProofs = mock((mintUrl: string, filter?: any) =>
      originalGetReadyProofs(mintUrl, filter),
    );
    proofRepo.getAllReadyProofs = mock((filter?: any) => originalGetAllReadyProofs(filter));

    const queries = new StoredBalanceQueries(proofRepo, mints as any);

    await proofRepo.saveProofs(mintUrl, [
      makeProof({ secret: 'scope-a1', amount: Amount.from(100) }),
      makeProof({ secret: 'scope-a2', amount: Amount.from(50) }),
    ]);
    await proofRepo.saveProofs(otherMintUrl, [
      makeProof({ secret: 'scope-b1', amount: Amount.from(200), mintUrl: otherMintUrl }),
    ]);
    await proofRepo.reserveProofs(mintUrl, ['scope-a1'], operationId);

    await expect(queries.getBalancesByMint({ mintUrls: [mintUrl] })).resolves.toEqual({
      [mintUrl]: {
        spendable: Amount.from(50),
        reserved: Amount.from(100),
        total: Amount.from(150),
        unit: 'sat',
      },
    });

    expect(proofRepo.getReadyProofs).toHaveBeenCalledTimes(1);
    expect(proofRepo.getReadyProofs).toHaveBeenCalledWith(mintUrl, { units: ['sat'] });
    expect(proofRepo.getAllReadyProofs).not.toHaveBeenCalled();
  });

  it('returns an empty snapshot for an explicit empty mint selection', async () => {
    const originalGetReadyProofs = proofRepo.getReadyProofs.bind(proofRepo);
    const originalGetAllReadyProofs = proofRepo.getAllReadyProofs.bind(proofRepo);

    proofRepo.getReadyProofs = mock((mintUrl: string, filter?: any) =>
      originalGetReadyProofs(mintUrl, filter),
    );
    proofRepo.getAllReadyProofs = mock((filter?: any) => originalGetAllReadyProofs(filter));

    const queries = new StoredBalanceQueries(proofRepo, mints as any);

    await proofRepo.saveProofs(mintUrl, [
      makeProof({ secret: 'empty-a1', amount: Amount.from(100) }),
    ]);
    await proofRepo.saveProofs(otherMintUrl, [
      makeProof({ secret: 'empty-b1', amount: Amount.from(200), mintUrl: otherMintUrl }),
    ]);

    await expect(queries.getBalancesByMint({ mintUrls: [] })).resolves.toEqual({});
    await expect(queries.getBalanceTotal({ mintUrls: [] })).resolves.toEqual({
      spendable: Amount.from(0),
      reserved: Amount.from(0),
      total: Amount.from(0),
      unit: 'sat',
    });

    expect(proofRepo.getReadyProofs).not.toHaveBeenCalled();
    expect(proofRepo.getAllReadyProofs).not.toHaveBeenCalled();
  });

  it('treats an explicit empty unit selection as no balance results', async () => {
    const originalGetReadyProofs = proofRepo.getReadyProofs.bind(proofRepo);
    const originalGetAllReadyProofs = proofRepo.getAllReadyProofs.bind(proofRepo);

    proofRepo.getReadyProofs = mock((mintUrl: string, filter?: any) =>
      originalGetReadyProofs(mintUrl, filter),
    );
    proofRepo.getAllReadyProofs = mock((filter?: any) => originalGetAllReadyProofs(filter));

    const queries = new StoredBalanceQueries(proofRepo, mints as any);

    await proofRepo.saveProofs(mintUrl, [
      makeProof({ secret: 'empty-unit-a1', amount: Amount.from(100), unit: 'sat' }),
      makeProof({ secret: 'empty-unit-u1', amount: Amount.from(40), unit: 'usd' }),
    ]);

    await expect(queries.getBalancesByMint({ units: [] })).resolves.toEqual({});
    await expect(queries.getBalanceTotal({ units: [] })).resolves.toEqual({
      spendable: Amount.zero(),
      reserved: Amount.zero(),
      total: Amount.zero(),
      unit: 'sat',
    });

    expect(proofRepo.getReadyProofs).not.toHaveBeenCalled();
    expect(proofRepo.getAllReadyProofs).not.toHaveBeenCalled();
  });

  it('returns canonical map views for all mints', async () => {
    const queries = new StoredBalanceQueries(proofRepo, mints as any);

    await proofRepo.saveProofs(mintUrl, [
      makeProof({ secret: 'b1', amount: Amount.from(100) }),
      makeProof({ secret: 'b2', amount: Amount.from(50) }),
    ]);
    await proofRepo.saveProofs(otherMintUrl, [
      makeProof({ secret: 'c1', amount: Amount.from(200), mintUrl: otherMintUrl }),
    ]);
    await proofRepo.reserveProofs(mintUrl, ['b1'], operationId);

    await expect(queries.getBalancesByMint()).resolves.toEqual({
      [mintUrl]: {
        spendable: Amount.from(50),
        reserved: Amount.from(100),
        total: Amount.from(150),
        unit: 'sat',
      },
      [otherMintUrl]: {
        spendable: Amount.from(200),
        reserved: Amount.from(0),
        total: Amount.from(200),
        unit: 'sat',
      },
    });
    await expect(queries.getBalanceTotal()).resolves.toEqual({
      spendable: Amount.from(250),
      reserved: Amount.from(100),
      total: Amount.from(350),
      unit: 'sat',
    });
  });

  it('keeps mixed-unit balances separated', async () => {
    const queries = new StoredBalanceQueries(proofRepo, mints as any);

    await proofRepo.saveProofs(mintUrl, [
      makeProof({ secret: 'sat-ready', amount: Amount.from(100), unit: 'sat' }),
      makeProof({ secret: 'usd-ready', amount: Amount.from(40), unit: 'usd' }),
      makeProof({ secret: 'usd-reserved', amount: Amount.from(10), unit: 'usd' }),
    ]);
    await proofRepo.saveProofs(otherMintUrl, [
      makeProof({
        secret: 'other-usd',
        amount: Amount.from(7),
        mintUrl: otherMintUrl,
        unit: 'usd',
      }),
    ]);
    await proofRepo.reserveProofs(mintUrl, ['usd-reserved'], operationId);

    await expect(queries.getBalancesByMint()).resolves.toEqual({
      [mintUrl]: {
        spendable: Amount.from(100),
        reserved: Amount.zero(),
        total: Amount.from(100),
        unit: 'sat',
      },
    });
    await expect(queries.getBalancesByMint({ units: ['usd'] })).resolves.toEqual({
      [mintUrl]: {
        spendable: Amount.from(40),
        reserved: Amount.from(10),
        total: Amount.from(50),
        unit: 'usd',
      },
      [otherMintUrl]: {
        spendable: Amount.from(7),
        reserved: Amount.zero(),
        total: Amount.from(7),
        unit: 'usd',
      },
    });
    await expect(queries.getBalancesByMintAndUnit()).resolves.toEqual({
      [mintUrl]: {
        sat: {
          spendable: Amount.from(100),
          reserved: Amount.zero(),
          total: Amount.from(100),
          unit: 'sat',
        },
        usd: {
          spendable: Amount.from(40),
          reserved: Amount.from(10),
          total: Amount.from(50),
          unit: 'usd',
        },
      },
      [otherMintUrl]: {
        usd: {
          spendable: Amount.from(7),
          reserved: Amount.zero(),
          total: Amount.from(7),
          unit: 'usd',
        },
      },
    });
    await expect(queries.getBalanceTotal({ units: ['sat', 'usd'] })).rejects.toThrow(
      ProofValidationError,
    );
    await expect(queries.getBalanceTotalByUnit()).resolves.toEqual({
      sat: {
        spendable: Amount.from(100),
        reserved: Amount.zero(),
        total: Amount.from(100),
        unit: 'sat',
      },
      usd: {
        spendable: Amount.from(47),
        reserved: Amount.from(10),
        total: Amount.from(57),
        unit: 'usd',
      },
    });
  });

  it('filters trusted balances', async () => {
    const queries = new StoredBalanceQueries(proofRepo, mints as any);

    await proofRepo.saveProofs(mintUrl, [
      makeProof({ secret: 'd1', amount: Amount.from(100) }),
      makeProof({ secret: 'd2', amount: Amount.from(50) }),
    ]);
    await proofRepo.saveProofs(otherMintUrl, [
      makeProof({ secret: 'e1', amount: Amount.from(500), mintUrl: otherMintUrl }),
    ]);
    await proofRepo.reserveProofs(mintUrl, ['d1'], operationId);

    await expect(queries.getBalancesByMint({ trustedOnly: true })).resolves.toEqual({
      [mintUrl]: {
        spendable: Amount.from(50),
        reserved: Amount.from(100),
        total: Amount.from(150),
        unit: 'sat',
      },
    });
    await expect(queries.getBalanceTotal({ trustedOnly: true })).resolves.toEqual({
      spendable: Amount.from(50),
      reserved: Amount.from(100),
      total: Amount.from(150),
      unit: 'sat',
    });
  });
});
