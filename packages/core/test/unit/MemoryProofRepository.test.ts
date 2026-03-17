import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository.ts';
import type { CoreProof } from '../../types.ts';

describe('MemoryProofRepository', () => {
  const mintUrl = 'https://mint.test';
  const otherMintUrl = 'https://other-mint.test';

  let repository: MemoryProofRepository;

  const makeProof = (secret: string, selectedMintUrl = mintUrl): CoreProof => ({
    id: 'keyset-1',
    amount: 1,
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
});
