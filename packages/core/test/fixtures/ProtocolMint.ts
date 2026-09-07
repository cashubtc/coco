import {
  Amount,
  createBlindSignature,
  createNewMintKeys,
  hashToCurve,
  pointFromHex,
  serializeMintKeys,
  type MintKeys,
  type Proof,
} from '@cashu/cashu-ts';
import { mock } from 'bun:test';
import { CashuMintClient } from '../../infra/CashuMintClient.ts';
import type { MintRequestFn } from '../../infra/MintRequestProvider.ts';
import type { MintMetadata } from '../../mints/MintMetadata.ts';
import { testMintInfo } from './MintMetadata.ts';
export const mintUrl = 'https://mint.test';
export const unit = 'sat';
export const seed = new Uint8Array(64).fill(1);
const keyset = createNewMintKeys(8, new Uint8Array(32).fill(2));
export const keys: MintKeys = {
  id: keyset.keysetId,
  unit,
  keys: serializeMintKeys(keyset.pubKeys),
};
export const metadata: MintMetadata = {
  mint: {
    mintUrl,
    name: 'Test Mint',
    trusted: true,
    mintInfo: testMintInfo,
    createdAt: 1,
    updatedAt: 1,
  },
  keysets: [
    { mintUrl, id: keys.id, unit, keypairs: keys.keys, active: true, feePpk: 0, updatedAt: 1 },
  ],
};

export function inputProof(): Proof {
  const secret = 'synthetic-input';
  const signature = createBlindSignature(
    hashToCurve(new TextEncoder().encode(secret)),
    keyset.privKeys['16']!,
    keys.id,
  );
  return { id: keys.id, secret, amount: Amount.from(16), C: signature.C_.toHex(true) };
}

type WireOutput = { id: string; amount: number; B_: string };
function sign(outputs: WireOutput[], signingKeyset = keyset) {
  return outputs.map((output) => {
    const signature = createBlindSignature(
      pointFromHex(output.B_),
      signingKeyset.privKeys[String(output.amount)]!,
      output.id,
    );
    return { id: output.id, amount: output.amount, C_: signature.C_.toHex(true) };
  });
}

export function createProtocolMintEnvironment(
  options: {
    restore?: 'none' | 'partial' | 'duplicate';
    states?: string[];
    signingKeyset?: typeof keyset;
  } = {},
) {
  function restoreOutputs(outputs: WireOutput[]) {
    if (options.restore === 'none') return [];
    if (options.restore === 'partial') return outputs.slice(0, 1);
    if (options.restore === 'duplicate') return [outputs[0]!, outputs[0]!];
    return outputs;
  }
  const calls: Array<{ endpoint: string; body?: Record<string, unknown> }> = [];
  const request: MintRequestFn = async <T>({
    endpoint,
    requestBody,
  }: Parameters<MintRequestFn>[0]): Promise<T> => {
    calls.push({ endpoint, body: requestBody });
    if (endpoint.endsWith('/swap'))
      return { signatures: sign(requestBody!.outputs as WireOutput[], options.signingKeyset) } as T;
    if (endpoint.endsWith('/restore'))
      return {
        outputs: restoreOutputs(requestBody!.outputs as WireOutput[]),
        signatures: sign(
          restoreOutputs(requestBody!.outputs as WireOutput[]),
          options.signingKeyset,
        ),
      } as T;
    if (endpoint.endsWith('/checkstate'))
      return {
        states: (requestBody!.Ys as string[]).map((Y, index) => ({
          Y,
          state: options.states?.[index] ?? 'UNSPENT',
        })),
      } as T;
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const mint = {
    getAuthProvider: () => undefined,
    fetchMintInfo: mock(async () => testMintInfo),
    fetchKeysets: mock(async () => ({
      keysets: [{ id: keys.id, unit, active: true, input_fee_ppk: 0 }],
    })),
    fetchKeysForId: mock(async () => keys.keys),
  };
  return { client: new CashuMintClient(mint, { getRequestFn: () => request }), calls, mint };
}
