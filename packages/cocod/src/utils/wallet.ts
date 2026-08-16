import { initializeCoco, ConsoleLogger, type Logger, type Manager } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';
import { Database } from 'bun:sqlite';
import { mnemonicToSeedSync } from '@scure/bip39';
import { NPCPlugin, type NPCAccountApi } from 'coco-cashu-plugin-npc';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { finalizeEvent, type EventTemplate } from 'nostr-tools';
import { decryptMnemonic } from './crypto.js';
import { SALT_FILE, DB_FILE } from './config.js';
import { ensureSecretFile } from './files.js';
import type { WalletConfig } from './config.js';

export interface InitializedWallet {
  manager: Manager;
  mintUrl: string;
  npcAccount: NPCAccountApi;
}

/** Reports whether cocod could clean up a failed post-Coco session initialization step. */
export class CocoSessionStartupError extends Error {
  constructor(
    message: string,
    readonly cleanupState: 'confirmed' | 'unconfirmed',
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'CocoSessionStartupError';
  }
}

export async function initializeWallet(
  config: WalletConfig,
  passphrase?: string,
  logger?: Logger,
): Promise<InitializedWallet> {
  let mnemonic: string;

  if (config.encrypted) {
    if (!passphrase) {
      throw new Error('Passphrase required for encrypted wallet');
    }
    const salt = await Bun.file(SALT_FILE).text();
    mnemonic = await decryptMnemonic(config.mnemonic, passphrase, salt);
  } else {
    mnemonic = config.mnemonic;
  }

  const seed = mnemonicToSeedSync(mnemonic);

  await ensureSecretFile(DB_FILE);
  const repo = new SqliteRepositories({ database: new Database(DB_FILE) });
  const walletLogger = logger?.child?.({ component: 'coco' }) ?? logger;
  const cocoLogger = walletLogger ?? new ConsoleLogger('Coco', { level: 'info' });
  const sk = privateKeyFromSeedWords(mnemonic);
  const signer = async (t: EventTemplate) => finalizeEvent(t, sk);
  const npcPlugin = new NPCPlugin({
    // npub.cash is a marketing redirect that does not speak the sync protocol
    defaultBaseUrl: 'https://npubx.cash',
    logger: cocoLogger,
  });
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => seed,
    logger: cocoLogger,
    plugins: [npcPlugin],
  });
  try {
    const npcAccount = await npcPlugin.addAccount({
      id: 'default',
      signer,
      useWebsocket: true,
    });
    await coco.mint.addMint(config.mintUrl, { trusted: true });

    return { manager: coco, mintUrl: config.mintUrl, npcAccount };
  } catch (error) {
    try {
      await coco.dispose();
    } catch (cleanupError) {
      throw new CocoSessionStartupError(
        'Coco Session startup and cleanup failed',
        'unconfirmed',
        new AggregateError([error, cleanupError]),
      );
    }
    throw new CocoSessionStartupError('Coco Session startup failed', 'confirmed', error);
  }
}
