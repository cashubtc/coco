import { deriveKeysetId } from '@cashu/cashu-ts';
import type { MintInfo } from '../../types.ts';

export const testMintInfo: MintInfo = {
  name: 'Test Mint',
  version: '1.0.0',
  pubkey: 'test-pubkey',
  contact: [],
  nuts: {
    '4': { methods: [], disabled: false },
    '5': { methods: [], disabled: false },
    '11': { supported: true },
  },
};

export const testMintKeypairs = {
  '1': '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  '2': '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
  '4': '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
  '8': '03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb',
};

export function testMintKeysetId(
  unit = 'sat',
  commitments: { input_fee_ppk?: number; expiry?: number } = {},
) {
  return deriveKeysetId(testMintKeypairs, { unit, ...commitments });
}

/** Legacy `00`-prefixed keyset id, derived from the keys alone (NUT-02 v1). */
export function testLegacyMintKeysetId() {
  return deriveKeysetId(testMintKeypairs, { versionByte: 0 });
}

/** NUT-02 V2 test vector 1: the id commits to `finalExpiry` and `feePpk` as well as the keys. */
export const expiringKeysetVector = {
  id: '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a',
  unit: 'sat',
  feePpk: 100,
  finalExpiry: 2059210353,
  keypairs: {
    '1': '03a40f20667ed53513075dc51e715ff2046cad64eb68960632269ba7f0210e38bc',
    '2': '03fd4ce5a16b65576145949e6f99f445f8249fee17c606b688b504a849cdc452de',
    '4': '02648eccfa4c026960966276fa5a4cae46ce0fd432211a4f449bf84f13aa5f8303',
    '8': '02fdfd6796bfeac490cbee12f778f867f0a2c68f6508d17c649759ea0dc3547528',
  },
} as const;
