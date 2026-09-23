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

export function testMintKeysetId(unit = 'sat') {
  return deriveKeysetId(testMintKeypairs, { unit });
}
