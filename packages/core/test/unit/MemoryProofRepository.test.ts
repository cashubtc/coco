import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository.ts';
import type { CoreProof } from '../../types.ts';

describe('MemoryProofRepository', () => {
  const mintUrl = 'https://mint.test';
  const otherMintUrl = 'https://other-mint.test';

  let repository: MemoryProofRepository;

  const makeProof = (secret: string, selectedMintUrl = mintUrl): CoreProof => ({
    id: 'keyset-1',
    unit: 'sat',
    amount: Amount.from(1),
    secret,
    C: `C_${secret}`,
    mintUrl: selectedMintUrl,
    state: 'ready',
  });

  beforeEach(() => {
    repository = new MemoryProofRepository();
  });

  it('gets proofs by batched secrets for one mint without duplicates', async () => {
    await repository.saveProofs(mintUrl, [makeProof('s1'), makeProof('s2')]);
    await repository.saveProofs(otherMintUrl, [makeProof('s1', otherMintUrl)]);

    const proofs = await repository.getProofsBySecrets(mintUrl, ['s1', 'missing', 's2', 's1']);

    expect(proofs).toHaveLength(2);
    expect(proofs.map((proof) => proof.secret).sort()).toEqual(['s1', 's2']);
    expect(proofs.every((proof) => proof.mintUrl === mintUrl)).toBe(true);
  });

  it('returns an empty array for an empty secret batch', async () => {
    const proofs = await repository.getProofsBySecrets(mintUrl, []);

    expect(proofs).toEqual([]);
  });

  it('requires proofs to carry a unit', async () => {
    const proof = makeProof('missing-unit') as unknown as Omit<CoreProof, 'unit'>;
    delete (proof as { unit?: string }).unit;

    await expect(repository.saveProofs(mintUrl, [proof as CoreProof])).rejects.toThrow(
      'Unit is required',
    );
  });

  it('filters ready and available proofs by unit', async () => {
    await repository.saveProofs(mintUrl, [
      makeProof('sat-1'),
      { ...makeProof('usd-1'), unit: 'usd', amount: Amount.from(2) },
      { ...makeProof('USD-2'), unit: 'USD', amount: Amount.from(3) },
    ]);

    const readyUsd = await repository.getReadyProofs(mintUrl, { unit: 'USD' });
    const availableSat = await repository.getAvailableProofs(mintUrl, { unit: 'sat' });
    const allUsd = await repository.getAllReadyProofs({ units: ['usd'] });

    expect(readyUsd.map((proof) => proof.secret).sort()).toEqual(['USD-2', 'usd-1']);
    expect(readyUsd.every((proof) => proof.unit === 'usd')).toBe(true);
    expect(availableSat.map((proof) => proof.secret)).toEqual(['sat-1']);
    expect(allUsd).toHaveLength(2);
  });
});
