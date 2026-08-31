import type { Logger } from '@core/logging';
import type { Keypair, KeypairPurpose } from '@core/models/Keypair';
import type { SeedService } from '@core/services/SeedService.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';
import type { PurposeBoundKeyDeriver } from './TransactionalKeypairOperations.ts';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { HDKey } from '@scure/bip32';

const DERIVATION_PURPOSES: Record<KeypairPurpose, number> = {
  p2pk: 10,
  nut20_mint_quote: 20,
};

export interface KeyRingTransactions {
  generateP2pkKey(): Promise<Keypair>;
  generateMintQuoteKey(): Promise<Keypair>;
  importP2pkKey(keypair: Keypair): Promise<void>;
  deleteP2pkKey(publicKey: string): Promise<void>;
}

export class CoreKeyRingTransactions implements KeyRingTransactions {
  constructor(
    private readonly runner: CoreTransactionRunner,
    private readonly seedService: SeedService,
    private readonly logger?: Logger,
  ) {}

  generateP2pkKey(): Promise<Keypair> {
    return this.generateForPurpose('p2pk');
  }

  generateMintQuoteKey(): Promise<Keypair> {
    return this.generateForPurpose('nut20_mint_quote');
  }

  importP2pkKey(keypair: Keypair): Promise<void> {
    return this.runner.run((transaction) => transaction.keypairs.importP2pk(keypair));
  }

  deleteP2pkKey(publicKey: string): Promise<void> {
    return this.runner.run((transaction) => transaction.keypairs.deleteP2pk(publicKey));
  }

  private async generateForPurpose(purpose: KeypairPurpose): Promise<Keypair> {
    this.logger?.debug('Generating new key pair', { purpose });

    // Seed loading and HD root construction are asynchronous preflight. The transaction receives
    // only a synchronous, purpose-bound derivation function, keeping it IndexedDB-compatible.
    const seed = await this.seedService.getSeed();
    const derive = createPurposeBoundKeyDeriver(seed, purpose);
    const keypair = await this.runner.run((transaction) =>
      transaction.keypairs.allocate({ purpose, derive }),
    );

    this.logger?.debug('New key pair generated', {
      publicKeyHex: keypair.publicKeyHex,
      purpose,
    });
    return keypair;
  }
}

function createPurposeBoundKeyDeriver(
  seed: Uint8Array,
  purpose: KeypairPurpose,
): PurposeBoundKeyDeriver {
  const hdKey = HDKey.fromMasterSeed(seed);
  const derivationPurpose = DERIVATION_PURPOSES[purpose];

  return (derivationIndex) => {
    const derivationPath = `m/129373'/${derivationPurpose}'/0'/0'/${derivationIndex}`;
    const { privateKey: secretKey } = hdKey.derive(derivationPath);
    if (!secretKey) {
      throw new Error('Failed to derive secret key');
    }

    const publicKeyHex =
      purpose === 'nut20_mint_quote'
        ? bytesToHex(secp256k1.getPublicKey(secretKey, true))
        : '02' + bytesToHex(schnorr.getPublicKey(secretKey));
    return { publicKeyHex, secretKey };
  };
}
