import { isBlsKeyset } from '@cashu/cashu-ts';
import type {
  MintMetadata,
  MintMetadataApplyResult,
  MintMetadataObservation,
} from '@core/mints/MintMetadata.ts';
import { UnknownMintError } from '@core/models/Error.ts';
import type { Mint } from '@core/models/Mint.ts';
import type { MintRepository, KeysetRepository } from '@core/repositories';

export interface AddMintInput {
  mintUrl: string;
  /** Omitted only when preflight found fresh metadata; never recreate a deleted mint from cache. */
  observation?: MintMetadataObservation;
  /** Omission preserves existing trust and creates new mints as untrusted. */
  trusted?: boolean;
}

export interface AddMintResult extends MintMetadataApplyResult {
  created: boolean;
  trustChanged: boolean;
}

export interface SetMintTrustedInput {
  mintUrl: string;
  trusted: boolean;
}

export interface ScopedMintCommands {
  applyObservation(observation: MintMetadataObservation): Promise<MintMetadataApplyResult>;
  updateMetadata(observation: MintMetadataObservation): Promise<MintMetadataApplyResult>;
  add(input: AddMintInput): Promise<AddMintResult>;
  setTrusted(input: SetMintTrustedInput): Promise<void>;
  delete(mintUrl: string): Promise<void>;
}

/** Mint management within one scope; remote observations cannot authorize trust changes. */
export class RepositoryMintCommands implements ScopedMintCommands {
  constructor(
    private readonly mints: MintRepository,
    private readonly keysets: KeysetRepository,
  ) {}

  async applyObservation(observation: MintMetadataObservation): Promise<MintMetadataApplyResult> {
    return this.applyMetadata(observation, await this.findMint(observation.mintUrl));
  }

  async updateMetadata(observation: MintMetadataObservation): Promise<MintMetadataApplyResult> {
    // Explicit refreshes must take effect even within the same second as the previous refresh.
    return this.applyMetadata(observation, await this.findMint(observation.mintUrl), true);
  }

  async add(input: AddMintInput): Promise<AddMintResult> {
    const current = await this.findMint(input.mintUrl);
    const previousTrust = current?.trusted;
    if (input.observation && input.observation.mintUrl !== input.mintUrl) {
      throw new Error('Mint observation URL does not match the mint being added');
    }
    let result: MintMetadataApplyResult;
    if (input.observation) {
      result = await this.applyMetadata(input.observation, current);
    } else {
      if (!current) throw new UnknownMintError(`Mint not found: ${input.mintUrl}`);
      result = { metadata: await this.snapshot(current), applied: false };
    }
    const trustChanged = input.trusted !== undefined && previousTrust !== input.trusted;
    if (input.trusted !== undefined && result.metadata.mint.trusted !== input.trusted) {
      await this.mints.setMintTrusted(input.mintUrl, input.trusted);
      result.metadata.mint = { ...result.metadata.mint, trusted: input.trusted };
    }
    return { ...result, created: !current, trustChanged };
  }

  async setTrusted(input: SetMintTrustedInput): Promise<void> {
    const current = await this.findMint(input.mintUrl);
    // Preserve the repository contract: changing trust of an unknown mint is a no-op.
    if (current && current.trusted !== input.trusted) {
      await this.mints.setMintTrusted(input.mintUrl, input.trusted);
    }
  }

  async delete(mintUrl: string): Promise<void> {
    if (!(await this.findMint(mintUrl))) return;
    for (const keyset of await this.keysets.getKeysetsByMintUrl(mintUrl)) {
      await this.keysets.deleteKeyset(mintUrl, keyset.id);
    }
    await this.mints.deleteMint(mintUrl);
  }

  private async findMint(mintUrl: string): Promise<Mint | undefined> {
    return (await this.mints.getAllMints()).find((mint) => mint.mintUrl === mintUrl);
  }

  private async snapshot(mint: Mint): Promise<MintMetadata> {
    const keysets = await this.keysets.getKeysetsByMintUrl(mint.mintUrl);
    return { mint, keysets: keysets.filter((keyset) => !isBlsKeyset(keyset.id)) };
  }

  private async applyMetadata(
    observation: MintMetadataObservation,
    current: Mint | undefined,
    replaceEqualTimestamp = false,
  ): Promise<MintMetadataApplyResult> {
    if (
      current &&
      (current.updatedAt > observation.observedAt ||
        (!replaceEqualTimestamp && current.updatedAt === observation.observedAt))
    ) {
      return { applied: false, metadata: await this.snapshot(current) };
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
    return { applied: true, metadata: await this.snapshot(mint) };
  }
}
