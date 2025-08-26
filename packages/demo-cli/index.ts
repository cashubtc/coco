import { program } from 'commander';
import { ConsoleLogger, Manager } from 'coco-cashu-core';
import { SqliteRepositories } from 'coco-cashu-sqlite3';
import { Database } from 'sqlite3';
import { getEncodedToken } from '@cashu/cashu-ts';

const db = new Database('./test.db');
const repo = new SqliteRepositories({ database: db });
await repo.init();
const manager = new Manager(repo, new ConsoleLogger());

program
  .command('balance')
  .description('get wallet balance')
  .action(async function (env, options) {
    const balance = await manager.getBalances();
    console.log(balance);
  });

program
  .command('add-mint')
  .description('add mint')
  .argument('<mintUrl>', 'the mint url to add')
  .action(async function (mintUrl) {
    try {
      await manager.addMint(mintUrl);
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
      await manager.redeemMintQuote(mintUrl, quoteId);
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
      const quote = await manager.createMintQuote(mintUrl, Number(amount));
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
      const toSend = await manager.send(mintUrl, Number(amount));
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
      await manager.receive(token);
    } catch (e) {
      console.error(e);
    }
  });

program.parse(process.argv);
