import { legacyPublicKeyHex } from '../../keypairs/PublicKeyEncoding.ts';

/** Secret scalar 6 has an odd-Y public key, so its legacy and canonical encodings differ. */
export const ODD_Y_SECRET_KEY = Uint8Array.from([...new Uint8Array(31), 6]);
export const ODD_Y_CANONICAL_PUBLIC_KEY =
  '03fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556';
export const ODD_Y_LEGACY_PUBLIC_KEY = legacyPublicKeyHex(ODD_Y_CANONICAL_PUBLIC_KEY);

/** Mnemonic from the NUT-13 P2PK derivation test vectors. */
export const NUT13_P2PK_MNEMONIC =
  'half depart obvious quality work element tank gorilla view sugar picture humble';

/** BIP39 seed for {@link NUT13_P2PK_MNEMONIC} with an empty passphrase. */
export async function nut13P2pkSeed(): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const password = encoder.encode(NUT13_P2PK_MNEMONIC.normalize('NFKD'));
  const salt = encoder.encode('mnemonic');
  const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  const seed = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-512', salt, iterations: 2048 },
    key,
    512,
  );
  return new Uint8Array(seed);
}
