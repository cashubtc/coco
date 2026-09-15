import { isBlsKeyset } from '@cashu/cashu-ts';
import { UnknownMintError } from '@core/models/Error.ts';
import type { MintMetadataApplyResult, ApplyMintMetadataInput } from '@core/mints/MintMetadata.ts';
import type { MintRepository, KeysetRepository } from '@core/repositories';

export interface ScopedMintMetadataCommands {
  assertTrusted(mintUrl: string): Promise<void>;
  invalidate(mintUrl: string): Promise<void>;
  applyObservation(observation: ApplyMintMetadataInput): Promise<MintMetadataApplyResult>;
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

  async invalidate(mintUrl: string): Promise<void> {
    const current = (await this.mints.getAllMints()).find((mint) => mint.mintUrl === mintUrl);
    if (!current) return;
    await this.mints.updateMint({
      ...current,
      updatedAt: 0,
      metadataRevision: (current.metadataRevision ?? 0) + 1,
    });
  }

  async applyObservation(observation: ApplyMintMetadataInput): Promise<MintMetadataApplyResult> {
    const current = (await this.mints.getAllMints()).find(
      (mint) => mint.mintUrl === observation.mintUrl,
    );
    const revision = current?.metadataRevision ?? 0;
    // A response started before invalidation or another refresh must never revive its snapshot.
    const superseded = observation.expectedRevision !== revision;
    const older =
      current &&
      (current.updatedAt > observation.observedAt ||
        (current.updatedAt === observation.observedAt && !observation.force));
    if (current && (superseded || older)) {
      return {
        applied: false,
        metadata: {
          mint: current,
          keysets: (await this.keysets.getKeysetsByMintUrl(current.mintUrl)).filter(
            (keyset) => !isBlsKeyset(keyset.id),
          ),
        },
      };
    }
    // Keep historical keys for Restore, but never allocate to an omitted keyset.
    for (const existing of await this.keysets.getKeysetsByMintUrl(observation.mintUrl)) {
      if (existing.active && !observation.keysets.some((keyset) => keyset.id === existing.id)) {
        await this.keysets.updateKeyset({ ...existing, active: false });
      }
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
        trusted: observation.initialTrust ?? false,
        createdAt: observation.observedAt,
      }),
      mintInfo: observation.mintInfo,
      updatedAt: observation.observedAt,
      metadataRevision: revision + 1,
    };
    await this.mints.addOrUpdateMint(mint);
    const keysets = await this.keysets.getKeysetsByMintUrl(mint.mintUrl);
    return {
      applied: true,
      metadata: { mint, keysets: keysets.filter((keyset) => !isBlsKeyset(keyset.id)) },
    };
  }
}
