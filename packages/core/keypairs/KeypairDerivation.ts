import { HDKey } from '@scure/bip32';
import type { KeypairPurpose } from '../models/Keypair.ts';
import { canonicalPublicKeyHex } from './PublicKeyEncoding.ts';
import type { AllocateKeypairInput } from './types.ts';

const DERIVATION_PURPOSES: Record<KeypairPurpose, number> = {
  p2pk: 10,
  nut20_mint_quote: 20,
};

/** Shared preflight capability. Loading the seed must not mutate Wallet storage. */
export class KeypairDerivation {
  constructor(private readonly loadSeed: () => Promise<Uint8Array>) {}

  async prepare(purpose: KeypairPurpose): Promise<AllocateKeypairInput> {
    const hdKey = HDKey.fromMasterSeed(await this.loadSeed());
    const derivationPurpose = DERIVATION_PURPOSES[purpose];
    return {
      purpose,
      derive(derivationIndex) {
        const { privateKey: secretKey } = hdKey.derive(
          `m/129373'/${derivationPurpose}'/0'/0'/${derivationIndex}`,
        );
        if (!secretKey) throw new Error('Failed to derive secret key');
        return { publicKeyHex: canonicalPublicKeyHex(secretKey), secretKey };
      },
    };
  }
}
