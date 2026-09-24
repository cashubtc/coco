import { Amount, isBlsKeyset } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError, UnknownMintError } from '@core/models/Error.ts';
import type { MintMetadataApplyResult, MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type { MintRepository, KeysetRepository } from '@core/repositories';

export interface TransactionMintMetadata {
  assertCanMint(mintUrl: string, method: string, unit: string, amount: Amount): Promise<void>;
  assertTrusted(mintUrl: string): Promise<void>;
  applyObservation(observation: MintMetadataObservation): Promise<MintMetadataApplyResult>;
}

/** Cache persistence shared by owning transactions; remote metadata cannot change mint trust. */
export class RepositoryTransactionMintMetadata implements TransactionMintMetadata {
  constructor(
    private readonly mints: MintRepository,
    private readonly keysets: KeysetRepository,
  ) {}

  async assertCanMint(
    mintUrl: string,
    method: string,
    unit: string,
    amount: Amount,
  ): Promise<void> {
    await this.assertTrusted(mintUrl);
    const mint = await this.mints.findMintByUrl(mintUrl);
    const settings = mint?.mintInfo.nuts['4'];
    const capability = settings?.methods?.find(
      (entry) => entry.method === method && normalizeUnit(entry.unit) === normalizeUnit(unit),
    );
    if (settings?.disabled || !capability)
      throw new ProofValidationError(`NUT-04 method ${method} does not support unit ${unit}`);
    if (
      method !== 'onchain' &&
      ((capability.min_amount != null && amount.lessThan(Amount.from(capability.min_amount))) ||
        (capability.max_amount != null && amount.greaterThan(Amount.from(capability.max_amount))))
    )
      throw new ProofValidationError(`Mint amount is outside NUT-04 limits for ${method} ${unit}`);
  }

  async assertTrusted(mintUrl: string): Promise<void> {
    if (!(await this.mints.isTrustedMint(mintUrl)))
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
  }

  async applyObservation(observation: MintMetadataObservation): Promise<MintMetadataApplyResult> {
    const current = await this.mints.findMintByUrl(observation.mintUrl);
    // Request timestamps have second precision, so keep the first commit on ties.
    if (current && current.updatedAt >= observation.observedAt) {
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
    return {
      applied: true,
      metadata: { mint, keysets: keysets.filter((keyset) => !isBlsKeyset(keyset.id)) },
    };
  }
}
