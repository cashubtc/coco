import { UnknownMintError } from '@core/models/Error.ts';
import { isBlsKeyset } from '@cashu/cashu-ts';
import type { MintMetadata, MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type { MintRepository, KeysetRepository } from '@core/repositories';

export interface ScopedMintMetadataCommands {
  assertTrusted(mintUrl: string): Promise<void>;
  applyObservation(observation: MintMetadataObservation): Promise<MintMetadata>;
}

/** Cache persistence shared by owning transactions; remote metadata cannot change mint trust. */
export class RepositoryMintMetadataCommands implements ScopedMintMetadataCommands {
  constructor(
    private readonly mints: MintRepository,
    private readonly keysets: KeysetRepository,
  ) {}

  async assertTrusted(mintUrl: string): Promise<void> {
    if (!(await this.mints.isTrustedMint(mintUrl)))
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
  }

  async applyObservation(observation: MintMetadataObservation): Promise<MintMetadata> {
    const current = (await this.mints.getAllMints()).find(
      (mint) => mint.mintUrl === observation.mintUrl,
    );
    if (current && current.updatedAt > observation.observedAt) {
      return {
        mint: current,
        keysets: (await this.keysets.getKeysetsByMintUrl(current.mintUrl)).filter(
          (keyset) => !isBlsKeyset(keyset.id),
        ),
      };
    }
    for (const keyset of observation.keysets) {
      const existing = await this.keysets.getKeysetById(observation.mintUrl, keyset.id);
      if (existing) {
        await this.keysets.updateKeyset(keyset);
      } else {
        await this.keysets.addKeyset(keyset);
      }
    }
    const mint = {
      ...(current ?? {
        mintUrl: observation.mintUrl,
        name: observation.mintUrl,
        trusted: false,
        createdAt: observation.observedAt,
      }),
      mintInfo: observation.mintInfo,
      updatedAt: observation.observedAt,
    };
    await this.mints.addOrUpdateMint(mint);
    const keysets = await this.keysets.getKeysetsByMintUrl(mint.mintUrl);
    return { mint, keysets: keysets.filter((keyset) => !isBlsKeyset(keyset.id)) };
  }
}
