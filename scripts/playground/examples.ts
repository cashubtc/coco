export const examples: Record<string, { label: string; source: string }> = {
  balances: {
    label: 'Wallet balances',
    source: `// Coco is ready. Run this snippet with Ctrl / ⌘ Enter.\n// Variables and wallet state stay alive between runs.\nconst balance = await coco.wallet.balances.total();\nassert.equal(balance.total.toNumber(), 0);\nbalance;`,
  },
  keyring: {
    label: 'Create a key pair',
    source: `const pair = await coco.keyring.generateKeyPair();\nassert.ok(await coco.keyring.getKeyPair(pair.publicKeyHex));\nconsole.log('Key pairs:', (await coco.keyring.getAllKeyPairs()).length);\npair.publicKeyHex;`,
  },
  persistence: {
    label: 'Inspect the same session',
    source: `// Run "Create a key pair" first.\nassert.ok(await coco.keyring.getKeyPair(pair.publicKeyHex));\n(await coco.keyring.getAllKeyPairs()).length;`,
  },
  amounts: {
    label: 'Amounts and imports',
    source: `import { Amount as CashuAmount } from '@cashu/coco-core';\nconst amount: Amount = CashuAmount.from(42);\nassert.equal(CashuAmount, core.Amount);\namount.toNumber();`,
  },
  mints: {
    label: 'Connect to a test mint',
    source: `// Change this URL to a mint that allows this browser origin (CORS).\nconst mintUrl = 'http://localhost:3338';\nawait coco.mint.addMint(mintUrl, { trusted: true });\nawait coco.mint.getAllMints();`,
  },
};
