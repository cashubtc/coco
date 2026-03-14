import { describe, it, expect, beforeEach } from 'bun:test';
import { AuthManager, type Proof } from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** secp256k1 scalar field (mod n) — used for DLEQ arithmetic */
const Fn = (secp256k1.Point as any).Fn as {
  ORDER: bigint;
  fromBytes(b: Uint8Array): bigint;
  toBytes(n: bigint): Uint8Array;
  add(a: bigint, b: bigint): bigint;
  mul(a: bigint, b: bigint): bigint;
};

/**
 * hash_e per NUT-12 / cashu-ts implementation:
 * uncompressed hex of each point → join → TextEncoder → sha256
 */
function hashE(points: InstanceType<typeof secp256k1.Point>[]): Uint8Array {
  const hex = points.map((p) => p.toHex(false)).join('');
  return sha256(new TextEncoder().encode(hex));
}

/**
 * Compute keyset id per NUT-02 v2:
 * "00" + hex(sha256(sorted_compressed_pubkeys)[0:7])
 */
function computeKeysetId(keys: Record<number, string>): string {
  const sorted = Object.entries(keys).sort((a, b) => Number(a[0]) - Number(b[0]));
  const totalLen = sorted.length * 33;
  const concat = new Uint8Array(totalLen);
  let offset = 0;
  for (const [, pubKeyHex] of sorted) {
    concat.set(hexToBytes(pubKeyHex), offset);
    offset += 33;
  }
  const hash = sha256(concat);
  return '00' + bytesToHex(hash.slice(0, 7));
}

// ────────────────────────────────────────────────────────────────
// Mock mint with real secp256k1 blind signatures + DLEQ
// ────────────────────────────────────────────────────────────────

interface MockMint {
  request: (args: any) => Promise<any>;
  calls: Array<{ endpoint: string; method: string; body?: any }>;
  keysetId: string;
  pubKeyHex: string;
}

function createMockMint(): MockMint {
  const privKey = secp256k1.utils.randomSecretKey();
  const kScalar = Fn.fromBytes(privKey);
  const K = secp256k1.Point.BASE.multiply(kScalar);
  const pubKeyHex = K.toHex(true);
  const keysetId = computeKeysetId({ 1: pubKeyHex });

  const calls: MockMint['calls'] = [];

  const mintInfo = {
    name: 'Test Mint',
    version: 'test/0.1',
    nuts: {
      '1': { methods: [{ method: 'bolt11', unit: 'sat' }] },
      '22': {
        bat_max_mint: 10,
        protected_endpoints: [
          { method: 'POST', path: '/v1/mint/bolt11' },
          { method: 'POST', path: '/v1/melt/bolt11' },
        ],
      },
    },
  };

  /**
   * Sign a blinded message B_ and produce a valid DLEQ proof.
   *
   * C_ = k * B_
   * DLEQ: nonce p → R1=p*G, R2=p*B_
   *        e = hash_e(R1, R2, K, C_)
   *        s = p + e*k (mod n)
   */
  function signBlindedMessage(B_hex: string) {
    const B_ = secp256k1.Point.fromHex(B_hex);
    const C_ = B_.multiply(kScalar);

    const nonceBytes = secp256k1.utils.randomSecretKey();
    const p = Fn.fromBytes(nonceBytes);
    const R1 = secp256k1.Point.BASE.multiply(p);
    const R2 = B_.multiply(p);

    const eBytes = hashE([R1, R2, K, C_]);
    const eScalar = Fn.fromBytes(eBytes);
    const sScalar = Fn.add(p, Fn.mul(eScalar, kScalar));

    return {
      id: keysetId,
      amount: 1,
      C_: C_.toHex(true),
      dleq: {
        e: bytesToHex(eBytes),
        s: bytesToHex(Fn.toBytes(sScalar)),
      },
    };
  }

  const request = async (args: any) => {
    calls.push({
      endpoint: args.endpoint,
      method: args.method,
      body: args.requestBody,
    });

    const url = new URL(args.endpoint);
    const path = url.pathname;

    if (path === '/v1/info' && args.method === 'GET') {
      return mintInfo;
    }
    if (path === '/v1/auth/blind/keysets' && args.method === 'GET') {
      return {
        keysets: [{ id: keysetId, unit: 'auth', active: true, input_fee_ppk: 0 }],
      };
    }
    if (path === '/v1/auth/blind/keys' && args.method === 'GET') {
      return {
        keysets: [{ id: keysetId, unit: 'auth', keys: { '1': pubKeyHex } }],
      };
    }
    if (path === '/v1/auth/blind/mint' && args.method === 'POST') {
      const outputs = args.requestBody?.outputs;
      if (!outputs) throw new Error('Mock mint: no outputs');
      const signatures = outputs.map((o: any) => signBlindedMessage(o.B_));
      return { signatures };
    }

    throw new Error(`Mock mint: unhandled ${args.method} ${path}`);
  };

  return { request, calls, keysetId, pubKeyHex };
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('AuthManager automatic topUp', () => {
  let mockMint: MockMint;
  let auth: AuthManager;

  beforeEach(() => {
    mockMint = createMockMint();
    auth = new AuthManager('https://mint.test', {
      request: mockMint.request,
      desiredPoolSize: 3,
    });
  });

  it('triggers topUp when pool is empty', async () => {
    expect(auth.poolSize).toBe(0);

    // getBlindAuthToken → ensure(1) → init() + topUp(3)
    const token = await auth.getBlindAuthToken({ method: 'POST', path: '/v1/mint/bolt11' });

    expect(token).toBeDefined();
    expect(token.startsWith('authA')).toBe(true);

    // 3 minted, 1 consumed → pool = 2
    expect(auth.poolSize).toBe(2);

    // /v1/auth/blind/mint should have been called exactly once
    const mintCalls = mockMint.calls.filter((c) => c.endpoint.includes('/v1/auth/blind/mint'));
    expect(mintCalls).toHaveLength(1);
    // Should have requested desiredPoolSize (3) tokens
    expect(mintCalls[0]!.body.outputs).toHaveLength(3);
  });

  it('does NOT trigger topUp when pool already has tokens', async () => {
    // First call: trigger topUp to populate pool
    await auth.getBlindAuthToken({ method: 'POST', path: '/v1/mint/bolt11' });
    expect(auth.poolSize).toBe(2);

    // Clear call log
    mockMint.calls.length = 0;

    // Second call: pool has 2 tokens, no topUp needed
    const token = await auth.getBlindAuthToken({ method: 'POST', path: '/v1/mint/bolt11' });
    expect(token).toBeDefined();
    expect(auth.poolSize).toBe(1);

    // No new /v1/auth/blind/mint calls
    const mintCalls = mockMint.calls.filter((c) => c.endpoint.includes('/v1/auth/blind/mint'));
    expect(mintCalls).toHaveLength(0);
  });

  it('triggers topUp again after pool fully depletes', async () => {
    // First topUp: mints 3 tokens
    await auth.getBlindAuthToken({ method: 'POST', path: '/v1/mint/bolt11' });
    expect(auth.poolSize).toBe(2);

    // Consume remaining tokens
    await auth.getBlindAuthToken({ method: 'POST', path: '/v1/mint/bolt11' });
    expect(auth.poolSize).toBe(1);

    await auth.getBlindAuthToken({ method: 'POST', path: '/v1/mint/bolt11' });
    expect(auth.poolSize).toBe(0);

    // Next call triggers second topUp
    await auth.getBlindAuthToken({ method: 'POST', path: '/v1/mint/bolt11' });
    expect(auth.poolSize).toBe(2); // 3 minted - 1 consumed

    // /v1/auth/blind/mint called twice total
    const mintCalls = mockMint.calls.filter((c) => c.endpoint.includes('/v1/auth/blind/mint'));
    expect(mintCalls).toHaveLength(2);
  });

  it('topUp respects bat_max_mint limit', async () => {
    // Create a mint with small bat_max_mint
    const limitedMint = createMockMint();
    const origRequest = limitedMint.request;
    limitedMint.request = async (args: any) => {
      const result = await origRequest(args);
      if (new URL(args.endpoint).pathname === '/v1/info') {
        result.nuts['22'].bat_max_mint = 2;
      }
      return result;
    };

    const limitedAuth = new AuthManager('https://mint.test', {
      request: limitedMint.request,
      desiredPoolSize: 5, // wants 5, but mint only allows 2 per request
    });

    await limitedAuth.getBlindAuthToken({ method: 'POST', path: '/v1/mint/bolt11' });

    // Should have requested min(5, 2) = 2 tokens in first topUp
    const mintCalls = limitedMint.calls.filter((c) =>
      c.endpoint.includes('/v1/auth/blind/mint'),
    );
    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0]!.body.outputs).toHaveLength(2);

    // 2 minted - 1 consumed = 1 remaining
    expect(limitedAuth.poolSize).toBe(1);
  });

  it('exported pool can be re-imported and avoids topUp', async () => {
    // Trigger topUp to get real BATs
    await auth.getBlindAuthToken({ method: 'POST', path: '/v1/mint/bolt11' });
    expect(auth.poolSize).toBe(2);

    // Export pool
    const exported = auth.exportPool();
    expect(exported).toHaveLength(2);

    // Create a new AuthManager and import the pool
    const auth2 = new AuthManager('https://mint.test', {
      request: mockMint.request,
      desiredPoolSize: 3,
    });
    auth2.importPool(exported, 'replace');
    expect(auth2.poolSize).toBe(2);

    // Clear call log
    mockMint.calls.length = 0;

    // getBlindAuthToken should work without new topUp
    const token = await auth2.getBlindAuthToken({ method: 'POST', path: '/v1/mint/bolt11' });
    expect(token).toBeDefined();
    expect(token.startsWith('authA')).toBe(true);
    expect(auth2.poolSize).toBe(1);

    // init() is called (info + keysets + keys) but NOT topUp
    const mintCalls = mockMint.calls.filter((c) => c.endpoint.includes('/v1/auth/blind/mint'));
    expect(mintCalls).toHaveLength(0);
  });
});
