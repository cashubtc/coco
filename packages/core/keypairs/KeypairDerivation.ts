import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { HDKey } from '@scure/bip32';
import type { KeypairPurpose } from '../models/Keypair.ts';
import type { AllocateKeypairCommand } from './types.ts';

const DERIVATION_PURPOSES: Record<KeypairPurpose, number> = {
  p2pk: 10,
  nut20_mint_quote: 20,
};

/** Shared preflight capability. Loading the seed must not mutate Wallet storage. */
export class KeypairDerivation {
  constructor(private readonly loadSeed: () => Promise<Uint8Array>) {}

  async prepare(purpose: KeypairPurpose): Promise<AllocateKeypairCommand> {
    const hdKey = HDKey.fromMasterSeed(await this.loadSeed());
    const derivationPurpose = DERIVATION_PURPOSES[purpose];
    return {
      purpose,
      derive(derivationIndex) {
        const { privateKey: secretKey } = hdKey.derive(
          `m/129373'/${derivationPurpose}'/0'/0'/${derivationIndex}`,
        );
        if (!secretKey) throw new Error('Failed to derive secret key');
        const publicKeyHex =
          purpose === 'nut20_mint_quote'
            ? bytesToHex(secp256k1.getPublicKey(secretKey, true))
            : '02' + bytesToHex(schnorr.getPublicKey(secretKey));
        return { publicKeyHex, secretKey };
      },
    };
  }
}
