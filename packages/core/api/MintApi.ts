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

  async isKnownMint(mintUrl: string): Promise<boolean> {
    return this.mintService.isKnownMint(mintUrl);
  }

  async getAllMints(): Promise<Mint[]> {
    return this.mintService.getAllMints();
  }
}
