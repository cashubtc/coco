import type {
  CheckPaymentMethodCapabilityInput,
  ListPaymentMethodCapabilitiesInput,
  MintService,
  PaymentMethodCapability,
  PaymentMethodCapabilityCheck,
} from '@core/services';
import type { Mint, Keyset } from '@core/models';
import type { MintInfo } from '@core/types';

export class MintApi {
  constructor(private readonly mintService: MintService) {}

  async addMint(
    mintUrl: string,
    options?: { trusted?: boolean },
  ): Promise<{
    mint: Mint;
    keysets: Keyset[];
  }> {
    return this.mintService.addMintByUrl(mintUrl, options);
  }

  async getMintInfo(mintUrl: string): Promise<MintInfo> {
    return this.mintService.getMintInfo(mintUrl);
  }

  /** Check whether a mint supports one method/unit pair for minting or melting. */
  async checkPaymentMethodCapability(
    input: CheckPaymentMethodCapabilityInput,
  ): Promise<PaymentMethodCapabilityCheck> {
    return this.mintService.checkPaymentMethodCapability(input);
  }

  /** List enabled Payment Method Capabilities advertised by NUT-04/NUT-05 mint metadata. */
  async listPaymentMethodCapabilities(
    input: ListPaymentMethodCapabilitiesInput,
  ): Promise<PaymentMethodCapability[]> {
    return this.mintService.listPaymentMethodCapabilities(input);
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
