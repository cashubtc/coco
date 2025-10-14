import type { MintService } from '@core/services';
import type { Mint, Keyset } from '@core/models';
import type { MintInfo } from '@core/types';

export class MintApi {
  constructor(private readonly mintService: MintService) {}

  async addMint(mintUrl: string): Promise<{
    mint: Mint;
    keysets: Keyset[];
  }> {
    return this.mintService.addMintByUrl(mintUrl);
  }

  async getMintInfo(mintUrl: string): Promise<MintInfo> {
    return this.mintService.getMintInfo(mintUrl);
  }

  async isTrustedMint(mintUrl: string): Promise<boolean> {
    return this.mintService.isTrustedMint(mintUrl);
  }

  async getAllMints(): Promise<Mint[]> {
    return this.mintService.getAllMints();
  }

  async getAllTrustedMints(): Promise<Mint[]> {
    return this.mintService.getAllTrustedMints();
  }

  async trustMint(mintUrl: string): Promise<void> {
    return this.mintService.trustMint(mintUrl);
  }

  async untrustMint(mintUrl: string): Promise<void> {
    return this.mintService.untrustMint(mintUrl);
  }
}
