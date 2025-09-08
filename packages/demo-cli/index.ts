import { program } from 'commander';
import { ConsoleLogger, Manager } from 'coco-cashu-core';
import { SqliteRepositories } from 'coco-cashu-sqlite3';
import { Database } from 'sqlite3';
import { getEncodedToken } from '@cashu/cashu-ts';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const db = new Database('./test.db');

db.exec(`CREATE  TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);

let cachedKey = await new Promise<string | null>((resolve, reject) => {
  db.get<{ value: string }>('SELECT value FROM config WHERE key = "mnemonic"', (err, row) => {
    if (err) reject(err);
    if (!row) {
      resolve(null);
    } else {
      resolve(row.value);
    }
  });
});
if (!cachedKey) {
  const newKey = bip39.generateMnemonic(wordlist);
  db.run('INSERT INTO config (key, value) VALUES (?, ?)', ['mnemonic', newKey]);
  cachedKey = newKey;
}
const seedGetter = async () => bip39.mnemonicToSeedSync(cachedKey);

const repo = new SqliteRepositories({ database: db });
await repo.init();
const manager = new Manager(repo, seedGetter, new ConsoleLogger(undefined, { level: 'debug' }));

program
  .command('balance')
  .description('get wallet balance')
  .action(async function (env, options) {
    const balance = await manager.wallet.getBalances();
    console.log(balance);
  });

program
  .command('add-mint')
  .description('add mint')
  .argument('<mintUrl>', 'the mint url to add')
  .action(async function (mintUrl) {
    try {
      await manager.mint.addMint(mintUrl);
    } catch (e) {
      console.error(e);
    }
  });

program
  .command('redeem-mint')
  .description('create new mint quote')
  .argument('<mintUrl>')
  .argument('quoteId')
  .action(async function (mintUrl, quoteId) {
    try {
      await manager.quotes.redeemMintQuote(mintUrl, quoteId);
      console.log('Redeemed quote!');
    } catch (e) {
      console.error(e);
    }
  });

program
  .command('create-mint')
  .description('create new mint quote')
  .argument('<mintUrl>')
  .argument('<amount>')
  .action(async function (mintUrl, amount) {
    try {
      const quote = await manager.quotes.createMintQuote(mintUrl, Number(amount));
      console.log('Quote created: ', quote.quote);
      console.log('Please pay this invoice: ', quote.request);
    } catch (e) {
      console.error(e);
    }
  });

program
  .command('send')
  .description('send token')
  .argument('<mintUrl>')
  .argument('<amount>')
  .action(async function (mintUrl, amount) {
    try {
      const toSend = await manager.wallet.send(mintUrl, Number(amount));
      console.log(getEncodedToken(toSend));
    } catch (e) {
      console.error(e);
    }
  });

program
  .command('receive')
  .argument('<token>', 'a cashu token')
  .action(async (token) => {
    try {
      await manager.wallet.receive(token);
    } catch (e) {
      console.error(e);
    }
  });

program.parse(process.argv);
