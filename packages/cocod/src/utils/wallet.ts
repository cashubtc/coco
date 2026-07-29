import { initializeCoco, ConsoleLogger, type Logger, type Manager } from "coco-cashu-core";
import { SqliteRepositories } from "coco-cashu-sqlite-bun";
import { Database } from "bun:sqlite";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NPCPlugin } from "coco-cashu-plugin-npc";
import { privateKeyFromSeedWords } from "nostr-tools/nip06";
import { finalizeEvent, type EventTemplate } from "nostr-tools";
import { decryptMnemonic } from "./crypto.js";
import { SALT_FILE, DB_FILE } from "./config.js";
import type { WalletConfig } from "./config.js";

export async function initializeWallet(
  config: WalletConfig,
  passphrase?: string,
  logger?: Logger,
): Promise<Manager> {
  let mnemonic: string;

  if (config.encrypted) {
    if (!passphrase) {
      throw new Error("Passphrase required for encrypted wallet");
    }
    const salt = await Bun.file(SALT_FILE).text();
    mnemonic = await decryptMnemonic(config.mnemonic, passphrase, salt);
  } else {
    mnemonic = config.mnemonic;
  }

  const seed = mnemonicToSeedSync(mnemonic);

  const repo = new SqliteRepositories({ database: new Database(DB_FILE) });
  const walletLogger = logger?.child?.({ component: "coco" }) ?? logger;
  const cocoLogger = walletLogger ?? new ConsoleLogger("Coco", { level: "info" });
  const sk = privateKeyFromSeedWords(mnemonic);
  const signer = async (t: EventTemplate) => finalizeEvent(t, sk);
  const npcPlugin = new NPCPlugin("https://npubx.cash", signer, {
    useWebsocket: true,
    logger: cocoLogger,
  });
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => seed,
    logger: cocoLogger,
  });

  coco.use(npcPlugin);

  await coco.mint.addMint(config.mintUrl, { trusted: true });

  return coco;
}
