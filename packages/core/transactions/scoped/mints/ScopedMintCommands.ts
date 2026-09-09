import { UnknownMintError } from '../../../models/Error.ts';
import type { Mint } from '../../../models/Mint.ts';
import type { Keyset } from '../../../models/Keyset.ts';
import type { MintRepository, KeysetRepository } from '../../../repositories/index.ts';

export interface SaveMintMetadataInput {
  mint: Mint;
  keysets: Array<Omit<Keyset, 'updatedAt'>>;
  /** Omission preserves the trust decision read inside this transaction. */
  trusted?: boolean;
}

export interface SaveMintMetadataResult {
  mint: Mint;
  keysets: Keyset[];
  created: boolean;
}

export interface SetMintTrustInput {
  mintUrl: string;
  trusted: boolean;
}

export interface ScopedMintCommands {
  saveMetadata(input: SaveMintMetadataInput): Promise<SaveMintMetadataResult>;
  setTrust(input: SetMintTrustInput): Promise<void>;
  delete(mintUrl: string): Promise<void>;
}

/** Commits metadata and keysets together without overwriting a concurrent trust decision. */
export class RepositoryMintCommands implements ScopedMintCommands {
  constructor(
    private readonly mints: MintRepository,
    private readonly keysets: KeysetRepository,
  ) {}

  async saveMetadata(input: SaveMintMetadataInput): Promise<SaveMintMetadataResult> {
    // getAllMints avoids catching a failed scoped repository call: such a failure must
    // roll back the entire attempt, including typed not-found errors.
    const existing = (await this.mints.getAllMints()).find((m) => m.mintUrl === input.mint.mintUrl);
    const mint = {
      ...input.mint,
      createdAt: existing?.createdAt ?? input.mint.createdAt,
      trusted: input.trusted ?? existing?.trusted ?? false,
    };
    await this.mints.addOrUpdateMint(mint);
    for (const keyset of input.keysets) {
      await this.keysets.addKeyset(keyset);
    }
    return {
      mint,
      keysets: await this.keysets.getKeysetsByMintUrl(mint.mintUrl),
      created: !existing,
    };
  }

  async setTrust(input: SetMintTrustInput): Promise<void> {
    // Authoritative existence and mutation share the same scope.
    if (!(await this.mints.getAllMints()).some((mint) => mint.mintUrl === input.mintUrl)) {
      throw new UnknownMintError(input.mintUrl);
    }
    await this.mints.setMintTrusted(input.mintUrl, input.trusted);
  }

  async delete(mintUrl: string): Promise<void> {
    for (const keyset of await this.keysets.getKeysetsByMintUrl(mintUrl)) {
      await this.keysets.deleteKeyset(mintUrl, keyset.id);
    }
    await this.mints.deleteMint(mintUrl);
  }
}
